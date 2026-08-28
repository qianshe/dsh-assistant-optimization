// Verify the turn-fold plan with real DSH snapshot shapes.
// Run: node test/turn-fold.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
const {
  planTurnFold, isProcessNode, formatDuration, terminalLabel,
  TERMINAL_LABELS,
} = loadBundleModule('dsao/turn-fold')

// ── Helpers: build a snapshot in the shape DSH produces ──────────────────
function node(key, kind, data) {
  return { key, kind, data, anchorSeq: 0, visibility: 'visible' }
}

/**
 * turns: [{ num, status, startT, endT, reason, nodes: [node,...] }]
 * node.location is not needed by the plan (grouping comes from locations.getTurn).
 */
function makeSession(turns) {
  const nodes = new Map()
  const order = []
  const byTurn = {}
  const turnMap = new Map()
  for (const t of turns) {
    byTurn[t.num] = t.nodes.map(n => n.key)
    turnMap.set(t.num, {
      turn: t.num,
      status: t.status,
      start: t.startT !== undefined ? { time: t.startT } : undefined,
      end: t.endT !== undefined
        ? { time: t.endT, data: { turn: t.num, reason: { kind: t.reason ?? 'completed' } } }
        : undefined,
    })
    for (const n of t.nodes) { nodes.set(n.key, n); order.push(n.key) }
  }
  return {
    chat: {
      order,
      nodes,
      locations: { getTurn: (num) => byTurn[num] ?? [] },
      timeline: { turns: turnMap },
    },
  }
}

const u1 = node('k1', 'user', { kind: 'user' })
const thinkOnly = node('k2', 'assistant-step', { kind: 'assistant', finalNode: { seq: 11 }, blocks: [{ kind: 'reasoning', text: 'hmm' }] })
const tool1 = node('k3', 'tool-call', { kind: 'tool' })
// closing step carries thinking + text: the thinking must stay in the fold scope
const finalStep = node('k4', 'assistant-step', { kind: 'assistant', finalNode: { seq: 22 }, blocks: [{ kind: 'reasoning', text: 'final thinking' }, { kind: 'text', text: 'final answer' }] })
const tail1 = node('k5', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: { finalNode: { seq: 22 } } })

// ── 1. Basic closed turn: process hidden, closing + user + tail kept ────
{
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 60000, nodes: [u1, thinkOnly, tool1, finalStep, tail1] }])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 1)
  const fold = plan.folds[0]
  assert.equal(fold.turn, 1)
  assert.deepEqual(fold.hiddenKeys, ['k2', 'k3'])
  assert.equal(fold.anchorKey, 'k2')
  assert.equal(fold.closingKey, 'k4')
  assert.equal(fold.reasonKind, 'completed')
  assert.equal(fold.headerText, '已完成 · 1分00秒')
  assert.ok(plan.keySet.has('k1') && plan.keySet.has('k5'))
}

// ── 2. Turn without process (user + one answer) → no fold ───────────────
{
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 5000, nodes: [u1, finalStep, tail1] }])
  assert.equal(planTurnFold(s).folds.length, 0)
}

// ── 3. Open (running) turn → never folded ───────────────────────────────
{
  const s = makeSession([{ num: 1, status: 'open', startT: 0, nodes: [u1, thinkOnly, tool1] }])
  assert.equal(planTurnFold(s).folds.length, 0)
}

// ── 4. Error turn: error row kept, all steps + tools hidden ─────────────
{
  const err = node('k6', 'turn-error', { kind: 'error' })
  const tail = node('k7', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: null })
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 12000, reason: 'error', nodes: [u1, thinkOnly, tool1, err, tail] }])
  const fold = planTurnFold(s).folds[0]
  assert.deepEqual(fold.hiddenKeys, ['k2', 'k3'])
  assert.equal(fold.closingKey, null)
  assert.equal(fold.reasonKind, 'error')
  assert.equal(fold.headerText, '已出错 · 12秒')
}

// ── 5. Aborted turn → 已停止 ────────────────────────────────────────────
{
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 4000, reason: 'aborted', nodes: [u1, thinkOnly, finalStep, tail1] }])
  const fold = planTurnFold(s).folds[0]
  assert.equal(fold.reasonKind, 'aborted')
  assert.equal(fold.label, '已停止')
}

