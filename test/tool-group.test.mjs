// Tool-group incremental scan: verify the shipped (lib) variant re-runs only
// the tail/latest group in steady state, and falls back to a full O(body) scan
// exactly on invalidation events (removals, batch adds, conversation switches,
// turn-status mount). Tests exercise the exact code that ships, loaded from
// lib/client.js, against a stub DOM with a real MutationObserver.
import assert from 'node:assert/strict'
import {
  installStubDocument,
  tick,
  StubElement,
} from './dom-stub.mjs'
import { loadBundleModule } from './load-module.mjs'

let keySeq = 0

function freshModule() {
  installStubDocument()
  return loadBundleModule('dsao/tool-group')
}

function makeColumn() {
  const col = document.createElement('div')
  document.body.appendChild(col)
  return col
}

function makeToolCall(name, { running = false } = {}) {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'tool-call')
  item.textContent = name // non-empty → not a transparent node
  const row = item.appendChild(new StubElement('div'))
  row.setAttribute('data-tool', name)
  if (running) row.setAttribute('data-state', 'running')
  return { item, row }
}

function makeTransparent() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'assistant-step')
  item.textContent = '' // empty → transparent
  return item
}

function makeText() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'assistant-text')
  item.textContent = 'assistant says hi' // non-empty → real content
  return item
}

function headerOf(col) {
  return col.querySelector('[data-dsao-tg-header]')
}

function summaryOf(col) {
  const h = headerOf(col)
  if (!h) return null
  const s = h.querySelector('[data-dsao-tg-summary]')
  return s ? s.textContent : null
}


function makeThinkOnly() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'assistant-step')
  item.textContent = '' // 自身无文本；只有 think 折叠行
  const think = item.appendChild(new StubElement('div'))
  think.setAttribute('data-variant', 'think')
  think.textContent = 'Think · reasoning preview' // think 行自身有文本（不计入判定）
  return item
}

function makeStepWithText() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'assistant-step')
  item.textContent = '先看结果，再继续下一步' // think + 正文 → 不是纯思考步（仍是边界）
  const think = item.appendChild(new StubElement('div'))
  think.setAttribute('data-variant', 'think')
  think.textContent = 'Think · …'
  return item
}

let passed = 0
function ok(cond, msg) {
  assert.ok(cond, msg)
  passed++
}

// ── 1. Initial open: one full scan, group of 2, collapsed (no active turn) ──
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeTransparent())
  col.appendChild(makeToolCall('grep').item)

  tg.startToolGroupObserver() // initial full scan runs synchronously

  const h = headerOf(col)
  ok(h, 'initial: header created')
  ok(h.getAttribute('data-dsao-tg-size') === '2', 'initial: size 2')
  ok(h.getAttribute('data-dsao-tg-state') === 'collapsed', 'initial: collapsed (no turn)')
  ok(summaryOf(col) === 'read\u3001grep \u00B7 2 \u4E2A\u5DE5\u5177', 'initial: summary text')
  ok(tg.scanStats.full === 1, 'initial: exactly one full scan')
  ok(tg.scanStats.tail === 0 && tg.scanStats.attr === 0, 'initial: no tail/attr scans')
}

// ── 2. Tail append: incremental (tail tier), group grows to 3 ──────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeTransparent())
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  const c = makeToolCall('bash')
  col.appendChild(c.item) // single node at the tail
  await tick()

  const h = headerOf(col)
  ok(h.getAttribute('data-dsao-tg-size') === '3', 'tail: group grew to 3')
  ok(summaryOf(col) === 'read\u3001grep\u3001bash \u00B7 3 \u4E2A\u5DE5\u5177', 'tail: summary updated')
  ok(h.getAttribute('data-dsao-tg-state') === 'collapsed', 'tail: still collapsed (no turn)')
  ok(tg.scanStats.full === 1, 'tail: NO extra full scan')
  ok(tg.scanStats.tail === 1, 'tail: exactly one tail scan')
  // The header swap inside applyGroup is our own write → ignored, not a rescan.
  ok(tg.scanStats.attr === 0, 'tail: no attr scan')
}

// ── 3. data-state flip: incremental (attr tier), latest group expands ─────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read')
  col.appendChild(a.item)
  col.appendChild(makeTransparent())
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  a.row.setAttribute('data-state', 'running') // a tool starts running
  await tick()

  const h = headerOf(col)
  ok(h.getAttribute('data-dsao-tg-state') === 'expanded', 'attr: group expanded (tool running)')
  ok(tg.scanStats.full === 1, 'attr: NO full scan on data-state flip')
  ok(tg.scanStats.attr === 1, 'attr: exactly one attr scan')

  a.row.setAttribute('data-state', 'ok') // tool settles, turn idle
  await tick()
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'collapsed', 'attr: collapsed once settled')
  ok(tg.scanStats.attr === 2, 'attr: second attr scan')
  ok(tg.scanStats.full === 1, 'attr: still no full scan')
}

