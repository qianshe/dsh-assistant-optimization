// dsh-assistant-optimization — Host module.
//
// Registers one loopback-only route that rewrites a composer draft with the
// deployment's current default model. It is a single non-session chat request:
// no Session is created, nothing is written to any session log, and no tools
// are offered to the model.
//
// Prompt design follows tiller/apps/deck prompt-enhancer: the draft is the
// source of truth, a razor rule picks the smallest rewrite, the task mode
// survives, and project/session context is PRIVATE REFERENCE used only to
// resolve ambiguity — never copied into the output.
//
// Instruction fallback: the Client reads instruction structure off the live
// conversation snapshot, but the conversation window can scroll that context
// out, and a project may carry no instruction file at all. When the Client
// reports no instructions, this half reads one itself in preference order —
// AGENTS.md, then CLAUDE.md, then README.md — from the session cwd.
//
// Services used (all optional — the route reports a clear error when absent):
//   ctx.webServer         route registration
//   ctx.llm               stream(GenerateOptions)
//   ctx.agentDefaultModel currentSelection()
//   ctx.fs                resolve + stat + readText for the fallback read
//   ctx.tools             context_search registration (key-gated)
//   ctx.systemPrompt      the tool's minimal guidance section (key-gated)

import { applyFastContextTool } from './fast-context/tool.js';
import { resolveWindsurfKey, writeKeyFile, clearKeyFile, keyFilePath } from './fast-context/key-source.js';

const ROUTE_PATH = '/api/dsao/prompt-enhance';
const KEY_ROUTE_PATH = '/api/dsao/windsurf-key';
const MAX_INPUT_CHARS = 8000;
const TIMEOUT_MS = 60000;
// Per-part ceilings; the Client already caps, this is the Host-side backstop.
const REF_CAPS = { project: 300, instructions: 1200, summary: 900, history: 900, replies: 800 };
const SEARCH_TOOL_NAME = 'context_search';
// Per-search budget inside the 60 s route cap: enough for a Windsurf brain
// round (typically 5-20 s) while still leaving the final rewrite its own time.
const TOOL_BUDGET_MS = 35000;

/**
 * Fallback instruction candidates in preference order. AGENTS.md and CLAUDE.md
 * are agent instructions; README.md is a last resort that describes the project
 * for humans, which is still better than no project context at all.
 */
const FALLBACK_FILES = ['AGENTS.md', 'CLAUDE.md', 'README.md'];
const FALLBACK_MAX_BYTES = 64 * 1024;
const FALLBACK_SIGNALS = 14;

