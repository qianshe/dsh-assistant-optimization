// Verify the archived-session cleanup: id-list parsing, the inventory view, the
// two hard guards (only-archived / never-live), the session-directory delete
// (every stored generation goes, the project directory never does), the
// listing-shape guard (bare headers and snapshot envelopes both resolve; an
// unmappable listing deletes nothing), the write ORDER
// (membership -> purge -> checkpoint -> archive set), the degraded-capability
// reports, and the route wiring (loopback fence, confirm gate, missing-service
// 503s) mounted through apply() the way the host does.
// Run: node test/archive-cleanup.test.mjs
import assert from 'node:assert/strict'
import { createArchiveCleanup, parseIdList } from '../lib/archive-cleanup.js'
import { apply } from '../lib/index.js'

const ARCHIVES_PATH = '/api/dsao/archives'
const SESSIONS_ROOT = 'C:\\home\\.dsh\\sessions\\--cwd--'

/** Transcript path the persistence double hands back for one id. */
function transcriptPath(id, dirName, filename = 'session.jsonl.zstd') {
  return `${SESSIONS_ROOT}\\${dirName ?? id}\\${filename}`
}

/**
 * fs double. Every call lands in the shared `trace`, so ordering across
 * services (detach vs purge vs the archive-set write) is assertable.
 * `files` lists the names `readdir` reports inside a session directory; a
 * recursive `rm` (the session-directory purge) empties that list, a plain one
 * removes just the matching name. `rmCalls` records the options each delete
 * carried, so the recursion itself is assertable.
 */
function fsStub(trace, { size = 4096, failOnStat = false, failOnRm = false, failOnReaddir = false, files } = {}) {
  const names = files === undefined ? ['session.jsonl.zstd'] : files.slice()
  const rmCalls = []
  return {
    rmCalls,
    async readdir(path) {
      trace.push(['readdir', path])
      if (failOnReaddir) throw new Error('EACCES')
      return names.slice()
    },
    async stat(path) {
      trace.push(['stat', path])
      if (failOnStat) throw new Error('ENOENT')
      return { size, mtime: new Date('2026-09-01T00:00:00.000Z') }
    },
    async rm(path, options) {
      trace.push(['rm', path])
      rmCalls.push({ path, recursive: options?.recursive === true })
      if (failOnRm) throw new Error('EPERM')
      if (options?.recursive === true) {
        names.length = 0
        return
      }
      const base = String(path).split(/[\\/]/).pop()
      const index = names.indexOf(base)
      if (index !== -1) names.splice(index, 1)
    },
    async rmdir(path) {
      trace.push(['rmdir', path])
    },
  }
}

/** Workspace entity double: only the account and detach are exercised here. */
function workspaceStub(trace, { id, title, path, sessionIds }) {
  return {
    id,
    title,
    path,
    sessionIds,
    async detachSession(sessionId) {
      trace.push(['detach', String(id), String(sessionId)])
    },
  }
}

/**
 * Registry double: the public archive set / entity list, plus the private
 * write path (`state` + `setState` + `enqueueOperation`) the module probes for
 * the archive-set prune. `options` selects the degraded shapes.
 */
function registryStub(trace, { archived, workspaces, options = {} }) {
  const entities = workspaces.map((workspace) => workspaceStub(trace, workspace))
  const registry = {
    get archivedSessionIds() {
      return archived.slice()
    },
    list: () => entities,
    get: (id) => entities.find((entity) => String(entity.id) === String(id)),
    state: {
      initialized: true,
      workspaceIds: workspaces.map((workspace) => workspace.id),
      archivedSessionIds: archived.slice(),
    },
    async setState(state) {
      trace.push(['archive-set', state.archivedSessionIds.map(String)])
      if (options.failSetState === true) throw new Error('write failed')
      archived = state.archivedSessionIds.slice()
      registry.state = state
    },
    async enqueueOperation(operation) {
      trace.push(['enqueue'])
      return operation()
    },
  }
  if (options.noSetState === true) {
    delete registry.setState
    delete registry.state
  }
  if (options.noQueue === true) delete registry.enqueueOperation
  return registry
}

/**
 * Persistence double: stored logs plus the JSONL backend's locate().
 * `shape` selects the two contract generations the module must tolerate:
 * `flat` (older backends return bare headers from `list()`) and `snapshot`
 * (current backends return `SessionPersistenceSnapshot` envelopes with the
 * header nested under `.header`). `unknown` returns entries carrying no id at
 * all — the shape the guard must refuse rather than read as "no stored logs".
 */
