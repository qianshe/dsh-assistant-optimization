// End-to-end over the REAL filesystem: a temp "sessions root" laid out exactly
// like the shipped JSONL backend (`<root>/--<cwd>--/<id>/session.jsonl.zstd`),
// the real node:fs operations, and the route mounted on an in-process HTTP
// server — so what is asserted is that bytes actually disappear, an unexpected
// extra file is left alone, and the registry bookkeeping follows.
// Run: node test/archive-cleanup-integration.test.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchiveCleanup, ARCHIVES_ROUTE_PATH } from '../lib/archive-cleanup.js'

const ID_CLEAN = 'session-clean'
const ID_EXTRA = 'session-with-extra-file'
const ID_LIVE = 'session-live'
const ID_UNARCHIVED = 'session-not-archived'

/** Build one session directory the way the JSONL backend does. */
async function seedSession(root, id, { extraFile = false, files = ['session.jsonl.zstd'] } = {}) {
  const dir = join(root, '--D-proj--', id)
  await mkdir(dir, { recursive: true })
  for (const file of files) await writeFile(join(dir, file), 'frame-one\nframe-two\n')
  if (extraFile) await writeFile(join(dir, 'attachment.png'), 'not ours to take')
  return join(dir, files[0])
}

/** Registry double with the same private write path the real one exposes. */
function registryDouble(archived, owners) {
  const state = { initialized: true, workspaceIds: ['w1'], archivedSessionIds: archived.slice() }
  const detached = []
  const entity = {
    id: 'w1',
    title: 'proj',
    path: 'D:\\proj',
    sessionIds: owners.slice(),
    async detachSession(sessionId) {
      detached.push(String(sessionId))
    },
  }
  return {
    detached,
    get archivedSessionIds() {
      return state.archivedSessionIds.map(String)
    },
    list: () => [entity],
    get state() {
      return state
    },
    async setState(next) {
      state.archivedSessionIds = next.archivedSessionIds
    },
    async enqueueOperation(operation) {
      return operation()
    },
  }
}

/** Persistence double whose locate() answers with real paths under `root`. */
function persistenceDouble(root, ids, filename = 'session.jsonl.zstd') {
  return {
    async list() {
      return ids.map((id) => ({ id, cwd: 'D:\\proj' }))
    },
    locate(meta) {
      return { kind: 'jsonl', path: join(root, '--D-proj--', String(meta.id), filename) }
    },
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Mount the route on a real loopback server and return a fetch-style caller. */
async function serve(handler) {
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Minimal route wiring, identical in shape to the one lib/index.js installs.
function archivesHandler(cleanup) {
  return async (req, res) => {
    const send = async (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET') {
      await send(200, await cleanup.scan())
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body.action === 'delete' && body.confirm !== true) {
      await send(400, { error: 'deleting archived sessions is irreversible; resend with confirm: true' })
      return
    }
    const result = body.action === 'delete'
      ? await cleanup.remove(body.ids, { force: body.force === true })
      : await cleanup.restore(body.ids)
    await send(200, { action: body.action, force: body.force === true, ...result })
  }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])
test('force delete over real HTTP cancels a running agent, waits for settle, and removes the bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsao-archives-'))
  const runningTranscript = await seedSession(root, ID_LIVE)
  const archived = [ID_LIVE]
  const registry = registryDouble(archived, [ID_LIVE])
  const cleanup = createArchiveCleanup({
    registry,
    persistence: persistenceDouble(root, archived),
    sessions: { list: () => [{ id: ID_LIVE }] },
    // A live agent that flips to idle exactly when cancelled — the settle poll
    // must observe that transition before any unlink happens.
    agents: {
      get(id) {
        if (String(id) !== ID_LIVE) return undefined
        return agent
      },
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, 1)),
    settleTimeoutMs: 500,
  })
  const events = []
  const agent = {
    status: 'running',
    cancel(cause) {
      events.push(['cancel', cause && cause.kind])
      agent.status = 'idle'
    },
  }

  const server = await serve(archivesHandler(cleanup))
  try {
    // Without force the running session is refused with the precise reason.
    const plain = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', confirm: true, ids: [ID_LIVE] }),
    })).json()
    assert.deepEqual(plain.refused, [{ id: ID_LIVE, reason: 'running' }])
    assert.equal(await exists(runningTranscript), true, 'refused means untouched')
    assert.equal(events.length, 0, 'refused means not even cancelled')

    // With force: cancel → settle → unlink, announced, archive entry pruned.
    const forced = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', confirm: true, force: true, ids: [ID_LIVE] }),
    })).json()
    assert.equal(forced.force, true)
    assert.deepEqual(forced.deleted.map((entry) => [entry.id, entry.log, entry.forced, entry.cancelled]), [
      [ID_LIVE, 'removed', true, true],
    ])
    assert.deepEqual(events, [['cancel', 'user']])
    assert.equal(await exists(runningTranscript), false, 'the bytes really went after settling')
    assert.equal(await exists(join(root, '--D-proj--', ID_LIVE)), false)
    assert.deepEqual(registry.state.archivedSessionIds.map(String), [])
  } finally {
    await server.close()
  }
})


