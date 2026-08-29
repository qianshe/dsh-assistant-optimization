// Verify the turn-fold plan with real DSH snapshot shapes.
// Run: node test/turn-fold.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
const {
  planTurnFold, isProcessNode, formatDuration, terminalLabel,
  isResumeMarkerNode,
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

// ── 11. runs: 运行中 turn 的「运行中」行锚点 ─────────────────────────────
{
  // 运行中 turn：user + streaming assistant → 锚到第一个过程节点前（before=true）
  const u = node('ru1', 'user', { kind: 'user' })
  const streaming = node('ru2', 'assistant-step', { kind: 'assistant', finalNode: undefined, blocks: [{ kind: 'reasoning', text: '...' }] })
  const tool = node('ru3', 'tool-call', { kind: 'tool' })
  const s = makeSession([{ num: 9, status: 'open', startT: 1000000, nodes: [u, streaming, tool] }])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 0) // 运行中不生成折叠
  assert.equal(plan.runs.length, 1)
  const run = plan.runs[0]
  assert.equal(run.turn, 9)
  assert.equal(run.anchorKey, 'ru2') // 第一个过程节点
  assert.equal(run.before, true)
  assert.equal(run.startTime, 1000000)
}

{
  // 运行中 turn：只有 user（尚无过程节点）→ 锚到该 turn 最后一个节点之后（before=false）
  const u = node('rd1', 'user', { kind: 'user' })
  const s = makeSession([{ num: 8, status: 'open', startT: 500000, nodes: [u] }])
  const plan = planTurnFold(s)
  assert.equal(plan.runs.length, 1)
  assert.equal(plan.runs[0].anchorKey, 'rd1')
  assert.equal(plan.runs[0].before, false)
}

// 运行中 turn 无 start → 不进 runs；closed turn 不进 runs
{
  const u = node('rx1', 'user', { kind: 'user' })
  const s = makeSession([{ num: 8, status: 'open', nodes: [u] }]) // 无 startT
  assert.equal(planTurnFold(s).runs.length, 0)
}
{
  const u = node('ry1', 'user', { kind: 'user' })
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 1000, nodes: [u] }])
  assert.equal(planTurnFold(s).runs.length, 0)
}

// ── 12. 中断续跑归并：aborted + resumed ⇒ 单一折叠组 ────────────────────
{
  const u = node('m0', 'user', { kind: 'user' })
  const partial = node('m1', 'assistant-step', { kind: 'assistant', finalNode: { seq: 41 }, blocks: [{ kind: 'text', text: '半截回复' }] })
  const tool1 = node('m2', 'tool-call', { kind: 'tool' })
  const tailA = node('m3', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: { finalNode: { seq: 41 } } })
  const marker = node('m4', 'user', { kind: 'user', source: { dsaoResume: true }, content: [] })
  const tool2 = node('m5', 'tool-call', { kind: 'tool' })
  const finalStep = node('m6', 'assistant-step', { kind: 'assistant', finalNode: { seq: 52 }, blocks: [{ kind: 'text', text: '最终回复' }] })
  const tailB = node('m7', 'turn-tail', { kind: 'turn-tail', turn: 2, closing: { finalNode: { seq: 52 } } })
  const s = makeSession([
    { num: 1, status: 'closed', startT: 0, endT: 630000, reason: 'aborted', nodes: [u, partial, tool1, tailA] },
    { num: 2, status: 'closed', startT: 700000, endT: 2045000, nodes: [marker, tool2, finalStep, tailB] },
  ])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 1)
  const f = plan.folds[0]
  assert.equal(f.turn, 1)
  // 链模型：非末段只留真实输入（m1 半截回复/m2 工具/m3 tail 全隐藏）；
  // 末段 marker（m4）与过程（m5）隐藏，closing/tail 保留
  assert.deepEqual(f.hiddenKeys, ['m1', 'm2', 'm3', 'm4', 'm5'])
  assert.equal(f.anchorKey, 'm1')
  assert.equal(f.closingKey, 'm6')
  assert.equal(f.reasonKind, 'completed')
  // 活跃时长求和：10分30秒 + 22分25秒 = 32分55秒（不含段间闲置 7 秒）
  assert.equal(f.headerText, '已完成 · 32分55秒')
  // 位置域归属改写到组 id
  assert.equal(plan.turnOf.get('m5'), 1)
  assert.equal(plan.turnOf.get('m6'), 1)
}