function persistenceStub(sessions, { layout = 'default', hasLocate = true, filename, shape = 'flat', unmappable = false } = {}) {
  const stub = {
    async list() {
      if (unmappable) return sessions.map((session) => ({ unknown: session.id }))
      return sessions.map((session) => (shape === 'snapshot'
        ? { header: { id: session.id, cwd: session.cwd }, revision: 'rev-' + session.id, sizeBytes: 4096 }
        : { id: session.id, cwd: session.cwd }))
    },
    locate(meta) {
      if (layout === 'none') return undefined
      const dirName = layout === 'mismatch' ? 'someone-elses-dir' : String(meta.id)
      const file = filename ?? (layout === 'v3' ? 'session.v3.jsonl.zstd' : 'session.jsonl.zstd')
      return { kind: 'jsonl', path: transcriptPath(meta.id, dirName, file) }
    },
  }
  if (!hasLocate) delete stub.locate
  return stub
}

/**
 * Live-agent registry double. `running` ids report status 'running' and flip
 * to idle on cancel (unless `stuck`); `idle` ids are attached-but-resting.
 */
function agentsStub(trace, { running = [], idle = [], stuck = false } = {}) {
  const map = new Map()
  for (const id of running) {
    map.set(String(id), {
      status: 'running',
      cancel(cause) {
        trace.push(['cancel', String(id), cause && cause.kind])
        if (!stuck) map.set(String(id), { status: 'idle' })
      },
    })
  }
  for (const id of idle) map.set(String(id), { status: 'idle' })
  return { get: (id) => map.get(String(id)), list: () => [...map.entries()].map(([id, agent]) => ({ id, status: agent.status })) }
}

/**
 * Assemble one cleanup scenario with all four services stubbed.
 * @param {object} [input] - scenario knobs; see the defaults.
 * @param {'ok'|'absent'|'throws'} [input.checkpoint] - projection-cache shape.
 * @param {object} [input.agentState] - agents-registry shape (absent → no force capability).
 * @returns {{ cleanup: object, registry: object, fileOps: object, trace: Array }}
 */
function scenario(input = {}) {
  const {
    archived = ['session-a', 'session-b'],
    sessions = [
      { id: 'session-a', cwd: 'D:\\proj\\one' },
      { id: 'session-b', cwd: 'D:\\proj\\two' },
    ],
    workspaces = [
      { id: 'w1', title: 'one', path: 'D:\\proj\\one', sessionIds: ['session-a', 'session-b'] },
    ],
    live = [],
    checkpoint = 'ok',
    registryOptions = {},
    layout = 'default',
    hasLocate = true,
    filename,
    listShape = 'flat',
    unmappable = false,
    fsOptions = {},
    fsFiles,
    notify = 'ok',
    agentState = undefined,
  } = input
  const trace = []
  const registry = registryStub(trace, { archived: archived.slice(), workspaces, options: registryOptions })
  const fileOps = fsStub(trace, fsFiles === undefined ? fsOptions : { ...fsOptions, files: fsFiles })
  const cache =
    checkpoint === 'ok'
      ? { table: { delete: async (id) => { trace.push(['checkpoint', String(id)]); return true } } }
      : checkpoint === 'throws'
        ? { table: { delete: async (id) => { trace.push(['checkpoint', String(id)]); throw new Error('ELOCKED') } } }
        : undefined
  // `api-session/removed` relay: the client applies it as a list remove.
  const notifyRemoved =
    notify === 'ok'
      ? (id) => { trace.push(['removed-event', String(id)]) }
      : notify === 'throws'
        ? (id) => { trace.push(['removed-event', String(id)]); throw new Error('EIO') }
        : undefined
  const cleanup = createArchiveCleanup({
    registry,
    persistence: persistenceStub(sessions, { layout, hasLocate, filename, shape: listShape, unmappable }),
    sessions: { list: () => live.map((id) => ({ id })) },
    cache,
    fileOps,
    notifyRemoved,
    agents: agentState === undefined ? undefined : agentsStub(trace, agentState),
    // Real-but-tiny sleeps keep the settle-poll honest without slowing tests.
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
    settleTimeoutMs: 40,
  })
  return { cleanup, registry, fileOps, trace }
}

/** Trace verbs with their payload, e.g. `['detach w1 session-a', 'rm ...']`. */
function verbs(trace) {
  return trace.map((entry) => entry.join(' '))
}

async function testParseIdList() {
  assert.deepEqual(parseIdList([' a ', 'a', '', 'b', 3, null]).ids, ['a', 'b'])
  assert.equal(parseIdList('nope').ids.length, 0)
  const big = parseIdList(Array.from({ length: 600 }, (_, index) => `id-${index}`))
  assert.equal(big.ids.length, 512)
  assert.equal(big.overflow, true)
}

