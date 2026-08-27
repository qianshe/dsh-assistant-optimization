// Verify the resume gate predicate — timeline-based approach.
// Run: node test/resume-gate.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
const { canResume, lastTurnReasonKind, RESUMABLE_KINDS } = loadBundleModule('dsao/resume-gate')

// ── Helpers ──────────────────────────────────────────────────────────────
function makeTurn(num, reasonKind, status = 'closed') {
  return {
    turn: num,
    start: { type: 'turn/start', data: { turn: num }, seq: num * 10 },
    end: reasonKind === undefined ? undefined : {
      type: 'turn/end',
      seq: num * 10 + 9,
      data: { turn: num, reason: { kind: reasonKind } },
    },
    status,
    steps: [],
    data: {},
  }
}

function makeTimeline(...turns) {
  const map = new Map()
  for (const t of turns) map.set(t.turn, t)
  return { turns: map, turnOrder: turns.map(t => t.turn) }
}

function makeSession({ timeline, running, queue, subagent } = {}) {
  return {
    running: running ?? false,
    queue: queue ?? [],
    subagent: subagent ?? null,
    chat: { timeline: timeline ?? makeTimeline() },
  }
}

// ── 1. User stopped (aborted) → resumable ────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'aborted'))
  const s = makeSession({ timeline: tl })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'aborted' })
}

// ── 2. Session error → resumable ─────────────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'error'))
  const s = makeSession({ timeline: tl })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'error' })
}

// ── 3. Max tokens → resumable ────────────────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'max-tokens'))
  const s = makeSession({ timeline: tl })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'max-tokens' })
}

// ── 4. Normal completion → NOT resumable ─────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'completed'))
  const s = makeSession({ timeline: tl })
  assert.equal(canResume(s, '').canResume, false)
  assert.equal(canResume(s, '').terminalKind, 'completed')
}

// ── 5. Blocked → NOT resumable ───────────────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'blocked'))
  const s = makeSession({ timeline: tl })
  assert.equal(canResume(s, '').canResume, false)
}

// ── 6. Multi-turn: earlier aborted, later completed → NOT resumable ──────
{
  const tl = makeTimeline(
    makeTurn(1, 'aborted'),
    makeTurn(2, 'completed'),
  )
  const s = makeSession({ timeline: tl })
  assert.equal(canResume(s, '').canResume, false)
}

// ── 7. Multi-turn: earlier completed, later aborted → resumable ──────────
{
  const tl = makeTimeline(
    makeTurn(1, 'completed'),
    makeTurn(2, 'aborted'),
  )
  const s = makeSession({ timeline: tl })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'aborted' })
}

// ── 8. Open turn (still running) → not terminal from timeline ────────────
{
  const tl = makeTimeline(makeTurn(1, undefined, 'open'))
  const s = makeSession({ timeline: tl })
  assert.equal(canResume(s, '').canResume, false)
}

// ── 9. Blocking inputs ───────────────────────────────────────────────────
{
  const tl = makeTimeline(makeTurn(1, 'aborted'))
  const base = makeSession({ timeline: tl })
  assert.equal(canResume({ ...base, running: true }, '').reason, 'running')
  assert.equal(canResume({ ...base, subagent: { address: {} } }, '').reason, 'subagent')
  assert.equal(canResume(base, 'hello').reason, 'draft-not-empty')
  assert.equal(canResume(base, '  \t ').canResume, true)
  assert.equal(canResume({ ...base, queue: [{ placement: 'queued' }] }, '').reason, 'queue-pending')
}

// ── 10. Edge cases ───────────────────────────────────────────────────────
assert.equal(canResume(null, '').reason, 'no-session')
assert.equal(canResume({}, '').reason, 'no-terminal')
assert.equal(canResume({ chat: {} }, '').reason, 'no-terminal')

// ── 11. lastTurnReasonKind direct tests ──────────────────────────────────
assert.equal(lastTurnReasonKind(makeTimeline(makeTurn(3, 'error'))), 'error')
assert.equal(lastTurnReasonKind(makeTimeline()), undefined)
assert.equal(lastTurnReasonKind(undefined), undefined)
assert.equal(lastTurnReasonKind({ turns: null }), undefined)

console.log('resume-gate: all assertions passed')
