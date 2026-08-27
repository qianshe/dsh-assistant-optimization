// Verify the resume gate predicate with real DSH snapshot shapes.
// Run: node test/resume-gate.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
const { canResume, TERMINAL_KINDS, lastTerminalFromChatNodes, lastTerminalFromLegacyNodes } = loadBundleModule('dsao/resume-gate')

// ── Helpers ──────────────────────────────────────────────────────────────
function makeChatNode(key, kind, data, visibility = 'visible') {
  return { key, kind, data, anchorSeq: 0, visibility }
}

function makeSession({ chat, running, queue, subagent, nodes } = {}) {
  const s = { running: running ?? false, queue: queue ?? [], subagent: subagent ?? null }
  if (chat) s.chat = chat
  if (nodes) s.nodes = nodes
  return s
}

function makeChat(nodes, order) {
  const map = new Map()
  for (const n of nodes) map.set(n.key, n)
  return {
    order: order ?? nodes.map(n => n.key),
    nodes: map,
    legacy: { nodes: [], turnEnds: new Map() },
  }
}

// ── 1. Happy path: interrupted assistant-step as last node ──────────────
{
  const chat = makeChat([
    makeChatNode('u1', 'user', { kind: 'user', seq: 1 }),
    makeChatNode('a1', 'assistant-step', { kind: 'assistant', interrupted: true, turn: 1 }),
  ])
  const s = makeSession({ chat })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'aborted' })
}

// ── 2. Completed session (normal assistant-step, not interrupted) ───────
{
  const chat = makeChat([
    makeChatNode('u1', 'user', { kind: 'user', seq: 1 }),
    makeChatNode('a1', 'assistant-step', { kind: 'assistant', turn: 1 }),
  ])
  const s = makeSession({ chat })
  assert.equal(canResume(s, '').canResume, false)
}

// ── 3. turn-error as last node ──────────────────────────────────────────
{
  const chat = makeChat([
    makeChatNode('a1', 'assistant-step', { kind: 'assistant', turn: 1 }),
    makeChatNode('e1', 'turn-error', { kind: 'error' }),
  ])
  const s = makeSession({ chat })
  assert.deepEqual(canResume(s, '').terminalKind, 'error')
}

// ── 4. turn-max-tokens as last node ─────────────────────────────────────
{
  const chat = makeChat([
    makeChatNode('a1', 'assistant-step', { kind: 'assistant', turn: 1 }),
    makeChatNode('m1', 'turn-max-tokens', { kind: 'max-tokens' }),
  ])
  const s = makeSession({ chat })
  assert.deepEqual(canResume(s, '').terminalKind, 'max-tokens')
}

// ── 5. Earlier interrupted but later completed → NOT resumable ──────────
{
  const chat = makeChat([
    makeChatNode('a1', 'assistant-step', { kind: 'assistant', interrupted: true, turn: 1 }),
    makeChatNode('a2', 'assistant-step', { kind: 'assistant', turn: 2 }),
  ])
  const s = makeSession({ chat })
  assert.equal(canResume(s, '').canResume, false)
}

// ── 6. Blocking inputs ──────────────────────────────────────────────────
{
  const chat = makeChat([makeChatNode('a1', 'assistant-step', { kind: 'assistant', interrupted: true })])
  const base = makeSession({ chat })
  assert.equal(canResume({ ...base, running: true }, '').reason, 'running')
  assert.equal(canResume({ ...base, subagent: { address: {} } }, '').reason, 'subagent')
  assert.equal(canResume(base, 'hello').reason, 'draft-not-empty')
  assert.equal(canResume(base, '  \t ').canResume, true) // whitespace = empty
  const queued = { ...base, queue: [{ placement: 'queued' }] }
  assert.equal(canResume(queued, '').reason, 'queue-pending')
}

// ── 7. Legacy fallback: chat.legacy.nodes ────────────────────────────────
{
  const chat = {
    order: [],
    nodes: new Map(),
    legacy: {
      nodes: [
        { kind: 'user', seq: 1 },
        { kind: 'assistant', interrupted: true, seq: 2 },
      ],
      turnEnds: new Map(),
    },
  }
  const s = makeSession({ chat })
  assert.deepEqual(canResume(s, ''), { canResume: true, terminalKind: 'aborted' })
}

// ── 8. No session / empty ───────────────────────────────────────────────
assert.equal(canResume(null, '').reason, 'no-session')
assert.equal(canResume({}, '').reason, 'no-terminal')

// ── 9. Every terminal kind is resumable ─────────────────────────────────
for (const kind of TERMINAL_KINDS) {
  const chat = makeChat([makeChatNode('x', kind === 'aborted' ? 'assistant-step' : kind === 'error' ? 'turn-error' : 'turn-max-tokens',
    kind === 'aborted' ? { interrupted: true } : {})])
  const s = makeSession({ chat })
  assert.equal(canResume(s, '').canResume, true, `${kind} must resume`)
}

console.log('resume-gate: all assertions passed')