// ── 13. 归并负例：用户新起 prompt（无 marker）→ 不合并 ─────────────────
{
  const u1 = node('n0', 'user', { kind: 'user' })
  const partial = node('n1', 'assistant-step', { kind: 'assistant', finalNode: { seq: 61 }, blocks: [{ kind: 'text', text: '半截回复' }] })
  const tool1 = node('n2', 'tool-call', { kind: 'tool' })
  const tailA = node('n3', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: { finalNode: { seq: 61 } } })
  const fresh = node('n4', 'user', { kind: 'user', content: [{ type: 'text', text: '换个问题' }] })
  const tool2 = node('n5', 'tool-call', { kind: 'tool' })
  const finalStep = node('n6', 'assistant-step', { kind: 'assistant', finalNode: { seq: 62 }, blocks: [{ kind: 'text', text: '回答' }] })
  const tailB = node('n7', 'turn-tail', { kind: 'turn-tail', turn: 2, closing: { finalNode: { seq: 62 } } })
  const s = makeSession([
    { num: 1, status: 'closed', startT: 0, endT: 630000, reason: 'aborted', nodes: [u1, partial, tool1, tailA] },
    { num: 2, status: 'closed', startT: 700000, endT: 2045000, nodes: [fresh, tool2, finalStep, tailB] },
  ])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 2)
  assert.deepEqual(plan.folds.map(f => f.turn), [1, 2])
}

// ── 14. isResumeMarkerNode 判定 ─────────────────────────────────────────
assert.equal(isResumeMarkerNode(node('x', 'user', { kind: 'user', source: { dsaoResume: true }, content: [] })), true)
assert.equal(isResumeMarkerNode(node('x', 'user', { kind: 'user', source: { dsaoResume: true }, content: [{ type: 'text', text: '  ' }] })), true)
assert.equal(isResumeMarkerNode(node('x', 'user', { kind: 'user', source: { dsaoResume: true }, content: [{ type: 'text', text: '真实输入' }] })), false)
assert.equal(isResumeMarkerNode(node('x', 'user', { kind: 'user', content: [] })), false)
assert.equal(isResumeMarkerNode(node('x', 'assistant-step', { source: { dsaoResume: true }, content: [] })), false)
assert.equal(isResumeMarkerNode(null), false)

// ── 15. 链跨越无 fold 的纯报错段（上游 400 → 继续 → 手动停止，截图态）───
{
  const u = node('q0', 'user', { kind: 'user' })
  const err1 = node('q1', 'turn-error', { kind: 'error' })
  const tail1 = node('q2', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: null })
  const marker = node('q3', 'user', { kind: 'user', source: { dsaoResume: true }, content: [] })
  const err2 = node('q4', 'turn-error', { kind: 'error' })
  const tail2 = node('q5', 'turn-tail', { kind: 'turn-tail', turn: 2, closing: null })
  const marker2 = node('q6', 'user', { kind: 'user', source: { dsaoResume: true }, content: [] })
  const tool = node('q7', 'tool-call', { kind: 'tool' })
  const finalStep = node('q8', 'assistant-step', { kind: 'assistant', finalNode: { seq: 91 }, blocks: [{ kind: 'text', text: 'final' }] })
  const tail3 = node('q9', 'turn-tail', { kind: 'turn-tail', turn: 3, closing: { finalNode: { seq: 91 } } })
  const s = makeSession([
    { num: 1, status: 'closed', startT: 0, endT: 2000, reason: 'error', nodes: [u, err1, tail1] },
    { num: 2, status: 'closed', startT: 3000, endT: 5000, reason: 'error', nodes: [marker, err2, tail2] },
    { num: 3, status: 'closed', startT: 6000, endT: 66000, reason: 'aborted', nodes: [marker2, tool, finalStep, tail3] },
  ])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 1)
  const f = plan.folds[0]
  assert.equal(f.turn, 1)
  // 无 fold 的报错段（q1/q4 错误行、q2/q5 tail）与组内 marker（q3/q6）全部收进组
  assert.deepEqual(f.hiddenKeys, ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'])
  assert.equal(f.anchorKey, 'q1')
  assert.equal(f.closingKey, 'q8')
  assert.equal(f.reasonKind, 'aborted')
  // 活跃时长 2s + 2s + 60s
  assert.equal(f.headerText, '已停止 · 1分04秒')
  assert.equal(plan.turnOf.get('q7'), 1)
  assert.equal(plan.turnOf.get('q4'), 1)
}

