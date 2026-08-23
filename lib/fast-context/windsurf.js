/**
 * Windsurf brain — reverse-engineered Windsurf SWE-grep Connect-RPC/Protobuf
 * protocol, ported as a pluggable "brain" for the fast-context search loop.
 *
 * Ported from fast-context-mcp src/core.mjs (protocol parts, MIT, see NOTICE.md).
 * Brain contract (shared with ./brain-llm.js):
 *   prepare(ctx, opts)  → state   (credentials / model selection; may throw)
 *   stream(state, messages, turnOpts) → { text, toolCalls }
 * where FC messages are { role: 1|2|4|5, content, tool_call_id?, tool_name?,
 * tool_args_json?, ref_call_id? } and toolCalls are
 * [{ name: 'restricted_exec' | 'answer', args: Object }].
 */

import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";
import { platform, arch, release, version as osVersion, hostname, cpus, totalmem } from "node:os";

import {
  ProtobufEncoder,
  extractStrings,
  connectFrameEncode,
  connectFrameDecode,
} from "./protocol.js";
import {
  parseJsonWithRepair,
  salvageRestrictedExecArgs,
} from "./repair.js";
import { extractKey } from "./extract-key.js";
import { buildToolSchemas } from "./shared.js";

// ─── Error Classification ──────────────────────────────────

/**
 * Classified error for fetch failures with structured error codes.
 */
export class FastContextError extends Error {
  /**
   * @param {string} message
   * @param {string} code - TIMEOUT | PAYLOAD_TOO_LARGE | RATE_LIMITED | AUTH_ERROR | SERVER_ERROR | NETWORK_ERROR
   * @param {Object} [details]
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = "FastContextError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Classify a raw fetch/HTTP error into a FastContextError.
 * @param {Error} err
 * @returns {FastContextError}
 */
export function classifyError(err) {
  if (err instanceof FastContextError) return err;

  // HTTP status-based classification
  if (err.status) {
    const s = err.status;
    if (s === 413) return new FastContextError(err.message, "PAYLOAD_TOO_LARGE", { status: s });
    if (s === 429) return new FastContextError(err.message, "RATE_LIMITED", { status: s });
    if (s === 401 || s === 403) return new FastContextError(err.message, "AUTH_ERROR", { status: s });
    return new FastContextError(err.message, "SERVER_ERROR", { status: s });
  }

  // Timeout (AbortSignal.timeout throws AbortError or TimeoutError)
  if (err.name === "AbortError" || err.name === "TimeoutError" || /timeout/i.test(err.message)) {
    return new FastContextError(err.message, "TIMEOUT");
  }

  // Everything else is a network-level issue
  return new FastContextError(err.message, "NETWORK_ERROR");
}

// ─── Protocol Constants ────────────────────────────────────

const API_BASE = "https://server.self-serve.windsurf.com/exa.api_server_pb.ApiServerService";
const AUTH_BASE = "https://server.self-serve.windsurf.com/exa.auth_pb.AuthService";
const WS_APP = "windsurf";
const WS_APP_VER = process.env.WS_APP_VER || "1.48.2";
const WS_LS_VER = process.env.WS_LS_VER || "1.9544.35";
// FAST is available to the same free-tier accounts as the legacy package.
// SLOW can return permission_denied for otherwise valid credentials.
const WS_MODEL = process.env.WS_MODEL || "MODEL_SWE_1_6_FAST";

/** Model id used for cache-key stability (kept in sync with WS_MODEL). */
export const WINDSURF_MODEL = WS_MODEL;

// ─── Credentials ───────────────────────────────────────────

/**
 * Auto-discover Windsurf API key from local installation.
 * @returns {Promise<string|null>}
 */
async function autoDiscoverApiKey() {
  try {
    const result = await extractKey();
    if (result.api_key && result.api_key.length > 10) {
      return result.api_key;
    }
  } catch {
    // Extraction failed
  }
  return null;
}

/**
 * Get API key from env var or auto-discovery.
 * @returns {Promise<string>}
 */
async function getApiKey() {
  const key = process.env.WINDSURF_API_KEY;
  if (key) return key;
  const discovered = await autoDiscoverApiKey();
  if (discovered) return discovered;
  throw new FastContextError(
    "Windsurf API Key not found. Set WINDSURF_API_KEY env var or ensure Windsurf is logged in.",
    "AUTH_ERROR",
  );
}

// ─── JWT Cache ──────────────────────────────────────────────

/** @type {Map<string, { token: string, expiresAt: number }>} */
const _jwtCache = new Map();

/**
 * Decode JWT payload and extract expiration time.
 * @param {string} jwt
 * @returns {number} expiration timestamp in seconds
 */
function _getJwtExp(jwt) {
  try {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

/**
 * Get a cached or fresh JWT token.
 * Refreshes when token expires or is within 60s of expiration.
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function getCachedJwt(apiKey, signal) {
  const now = Math.floor(Date.now() / 1000);
  const cached = _jwtCache.get(apiKey);
  if (cached && cached.expiresAt > now + 60) return cached.token;
  const token = await fetchJwt(apiKey, signal);
  const exp = _getJwtExp(token);
  _jwtCache.set(apiKey, { token, expiresAt: exp || now + 3600 });
  return token;
}

// ─── TLS Security ──────────────────────────────────────────
// TLS certificate verification is ALWAYS enabled by default.
// Only disabled when FC_ALLOW_INSECURE_TLS=1 (e.g. corporate proxy).
let _tlsFallbackApplied = false;

function _applyTlsFallback() {
  if (_tlsFallbackApplied) return;
  const allowed = process.env.FC_ALLOW_INSECURE_TLS === "1";
  if (allowed && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    _tlsFallbackApplied = true;
    process.stderr.write(
      "[fast-context] WARNING: TLS certificate verification disabled (FC_ALLOW_INSECURE_TLS=1). " +
      "Remove this env var to restore secure defaults.\n",
    );
  }
}

// ─── Network Layer ─────────────────────────────────────────

/** Combine an external abort signal with a timeout, when both exist. */
function _combineSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (signal && typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeout, signal]);
  }
  return timeout;
}

