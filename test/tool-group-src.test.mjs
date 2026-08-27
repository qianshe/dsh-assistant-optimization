// Tool-group incremental scan — SRC (hysteresis) variant. The shipped bundle
// (lib) is covered by tool-group.test.mjs; this loads the dev-reference src
// module directly (it uses CommonJS-style `exports`, not an ES export) to
// verify the same tiered scan strategy was mirrored: steady state uses the
// tail/attr tiers, invalidation falls back to a full scan.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { installStubDocument, tick, StubElement } from './dom-stub.mjs'

function loadSrcModule() {
  installStubDocument()
  const src = readFileSync(new URL('../src/modules/tool-group.js', import.meta.url), 'utf8')
  const exportsObj = {}
  new Function('exports', src)(exportsObj)
  return exportsObj
}

let keySeq = 0

function makeColumn() {
  const col = document.createElement('div')
  document.body.appendChild(col)
  return col
}

function makeToolCall(name, { running = false } = {}) {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'tool-call')
  item.textContent = name
  const row = item.appendChild(new StubElement('div'))
  row.setAttribute('data-tool', name)
  if (running) row.setAttribute('data-state', 'running')
  return { item, row }
}

// An empty assistant-step is the src variant's transparent placeholder.
function makeEmptyStep() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'assistant-step')
  item.textContent = ''
  return item
}

function headerOf(col) {
  return col.querySelector('[data-dsao-tg-header]')
}

let passed = 0
function ok(cond, msg) {
  assert.ok(cond, msg)
  passed++
}

// ── 1. Initial open: one full scan, group of 2 ────────────────────────────
{
  const tg = loadSrcModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeEmptyStep())
  col.appendChild(makeToolCall('grep').item)

  tg.startToolGroupObserver()

  const h = headerOf(col)
  ok(h, 'src initial: header created')
  ok(h.getAttribute('data-dsao-tg-size') === '2', 'src initial: size 2')
  ok(tg.scanStats.full === 1, 'src initial: exactly one full scan')
  ok(tg.scanStats.tail === 0 && tg.scanStats.attr === 0, 'src initial: no tail/attr scans')
}

// ── 2. Tail append: incremental (tail tier), group grows to 3 ─────────────
{
  const tg = loadSrcModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeEmptyStep())
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  const c = makeToolCall('bash')
  col.appendChild(c.item)
  await tick()

  ok(headerOf(col).getAttribute('data-dsao-tg-size') === '3', 'src tail: group grew to 3')
  ok(tg.scanStats.full === 1, 'src tail: NO extra full scan')
  ok(tg.scanStats.tail === 1, 'src tail: exactly one tail scan')
}

// ── 3. data-state flip: incremental (attr tier) ───────────────────────────
{
  const tg = loadSrcModule()
  const col = makeColumn()
  const a = makeToolCall('read')
  col.appendChild(a.item)
  col.appendChild(makeEmptyStep())
  col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  assert.equal(tg.scanStats.full, 1)

  a.row.setAttribute('data-state', 'running')
  await tick()

  ok(tg.scanStats.full === 1, 'src attr: NO full scan on data-state flip')
  ok(tg.scanStats.attr === 1, 'src attr: exactly one attr scan')
}

// ── 4. Removal: invalidation → full scan ──────────────────────────────────
{
  const tg = loadSrcModule()
  const col = makeColumn()
  col.appendChild(makeToolCall('read').item)
  col.appendChild(makeEmptyStep())
  const b = makeToolCall('grep')
  col.appendChild(b.item)
  col.appendChild(makeToolCall('bash').item)
  tg.startToolGroupObserver()
  assert.equal(headerOf(col).getAttribute('data-dsao-tg-size'), '3')

  col.removeChild(b.item)
  await tick()

  ok(tg.scanStats.full === 2, 'src removal: full scan triggered')
  ok(headerOf(col).getAttribute('data-dsao-tg-size') === '2', 'src removal: group re-formed to 2')
}

console.log(`tool-group (src): ${passed} assertions passed`)
