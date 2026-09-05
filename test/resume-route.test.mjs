// Verify the resume route: registration order safety, the loopback fence,
// method/input guards, missing-service reporting, the gate computation over a
// fake live agent (status / inbox / last turn-end reason), and the exact
// marker message handed to agent.followup.
// Run: node test/resume-route.test.mjs
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const RESUME_PATH = '/api/dsao/resume'
const ENHANCE_PATH = '/api/dsao/prompt-enhance'

/**
 * Mount the plugin with stub services and capture EVERY registered route by
 * path. Registering three routes in apply() must not disturb the existing
 * prompt-enhance tests, which rely on their capture seeing the enhance route.
 */
function mount(services) {
  const routes = new Map()
  const webServer = {
    register: (r) => {
      routes.set(r.path, r)
      return () => {}
    },
  }
  apply({
    webServer,
    get: (name) => services[name],
    effect: (callback) => callback(),
  })
  return routes
}

function call(route, { method = 'POST', remoteAddress = '127.0.0.1', url, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    url: url ?? '/api/dsao/resume',
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

/** A fake live agent whose gate inputs are all directly controllable. */
function agentStub({
  status = 'idle',
  hasPending = false,
  lastReason = { kind: 'aborted' },
  events = undefined,
  eventList = undefined,
} = {}) {
  const submitted = []
  const turnEnd = { type: 'turn/end', seq: 99, data: { turn: 7, reason: lastReason } }
  const eventArray = events ?? [
    { type: 'turn/start', seq: 10, data: { turn: 7 } },
    { type: 'user/message', seq: 11, data: { role: 'user', content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
    ...(lastReason === null ? [] : [turnEnd]),
  ]
  return {
    submitted,
    status,
    inbox: { hasPending },
    session: eventList
      // dsh 0.1.2 Session 形态：无 .events 数组，事件流经 snapshotEvents() 读取。
      ? { snapshotEvents: () => eventList }
      : { events: eventArray },
    followup(message) { submitted.push(message) },
  }
}

// 1. Three routes register; both named paths resolve; registration order keeps
//    the enhance route LAST so legacy single-slot captures still see it.
{
  const routes = mount({})
  assert.equal(routes.size, 3, `expected 3 routes, got ${routes.size}`)
  assert.ok(routes.has(RESUME_PATH), 'resume route must be registered')
  assert.equal(routes.get(RESUME_PATH).kind, 'exact')
  assert.equal([...routes.keys()][routes.size - 1], ENHANCE_PATH, 'prompt-enhance must remain the last registration for legacy capture tests')
}

const base = { agents: undefined }

// 2. Missing agents service → 503 with a clear message (both methods).
{
  const routes = mount(base)
  const route = routes.get(RESUME_PATH)
  const out = await call(route, { body: { sessionId: 's1' } })
  assert.equal(out.status, 503)
  assert.match(out.body.error, /agents service/)
  const probe = await call(route, { method: 'GET', url: '/api/dsao/resume?sessionId=s1' })
  assert.equal(probe.status, 503)
}

// 3. Loopback fence and method guards.
{
  const routes = mount({ agents: new Map() })
  const route = routes.get(RESUME_PATH)
  const remote = await call(route, { remoteAddress: '192.168.1.9', body: { sessionId: 's1' } })
  assert.equal(remote.status, 403)
  const wrongMethod = await call(route, { method: 'PUT', body: { sessionId: 's1' } })
  assert.equal(wrongMethod.status, 405)
}

// 4. Body validation: missing / blank sessionId, invalid markerStyle.
{
  const routes = mount({ agents: new Map() })
  const route = routes.get(RESUME_PATH)
  assert.equal((await call(route, {})).status, 400)
  assert.equal((await call(route, { body: { sessionId: '   ' } })).status, 400)
  const bad = await call(route, { body: { sessionId: 's1', markerStyle: 'poem' } })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /markerStyle/)
}

// 5. Unknown session → 404 naming the id.
{
  const routes = mount({ agents: new Map() })
  const out = await call(routes.get(RESUME_PATH), { body: { sessionId: 'ghost' } })
  assert.equal(out.status, 404)
  assert.match(out.body.error, /ghost/)
}

// 6. Busy agent → 409 code=agent-busy; followup untouched.
{
  const agent = agentStub({ status: 'running' })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 409)
  assert.equal(out.body.code, 'agent-busy')
  assert.equal(agent.submitted.length, 0)
}

// 7. Normal completed terminal → 409 code=not-resumable.
{
  const agent = agentStub({ lastReason: { kind: 'completed' } })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 409)
  assert.equal(out.body.code, 'not-resumable')
  assert.equal(out.body.terminalKind, 'completed')
}

// 8. Pending inbox blocks even on idle+aborted.
{
  const agent = agentStub({ hasPending: true })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 409)
  assert.equal(out.body.code, 'agent-busy')
  assert.equal(agent.submitted.length, 0)
}