/**
 * Standard unary HTTP POST with proto content type.
 * @param {string} url
 * @param {Buffer} protoBytes
 * @param {boolean} [compress=true]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer>}
 */
async function _unaryRequest(url, protoBytes, compress = true, signal) {
  const headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "gzip",
  };

  let body;
  if (compress) {
    body = gzipSync(protoBytes);
    headers["Content-Encoding"] = "gzip";
  } else {
    body = protoBytes;
  }

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body,
    signal: _combineSignal(30000, signal),
  });

  let resp;
  try {
    resp = await doFetch();
  } catch (e) {
    if (signal?.aborted) throw new FastContextError("aborted", "TIMEOUT");
    // TLS or network error — try with cert verification disabled
    _applyTlsFallback();
    try {
      resp = await doFetch();
    } catch (e2) {
      throw classifyError(e2);
    }
  }

  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw classifyError(err);
  }

  const arrayBuf = await resp.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Connect-RPC streaming POST to GetDevstralStream with retry.
 * @param {Buffer} protoBytes
 * @param {number} [timeoutMs=30000]
 * @param {number} [maxRetries=2]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Buffer>}
 */
async function _streamingRequest(protoBytes, timeoutMs = 30000, maxRetries = 2, signal) {
  const frame = connectFrameEncode(protoBytes);
  const url = `${API_BASE}/GetDevstralStream`;
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const baseTimeoutMs = Number.isFinite(timeoutMs) ? timeoutMs : 30000;
  const abortMs = baseTimeoutMs + 5000;

  const headers = {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Content-Encoding": "gzip",
    "Connect-Timeout-Ms": String(baseTimeoutMs),
    "User-Agent": "connect-go/1.18.1 (go1.25.5)",
    "Accept-Encoding": "identity",
    "Baggage": `sentry-release=language-server-windsurf@${WS_LS_VER},` +
      `sentry-environment=stable,sentry-sampled=false,` +
      `sentry-trace_id=${traceId},` +
      `sentry-public_key=b813f73488da69eedec534dba1029111`,
    "Sentry-Trace": `${traceId}-${spanId}-0`,
  };

  const doFetch = () => fetch(url, {
    method: "POST",
    headers,
    body: frame,
    signal: _combineSignal(abortMs, signal),
  });

  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (signal?.aborted) throw new FastContextError("aborted", "TIMEOUT");
      let resp;
      try {
        resp = await doFetch();
      } catch (e) {
        if (signal?.aborted) throw new FastContextError("aborted", "TIMEOUT");
        if (attempt === 0) {
          _applyTlsFallback();
          resp = await doFetch();
        } else {
          throw e;
        }
      }

      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        // Don't retry on 4xx client errors (except 429)
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }

      const arrayBuf = await resp.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (e) {
      if (e instanceof FastContextError && e.code === "TIMEOUT" && e.message === "aborted") throw e;
      lastErr = e;
      // Don't retry on 4xx client errors (except 429)
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) {
        throw classifyError(e);
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }
  throw classifyError(lastErr);
}