// ── 4. Removal: invalidation → full scan, group re-formed ─────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeTransparent())
  const b = makeToolCall('grep')
  col.appendChild(b.item)
  col.appendChild(makeToolCall('bash').item)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-size'), '3')

  col.removeChild(b.item) // break the run in the middle
  await tick()

  ok(tg.scanStats.full === 2, 'removal: full scan triggered')
  const h = headerOf(col)
  ok(h.getAttribute('data-dsao-tg-size') === '2', 'removal: group re-formed to 2')
  ok(summaryOf(col) === 'read\u3001bash \u00B7 2 \u4E2A\u5DE5\u5177', 'removal: summary reflects survivors')
}

// ── 5. Batch add: invalidation → full scan ─────────────────────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  const a = makeToolCall('grep')
  const b = makeToolCall('bash')
  // Two appends in the same synchronous window → one observer batch of two
  // flow items → must classify as a batch (full), not a tail append.
  col.appendChild(a.item)
  col.appendChild(b.item)
  await tick()

  ok(tg.scanStats.full === 2, 'batch: full scan (not tail)')
  ok(tg.scanStats.tail === 0, 'batch: no tail scan')
  const h = headerOf(col)
  ok(h && h.getAttribute('data-dsao-tg-size') === '3', 'batch: all three grouped')
}

// ── 6. Non-tail (middle) insertion: invalidation → full scan ───────────────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read')
  const b = makeToolCall('grep')
  const c = makeToolCall('bash')
  col.appendChild(a.item)
  col.appendChild(b.item)
  col.appendChild(c.item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  const mid = makeToolCall('write')
  col.insertBefore(mid.item, c.item) // inserted before the last item → not tail
  await tick()

  ok(tg.scanStats.full === 2, 'middle insert: full scan (not tail)')
  ok(tg.scanStats.tail === 0, 'middle insert: no tail scan')
}

// ── 7. Conversation switch: remove all + add new → full scan ──────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-size'), '2')

  for (const child of col.children.slice()) col.removeChild(child)
  col.appendChild(makeToolCall('web_search').item)
  col.appendChild(makeToolCall('glob').item)
  await tick()

  ok(tg.scanStats.full >= 2, 'switch: full scan on rebuild')
  const h = headerOf(col)
  ok(h && h.getAttribute('data-dsao-tg-size') === '2', 'switch: new group formed')
  ok(summaryOf(col) === 'web_search\u3001glob \u00B7 2 \u4E2A\u5DE5\u5177', 'switch: new summary')
}

// ── 8. Turn-status mount: chrome → full scan; group stays expanded ────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-state'), 'collapsed')

  const status = new StubElement('div')
  status.className = 'abc_turnStatus' // matches [class*="_turnStatus"]
  col.appendChild(status)
  await tick()

  ok(tg.scanStats.full === 2, 'turn-status: full scan (chrome mount)')
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'expanded', 'turn-status: group expanded (turn active, no content after)')
}

// ── 9. Real content after the group: tail (non-groupable) → collapse ──────
{
  const tg = freshModule()
  const col = makeColumn()
  const status = new StubElement('div')
  status.className = 'abc_turnStatus'
  const a = makeToolCall('read')
  const b = makeToolCall('grep')
  col.appendChild(a.item)
  col.appendChild(b.item)
  col.appendChild(status) // turn active
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-state'), 'expanded')

  col.appendChild(makeText()) // assistant text arrives after the group
  await tick()

  ok(tg.scanStats.tail === 1, 'content-after: tail scan (non-groupable at tail)')
  ok(tg.scanStats.full === 1, 'content-after: no full scan')
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'collapsed', 'content-after: group collapsed')
}

// ── 10. User toggled a header: auto-management respects the choice ────────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read', { running: true })
  const b = makeToolCall('grep')
  col.appendChild(a.item)
  col.appendChild(b.item)
  tg.startToolGroupObserver()
  const h = headerOf(col)
  assert.equal(h.getAttribute('data-dsao-tg-state'), 'expanded')

  // Simulate a user click: flag the group as user-controlled and collapse it
  // (the click handler sets data-dsao-tg-user then toggles the state).
  h.setAttribute('data-dsao-tg-user', '')
  h.setAttribute('data-dsao-tg-state', 'collapsed')

  // A further data-state flip must NOT re-expand a user-controlled group.
  b.row.setAttribute('data-state', 'running')
  await tick()
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'collapsed', 'user flag: stays collapsed despite running tool')
}

