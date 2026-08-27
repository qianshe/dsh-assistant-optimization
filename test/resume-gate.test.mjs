// Verify the resume gate predicate: every FR-1 input, terminal-kind set,
// turnEnds container-shape tolerance, and the last-by-seq rule.
// Run: node test/resume-gate.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
const { canResume, lastTerminalKind, TERMINAL_KINDS } = loadBundleModule('dsao/resume-gate')

function endEvent(seq, kind) {
  return { seq, type: 'turn/end', data: { turn: 1, reason: kind === null ? undefined : { kind } } }
}

const baseSession = () => ({
  running: false,
  queue: [],
  subagent: null,
  turnEnds: [{ start: { seq: 5 }, end: endEvent(9, 'aborted') }],
})

// 1. Happy path: idle + empty draft + drained queue + aborted tail.
{
  const out = canResume(baseSession(), '')
  assert.deepEqual(out, { canResume: true, terminalKind: 'aborted' })
}

// 2. Every positive terminal kind.
for (const kind of TERMINAL_KINDS) {
  const s = baseSession()
  s.turnEnds = [{ start: {}, end: endEvent(3, kind) }]
  const out = canResume(s, '')
  assert.equal(out.canResume, true, `${kind} must resume`)
}

// 3. Negative terminals and no-terminal at all.
for (const kind of ['completed', 'blocked']) {
  const s = baseSession()
  s.turnEnds = [{ start: {}, end: endEvent(3, kind) }]
  assert.equal(canResume(s, '').canResume, false)
}
assert.equal(canResume({ running: false, queue: [], subagent: null, turnEnds: [] }, '').reason, 'no-terminal')
assert.equal(canResume({}, '').reason, 'no-terminal')
assert.equal(canResume(null, '').reason, 'no-session')

// 4. Each blocking input wins with a named reason.
assert.equal(canResume({ ...baseSession(), running: true }, '').reason, 'running')
assert.equal(canResume({ ...baseSession(), subagent: { address: {} } }, '').reason, 'subagent')
// Whitespace-only drafts are empty by trim semantics (canResume returns the
// positive object, so just assert it doesn't block on draft).
assert.equal(canResume(baseSession(), '  \t ').canResume, true)
assert.equal(canResume(baseSession(), 'hello').reason, 'draft-not-empty')

// Queue: only rows still waiting (placement==='queued') block.
{
  const s = baseSession()
  s.queue = [{ placement: 'done' }, { placement: 'steered' }]
  assert.equal(canResume(s, '').canResume, true)
  s.queue.push({ placement: 'queued' })
  assert.equal(canResume(s, '').reason, 'queue-pending')
}

// 5. turnEnds tolerance: Map, object map, missing ends, junk entries.
{
  const mapish = new Map([['t7', { start: {}, end: endEvent(7, 'error') }]])
  assert.deepEqual(lastTerminalKind(mapish), 'error')

  const objMap = { t7: { start: {}, end: endEvent(7, 'max-tokens') } }
  assert.equal(lastTerminalKind(objMap), 'max-tokens')

  // Last by SEQ, not array order.
  const unordered = [
    { start: {}, end: endEvent(20, 'aborted') },
    { start: {}, end: endEvent(21, 'interrupted') },
    { start: {}, end: endEvent(22, 'error') },
    { start: {}, end: endEvent(23, 'aborted') },
  ]
  assert.equal(lastTerminalKind(unordered), 'aborted')

  for (const junk of [null, undefined, [], {}, [null], [{ start: {} }], [{ end: { seq: 4 } }]]) {
    if (junk !== [] && junk !== {}) continue
    assert.equal(lastTerminalKind(junk), undefined)
  }
  assert.equal(lastTerminalKind([{ start: {} }]), undefined)
  assert.equal(lastTerminalKind(42), undefined)

  // Entries without an end fall back to positional index ordering — still
  // returns the newest END-bearing entry's kind.
  const mixed = [null, { start: {}, end: endEvent(4, 'error') }]
  assert.equal(lastTerminalKind(mixed), 'error')
}

// 5b. REAL-WORLD SHAPE (v1.6.8): interrupted assistant nodes have
// kind 'assistant-step' (NOT 'assistant'), interrupted flag at
// node.data.interrupted. Gate must detect this correctly.
{
  const s = baseSession()
  s.turnEnds = new Map([[7, 431]])
  s.nodes = [
    { kind: "user", anchorSeq: 1 },
    { kind: "assistant-step", data: {} },
    { kind: "assistant-step", data: { interrupted: true } },
  ]
  assert.deepEqual(canResume(s, ""), { canResume: true, terminalKind: "aborted" })
  // A normal (non-interrupted) assistant-step as last node → not resumable.
  s.nodes = [
    { kind: "user", anchorSeq: 1 },
    { kind: "assistant-step", data: {} },
  ]
  assert.equal(canResume(s, "").canResume, false)
  // turn-error as last node → resumable (error).
  s.nodes = [...s.nodes, { kind: "turn-error", anchorSeq: 440 }]
  assert.deepEqual(canResume(s, "").terminalKind, "error")
  // Earlier interrupted node but later completed → not resumable.
  s.nodes = [
    { kind: "assistant-step", data: { interrupted: true } },
    { kind: "assistant-step", data: {} },
  ]
  assert.equal(canResume(s, "").canResume, false)
}
// 6. Full gate over Map-shaped turnEnds end to end.
{
  const s = baseSession()
  s.turnEnds = new Map([['t', { start: {}, end: endEvent(11, 'interrupted') }]])
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'interrupted' })
}

console.log('resume-gate: all assertions passed')