/**
 * Authenticate with API key to get JWT token.
 * @param {string} apiKey
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function fetchJwt(apiKey, signal) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");
  meta.writeString(7, WS_LS_VER);
  meta.writeString(12, WS_APP);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));

  const outer = new ProtobufEncoder();
  outer.writeMessage(1, meta);

  const resp = await _unaryRequest(`${AUTH_BASE}/GetUserJwt`, outer.toBuffer(), false, signal);
  for (const s of extractStrings(resp)) {
    if (s.startsWith("eyJ") && s.includes(".")) {
      return s;
    }
  }
  throw new FastContextError("Failed to extract JWT from GetUserJwt response", "AUTH_ERROR");
}

/**
 * Check rate limit. Returns true if OK, false if rate-limited.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function checkRateLimit(apiKey, jwt, signal) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));
  req.writeString(3, WS_MODEL);

  try {
    await _unaryRequest(`${API_BASE}/CheckUserMessageRateLimit`, req.toBuffer(), true, signal);
    return true;
  } catch (e) {
    if (e.status === 429 || (e instanceof FastContextError && e.code === "RATE_LIMITED")) return false;
    return true; // Don't block on network issues
  }
}

// ─── Request Building ──────────────────────────────────────

/**
 * Build protobuf metadata with app info, system info, JWT, etc.
 * @param {string} apiKey
 * @param {string} jwt
 * @returns {ProtobufEncoder}
 */
function _buildMetadata(apiKey, jwt) {
  const meta = new ProtobufEncoder();
  meta.writeString(1, WS_APP);
  meta.writeString(2, WS_APP_VER);
  meta.writeString(3, apiKey);
  meta.writeString(4, "en");

  const plat = platform();
  const sysInfo = {
    Os: plat,
    Arch: arch(),
    Release: release(),
    Version: osVersion(),
    Machine: arch(),
    Nodename: hostname(),
    Sysname: plat === "darwin" ? "Darwin" : plat === "win32" ? "Windows_NT" : "Linux",
    ProductVersion: "",
  };
  meta.writeString(5, JSON.stringify(sysInfo));
  meta.writeString(7, WS_LS_VER);

  const cpuList = cpus();
  const ncpu = cpuList.length || 4;
  const mem = totalmem();
  const cpuInfo = {
    NumSockets: 1,
    NumCores: ncpu,
    NumThreads: ncpu,
    VendorID: "",
    Family: "0",
    Model: "0",
    ModelName: cpuList[0]?.model || "Unknown",
    Memory: mem,
  };
  meta.writeString(8, JSON.stringify(cpuInfo));
  meta.writeString(12, WS_APP);
  meta.writeString(21, jwt);
  meta.writeBytes(30, Buffer.from([0x00, 0x01]));
  return meta;
}

/**
 * Build a chat message protobuf.
 * @param {number} role - 1=user, 2=assistant, 4=tool_result, 5=system
 * @param {string} content
 * @param {Object} [opts]
 * @param {string} [opts.toolCallId]
 * @param {string} [opts.toolName]
 * @param {string} [opts.toolArgsJson]
 * @param {string} [opts.refCallId]
 * @returns {ProtobufEncoder}
 */
function _buildChatMessage(role, content, opts = {}) {
  const msg = new ProtobufEncoder();
  msg.writeVarint(2, role);
  msg.writeString(3, content);

  if (opts.toolCallId && opts.toolName && opts.toolArgsJson) {
    const tc = new ProtobufEncoder();
    tc.writeString(1, opts.toolCallId);
    tc.writeString(2, opts.toolName);
    tc.writeString(3, opts.toolArgsJson);
    msg.writeMessage(6, tc);
  }

  if (opts.refCallId) {
    msg.writeString(7, opts.refCallId);
  }

  return msg;
}

/**
 * Build a full request with metadata, messages, and tool definitions.
 * @param {string} apiKey
 * @param {string} jwt
 * @param {Array} messages
 * @param {string} toolDefs
 * @returns {Buffer}
 */
function _buildRequest(apiKey, jwt, messages, toolDefs) {
  const req = new ProtobufEncoder();
  req.writeMessage(1, _buildMetadata(apiKey, jwt));

  for (const m of messages) {
    const msgEnc = _buildChatMessage(m.role, m.content, {
      toolCallId: m.tool_call_id,
      toolName: m.tool_name,
      toolArgsJson: m.tool_args_json,
      refCallId: m.ref_call_id,
    });
    req.writeMessage(2, msgEnc);
  }

  req.writeString(3, toolDefs);
  return req.toBuffer();
}