async function testScanInventory() {
  // Two generations sit in each session directory: the inventory must report
  // the directory total (that is what the purge frees), not just the file
  // `locate()` happens to name.
  const { cleanup, trace } = scenario({
    live: ['session-b'],
    agentState: { idle: ['session-b'] },
    fsOptions: { size: 1000 },
    fsFiles: ['session.v3.jsonl.zstd', 'session.jsonl.zstd'],
  })
  const report = await cleanup.scan()
  assert.equal(report.items.length, 2)
  assert.equal(report.archivedCount, 2)
  assert.equal(report.totalBytes, 4000)
  assert.deepEqual(report.live, ['session-b'])
  // attached-but-idle is NOT running: the badge and the guard must differ
  assert.deepEqual(report.running, [])
  assert.equal(report.items[1].attached, true)
  assert.equal(report.items[1].running, false)
  // A live archived session is neither deletable nor restorable-by-us.
  assert.deepEqual(report.deletableIds, ['session-a'])
  assert.deepEqual(report.forceDeletableIds, ['session-b'])
  assert.deepEqual(report.unarchivableIds, ['session-a'])
  const first = report.items[0]
  assert.equal(first.cwd, 'D:\\proj\\one')
  assert.equal(first.workspaces[0].title, 'one')
  assert.equal(first.path, transcriptPath('session-a'))
  assert.equal(first.dirPath, `${SESSIONS_ROOT}\\session-a`)
  assert.equal(first.bytes, 2000)
  assert.equal(first.files, 2)
  assert.equal(first.mtime, '2026-09-01T00:00:00.000Z')
  assert.equal(report.storedCount, 2)
  assert.deepEqual(verbs(trace), [
    'readdir ' + `${SESSIONS_ROOT}\\session-a`,
    'stat ' + transcriptPath('session-a', undefined, 'session.v3.jsonl.zstd'),
    'stat ' + transcriptPath('session-a', undefined, 'session.jsonl.zstd'),
    'readdir ' + `${SESSIONS_ROOT}\\session-b`,
    'stat ' + transcriptPath('session-b', undefined, 'session.v3.jsonl.zstd'),
    'stat ' + transcriptPath('session-b', undefined, 'session.jsonl.zstd'),
  ])
  assert.deepEqual(report.capabilities, { archivePrune: true, checkpointDelete: true, detach: true, force: true })
}

async function testScanReportsMissingLogs() {
  const { cleanup } = scenario({ sessions: [{ id: 'session-b', cwd: 'D:\\proj\\two' }] })
  const report = await cleanup.scan()
  assert.deepEqual(report.items.map((item) => item.id), ['session-b'])
  assert.deepEqual(report.missing.map((entry) => entry.id), ['session-a'])
  assert.equal(report.missing[0].reason, 'no-stored-log')
  // A hand-deleted log still leaves bookkeeping to clean, so it stays selectable.
  assert.ok(report.deletableIds.includes('session-a'))
}

async function testScanSurvivesStatFailure() {
  // Unstatiable entries simply contribute nothing to the estimate; the row is
  // still inventoried and still deletable.
  const { cleanup } = scenario({ fsOptions: { failOnStat: true } })
  const report = await cleanup.scan()
  assert.equal(report.totalBytes, 0)
  assert.deepEqual(report.items.map((item) => item.bytes), [0, 0])
  assert.deepEqual(report.items.map((item) => item.files), [1, 1])
  assert.equal(report.items[0].problem, undefined)
}

/** A directory that is already gone is reported, never guessed at. */
async function testScanReportsMissingDirectory() {
  const { cleanup } = scenario({ fsOptions: { failOnReaddir: false }, fsFiles: [] })
  const report = await cleanup.scan()
  assert.equal(report.totalBytes, 0)
  assert.deepEqual(report.items.map((item) => item.files), [0, 0])
}

async function testRefusesNonArchivedAndLive() {
  // session-b is archived AND live; session-not-archived is neither.
  const { cleanup, trace, registry } = scenario({ live: ['session-b'] })
  const result = await cleanup.remove(['session-b', 'session-a', 'session-not-archived'])
  assert.deepEqual(result.refused, [
    { id: 'session-b', reason: 'attached' },
    { id: 'session-not-archived', reason: 'not-archived' },
  ])
  assert.deepEqual(result.deleted.map((entry) => entry.id), ['session-a'])
  // Only the archived, non-live id lost a byte: its whole session directory.
  assert.deepEqual(trace.filter((entry) => entry[0] === 'rm'), [['rm', `${SESSIONS_ROOT}\\session-a`]])
  // The refused live id keeps its archive entry; only the cleaned id left the set.
  assert.deepEqual(registry.state.archivedSessionIds.map(String), ['session-b'])
}

/**
 * Force delete: an archived session whose agent runs is cancelled (queued
 * input dropped), awaited to settle, then deleted through the normal path.
 * Without force the same id is refused with the precise reason.
 */