// ── 16. 运行中插话（steering）随折叠收起 + 头计数 ───────────────────────
{
  const u = node('w0', 'user', { kind: 'user' })
  const tool1 = node('w1', 'tool-call', { kind: 'tool' })
  const steer = node('w2', 'steering', { kind: 'user', content: [{ type: 'text', text: '补充一下' }] })
  const tool2 = node('w3', 'tool-call', { kind: 'tool' })
  const finalStep = node('w4', 'assistant-step', { kind: 'assistant', finalNode: { seq: 101 }, blocks: [{ kind: 'text', text: 'done' }] })
  const tail = node('w5', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: { finalNode: { seq: 101 } } })
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 60000, nodes: [u, tool1, steer, tool2, finalStep, tail] }])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 1)
  const f = plan.folds[0]
  assert.deepEqual(f.hiddenKeys, ['w1', 'w2', 'w3'])
  assert.equal(f.anchorKey, 'w1')
  assert.equal(f.headerText, '已完成 · 1分00秒 · 1 条插话')
}
// 插话先于一切过程节点 → 锚点取插话，且仅凭插话也可成组
{
  const u = node('x0', 'user', { kind: 'user' })
  const steer = node('x1', 'steering', { kind: 'user', content: [] })
  const finalStep = node('x2', 'assistant-step', { kind: 'assistant', finalNode: { seq: 111 }, blocks: [{ kind: 'text', text: 'ok' }] })
  const tail = node('x3', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: { finalNode: { seq: 111 } } })
  const s = makeSession([{ num: 1, status: 'closed', startT: 0, endT: 5000, nodes: [u, steer, finalStep, tail] }])
  const f = planTurnFold(s).folds[0]
  assert.deepEqual(f.hiddenKeys, ['x1'])
  assert.equal(f.anchorKey, 'x1')
  assert.equal(f.headerText, '已完成 · 5秒 · 1 条插话')
}

// ── 17. 链归并末段的插话同样收起并计入 ─────────────────────────────────
{
  const u = node('y0', 'user', { kind: 'user' })
  const tool1 = node('y1', 'tool-call', { kind: 'tool' })
  const tailA = node('y2', 'turn-tail', { kind: 'turn-tail', turn: 1, closing: null })
  const marker = node('y3', 'user', { kind: 'user', source: { dsaoResume: true }, content: [] })
  const steer = node('y4', 'steering', { kind: 'user', content: [] })
  const finalStep = node('y5', 'assistant-step', { kind: 'assistant', finalNode: { seq: 121 }, blocks: [{ kind: 'text', text: 'done' }] })
  const tailB = node('y6', 'turn-tail', { kind: 'turn-tail', turn: 2, closing: { finalNode: { seq: 121 } } })
  const s = makeSession([
    { num: 1, status: 'closed', startT: 0, endT: 5000, reason: 'aborted', nodes: [u, tool1, tailA] },
    { num: 2, status: 'closed', startT: 6000, endT: 66000, nodes: [marker, steer, finalStep, tailB] },
  ])
  const plan = planTurnFold(s)
  assert.equal(plan.folds.length, 1)
  const f = plan.folds[0]
  assert.deepEqual(f.hiddenKeys, ['y1', 'y2', 'y3', 'y4'])
  assert.equal(f.closingKey, 'y5')
  assert.equal(f.headerText, '已完成 · 1分05秒 · 1 条插话')
}

console.log('turn-fold: all assertions passed')