// ─── Response Parsing ──────────────────────────────────────

/**
 * Strip invalid UTF-8 bytes from a Buffer → clean string.
 * Matches Python's bytes.decode("utf-8", errors="ignore").
 * @param {Buffer} buf
 * @returns {string}
 */
function stripInvalidUtf8(buf) {
  return buf.toString("utf-8").replace(/\ufffd/g, "");
}

/**
 * Parse tool call from [TOOL_CALLS]name[ARGS]{json} format.
 * @param {string} text
 * @returns {[string, string, Object]|null} [thinking, name, args] or null
 */
export function _parseToolCall(text) {
  text = text.replace(/<\/s>/g, "");
  const m = text.match(/\[TOOL_CALLS\](\w+)\[ARGS\](\{.+)/s);
  if (!m) return null;

  const name = m[1];
  const raw = m[2].trim();

  // Find matching closing brace
  let depth = 0;
  let end = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === 0) end = raw.length;

  const jsonText = raw.slice(0, end);
  let args = parseJsonWithRepair(jsonText);
  if (!args && name === "restricted_exec") {
    args = salvageRestrictedExecArgs(jsonText);
  }
  if (!args) return null;

  const thinking = text.slice(0, m.index).trim();
  return [thinking, name, args];
}

/**
 * Parse streaming response: decode frames, extract text, parse tool calls.
 * @param {Buffer} data
 * @returns {[string, [string, Object]|null]} [text, toolInfo]
 */
function _parseResponse(data) {
  const frames = connectFrameDecode(data);
  let allText = "";

  for (const frameData of frames) {
    // Check for error JSON
    try {
      const textCandidate = frameData.toString("utf-8");
      if (textCandidate.startsWith("{")) {
        const errObj = JSON.parse(textCandidate);
        if (errObj.error) {
          const code = errObj.error.code || "unknown";
          const msg = errObj.error.message || "";
          return [`[Error] ${code}: ${msg}`, null];
        }
      }
    } catch {
      // Not JSON, continue
    }

    // Extract text from frame — strip invalid UTF-8 (matches Python errors="ignore")
    const rawText = stripInvalidUtf8(frameData);
    if (rawText.includes("[TOOL_CALLS]")) {
      allText = rawText;
      break;
    }

    for (const s of extractStrings(frameData)) {
      if (s.length > 10) {
        allText += s;
      }
    }
  }

  const parsed = _parseToolCall(allText);
  if (parsed) {
    const [thinking, name, args] = parsed;
    return [thinking, [name, args]];
  }
  return [allText, null];
}

// ─── Brain Interface ───────────────────────────────────────

/**
 * Prepare Windsurf credentials (key + JWT + rate-limit check).
 * @param {{ apiKey?: string|null }} [opts]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ apiKey: string, jwt: string }>}
 */
async function prepare(opts = {}, signal) {
  const apiKey = opts.apiKey || await getApiKey();
  const jwt = await getCachedJwt(apiKey, signal);
  if (!(await checkRateLimit(apiKey, jwt, signal))) {
    throw new FastContextError("Rate limited, please try again later", "RATE_LIMITED");
  }
  return { apiKey, jwt };
}

/**
 * Run one Devstral turn over the Connect-RPC stream.
 * @param {{ apiKey: string, jwt: string }} state
 * @param {Array} messages - FC message list
 * @param {{ maxCommands?: number, timeoutMs?: number, signal?: AbortSignal }} [turnOpts]
 * @returns {Promise<{ text: string, toolCalls: Array<{name: string, args: Object}> }>}
 */
async function stream(state, messages, turnOpts = {}) {
  const { maxCommands = 8, timeoutMs = 30000, signal } = turnOpts;
  const toolSchemas = buildToolSchemas(maxCommands);
  // Wire format: OpenAI-style function definitions, JSON string (matches reference).
  const toolDefs = JSON.stringify(
    toolSchemas.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
  );
  const proto = _buildRequest(state.apiKey, state.jwt, messages, toolDefs);
  const respData = await _streamingRequest(proto, timeoutMs, 2, signal);
  const [text, toolInfo] = _parseResponse(respData);
  return {
    text,
    toolCalls: toolInfo ? [{ name: toolInfo[0], args: toolInfo[1] }] : [],
  };
}

export const windsurfBrain = { kind: "windsurf", prepare, stream };