async function testForceDeleteRunning() {
  const { cleanup, trace } = scenario({
    live: ['session-b'],
    agentState: { running: ['session-b'] },
  })
  // Without force: refused, nothing touched.
  const plain = await cleanup.remove(['session-b'])
  assert.deepEqual(plain.refused, [{ id: 'session-b', reason: 'running' }])
  assert.equal(trace.filter((entry) => entry[0] === 'cancel').length, 0)
  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 0)

  // With force: cancel → settle → delete.
  const forced = await cleanup.remove(['session-b'], { force: true })
  assert.equal(forced.refused.length, 0)
  assert.equal(forced.deleted[0].forced, true)
  assert.equal(forced.deleted[0].cancelled, true)
  assert.equal(forced.deleted[0].log, 'removed')
  assert.equal(forced.forced, true)
  const verbsList = verbs(trace)
  const cancelAt = verbsList.findIndex((line) => line.startsWith('cancel session-b'))
  const rmAt = verbsList.findIndex((line) => line === 'rm ' + `${SESSIONS_ROOT}\\session-b`)
  assert.ok(cancelAt >= 0 && rmAt > cancelAt, 'the agent is cancelled before any delete')
  assert.ok(verbsList[cancelAt].includes('user'), 'cancelled as a user stop')
}

/** An idle-attached session needs no cancel, only the force opt-in. */
async function testForceDeleteAttachedIdle() {
  const { cleanup, trace, fileOps } = scenario({ live: ['session-b'], agentState: { idle: ['session-b'] } })
  const result = await cleanup.remove(['session-b'], { force: true })
  assert.equal(result.deleted[0].forced, true)
  assert.equal(result.deleted[0].cancelled, undefined)
  assert.equal(trace.filter((entry) => entry[0] === 'cancel').length, 0)
  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 1)
  // The one delete is the recursive session-directory purge, not a file unlink.
  assert.deepEqual(fileOps.rmCalls, [{ path: `${SESSIONS_ROOT}\\session-b`, recursive: true }])
}

/** An agent that refuses to settle is never deleted from under. */
async function testForceDeleteUnsettledRefused() {
  const { cleanup, trace } = scenario({
    live: ['session-b'],
    agentState: { running: ['session-b'], stuck: true },
  })
  const result = await cleanup.remove(['session-b'], { force: true })
  assert.deepEqual(result.refused, [{ id: 'session-b', reason: 'not-settled' }])
  assert.equal(result.deleted.length, 0)
  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 0)
  assert.equal(trace.filter((entry) => entry[0] === 'cancel').length, 1)
}

/** Force never reaches past the archive set: an un-archived running session stays protected. */
async function testForceDoesNotBypassArchiveGuard() {
  const { cleanup, trace } = scenario({
    archived: ['session-a'],
    live: ['session-b'],
    agentState: { running: ['session-b'] },
  })
  const result = await cleanup.remove(['session-b'], { force: true })
  assert.deepEqual(result.refused, [{ id: 'session-b', reason: 'not-archived' }])
  assert.equal(trace.filter((entry) => entry[0] === 'cancel').length, 0, 'a protected session is not even cancelled')
}

/** No agents registry (older host): force is refused per id, and scan says so. */
async function testForceWithoutAgentsRegistry() {
  const { cleanup, trace } = scenario({ live: ['session-b'] })
  const report = await cleanup.scan()
  assert.equal(report.capabilities.force, false)
  const result = await cleanup.remove(['session-b'], { force: true })
  assert.deepEqual(result.refused, [{ id: 'session-b', reason: 'no-agent-control' }])
  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 0)
}

async function testWriteOrdering() {
  const { cleanup, trace } = scenario()
  const result = await cleanup.remove(['session-a'])
  assert.deepEqual(verbs(trace), [
    // membership first, while the header is still readable
    'detach w1 session-a',
    // the directory is measured, then purged as one unit: every generation
    // (and any other session-owned artifact) goes in a single recursive delete
    'readdir ' + `${SESSIONS_ROOT}\\session-a`,
    'stat ' + transcriptPath('session-a'),
    'rm ' + `${SESSIONS_ROOT}\\session-a`,
    'checkpoint session-a',
    // the client list drops the row before the archive filter that hid it goes away
    'removed-event session-a',
    // archive set last: a crash must not leave a visible session with no log
    'enqueue',
    "archive-set session-b",
  ])
  assert.deepEqual(result.deleted, [{
    id: 'session-a',
    log: 'removed',
    bytes: 4096,
    files: 1,
    checkpoint: 'removed',
    cwd: 'D:\\proj\\one',
    announced: true,
  }])
  assert.equal(result.archivePruned, true)
  assert.equal(result.note, undefined)
}

