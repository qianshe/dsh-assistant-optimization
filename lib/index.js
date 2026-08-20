// dsh-assistant-optimization — Host module.
//
// Registers one loopback-only route that rewrites a composer draft with the
// deployment's current default model. It is a single non-session chat request:
// no Session is created, nothing is written to any session log, and no tools
// are offered to the model.
//
// Services used (both optional — the route reports a clear error when absent):
//   ctx.webServer         route registration
//   ctx.llm               stream(GenerateOptions)
//   ctx.agentDefaultModel currentSelection()

const ROUTE_PATH = '/api/dsao/prompt-enhance';
const MAX_INPUT_CHARS = 8000;
const TIMEOUT_MS = 60000;

const SYSTEM_PROMPT = [
  'You rewrite a user\'s draft instruction for a coding agent so the agent can act on it without guessing.',
  '',
  'Rules:',
  '- Preserve the original intent, language, and every concrete detail (paths, names, numbers, code).',
  '- Make implicit requirements explicit; state the expected outcome and any acceptance criteria the draft implies.',
  '- Keep it compact. Do not pad, do not invent requirements the draft does not imply, do not ask questions.',
  '- Reply in the SAME language as the draft.',
  '- Output ONLY the rewritten instruction. No preamble, no explanation, no code fences, no quotes around it.',
].join('\n');

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

/**
 * Run one non-session model call and collect its visible text.
 * @returns the rewritten text.
 */
async function enhance(llm, selection, text, signal) {
  const chunks = [];
  const stream = llm.stream({
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    system: SYSTEM_PROMPT,
    messages: [{
      id: `dsao-enhance-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }],
    temperature: 0.3,
    signal,
  });

  // stream() normalizes adapter failures into a terminal finish chunk, so the
  // finish reason — not a thrown error — is the failure signal to check.
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') chunks.push(chunk.text);
    else if (chunk.type === 'finish' && chunk.reason !== 'stop' && chunk.reason !== 'length') {
      throw new Error(`model call did not complete: ${chunk.reason}`);
    }
  }
  return chunks.join('').trim();
}

function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (webServer === undefined) return;

  ctx.effect(() => webServer.register({
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

      const body = await readJsonBody(req, MAX_INPUT_CHARS * 4);
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

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const next = await enhance(llm, selection, text, controller.signal);
        if (next === '') {
          writeJson(res, 502, { error: 'the model returned no text' });
          return;
        }
        writeJson(res, 200, { text: next, provider: selection.provider, model: selection.model });
      } catch (error) {
        writeJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        clearTimeout(timer);
      }
    },
  }), 'dsao: prompt-enhance route');
}

export { apply };
