/**
 * Fast Context search loop — ported from fast-context-mcp src/core.mjs
 * (search + searchWithContent, MIT, see NOTICE.md).
 *
 * Change: the "brain" (Windsurf Devstral protocol vs DSH ctx.llm local model)
 * is a pluggable adapter with prepare()/stream(), enabling A→B auto-fallback
 * (option C of the plugin design):
 *   brain: 'auto'      — Windsurf when a key is available, else local model
 *   brain: 'windsurf'  — Windsurf only (error when unavailable)
 *   brain: 'llm'       — DSH deployment model only
 */

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { ToolExecutor } from "./executor.js";
import {
  getRepoMap,
  _parseAnswer,
  FINAL_FORCE_ANSWER,
  buildWindsurfPrompt,
  buildLlmPrompt,
} from "./shared.js";
import {
  buildCacheKey,
  getCachedResult,
  setCachedResult,
  computeMtimeHash,
} from "./cache.js";
import { salvageSearchEvidence } from "./repair.js";
import { windsurfBrain, classifyError, FastContextError, WINDSURF_MODEL } from "./windsurf.js";
import { llmBrain } from "./brain-llm.js";
import { formatSearchResult } from "./content-embed.js";

// ─── Message Trim ──────────────────────────────────────────

/**
 * Trim accumulated messages to reduce payload size for retry.
 * Keeps: system prompt (index 0), user query (index 1), and last 2 messages.
 * Inserts a bridge note so the AI knows context was truncated.
 * @param {Array} messages
 * @returns {boolean} true if messages were actually trimmed
 */
function _trimMessages(messages) {
  if (messages.length <= 4) return false;
  const head = messages.slice(0, 2);
  const tail = messages.slice(-2);
  messages.length = 0;
  messages.push(
    ...head,
    { role: 1, content: "[Prior search rounds omitted to reduce payload. Provide your best answer based on available context.]" },
    ...tail,
  );
  return true;
}

// ─── Brain Selection ───────────────────────────────────────

/**
 * Resolve the active brain.
 * @param {{ brain?: string, ctx?: Object, apiKey?: string|null }} opts
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ brain: Object, state: Object, modelId: string, fallback?: string }>}
 */
async function selectBrain(opts = {}, signal) {
  const requested = opts.brain || "auto";

  if (requested === "llm") {
    const state = await llmBrain.prepare(opts.ctx, {});
    return { brain: llmBrain, state, modelId: `local:${state.provider}/${state.model}` };
  }

  // windsurf and auto both try Windsurf first
  try {
    const state = await windsurfBrain.prepare({ apiKey: opts.apiKey || null }, signal);
    if (requested === "windsurf") {
      return { brain: windsurfBrain, state, modelId: WINDSURF_MODEL };
    }
    // auto with a working Windsurf brain — but the local model is still the
    // fallback at stream time (handled by search()).
    return { brain: windsurfBrain, state, modelId: WINDSURF_MODEL, auto: true };
  } catch (e) {
    if (requested === "windsurf") {
      throw e;
    }
    // auto → fall back to the local model
    const state = await llmBrain.prepare(opts.ctx, {});
    return {
      brain: llmBrain,
      state,
      modelId: `local:${state.provider}/${state.model}`,
      fallback: `windsurf unavailable (${e?.message || e}); using local model`,
    };
  }
}

// ─── Core Search ───────────────────────────────────────────

/**
 * Execute Fast Context search.
 *
 * @param {Object} opts
 * @param {string} opts.query - Natural language search query
 * @param {string} opts.projectRoot - Project root directory
 * @param {Object} [opts.ctx] - DSH plugin ctx (required for brain 'llm'/'auto')
 * @param {string} [opts.brain='auto'] - 'auto' | 'windsurf' | 'llm'
 * @param {string} [opts.apiKey] - Windsurf API key (auto-discovered if not set)
 * @param {number} [opts.maxTurns=3] - Search rounds
 * @param {number} [opts.maxCommands=8] - Max commands per round
 * @param {number} [opts.maxResults=10] - Max number of files to return
 * @param {number} [opts.treeDepth=3] - Directory tree depth for repo map (1-6, auto fallback)
 * @param {number} [opts.timeoutMs=30000] - Per-turn timeout for streaming requests
 * @param {string[]} [opts.excludePaths=[]] - Patterns to exclude from tree
 * @param {function} [opts.onProgress] - Progress callback
 * @param {AbortSignal} [opts.signal] - Cancellation (agent interrupt)
 * @returns {Promise<Object>}
 */