// The enhancer contract, kept close to tiller/apps/deck's prompt-enhancer: the
// draft is the source of truth, a razor rule picks the smallest rewrite, the
// task mode survives, and project/session context is private reference used
// only to resolve ambiguity.
//
// One rule is ours: resolve a referent instead of deleting it. An early version
// answered a vague draft with pure copy-editing and dropped the demonstrative
// that needed resolving. The companion failure — a rewrite that pasted values
// found in the reference — is handled where it belongs, by not putting agent
// replies into the reference at all (see readHistory in the client half), so no
// rule has to police it.
const SYSTEM_PROMPT = [
  '你是一个 coding-agent 提示词增强器。',
  'Core rule: the user draft is the source of truth. 只强化用户真实意图，不改变目标，不扩大范围，不替用户做未要求的技术决策。Use the draft’s own language.',
  'Razor rule: when several rewrites would work, choose the one with the fewest assumptions, smallest scope, shortest useful wording, and most direct verification. 删除不影响执行的背景、形容词和模板段落。',
  'Resolve ambiguity, do not delete it. A vague draft is NOT already actionable, and pure copy-editing is a failed enhancement while the agent is still left guessing. When the draft points at something with a demonstrative or an unnamed noun ("那个预算", "这个 bug", "the config"), name WHICH component, file, or feature it means; when it cannot be resolved, keep the pointer and ask the agent to identify it. Name things, never invent their values — if being specific would need a number or literal the draft lacks, ask the agent to look it up. Only a draft that is already specific and unambiguous deserves light edits alone.',
  'Internal workflow, applied silently: Keep explicit intent and constraints; Drop filler and unsupported context; Inspect by asking the agent to read the relevant files when repository facts are needed; Propose lightweight options for open-ended requests; Verify with the smallest useful check; Defer high-risk or irreversible actions to user confirmation.',
  'Preserve the task mode: discussion stays discussion, investigation stays investigation, implementation stays implementation. Do not turn planning or discussion into implementation unless the draft explicitly asks to implement. A discussion draft still benefits from a resolved subject — sharpen WHAT is being discussed without turning it into a task.',
  'Private reference handling: the project identity, instruction outline, session summary, recent user asks, and recent agent results below are NON-OUTPUT context, ordered broadest to most specific. Use them only to resolve what the draft refers to, the constraints already in force, and the work already done. The outline lists rule NAMES, not full rules. Never copy, summarize, quote, or restate any part of it, and never mention that you received it.',
  'Do not pretend you inspected the repository. You may name a component, file, or API that appears in the draft or the reference, but naming is the limit. When repository facts are needed, ask the agent to inspect the relevant files.',
  'Do not add constraints, features, dependencies, abstractions, or refactors unless they are explicit in the draft or needed to prevent scope, safety, or data-risk problems. 项目规则已经对 agent 生效，不要把它们重写进提示词。',
  'Use sections sparingly: prefer none for short drafts, at most two for ordinary tasks. Add Goal / Success Criteria / Verification only when headings genuinely make the prompt clearer, and never for a pure discussion or investigation draft.',
  'The result must be directly usable as the user’s next message. Never prefix it with meta commentary such as "以下是增强后的提示词" or "Here is the enhanced prompt".',
  'Output ONLY the rewritten prompt: no explanation, no confirmation, no caveats, no Markdown code fences, no surrounding quotes.',
].join('\n\n');

// Appended to the system prompt only when context_search is actually
// available: proactive-use guidance plus the inspection boundary that a live
// search genuinely lifts.
const TOOL_POLICY = [
  'This call provides the context_search tool: a natural-language code locator that returns file paths with line ranges, never file content. Use it proactively: whenever the draft points at project code — a component, feature, or file — that neither the draft nor the private reference names, search first so the rewritten prompt can name the real target; never guess paths or file names. If the draft is already specific, skip the search: it is a means to resolve references, not a ritual. One round of searching at most.',
  'While this call is active the "do not pretend you inspected" rule above is lifted for what the search returns: you may name the files and paths it found, with their line ranges, and ask the agent to read them. You may not paste, quote, or restate code or values from the results, and everything the search did not return stays out of bounds — when deeper facts are needed, ask the agent to inspect the relevant files.',
  'The rewritten prompt is the only deliverable and must stand on its own: complete and directly usable as the user\u2019s next message, without the user answering anything first.',
].join('\n\n');

function refText(value, max) {
  if (typeof value !== 'string') return '';
  const out = value.trim();
  if (out === '') return '';
  return out.length > max ? out.slice(0, max) + '…' : out;
}

/**
 * Reduce a Markdown instruction file to its structure signals: headings plus
 * each rule's name. Mirrors the Client's extraction so a fallback read produces
 * the same shape the snapshot path does.
 */