// ── 11. Accumulator: a tail add + a data-state flip in ONE window ─────────
// The later attr batch must not replace the earlier tail add (the debounce
// reschedule used to drop it). The tail add survives and the state is
// re-evaluated by the tail scan's manageLatestGroup.
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read')
  col.appendChild(a.item)
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-size'), '2')

  const c = makeToolCall('bash')
  col.appendChild(c.item)               // batch 1: tail add
  await Promise.resolve()               // deliver batch 1 → pending.item = C
  a.row.setAttribute('data-state', 'running') // batch 2: attr flip
  await tick()                          // deliver batch 2 + 80ms debounce fires

  ok(headerOf(col).getAttribute('data-dsao-tg-size') === '3', 'acc: tail add preserved (group grew to 3)')
  ok(tg.scanStats.full === 1, 'acc: NO full scan')
  ok(tg.scanStats.tail === 1, 'acc: exactly one tail scan')
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'expanded', 'acc: state re-evaluated (running → expanded)')
}

// ── 12. Accumulator: two tail adds in ONE window collapse to full ─────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-size'), '2')

  const c = makeToolCall('bash')
  col.appendChild(c.item)      // batch 1: tail
  await Promise.resolve()      // deliver batch 1 → pending.item = C
  const d = makeToolCall('web_search')
  col.appendChild(d.item)      // batch 2: tail, but pending.item set → full
  await tick()

  ok(headerOf(col).getAttribute('data-dsao-tg-size') === '4', 'acc2: all four grouped')
  ok(tg.scanStats.full === 2, 'acc2: full scan (two tail adds in one window)')
  ok(tg.scanStats.tail === 0, 'acc2: no tail scan')
}


// ── 13. 工具调用之间仅隔纯思考步 → 合并为同一组（核心新行为）──────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeThinkOnly())
  col.appendChild(makeToolCall('grep').item)

  tg.startToolGroupObserver()

  const h = headerOf(col)
  ok(h, 'think-between: header created')
  ok(h.getAttribute('data-dsao-tg-size') === '2', 'think-between: size 2（思考不计入工具数）')
  ok(summaryOf(col) === 'read、grep · 2 个工具', 'think-between: summary')
  ok(h.getAttribute('data-dsao-tg-state') === 'collapsed', 'think-between: collapsed by default')
  const thinkEl = col.querySelector('[data-chat-flow-kind="assistant-step"]')
  ok(thinkEl && thinkEl.hasAttribute('data-dsao-tg-collapsed'), 'think-between: 折叠跨度收起思考行')
  ok(thinkEl && thinkEl.hasAttribute('data-dsao-tg-pos'), 'think-between: 思考行带组缩进标记')
}

// ── 13b. 尾部增量路径：think 之后的工具仍并入（tail scan 跨思考步回走）────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeThinkOnly())
  tg.startToolGroupObserver()
  assert.equal(headerOf(col), null, 'tail-think: 单工具无组')

  col.appendChild(makeToolCall('grep').item)
  await tick()

  const h = headerOf(col)
  ok(h && h.getAttribute('data-dsao-tg-size') === '2', 'tail-think: 跨思考步并入同组')
  ok(tg.scanStats.tail === 1, 'tail-think: 走 tail 增量（未触发全扫）')
}

// ── 14. 边界保留：think+正文 组合步、纯文本步仍打断分组 ────────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeStepWithText()) // think + 正文 → 非纯思考步
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  ok(headerOf(col) === null, 'boundary: think+正文 步仍是分组边界')

  // 旧行为回归：assistant-text 类（makeText 同型）仍边界
  const col2 = makeColumn()
  col2.appendChild(makeToolCall('read').item)
  col2.appendChild(makeText())
  col2.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver() // 复用同模块二次扫描（幂等）
  ok(headerOf(col) === null && headerOf(col2) === null, 'boundary: assistant-text 仍是边界（现状保持）')
}

// ── 15. 纯思考步在尾部不触发收起（无越组渲染信号）─────────────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read')
  const b = makeToolCall('grep')
  col.appendChild(a.item)
  col.appendChild(b.item)
  const status = new StubElement('div')
  status.className = 'abc_turnStatus'
  col.appendChild(status)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-state'), 'expanded')

  col.appendChild(makeThinkOnly()) // 只有思考行到达
  await tick()

  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'expanded', 'think-tail: 不误判为越组内容')

  col.appendChild(makeStepWithText()) // 真正的正文到达 → 收起
  await tick()
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'collapsed', 'think-tail: 正文到达照常收起')
}