async function testLayoutAndLocateGuards() {
  // A path that is not the documented <id>/session(.vN)?.jsonl[.zstd] layout is refused.
  const mismatch = scenario({ layout: 'mismatch' })
  const mismatchResult = await mismatch.cleanup.remove(['session-a'])
  assert.equal(mismatchResult.deleted[0].log, 'kept')
  assert.deepEqual(mismatchResult.errors, [{ id: 'session-a', step: 'transcript', detail: 'unexpected-layout' }])
  assert.equal(mismatch.trace.filter((entry) => entry[0] === 'rm').length, 0)

  // A backend whose locate() resolves nothing is reported, never guessed at.
  const unlocated = scenario({ layout: 'none' })
  const unlocatedResult = await unlocated.cleanup.remove(['session-a'])
  assert.deepEqual(unlocatedResult.errors[0], { id: 'session-a', step: 'transcript', detail: 'no-location' })
  assert.equal(unlocatedResult.deleted[0].log, 'kept')
  assert.equal(unlocated.trace.filter((entry) => entry[0] === 'rm').length, 0)

  // A backend with no locate() at all is the other distinct refusal.
  const noLocate = scenario({ hasLocate: false })
  const noLocateResult = await noLocate.cleanup.remove(['session-a'])
  assert.deepEqual(noLocateResult.errors[0], { id: 'session-a', step: 'transcript', detail: 'locate-unavailable' })
  assert.equal(noLocate.trace.filter((entry) => entry[0] === 'rm').length, 0)
  // scan() surfaces the same problem instead of a fake path
  const scanned = await noLocate.cleanup.scan()
  assert.equal(scanned.items[0].problem, 'locate-unavailable')
  assert.equal(scanned.items[0].path, '')

  // A checkpoint write that throws is contained: the file work still stands.
  const throwing = scenario({ checkpoint: 'throws' })
  const throwingResult = await throwing.cleanup.remove(['session-a'])
  assert.equal(throwingResult.deleted[0].log, 'removed')
  assert.equal(throwingResult.deleted[0].checkpoint, 'failed')
  assert.deepEqual(throwingResult.errors, [{ id: 'session-a', step: 'checkpoint', detail: 'ELOCKED' }])
  assert.equal(throwingResult.archivePruned, true)
}

async function testArchivePruneDegradation() {
  // No cache service: the row is reported unavailable, nothing else changes.
  const noCache = scenario({ checkpoint: 'absent' })
  const noCacheResult = await noCache.cleanup.remove(['session-a'])
  assert.equal(noCacheResult.deleted[0].checkpoint, 'unavailable')
  assert.equal(noCacheResult.archivePruned, true)

  // No registry write path (a host shape without the private state handle):
  // bytes still come back, and the caller is told the archive set still names them.
  const noPrune = scenario({ registryOptions: { noSetState: true } })
  const noPruneResult = await noPrune.cleanup.remove(['session-a'])
  assert.equal(noPruneResult.deleted[0].log, 'removed')
  assert.equal(noPruneResult.archivePruned, false)
  assert.match(noPruneResult.note, /archive set could not be written/)
  assert.deepEqual(noPruneResult.capabilities === undefined, true)

  // A failing archive-set write is an error, not a silent success.
  const failing = scenario({ registryOptions: { failSetState: true } })
  const failingResult = await failing.cleanup.remove(['session-a'])
  assert.equal(failingResult.archivePruned, false)
}

async function testRestoreOnlyPrunesArchive() {
  const { cleanup, trace, registry } = scenario()
  const result = await cleanup.restore(['session-b', 'session-x'])
  assert.deepEqual(result.restored, ['session-b'])
  assert.deepEqual(result.refused, [{ id: 'session-x', reason: 'not-archived' }])
  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 0, 'restore never touches bytes')
  assert.deepEqual(registry.state.archivedSessionIds.map(String), ['session-a'])
  // No membership and no checkpoint work either.
  assert.deepEqual(verbs(trace), ['enqueue', 'archive-set session-a'])
}

/** Mount the plugin with stub services and capture every registered route. */
function mount(services, events) {
  const routes = new Map()
  apply({
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
    get: (name) => services[name],
    effect: (callback) => callback(),
    emit: (event, ...args) => {
      if (events !== undefined) events.push([event, ...args])
    },
  })
  return routes
}

function call(route, { method = 'GET', remoteAddress = '127.0.0.1', body } = {}) {
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const req = {
    method,
    url: ARCHIVES_PATH,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      if (payload !== undefined) yield payload
    },
  }
  const res = {
    status: 0,
    text: '',
    writeHead(status) {
      this.status = status
    },
    end(text) {
      this.text = text ?? ''
    },
  }
  return Promise.resolve(route.handler(req, res)).then(() => ({
    status: res.status,
    body: res.text === '' ? undefined : JSON.parse(res.text),
  }))
}