test('deleting an archived session really removes its bytes and its bookkeeping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsao-archives-'))
  const cleanTranscript = await seedSession(root, ID_CLEAN)
  const extraTranscript = await seedSession(root, ID_EXTRA, { extraFile: true })
  const liveTranscript = await seedSession(root, ID_LIVE)
  const unarchivedTranscript = await seedSession(root, ID_UNARCHIVED)

  const archived = [ID_CLEAN, ID_EXTRA, ID_LIVE]
  const owners = [ID_CLEAN, ID_EXTRA, ID_LIVE, ID_UNARCHIVED]
  const registry = registryDouble(archived, owners)
  const persistence = persistenceDouble(root, [...archived, ID_UNARCHIVED])
  const dropped = []
  const cleanup = createArchiveCleanup({
    registry,
    persistence,
    sessions: { list: () => [{ id: ID_LIVE }] },
    cache: { table: { delete: async (id) => { dropped.push(String(id)); return true } } },
  })

  const server = await serve(archivesHandler(cleanup))
  try {
    const report = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`)).json()
    assert.equal(report.items.length, 3)
    assert.ok(report.totalBytes > 0)
    assert.deepEqual(report.live, [ID_LIVE])
    assert.ok(!report.deletableIds.includes(ID_LIVE))

    // The guard rail: an unconfirmed delete must not touch anything.
    const unconfirmed = await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'delete', ids: [ID_CLEAN] }),
    })
    assert.equal(unconfirmed.status, 400)
    assert.equal(await exists(cleanTranscript), true, 'nothing may go without confirm:true')

    const confirmed = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({
        action: 'delete',
        confirm: true,
        ids: [ID_CLEAN, ID_EXTRA, ID_LIVE, ID_UNARCHIVED],
      }),
    })).json()

    assert.deepEqual(confirmed.deleted.map((entry) => entry.id), [ID_CLEAN, ID_EXTRA])
    assert.deepEqual(confirmed.refused, [
      { id: ID_LIVE, reason: 'attached' },
      { id: ID_UNARCHIVED, reason: 'not-archived' },
    ])
    assert.equal(confirmed.archivePruned, true)
    assert.equal(confirmed.force, false)

    // Real bytes: the transcript and its now-empty directory are gone.
    assert.equal(await exists(cleanTranscript), false)
    assert.equal(await exists(join(root, '--D-proj--', ID_CLEAN)), false)
    // A directory holding something we did not expect keeps that file.
    assert.equal(await exists(extraTranscript), false)
    assert.equal(await exists(join(root, '--D-proj--', ID_EXTRA, 'attachment.png')), true)
    // Untouched targets survive.
    assert.equal(await exists(liveTranscript), true)
    assert.equal(await exists(unarchivedTranscript), true)

    assert.deepEqual(dropped.sort(), [ID_CLEAN, ID_EXTRA].sort())
    assert.deepEqual(registry.detached.sort(), [ID_CLEAN, ID_EXTRA].sort())
    assert.deepEqual(registry.state.archivedSessionIds.map(String), [ID_LIVE])

    // The re-scan after cleanup reflects the new reality.
    const after = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`)).json()
    assert.deepEqual(after.archivedIds, [ID_LIVE])
    assert.equal(after.items[0].live, true)
    assert.equal(after.deletableIds.length, 0)

    // Restore brings the remaining id back out of the archive set, files intact.
    const restored = await (await fetch(`${server.base}${ARCHIVES_ROUTE_PATH}`, {
      method: 'POST',
      body: JSON.stringify({ action: 'restore', ids: [ID_LIVE] }),
    })).json()
    assert.deepEqual(restored.restored, [ID_LIVE])
    assert.equal(await exists(liveTranscript), true, 'restore never deletes a byte')
    assert.deepEqual(registry.state.archivedSessionIds.map(String), [])
  } finally {
    await server.close()
  }
})

test('deleting removes every generation artifact so the session cannot resurface from v0', async () => {
  // Real hosts write `session.v3.jsonl.zstd` while older `session.jsonl.zstd`
  // files can remain in the same directory. `locate()` points at the current
  // generation only; the backend treats the newest remaining generation as the
  // session, so all generation artifacts must be unlinked together.
  const root = await mkdtemp(join(tmpdir(), 'dsao-archives-'))
  const v3 = await seedSession(root, ID_CLEAN, { files: ['session.v3.jsonl.zstd', 'session.jsonl.zstd'] })
  const dir = join(root, '--D-proj--', ID_CLEAN)
  const registry = registryDouble([ID_CLEAN], [ID_CLEAN])
  const cleanup = createArchiveCleanup({
    registry,
    persistence: persistenceDouble(root, [ID_CLEAN], 'session.v3.jsonl.zstd'),
    sessions: { list: () => [] },
  })
  const result = await cleanup.remove([ID_CLEAN])
  assert.equal(result.deleted[0].log, 'removed')
  assert.equal(await exists(v3), false, 'current generation is gone')
  assert.equal(await exists(join(dir, 'session.jsonl.zstd')), false, 'legacy generation is gone too')
  assert.equal(await exists(dir), false, 'the now-empty session directory is gone')
  assert.deepEqual(registry.state.archivedSessionIds.map(String), [])
})

test('the transcript content is the only thing removed, and reading it back is possible', async () => {
  // Guards against "deleted the wrong session": the surviving id keeps its file
  // AND its content.
  const root = await mkdtemp(join(tmpdir(), 'dsao-archives-'))
  const keep = await seedSession(root, ID_LIVE)
  const drop = await seedSession(root, ID_CLEAN)
  const before = await readFile(keep, 'utf8')
  const registry = registryDouble([ID_CLEAN, ID_LIVE], [ID_CLEAN, ID_LIVE])
  const cleanup = createArchiveCleanup({
    registry,
    persistence: persistenceDouble(root, [ID_CLEAN, ID_LIVE]),
    sessions: { list: () => [{ id: ID_LIVE }] },
  })
  const result = await cleanup.remove([ID_CLEAN])
  assert.equal(result.deleted[0].log, 'removed')
  assert.equal(await exists(drop), false)
  assert.equal(await readFile(keep, 'utf8'), before)
})

let failures = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}`)
  }
}
console.log(failures === 0 ? `\n${tests.length} passed` : `\n${failures} of ${tests.length} failed`)
process.exit(failures === 0 ? 0 : 1)