export async function search({
  query,
  projectRoot,
  ctx = null,
  brain = "auto",
  apiKey = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  onProgress = null,
  signal = null,
}) {
  const log = (msg) => onProgress?.(msg);
  projectRoot = resolve(projectRoot);

  // Resolve the active brain (Windsurf first for auto/windsurf; local model for llm/fallback)
  let selection;
  try {
    selection = await selectBrain({ brain, ctx, apiKey }, signal);
  } catch (e) {
    return {
      files: [],
      error: `${e instanceof FastContextError ? e.code : "ERROR"}: ${e.message}`,
      _meta: { errorCode: e instanceof FastContextError ? e.code : "ERROR" },
    };
  }
  const active = { brain: selection.brain, state: selection.state, fallback: selection.fallback || null };
  if (active.fallback) log(active.fallback);

  // Cache hits must avoid auth/network and repo-map work. The recursive mtime
  // fingerprint includes file paths, sizes, and mtimes, so it also invalidates
  // when the searchable tree changes.
  const mtimeHash = computeMtimeHash(projectRoot, excludePaths);
  const cacheKey = buildCacheKey({ query, model: selection.modelId, maxTurns, maxResults, treeDepth, mtimeHash, excludePaths });
  const cached = getCachedResult(cacheKey);
  if (cached) {
    log("Cache hit");
    return { ...cached, _meta: { ...cached._meta, cache_hit: true } };
  }

  const systemPrompt = active.brain.kind === "windsurf"
    ? buildWindsurfPrompt(maxTurns, maxCommands, maxResults)
    : buildLlmPrompt(maxTurns, maxCommands, maxResults);

  const executor = new ToolExecutor(projectRoot, { signal });
  const { tree: repoMap, depth: actualDepth, sizeBytes: treeSizeBytes, fellBack } = getRepoMap(projectRoot, treeDepth, excludePaths);
  log(`Repo map: tree -L ${actualDepth} (${(treeSizeBytes / 1024).toFixed(1)}KB)${fellBack ? ` [fell back from L=${treeDepth}]` : ""}`);

  const userContent = `Problem Statement: ${query}\n\nRepo Map (tree -L ${actualDepth} /codebase):\n\`\`\`text\n${repoMap}\n\`\`\``;

  const messages = [
    { role: 5, content: systemPrompt },
    { role: 1, content: userContent },
  ];

  // Total API calls = maxTurns + 1 (last round for answer)
  const totalApiCalls = maxTurns + 1;
  let compensatedTurns = 0; // compensated turn count
  const MAX_COMPENSATIONS = 2; // max compensations to prevent infinite loops
  let forceAnswerInjected = false;

  const turnOpts = () => ({
    maxTurns,
    maxCommands,
    maxResults,
    timeoutMs,
    signal,
    ...(active.brain.kind === "llm" ? { system: systemPrompt } : {}),
  });

  for (let turn = 0; turn < totalApiCalls + compensatedTurns; turn++) {
    if (signal?.aborted) {
      return { files: [], error: "aborted", _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot } };
    }
    log(`Turn ${turn + 1}/${totalApiCalls}`);

    let text;
    let toolCalls;
    try {
      const out = await active.brain.stream(active.state, messages, turnOpts());
      text = out.text;
      toolCalls = out.toolCalls;
    } catch (e) {
      const errCode = e instanceof FastContextError ? e.code : (active.brain.kind === "windsurf" ? classifyError(e).code : "SERVER_ERROR");
      const baseMeta = { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot, errorCode: errCode };

      // Auto-retry with trimmed context on payload/timeout errors
      if ((errCode === "PAYLOAD_TOO_LARGE" || errCode === "TIMEOUT") && messages.length > 4) {
        log(`${errCode} on turn ${turn + 1}: trimming context and retrying...`);
        _trimMessages(messages);
        try {
          const out = await active.brain.stream(active.state, messages, turnOpts());
          text = out.text;
          toolCalls = out.toolCalls;
        } catch (retryErr) {
          const retryCode = retryErr instanceof FastContextError ? retryErr.code : "UNKNOWN";
          return {
            files: [],
            error: `${retryCode}: ${retryErr.message} (retry after context trim also failed)`,
            _meta: { ...baseMeta, errorCode: retryCode, contextTrimmed: true },
          };
        }
      } else {
        return {
          files: [],
          error: `${errCode}: ${e.message}`,
          _meta: baseMeta,
        };
      }
    }

    // Normalize: pick the answer call first, else the restricted_exec call
    let toolInfo = null;
    const answerCall = toolCalls.find((c) => c && c.name === "answer");
    const execCall = toolCalls.find((c) => c && c.name === "restricted_exec");
    if (answerCall) toolInfo = ["answer", answerCall.args || {}];
    else if (execCall) toolInfo = ["restricted_exec", execCall.args || {}];

    if (toolInfo === null) {
      if (text && text.startsWith("[Error]")) {
        return { files: [], error: text, _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot } };
      }
      const salvaged = salvageSearchEvidence(text, projectRoot);
      if (salvaged.files.length || salvaged.rg_patterns.length) {
        return {
          ...salvaged,
          raw_response: text,
          _meta: {
            treeDepth: actualDepth,
            treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
            fellBack,
            projectRoot,
            salvaged_response: true,
            ...(active.fallback ? { fallback: active.fallback } : {}),
          },
        };
      }
      return { files: [], raw_response: text, _meta: { treeDepth: actualDepth, treeSizeKB: +(treeSizeBytes / 1024).toFixed(1), fellBack, projectRoot, ...(active.fallback ? { fallback: active.fallback } : {}) } };
    }

    const [toolName, toolArgs] = toolInfo;

    if (toolName === "answer") {
      const answerXml = toolArgs.answer || "";
      log("Received final answer");
      const result = _parseAnswer(answerXml, projectRoot);
      result.rg_patterns = [...new Set(executor.collectedRgPatterns)];
      result._meta = {
        treeDepth: actualDepth,
        treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
        fellBack,
        cache_hit: false,
        projectRoot,
        brain: active.brain.kind,
        ...(active.fallback ? { fallback: active.fallback } : {}),
      };
      // Skip caching empty results so retries can re-search next time
      if (result.files?.length > 0) {
        setCachedResult(cacheKey, result);
      }
      return result;
    }

    if (toolName === "restricted_exec") {
      const callId = randomUUID();
      const argsJson = JSON.stringify(toolArgs);

      const cmds = Object.keys(toolArgs).filter((k) => k.startsWith("command"));
      log(`Executing ${cmds.length} local commands`);

      const results = await executor.execToolCallAsync(toolArgs);

      // Detect all commands invalid → don't count as effective turn
      const validCommands = cmds.filter((k) => {
        const c = toolArgs[k];
        return c && c.type; // at least has a type field
      });

      if (validCommands.length === 0 && compensatedTurns < MAX_COMPENSATIONS) {
        compensatedTurns++; // compensate: this turn doesn't count as effective
        log(`Turn compensation: no valid commands, extending search by 1 turn (${compensatedTurns}/${MAX_COMPENSATIONS})`);
      } else if (validCommands.length === 0) {
        log(`Turn compensation skipped: max compensations (${MAX_COMPENSATIONS}) reached, forcing turn advance`);
      }

      messages.push({
        role: 2,
        content: text || "",
        tool_call_id: callId,
        tool_name: "restricted_exec",
        tool_args_json: argsJson,
      });
      messages.push({ role: 4, content: results, ref_call_id: callId });

      // Inject force-answer after last effective search round
      // Use effective turn count (excluding compensated turns) to avoid premature injection
      const effectiveTurn = turn - compensatedTurns;
      if (effectiveTurn >= maxTurns - 1 && !forceAnswerInjected) {
        messages.push({ role: 1, content: FINAL_FORCE_ANSWER });
        forceAnswerInjected = true;
        log("Injected force-answer prompt");
      }
    }
  }

  const conversationText = messages
    .flatMap((message) => [message.content, message.tool_args_json])
    .filter(Boolean)
    .join("\n");
  const salvaged = salvageSearchEvidence(conversationText, projectRoot);
  if (salvaged.files.length || salvaged.rg_patterns.length) {
    return {
      ...salvaged,
      _meta: {
        treeDepth: actualDepth,
        treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
        fellBack,
        projectRoot,
        salvaged_response: true,
        brain: active.brain.kind,
        ...(active.fallback ? { fallback: active.fallback } : {}),
      },
    };
  }

  return {
    files: [],
    error: "Max turns reached without getting an answer",
    rg_patterns: [...new Set(executor.collectedRgPatterns)],
    _meta: {
      treeDepth: actualDepth,
      treeSizeKB: +(treeSizeBytes / 1024).toFixed(1),
      fellBack,
      projectRoot,
      brain: active.brain.kind,
      ...(active.fallback ? { fallback: active.fallback } : {}),
    },
  };
}