function routeServices() {
  const { cleanup, registry } = scenario()
  return {
    cleanup,
    workspaceRegistry: registry,
    sessionPersistence: persistenceStub([
      { id: 'session-a', cwd: 'D:\\proj\\one' },
      { id: 'session-b', cwd: 'D:\\proj\\two' },
    ]),
    sessions: { list: () => [] },
    sessionProjectionCache: { table: { delete: async () => true } },
  }
}

async function testRouteWiring() {
  const events = []
  const services = routeServices()
  const routes = mount(services, events)
  const route = routes.get(ARCHIVES_PATH)
  assert.ok(route !== undefined, 'apply() must register the archives route')
  assert.ok(routes.get(ROUTE_PROMPT_ENHANCE) !== undefined, 'existing routes survive the addition')

  assert.equal((await call(route, { remoteAddress: '10.0.0.5' })).status, 403)
  assert.equal((await call(route, { method: 'PUT' })).status, 405)

  const scan = await call(route, { method: 'GET' })
  assert.equal(scan.status, 200)
  assert.deepEqual(scan.body.archivedIds, ['session-a', 'session-b'])

  assert.equal((await call(route, { method: 'POST', body: {} })).status, 400)
  assert.equal((await call(route, { method: 'POST', body: { action: 'wipe', ids: ['session-a'] } })).status, 400)
  assert.equal((await call(route, { method: 'POST', body: { action: 'delete', ids: [] } })).status, 400)
  const unconfirmed = await call(route, { method: 'POST', body: { action: 'delete', ids: ['session-a'] } })
  assert.equal(unconfirmed.status, 400)
  assert.match(unconfirmed.body.error, /irreversible/)

  const removed = await call(route, { method: 'POST', body: { action: 'delete', ids: ['session-a'], confirm: true } })
  assert.equal(removed.status, 200)
  assert.equal(removed.body.action, 'delete')
  assert.deepEqual(removed.body.deleted.map((entry) => entry.id), ['session-a'])
  assert.equal(removed.body.archivePruned, true)
  // The deletion is announced on the host event the connection layer forwards
  // to clients, so the sidebar row drops instead of lingering as a ghost.
  assert.deepEqual(events, [['api-session/removed', 'session-a']])

  const restored = await call(route, { method: 'POST', body: { action: 'restore', ids: ['session-b'] } })
  assert.equal(restored.status, 200)
  assert.deepEqual(restored.body.restored, ['session-b'])
  // Restore never announces a removal: the session stays, it just reappears.
  assert.deepEqual(events, [['api-session/removed', 'session-a']])

  // Missing services answer with a readable 503 instead of mounting nothing.
  const noRegistry = mount({ sessionPersistence: services.sessionPersistence })
  const noRegistryResponse = await call(noRegistry.get(ARCHIVES_PATH), { method: 'GET' })
  assert.equal(noRegistryResponse.status, 503)
  assert.match(noRegistryResponse.body.error, /workspaceRegistry/)
  const noPersistence = mount({ workspaceRegistry: services.workspaceRegistry })
  assert.equal((await call(noPersistence.get(ARCHIVES_PATH), { method: 'GET' })).status, 503)
}

const ROUTE_PROMPT_ENHANCE = '/api/dsao/prompt-enhance'

/**
 * The client session-list store only learns a session is gone through the
 * `api-session/removed` relay; without it, a deleted session survives as a
 * ghost row that the pruned archive filter no longer hides (未分组 residue,
 * stale 运行中 dot). Removal must be announced exactly when the row's durable
 * basis is gone (log removed, or was never there), never for a kept/failed
 * transcript — a loadable session must keep its row.
 */
async function testAnnounceRemoved() {
  // Normal delete: one event per removed id, after the files are gone.
  const { cleanup, trace } = scenario()
  const result = await cleanup.remove(['session-a', 'session-b'])
  assert.deepEqual(trace.filter((entry) => entry[0] === 'removed-event'), [
    ['removed-event', 'session-a'],
    ['removed-event', 'session-b'],
  ])
  assert.deepEqual(result.deleted.map((entry) => [entry.id, entry.announced]), [
    ['session-a', true],
    ['session-b', true],
  ])

  // A layout the module refuses to touch keeps the session loadable: no event.
  const kept = scenario({ layout: 'mismatch' })
  const keptResult = await kept.cleanup.remove(['session-a'])
  assert.equal(keptResult.deleted[0].announced, undefined)
  assert.equal(kept.trace.filter((entry) => entry[0] === 'removed-event').length, 0)

  // A transcript rm that throws likewise keeps the row (the log still loads).
  const failed = scenario({ fsOptions: { failOnRm: true } })
  const failedResult = await failed.cleanup.remove(['session-a'])
  assert.equal(failedResult.deleted[0].log, 'failed')
  assert.equal(failedResult.deleted[0].announced, undefined)

  // An already-missing log (deleted out-of-band earlier) still announces: the
  // bookkeeping cleanup removes the last durable basis of the row.
  const absent = scenario({ sessions: [] })
  const absentResult = await absent.cleanup.remove(['session-a'])
  assert.equal(absentResult.deleted[0].log, 'absent')
  assert.equal(absentResult.deleted[0].announced, true)

  // A relay failure is contained: the deletion stands, reported as an error.
  const throwing = scenario({ notify: 'throws' })
  const throwingResult = await throwing.cleanup.remove(['session-a'])
  assert.equal(throwingResult.deleted[0].log, 'removed')
  assert.equal(throwingResult.deleted[0].announced, undefined)
  assert.deepEqual(throwingResult.errors, [{ id: 'session-a', step: 'announce', detail: 'EIO' }])
}