function structureSignals(text, max) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let fenced = false;
  for (const raw of lines) {
    if (out.length >= max) break;
    const line = raw.trim();
    if (line === '') continue;
    if (/^```/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;

    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading !== null) {
      out.push(heading[1].replace(/\s+/g, ' ').trim());
      continue;
    }

    const bullet = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
    if (bullet === null) continue;
    const body = bullet[1]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    const named = /^([^:：—]{2,60})\s*[:：—]/.exec(body);
    const signal = named !== null ? named[1].trim() : body;
    if (signal !== '') out.push(signal);
  }
  return out;
}

/**
 * Read the first available instruction file under `cwd` and reduce it to
 * structure signals. Used only when the Client reported no instructions.
 * @returns `{ text, source }`, or undefined when nothing readable exists.
 */
async function fallbackInstructions(fs, cwd, signal) {
  if (fs === undefined || typeof cwd !== 'string' || cwd.trim() === '') return undefined;
  for (const name of FALLBACK_FILES) {
    try {
      const target = await fs.resolve(name, { cwd, signal });
      const info = await fs.stat(target, signal);
      // undefined = absent. `type` must be checked too: a directory named
      // AGENTS.md would otherwise reach readText and throw (FsInfo.type is the
      // documented way to reject directories before reading).
      if (info === undefined || info.type !== 'file') continue;
      const size = typeof info.size === 'number' ? info.size : 0;
      if (size > FALLBACK_MAX_BYTES) continue;
      const content = await fs.readText(target, signal);
      const signals = structureSignals(content, FALLBACK_SIGNALS);
      if (signals.length === 0) continue;
      return { text: `${name}: ${signals.join('; ')}`, source: name };
    } catch {
      // A missing or unreadable candidate is ordinary; try the next one.
      continue;
    }
  }
  return undefined;
}

/** Ordered private reference: broadest → most specific. */
function buildUserMessage(draft, ref) {
  const lines = ['Rewrite the draft below into a concise, precise prompt for a coding agent.', ''];
  const blocks = [];
  if (ref.project !== '') blocks.push('Project: ' + ref.project);
  if (ref.instructions !== '') {
    blocks.push('Project instruction outline (rule names only, already in force for the agent):\n' + ref.instructions);
  }
  if (ref.summary !== '') blocks.push('Earlier session summary:\n' + ref.summary);
  if (ref.history !== '') blocks.push('Recent user asks:\n' + ref.history);
  if (ref.replies !== '') blocks.push('Recent agent results:\n' + ref.replies);

  if (blocks.length > 0) {
    lines.push('<private_reference>');
    lines.push(blocks.join('\n\n'));
    lines.push('</private_reference>');
    lines.push('');
    lines.push('Treat the private reference as non-output context, ordered broadest to most specific: use it only to resolve what the draft refers to, the constraints already in force, and the work already done. Do not copy it into the output, do not restate it before the prompt, and ignore it when it is not needed.');
    lines.push('');
  }

  lines.push('<user_draft>');
  lines.push(draft);
  lines.push('</user_draft>');
  lines.push('');
  lines.push('Return only the rewritten prompt, in the same language as the draft.');
  return lines.join('\n');
}

/**
 * A FinishReason is an OBJECT ({ kind, failure? }), never a bare string, and
 * `max-tokens` (not `length`) is the truncation kind.
 * @returns a readable problem, or null when the call completed acceptably.
 */
function finishProblem(reason) {
  const kind = reason !== null && typeof reason === 'object' && typeof reason.kind === 'string'
    ? reason.kind
    : String(reason);
  // 'tool-calls' is a clean exit: the model stopped to request a tool.
  if (kind === 'stop' || kind === 'max-tokens' || kind === 'tool-calls') return null;
  const failure = reason !== null && typeof reason === 'object' ? reason.failure : undefined;
  if (failure !== null && typeof failure === 'object') {
    const message = typeof failure.message === 'string' ? failure.message : '';
    const code = typeof failure.code === 'string' ? failure.code : '';
    const status = typeof failure.status === 'number' ? ' (HTTP ' + failure.status + ')' : '';
    if (message !== '') return kind + ': ' + message + status;
    if (code !== '') return kind + ': ' + code + status;
  }
  return kind;
}

/** Strip a meta preface or code fence the model may add despite the contract. */
function normalize(raw) {
  let out = raw.trim();
  const fenced = out.match(/^```(?:[a-zA-Z]+)?\s*\n([\s\S]*?)\n```$/);
  if (fenced !== null) out = fenced[1].trim();
  out = out.replace(/^(?:Here(?:'s| is)\s+(?:the\s+)?(?:enhanced|rewritten)\s+prompt|(?:优化|增强|改写)后的?提示词(?:如下)?|以下是增强后的提示词)\s*[:：]?\s*/i, '');
  return out.trim();
}

/** Loopback fence: this route reaches the model, so remote callers are refused. */
function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (typeof addr !== 'string') return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

let enhanceSeq = 0;
/** Unique synthetic message id for the enhance conversation (never a session message). */
function enhanceMsgId(prefix) {
  enhanceSeq += 1;
  return `${prefix}-${Date.now()}-${enhanceSeq}`;
}

/**
 * One model pass: stream to the finish, collecting the visible text, the
 * complete tool-call blocks, and the finish problem. `tools` is omitted
 * from the request when undefined.
 */
async function modelPass(llm, selection, system, messages, tools, signal) {
  const parts = [];
  const toolCalls = [];
  let problem = null;
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    system,
    messages,
    ...(tools === undefined ? {} : { tools }),
    temperature: 0.2,
    signal,
  });
  // stream() normalizes adapter failures into a terminal finish chunk, so the
  // finish reason — an object — is the failure signal to inspect.
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') parts.push(chunk.text);
    else if (chunk.type === 'block-end' && chunk.block !== undefined && chunk.block.type === 'tool-call') toolCalls.push(chunk.block);
    else if (chunk.type === 'finish') problem = finishProblem(chunk.reason);
  }
  return { text: parts.join(''), toolCalls, problem };
}

/**
 * Run one search round: execute the model's tool calls against the registry
 * in parallel and return one tool-result message per call. Every failure
 * mode — unknown tool, malformed arguments, execution error, budget
 * timeout — degrades to an error result the model can work around; the
 * round itself never throws.
 */
async function searchRound(tools, calls, cwd, signal) {
  // The request may already be dead (an abort mid tool-call stream still
  // delivers the blocks): don't spend search quota for a caller who left.
  if (signal !== undefined && signal.aborted === true) {
    return calls.map((call) => ({
      id: enhanceMsgId('dsao-enhance-tr'),
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'request aborted before the search ran' }], isError: true }],
      source: { kind: 'tool', callId: call.id },
    }));
  }
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), TOOL_BUDGET_MS);
  const onAbort = () => budget.abort();
  if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.all(calls.map(async (call) => {
      let isError = false;
      let content;
      try {
        const def = tools.get(call.name);
        if (def === undefined) {
          isError = true;
          content = [{ type: 'text', text: `the tool ${call.name} is not available in this call` }];
        } else {
          let args;
          try {
            args = JSON.parse(call.arguments === '' ? '{}' : call.arguments);
          } catch {
            args = {};
          }
          if (
            call.name === SEARCH_TOOL_NAME &&
            args !== null && typeof args === 'object' &&
            typeof cwd === 'string' && cwd.trim() !== ''
          ) {
            // Pin the search to the session workspace: the model does not
            // know the cwd and must not be trusted to guess it.
            args.project_path = cwd;
          }
          const result = await tools.execute({
            callId: call.id,
            name: call.name,
            arguments: args,
            signal: budget.signal,
          });
          isError = result.isError === true;
          content = result.content;
        }
      } catch (error) {
        isError = true;
        content = [{ type: 'text', text: `search failed: ${error instanceof Error ? error.message : String(error)}` }];
      }
      return {
        id: enhanceMsgId('dsao-enhance-tr'),
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: call.id, content, isError }],
        source: { kind: 'tool', callId: call.id },
      };
    }));
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The enhance call. Without a search tool this is the plain one-shot call;
 * with one, at most one search round precedes a forced text-only final
 * answer. The rewritten prompt is the only deliverable, so every
 * tool-side failure degrades instead of surfacing: a provider failure of
 * the tool-carrying call retries once without tools, and tool execution
 * errors come back to the model as error results. Only a total failure
 * with no text at all surfaces as a problem.
 * @returns the rewritten text, the finish problem (null when clean), and
 *   how many tool calls were executed.
 */
async function enhance(llm, selection, userText, signal, opts) {
  const hasTool = opts !== undefined && opts.toolSchema !== undefined;
  const system = hasTool ? SYSTEM_PROMPT + '\n\n' + TOOL_POLICY : SYSTEM_PROMPT;
  const tools = hasTool ? [opts.toolSchema] : undefined;
  const messages = [{
    id: enhanceMsgId('dsao-enhance'),
    role: 'user',
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }];

  let pass = await modelPass(llm, selection, system, messages, tools, signal);
  let searches = 0;

  if (pass.toolCalls.length > 0) {
    // The model asked to look things up: run the one search round, then
    // force the final answer with no tools offered.
    searches = pass.toolCalls.length;
    const results = await searchRound(opts.tools, pass.toolCalls, opts.cwd, signal);
    messages.push({
      id: enhanceMsgId('dsao-enhance-asst'),
      role: 'assistant',
      content: pass.toolCalls,
      source: { kind: 'model', provider: selection.provider, model: selection.model },
    }, ...results);
    pass = await modelPass(llm, selection, system, messages, undefined, signal);
  } else if (pass.problem !== null && pass.text === '' && tools !== undefined) {
    // The tool-carrying call died before producing anything — most likely a
    // model that rejects tool schemas. Retry once, plain.
    pass = await modelPass(llm, selection, system, messages, undefined, signal);
  }

  return { text: normalize(pass.text), problem: pass.problem, searches };
}

/**
 * `webServer` is a HARD dependency, declared through `inject` rather than probed
 * with ctx.get.
 *
 * Row order in the composed tree does not make a service available: this plugin
 * sits well after the webserver row, yet ctx.get('webServer') still returned
 * undefined at apply time, so the route was silently never registered and every
 * request fell through to the webserver's 404 fallback. Declaring the injection
 * makes Cordis hold the plugin in waiting until the service exists, which is how
 * the other route-owning plugins in this profile do it.
 *
 * `llm`, `agentDefaultModel`, and `fs` stay optional on purpose: the route must
 * answer with a readable error when they are absent rather than fail to mount,
 * and `fs` only backs the fallback read.
 */
const inject = ['webServer'];

/**
 * Manual key entry route: GET reports where a key came from (never its value),
 * PUT stores one, DELETE removes the stored file. Loopback-only, like the
 * enhance route — it handles a bearer credential.
 *
 * Registering or unregistering the tool takes effect on the next composition,
 * so the response says so instead of pretending it is live.
 */
function keyRoute(ctx) {
  return {
    kind: 'exact',
    path: KEY_ROUTE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' });
        return;
      }

      if (req.method === 'GET') {
        const resolved = await resolveWindsurfKey();
        writeJson(res, 200, {
          present: resolved.key !== '',
          source: resolved.source,
          detail: resolved.detail,
          keyFile: keyFilePath(),
          // A fingerprint lets the UI show WHICH key without exposing it.
          preview: resolved.key === '' ? '' : `${resolved.key.slice(0, 4)}…${resolved.key.slice(-4)}`,
        });
        return;
      }

      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readJsonBody(req, 8192);
        const key = body !== undefined && typeof body.key === 'string' ? body.key.trim() : '';
        if (key === '') {
          writeJson(res, 400, { error: 'empty key' });
          return;
        }
        try {
          const path = writeKeyFile(key);
          writeJson(res, 200, { saved: true, keyFile: path, note: 'takes effect after the next restart' });
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      if (req.method === 'DELETE') {
        try {
          const removed = clearKeyFile();
          writeJson(res, 200, { removed, keyFile: keyFilePath(), note: 'takes effect after the next restart' });
        } catch (error) {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      writeJson(res, 405, { error: `method not allowed: ${req.method}` });
    },
  };
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register(keyRoute(ctx)), 'dsao: windsurf-key route');

  // Semantic search tool. Gated on a resolvable Windsurf key: with none, the
  // tool and its prompt section are both absent — the model is never told
  // about a capability it cannot use. Failure here must not unmount the rest.
  applyFastContextTool(ctx).then(
    (result) => {
      if (result.registered) {
        ctx.logger?.info?.(`context_search registered (key source: ${result.source})`);
      } else {
        ctx.logger?.info?.(`context_search disabled: ${result.detail}`);
      }
    },
    (error) => {
      ctx.logger?.warn?.(`context_search registration failed: ${error instanceof Error ? error.message : String(error)}`);
    },
  );

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: `method not allowed: ${req.method}` });
        return;
      }

      const llm = ctx.get('llm');
      const defaultModel = ctx.get('agentDefaultModel');
      if (llm === undefined || defaultModel === undefined) {
        writeJson(res, 503, { error: 'prompt enhance needs the llm and agentDefaultModel services' });
        return;
      }

      const body = await readJsonBody(req, (MAX_INPUT_CHARS + 6000) * 4);
      const text = body !== undefined && typeof body.text === 'string' ? body.text : '';
      if (text.trim() === '') {
        writeJson(res, 400, { error: 'empty draft' });
        return;
      }
      if (text.length > MAX_INPUT_CHARS) {
        writeJson(res, 413, { error: `draft exceeds ${MAX_INPUT_CHARS} characters` });
        return;
      }

      let selection;
      try {
        selection = defaultModel.currentSelection();
      } catch (error) {
        writeJson(res, 503, { error: `no model selected: ${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      if (selection === undefined || typeof selection.provider !== 'string' || typeof selection.model !== 'string') {
        writeJson(res, 503, { error: 'no model selected' });
        return;
      }

      // The optional search tool: present only when a key resolved at boot,
      // so the enhance call degrades to the plain one-shot without one.
      const tools = ctx.get('tools');
      const searchDef = tools !== undefined && typeof tools.get === 'function'
        ? tools.get(SEARCH_TOOL_NAME)
        : undefined;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const ref = {
          project: refText(body.project, REF_CAPS.project),
          instructions: refText(body.instructions, REF_CAPS.instructions),
          summary: refText(body.summary, REF_CAPS.summary),
          history: refText(body.history, REF_CAPS.history),
          replies: refText(body.replies, REF_CAPS.replies),
        };

        // The snapshot path is preferred; this only covers a scrolled-out
        // instruction context or a project with no instruction file.
        let instructionSource = ref.instructions === '' ? 'none' : 'session';
        if (ref.instructions === '') {
          const fallback = await fallbackInstructions(ctx.get('fs'), body.cwd, controller.signal);
          if (fallback !== undefined) {
            ref.instructions = refText(fallback.text, REF_CAPS.instructions);
            instructionSource = fallback.source;
          }
        }

        const result = await enhance(llm, selection, buildUserMessage(text, ref), controller.signal,
          searchDef === undefined
            ? undefined
            : {
                toolSchema: {
                  name: searchDef.name,
                  description: searchDef.description,
                  parameters: searchDef.parameters,
                },
                tools,
                cwd: typeof body.cwd === 'string' ? body.cwd : '',
              });
        // Diagnostic: what the model actually received, so an unhelpful rewrite
        // can be attributed to thin context rather than guessed at.
        const refBytes = {
          project: ref.project.length,
          instructions: ref.instructions.length,
          summary: ref.summary.length,
          history: ref.history.length,
          replies: ref.replies.length,
          instructionSource,
        };

        // Text already collected wins over a late failure: a truncated but
        // usable rewrite beats an error with an untouched draft.
        if (result.text !== '') {
          writeJson(res, 200, {
            text: result.text,
            provider: selection.provider,
            model: selection.model,
            refBytes,
            searches: result.searches,
          });
          return;
        }
        if (result.problem !== null) {
          writeJson(res, 502, { error: `model call did not complete: ${result.problem}`, refBytes, searches: result.searches });
          return;
        }
        writeJson(res, 502, { error: 'the model returned no text', refBytes, searches: result.searches });
      } catch (error) {
        writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
      }
    },
  }), 'dsao: prompt-enhance route');
}

export { apply, inject };