// ── 6. Multiple closed turns → each folded independently ────────────────
{
  const u2 = node('k8', 'user', { kind: 'user' })
  const mid = node('k9', 'assistant-step', { kind: 'assistant', finalNode: { seq: 31 }, blocks: [{ kind: 'text', text: 'mid answer' }] })
  const tool2 = node('k10', 'tool-call', { kind: 'tool' })
  const final2 = node('k11', 'assistant-step', { kind: 'assistant', finalNode: { seq: 32 }, blocks: [{ kind: 'text', text: 'last answer' }] })
  const tail2 = node('k12', 'turn-tail', { kind: 'turn-tail', turn: 2, closing: { finalNode: { seq: 32 } } })
  const s = makeSession([
    { num: 1, status: 'closed', startT: 0, endT: 60000, nodes: [u1, thinkOnly, tool1, finalStep, tail1] },
    { num: 2, status: 'closed', startT: 70000, endT: 100000, nodes: [u2, mid, tool2, final2, tail2] },
  ])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 2)
  assert.deepEqual(plan.folds.map(f => f.turn), [1, 2])
  // turn 2: intermediate text step + tool are process; final answer kept
  assert.deepEqual(plan.folds[1].hiddenKeys, ['k9', 'k10'])
  assert.equal(plan.folds[1].anchorKey, 'k9')
  assert.equal(plan.folds[1].closingKey, 'k11')
}

// ── 7. Degenerate inputs ─────────────────────────────────────────────────
assert.equal(planTurnFold(null).keySet, null)
assert.equal(planTurnFold({}).keySet, null)
assert.equal(planTurnFold({ chat: {} }).keySet.size, 0)
assert.equal(planTurnFold({ chat: { order: ['k1'] } }).keySet.has('k1'), true)

// ── 8. isProcessNode unit checks ─────────────────────────────────────────
assert.equal(isProcessNode(node('a', 'user', {}), null), false)
assert.equal(isProcessNode(node('a', 'steering', {}), null), false)
assert.equal(isProcessNode(node('a', 'command', {}), null), false)
assert.equal(isProcessNode(node('a', 'tool-call', {}), null), true)
assert.equal(isProcessNode(node('a', 'model-retry', {}), null), true)
assert.equal(isProcessNode(node('a', 'context', {}), null), true)
assert.equal(isProcessNode(node('a', 'compaction', {}), null), true)
assert.equal(isProcessNode(node('a', 'turn-tail', {}), null), false)
assert.equal(isProcessNode(node('a', 'turn-error', {}), null), false)
assert.equal(isProcessNode(node('a', 'unknown', {}), null), false)
assert.equal(isProcessNode(node('a', 'assistant-step', { finalNode: { seq: 5 } }), 5), false)
assert.equal(isProcessNode(node('a', 'assistant-step', { finalNode: { seq: 5 } }), 6), true)
assert.equal(isProcessNode(node('a', 'assistant-step', { finalNode: { seq: 5 } }), null), true)
assert.equal(isProcessNode(null, null), true)

// ── 9. formatDuration（与 DSH 原生计时格式一致） ─────────────────────────
assert.equal(formatDuration(0), '0秒')
assert.equal(formatDuration(5999), '5秒')
assert.equal(formatDuration(59000), '59秒')
assert.equal(formatDuration(60000), '1分00秒')
assert.equal(formatDuration(61000), '1分01秒')
assert.equal(formatDuration(185000), '3分05秒')
assert.equal(formatDuration(3600000), '60分00秒')
assert.equal(formatDuration(3661000), '61分01秒')

// ── 10. terminalLabel ────────────────────────────────────────────────────
assert.equal(terminalLabel('completed'), '已完成')
assert.equal(terminalLabel('aborted'), '已停止')
assert.equal(terminalLabel('error'), '已出错')
assert.equal(terminalLabel('max-tokens'), '已截断')
assert.equal(terminalLabel('whatever'), '已完成')
assert.equal(TERMINAL_LABELS.completed, '已完成')

console.log('turn-fold: all assertions passed')