/** No relay wired (older host / route without ctx.emit): deletion still works. */
async function testAnnounceOptional() {
  const { cleanup, trace } = scenario({ notify: 'absent' })
  const result = await cleanup.remove(['session-a'])
  assert.equal(result.deleted[0].log, 'removed')
  assert.equal(result.deleted[0].announced, undefined)
  assert.equal(result.errors.length, 0)
  assert.equal(trace.filter((entry) => entry[0] === 'removed-event').length, 0)
}

/** Restore never announces: the session stays, it just becomes visible again. */
async function testRestoreDoesNotAnnounce() {
  const { cleanup, trace } = scenario()
  await cleanup.restore(['session-a'])
  assert.equal(trace.filter((entry) => entry[0] === 'removed-event').length, 0)
}

/** Deleting purges the whole session directory, not just the file `locate()` names. */
async function testDeletePurgesTheWholeSessionDirectory() {
  // Real dsh writes `session.v3.jsonl.zstd` while older generations may still
  // sit beside it, and the backend promotes the newest file it finds. Deleting
  // only what `locate()` names would leave a generation behind to resurrect
  // the session after a restart, so the whole directory goes.
  const { cleanup, trace, registry, fileOps } = scenario({
    archived: ['session-a'],
    sessions: [{ id: 'session-a', cwd: 'D:\\proj\\one' }],
    layout: 'v3',
    fsFiles: ['session.v3.jsonl.zstd', 'session.jsonl.zstd', 'attachment.png'],
  })
  const result = await cleanup.remove(['session-a'])
  assert.equal(result.deleted[0].log, 'removed')
  // Every artifact inside the session directory is freed, size included.
  assert.equal(result.deleted[0].bytes, 3 * 4096)
  assert.equal(result.deleted[0].files, 3)
  const rmPaths = trace.filter((entry) => entry[0] === 'rm').map((entry) => entry[1])
  assert.deepEqual(rmPaths, [`${SESSIONS_ROOT}\\session-a`], 'one delete, scoped to the session directory')
  assert.equal(fileOps.rmCalls[0].recursive, true, 'the session directory is purged recursively')
  // Never the project directory — that would take sibling sessions with it.
  assert.equal(rmPaths.some((path) => path === SESSIONS_ROOT), false)
  assert.deepEqual(registry.state.archivedSessionIds.map(String), [])

  // A session whose only stored artifact predates the current generation must
  // disappear too: `locate()` names the missing v3 path, and the purge takes
  // the directory regardless of which generation is inside.
  const legacyOnly = scenario({
    archived: ['session-a'],
    sessions: [{ id: 'session-a', cwd: 'D:\\proj\\one' }],
    layout: 'v3',
    fsFiles: ['session.jsonl.zstd'],
  })
  const legacyResult = await legacyOnly.cleanup.remove(['session-a'])
  assert.equal(legacyResult.deleted[0].log, 'removed')
  assert.equal(legacyResult.deleted[0].bytes, 4096)
  assert.deepEqual(legacyOnly.trace.filter((entry) => entry[0] === 'rm').map((entry) => entry[1]), [`${SESSIONS_ROOT}\\session-a`])
  assert.deepEqual(legacyOnly.registry.state.archivedSessionIds.map(String), [])
}

/**
 * `sessionPersistence.list()` has two shipped shapes: bare headers (older
 * backends) and `SessionPersistenceSnapshot` envelopes (`{ header }`, current
 * ones). Both must find the same targets — reading only the bare shape is what
 * made every delete on a current host a no-op that still un-archived the row.
 */