// ── 16. 组解散后思考行的孤儿折叠标记被清理 ────────────────────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read').item
  const think = makeThinkOnly()
  const b = makeToolCall('grep').item
  col.appendChild(a)
  col.appendChild(think)
  col.appendChild(b)
  tg.startToolGroupObserver()
  ok(think.hasAttribute('data-dsao-tg-collapsed'), 'cleanup: 组折叠时思考行随跨度收起')

  col.removeChild(b) // 组解散（剩 1 个成员；stub 无 Element.remove）
  await tick()

  ok(headerOf(col) === null, 'cleanup: 头已拆')
  ok(!think.hasAttribute('data-dsao-tg-collapsed'), 'cleanup: 思考行孤儿标记已清')
}

// ── 13c. 深层嵌套思考行（真实 DOM：flowItem>root>body>ProcessReasoning>Row）──
// textContent 按聚合模型模拟（父含 think 子树文本），守护 textOutsideThink 的
// 深度无关扣除——旧实现只扣直接子级，此用例会失败。
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  const step = new StubElement('div')
  step.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  step.setAttribute('data-chat-flow-kind', 'assistant-step')
  // 聚合模型：step 的 textContent 含 think 行全文（真实 DOM 行为）
  const THINK_TEXT = 'Think\u00B7The user wants merging'
  step.textContent = THINK_TEXT
  const mdRoot = step.appendChild(new StubElement('div'))
  const body = mdRoot.appendChild(new StubElement('div'))
  const inline = body.appendChild(new StubElement('div'))
  inline.setAttribute('data-turn-process-inline', '')
  const think = inline.appendChild(new StubElement('div'))
  think.setAttribute('data-variant', 'think')
  think.textContent = THINK_TEXT
  col.appendChild(step)
  col.appendChild(makeToolCall('grep').item)

  tg.startToolGroupObserver()

  const h = headerOf(col)
  ok(h && h.getAttribute('data-dsao-tg-size') === '2', 'nested-think: 跨深层思考行合并为同组')
}

// ── 17. 组缩进：header 与组首之间的思考行入跨度；运行展开态有缩进无折叠 ──
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read').item
  const b = makeToolCall('grep').item
  col.appendChild(a)
  col.appendChild(b)
  tg.startToolGroupObserver()
  const h = headerOf(col)
  ok(h, 'indent: 组已建')

  // think 插在组头与组首成员之间（流式 reasoning 先于首工具重排的现实场景）
  const think = makeThinkOnly()
  col.insertBefore(think, a)
  await tick()

  ok(think.hasAttribute('data-dsao-tg-pos'), 'indent: 头后思考行入跨度带缩进')
  ok(think.hasAttribute('data-dsao-tg-collapsed'), 'indent: 折叠态随组收起')

  // 运行展开：grep 转为 running → 组展开 → 思考行保留缩进、解除折叠
  const grepRow = b.querySelector('[data-tool]')
  grepRow.setAttribute('data-state', 'running')
  await tick()
  ok(headerOf(col).getAttribute('data-dsao-tg-state') === 'expanded', 'indent: 运行展开')
  ok(think.hasAttribute('data-dsao-tg-pos'), 'indent: 展开态思考行仍缩进')
  ok(!think.hasAttribute('data-dsao-tg-collapsed'), 'indent: 展开态思考行可见')
}

// ── 13d. 多条纯思考步连续夹层 → 仍合并为同组 ─────────────────────────────
{
  const tg = freshModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeThinkOnly())
  col.appendChild(makeThinkOnly())
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  const h = headerOf(col)
  ok(h && h.getAttribute('data-dsao-tg-size') === '2', 'multi-think: 跨多条思考行合并')
  const thinks = col.querySelectorAll('[data-dsao-tg-collapsed]')
  let thinkCollapsed = 0
  for (const el of thinks) if (el.getAttribute('data-chat-flow-kind') === 'assistant-step') thinkCollapsed++
  ok(thinkCollapsed === 2, 'multi-think: 两条思考行都随跨度收起')
}

// ── 18. 官方 turn 折叠联动：成员 hidden → 组头 hidden=until-found ────────
{
  const tg = freshModule()
  const col = makeColumn()
  const a = makeToolCall('read').item
  const b = makeToolCall('grep').item
  col.appendChild(a)
  col.appendChild(b)
  tg.startToolGroupObserver()
  const h = headerOf(col)
  ok(h && !h.hasAttribute('hidden'), 'fold-sync: 未折叠时组头无 hidden')

  a.setAttribute('hidden', 'until-found') // 官方折叠 process member
  tg.scanToolGroups(document.body)
  ok(h.hasAttribute('hidden') && h.getAttribute('hidden') === 'until-found', 'fold-sync: 组头跟随官方折叠')

  a.removeAttribute('hidden') // 官方展开
  tg.scanToolGroups(document.body)
  ok(!h.hasAttribute('hidden'), 'fold-sync: 官方展开后组头恢复')
}

console.log(`tool-group: ${passed} assertions passed`)