// 8b. dsh 0.1.2 Session 形态：事件流经 snapshotEvents() 暴露（无 .events 数组），
//     gate 必须走新读取路径——aborted 终态照样点亮续发。
{
  const agent = agentStub({ lastReason: { kind: 'aborted' }, eventList: [
    { type: 'turn/start', seq: 10, data: { turn: 7 } },
    { type: 'turn/end', seq: 99, data: { turn: 7, reason: { kind: 'aborted' } } },
  ] })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 200)
  assert.equal(out.body.accepted, true)
  assert.equal(out.body.terminalKind, 'aborted')
  assert.equal(agent.submitted.length, 1)
}

// 9. Happy path (default zero marker): followup receives exactly one user-role
//    message whose content is EMPTY — no prompt text crosses DR-4's line.
{
  const agent = agentStub({ lastReason: { kind: 'aborted' } })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 200)
  assert.deepEqual(out.body, {
    accepted: true,
    sessionId: 's1',
    markerStyle: 'zero',
    terminalKind: 'aborted',
    note: agent.submitted.length >= 0 ? out.body.note : '',
  })
  assert.equal(agent.submitted.length, 1)
  const marker = agent.submitted[0]
  assert.equal(marker.role, 'user')
  assert.deepEqual(marker.content, [])
  assert.equal(marker.source.kind, 'user')
  assert.ok(typeof marker.id === 'string' && marker.id.startsWith('dsao-resume-'))
}

// 10. Sentinel override produces one minimal text block instead.
{
  const agent = agentStub({ lastReason: { kind: 'max-tokens' } })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), {
    body: { sessionId: 's1', markerStyle: 'sentinel' },
  })
  assert.equal(out.status, 200)
  assert.equal(out.body.markerStyle, 'sentinel')
  assert.equal(agent.submitted[0].content.length, 1)
  assert.equal(agent.submitted[0].content[0].type, 'text')
}

// 11. Every declared terminal kind passes the gate symmetrically; error reason
//     wrapped as an Error object also passes (turn/end stores what was given).
for (const kind of ['aborted', 'error', 'max-tokens', 'interrupted']) {
  const agent = agentStub({ lastReason: kind === 'error' ? { kind: 'error' } : { kind } })
  const agents = new Map([['s1', agent]])
  const out = await call(mount({ agents }).get(RESUME_PATH), { body: { sessionId: 's1' } })
  assert.equal(out.status, 200, `terminal kind ${kind} must be resumable`)
}

// 12. GET gate reports computed facts without waking anything.
{
  const agent = agentStub({ status: 'idle', lastReason: { kind: 'aborted' } })
  const agents = new Map([['live', agent], ['done', agentStub({ lastReason: { kind: 'completed' } })]])
  const route = mount({ agents }).get(RESUME_PATH)
  const yes = await call(route, { method: 'GET', url: '/api/dsao/resume?sessionId=live' })
  assert.equal(yes.status, 200)
  assert.deepEqual(yes.body.gate, { canResume: true, status: 'idle', terminalKind: 'aborted' })
  const no = await call(route, { method: 'GET', url: '/api/dsao/resume?sessionId=done' })
  assert.deepEqual(no.body.gate, { canResume: false, status: 'idle', terminalKind: 'completed' })
  assert.equal(agent.submitted.length, 0, 'gate reads must never wake the agent')
}

console.log('resume-route: all assertions passed')