async function testHandlesBothListShapes() {
  const flat = scenario({ archived: ['session-a'], sessions: [{ id: 'session-a', cwd: 'D:\\proj\\one' }], listShape: 'flat' })
  const snapshot = scenario({ archived: ['session-a'], sessions: [{ id: 'session-a', cwd: 'D:\\proj\\one' }], listShape: 'snapshot' })

  const flatReport = await flat.cleanup.scan()
  const snapshotReport = await snapshot.cleanup.scan()
  assert.deepEqual(snapshotReport.items.map((item) => item.id), ['session-a'], 'the envelope shape resolves to the same session')
  assert.equal(snapshotReport.items[0].path, flatReport.items[0].path)
  assert.equal(snapshotReport.storedCount, flatReport.storedCount)

  const flatResult = await flat.cleanup.remove(['session-a'])
  const snapshotResult = await snapshot.cleanup.remove(['session-a'])
  assert.equal(flatResult.deleted[0].log, 'removed')
  assert.equal(snapshotResult.deleted[0].log, 'removed', 'a snapshot-listed session is purged just the same')
  assert.deepEqual(snapshotResult.deleted[0].bytes, 4096)
  assert.deepEqual(snapshot.trace.filter((entry) => entry[0] === 'rm').map((entry) => entry[1]), [`${SESSIONS_ROOT}\\session-a`])
  assert.deepEqual(snapshot.registry.state.archivedSessionIds.map(String), [])
}

/** An unmappable `list()` is refused loudly — never read as "these logs are gone". */
async function testUnmappableListRefusesEverything() {
  const { cleanup, registry, trace } = scenario({ unmappable: true })

  await assert.rejects(() => cleanup.scan(), /no readable session id/)
  // remove() throws the same way; the route turns it into a 500 the GUI shows
  // as an error banner, which beats reporting a successful cleanup of nothing.
  await assert.rejects(() => cleanup.remove(['session-a']), /no readable session id/)

  assert.equal(trace.filter((entry) => entry[0] === 'rm').length, 0, 'not one byte is touched')
  assert.equal(trace.filter((entry) => entry[0] === 'detach').length, 0, 'no account changes either')
  assert.equal(trace.filter((entry) => entry[0] === 'archive-set').length, 0, 'the archive set is never written')
  assert.deepEqual(registry.state.archivedSessionIds.map(String), ['session-a', 'session-b'])
}

/** A session whose transcript was kept or failed must stay in the archive set. */
async function testKeptOrFailedTranscriptStaysArchived() {
  const kept = scenario({ layout: 'mismatch' })
  const keptResult = await kept.cleanup.remove(['session-a'])
  assert.equal(keptResult.deleted[0].log, 'kept')
  // Not pruned: the id remains hidden in the sidebar and is retryable.
  assert.deepEqual(kept.registry.state.archivedSessionIds.map(String), ['session-a', 'session-b'])

  const failed = scenario({ fsOptions: { failOnRm: true } })
  const failedResult = await failed.cleanup.remove(['session-a'])
  assert.equal(failedResult.deleted[0].log, 'failed')
  assert.deepEqual(failed.registry.state.archivedSessionIds.map(String), ['session-a', 'session-b'])
}

const tests = [
  ['parseIdList', testParseIdList],
  ['scan inventory', testScanInventory],
  ['scan reports missing logs', testScanReportsMissingLogs],
  ['scan survives stat failure', testScanSurvivesStatFailure],
  ['scan reports missing directory', testScanReportsMissingDirectory],
  ['refuses non-archived and live', testRefusesNonArchivedAndLive],
  ['force delete running', testForceDeleteRunning],
  ['force delete attached idle', testForceDeleteAttachedIdle],
  ['force delete unsettled refused', testForceDeleteUnsettledRefused],
  ['force does not bypass archive guard', testForceDoesNotBypassArchiveGuard],
  ['force without agents registry', testForceWithoutAgentsRegistry],
  ['write ordering', testWriteOrdering],
  ['delete purges the whole session directory', testDeletePurgesTheWholeSessionDirectory],
  ['handles both list() shapes', testHandlesBothListShapes],
  ['unmappable list() refuses everything', testUnmappableListRefusesEverything],
  ['kept/failed transcript stays archived', testKeptOrFailedTranscriptStaysArchived],
  ['layout and locate guards', testLayoutAndLocateGuards],
  ['archive prune degradation', testArchivePruneDegradation],
  ['announce removed', testAnnounceRemoved],
  ['announce optional', testAnnounceOptional],
  ['restore does not announce', testRestoreDoesNotAnnounce],
  ['restore prunes only', testRestoreOnlyPrunesArchive],
  ['route wiring', testRouteWiring],
]

let failures = 0
for (const [name, test] of tests) {
  try {
    await test()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  }
}
console.log(failures === 0 ? `\n${tests.length} passed` : `\n${failures} of ${tests.length} failed`)
process.exit(failures === 0 ? 0 : 1)
