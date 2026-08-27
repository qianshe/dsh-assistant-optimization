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

console.log(`tool-group: ${passed} assertions passed`)
