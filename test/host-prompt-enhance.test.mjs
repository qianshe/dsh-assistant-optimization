// Verify the host prompt-enhance route: loopback fence, method/input guards,
// missing-service reporting, and the single non-session model call.
// Run: node test/host-prompt-enhance.test.mjs
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

/** Capture the route the plugin registers. */
function mount(services) {
  let route
  const ctx = {
    get: (name) => services[name],
    effect: (callback) => callback(),
  }
  const webServer = {
    register: (r) => {
      route = r
      return () => {}
    },
  }
  apply({ ...ctx, get: (name) => (name === 'webServer' ? webServer : services[name]) })
  return route
}

/** Minimal req/res pair; the body is an async-iterable of one Buffer. */
function call(route, { method = 'POST', remoteAddress = '127.0.0.1', body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  const res = {
    status: 0,
    text: '',
    writeHead(status) { this.status = status },
    end(text) { this.text = text ?? '' },
  }
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.status,
    body: res.text === '' ? undefined : JSON.parse(res.text),
  }))
}

/** An llm stub whose stream yields text deltas then a finish chunk. */
function llmStub({ deltas = ['rewritten'], reason = 'stop', capture } = {}) {
  return {
    stream(options) {
      if (capture !== undefined) capture(options)
      return (async function* () {
        for (const text of deltas) yield { type: 'text-delta', index: 0, text }
        yield { type: 'finish', reason }
      })()
    },
  }
}

const selection = { provider: 'deepseek', model: 'deepseek-v4-flash' }
const defaultModel = { currentSelection: () => selection }

// 0. The route claims the documented path with an exact match.
{
  const route = mount({})
  assert.equal(route.kind, 'exact', 'route must be an exact match')
  assert.equal(route.path, '/api/dsao/prompt-enhance', 'route path must match the client endpoint')
}

// 1. A non-loopback caller is refused before any service is touched.
{
  const route = mount({ llm: llmStub(), agentDefaultModel: defaultModel })
  const res = await call(route, { remoteAddress: '10.0.0.5', body: { text: 'hi' } })
  assert.equal(res.status, 403, 'remote callers must be refused')
}

// 2. Only POST is accepted.
{
  const route = mount({ llm: llmStub(), agentDefaultModel: defaultModel })
  const res = await call(route, { method: 'GET' })
  assert.equal(res.status, 405, 'GET must be rejected')
}

// 3. Missing services report a clear 503 instead of throwing.
{
  const route = mount({})
  const res = await call(route, { body: { text: 'hi' } })
  assert.equal(res.status, 503, 'absent llm/agentDefaultModel must report 503')
  assert.match(res.body.error, /llm and agentDefaultModel/, 'the error must name both services')
}

// 4. An empty draft is refused without calling the model.
{
  let called = false
  const route = mount({ llm: llmStub({ capture: () => { called = true } }), agentDefaultModel: defaultModel })
  const res = await call(route, { body: { text: '   ' } })
  assert.equal(res.status, 400, 'an empty draft must be refused')
  assert.equal(called, false, 'an empty draft must not reach the model')
}

// 5. Happy path: one non-session call, no tools, no sessionId.
{
  let options
  const route = mount({
    llm: llmStub({ deltas: ['改写后的', '指令'], capture: (o) => { options = o } }),
    agentDefaultModel: defaultModel,
  })
  const res = await call(route, { body: { text: '帮我改一下这个函数' } })
  assert.equal(res.status, 200, 'a valid draft must succeed')
  assert.equal(res.body.text, '改写后的指令', 'deltas must be concatenated and trimmed')
  assert.equal(res.body.model, selection.model, 'the response must report the model used')

  assert.equal(options.provider, selection.provider, 'the current default provider must be used')
  assert.equal(options.model, selection.model, 'the current default model must be used')
  assert.equal(options.tools, undefined, 'no tools may be offered')
  assert.equal(options.sessionId, undefined, 'the call must not be bound to a session')
  assert.equal(options.messages.length, 1, 'exactly one user message')
  assert.equal(options.messages[0].role, 'user', 'the draft rides a user message')
  assert.equal(options.messages[0].content[0].text, '帮我改一下这个函数', 'the draft must be passed verbatim')
  assert.equal(typeof options.system, 'string', 'a system prompt must be supplied')
}

// 6. An oversized draft is refused.
{
  const route = mount({ llm: llmStub(), agentDefaultModel: defaultModel })
  const res = await call(route, { body: { text: 'x'.repeat(8001) } })
  assert.equal(res.status, 413, 'an oversized draft must be refused')
}

// 7. A non-stop finish reason surfaces as a failure, not as empty text.
{
  const route = mount({ llm: llmStub({ deltas: ['partial'], reason: 'error' }), agentDefaultModel: defaultModel })
  const res = await call(route, { body: { text: 'hi' } })
  assert.equal(res.status, 502, 'a failed model call must report 502')
}

// 8. A model that returns nothing is reported rather than clearing the draft.
{
  const route = mount({ llm: llmStub({ deltas: [] }), agentDefaultModel: defaultModel })
  const res = await call(route, { body: { text: 'hi' } })
  assert.equal(res.status, 502, 'empty model output must report 502')
}

// 9. No model selected is reported as 503.
{
  const route = mount({ llm: llmStub(), agentDefaultModel: { currentSelection: () => undefined } })
  const res = await call(route, { body: { text: 'hi' } })
  assert.equal(res.status, 503, 'an absent selection must report 503')
}

console.log('host-prompt-enhance: 10 scenarios passed')