/**
 * Search and return formatted result suitable for a tool response.
 *
 * @param {Object} opts
 * @param {string} opts.query
 * @param {string} opts.projectRoot
 * @param {Object} [opts.ctx] - DSH plugin ctx (for brain 'llm'/'auto')
 * @param {string} [opts.brain='auto']
 * @param {string} [opts.apiKey]
 * @param {number} [opts.maxTurns=3]
 * @param {number} [opts.maxCommands=8]
 * @param {number} [opts.maxResults=10]
 * @param {number} [opts.treeDepth=3]
 * @param {number} [opts.timeoutMs=30000]
 * @param {string[]} [opts.excludePaths=[]]
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.includeContent=true]
 *   Embed the code of the returned line ranges (budget-limited, see
 *   ./content-embed.js). false yields a path+range list only.
 * @returns {Promise<string>}
 */
export async function searchWithContent({
  query,
  projectRoot,
  ctx = null,
  brain = "auto",
  apiKey = null,
  maxTurns = 3,
  maxCommands = 8,
  maxResults = 10,
  treeDepth = 3,
  timeoutMs = 30000,
  excludePaths = [],
  signal = null,
  includeContent = true,
}) {
  const result = await search({ query, projectRoot, ctx, brain, apiKey, maxTurns, maxCommands, maxResults, treeDepth, timeoutMs, excludePaths, signal });

  if (result.error) {
    const meta = result._meta;
    let errMsg = `Error: ${result.error}`;
    if (meta) {
      errMsg += `\n\n[diagnostic] error_type=${meta.errorCode || "unknown"}, tree_depth_used=${meta.treeDepth}, tree_size=${meta.treeSizeKB}KB`;
      if (meta.fellBack) errMsg += ` (auto fell back from requested depth)`;
      if (meta.contextTrimmed) errMsg += `, context_trimmed=true`;
      if (meta.projectRoot) errMsg += `\n[diagnostic] project_path=${meta.projectRoot}`;
      errMsg += `\n[config] max_turns=${maxTurns}, max_results=${maxResults}, max_commands=${maxCommands}, timeout_ms=${timeoutMs}, brain=${meta.brain || brain}`;
      if (excludePaths.length) errMsg += `, exclude_paths=[${excludePaths.join(", ")}]`;
      if (meta.fallback) errMsg += `\n[fallback] ${meta.fallback}`;
      // Targeted hints based on error type
      if (meta.errorCode === "PAYLOAD_TOO_LARGE" || meta.errorCode === "TIMEOUT") {
        errMsg += `\n[hint] Payload/timeout error. Try: reduce tree_depth, reduce max_turns, add exclude_paths, or narrow project_path to a subdirectory.`;
      } else if (meta.errorCode === "AUTH_ERROR") {
        errMsg += `\n[hint] Authentication error. The API key may be expired or revoked. Set a fresh WINDSURF_API_KEY, or use brain 'llm' for the local model.`;
      } else if (meta.errorCode === "RATE_LIMITED") {
        errMsg += `\n[hint] Rate limited. Wait a moment and retry.`;
      } else {
        errMsg += `\n[hint] If the error is payload-related, try a lower tree_depth value or add exclude_paths.`;
      }
    }
    return errMsg;
  }

  const files = result.files || [];
  if (!files.length) {
    const raw = result.raw_response || "";
    return raw ? `No relevant files found.\n\nRaw response:\n${raw}` : "No relevant files found.";
  }

  // The result IS the context: two independent sections — the explicit file
  // list (path + ranges) first, then each file's full range code
  // (budget-limited, fresh from disk even on a cache hit). No grep-keyword
  // or config lines — they cost tokens without adding signal. Diagnostics
  // stay on the error path only.
  return formatSearchResult(files, { includeContent });
}
