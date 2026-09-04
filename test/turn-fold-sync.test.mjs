// 会话切换收敛 + 官方 turn 折叠的组头跟随（v1.7.1 两个补丁的专项测试）。
//
// 补丁 1（converge）：一批移除 ≥ CONVERGE_REMOVAL_THRESHOLD 个 flowItem
//   = React 整列 keyed 替换（会话切换）。旧注入头是 React 不管理的外来
//   节点，必须拆掉重建，否则漂进新会话的列（"工具组头跑到 turn 外"）。
// 补丁 2（hidden 跟随）：dsh 0.1.2+ 官方折叠对 process member 设
//   hidden="until-found"；组头是外来节点，官方不折叠它，需要 DOM 层
//   跟随同步，否则折叠后组头漂在 turn 折叠区外。
//
// Run: node test/turn-fold-sync.test.mjs
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
function makeToolCall(name, { running = false } = {}) {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'tool-call')
  const row = item.appendChild(new StubElement('div'))
  row.setAttribute('data-tool', name)
  if (running) row.setAttribute('data-state', 'running')
  return { item, row }
}
function makeUserRow() {
  const item = new StubElement('div')
  item.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  item.setAttribute('data-chat-flow-kind', 'user')
  return item
}
function headerOf(col) {
  return col.querySelector('[data-dsao-tg-header]')
}

let passed = 0
function ok(cond, msg) { assert.ok(cond, msg); passed++ }

// ─────────────────────────────────────────────────────────────
// 1. 会话切换：整列替换触发 converge（拆旧头 + 重建）
// ─────────────────────────────────────────────────────────────
{
  const tg = loadSrcModule()
  const col = document.createElement('div')
  document.body.appendChild(col)

  // 会话 A：10 行工具调用 → 一个组
  const itemsA = []
  for (let i = 0; i < 10; i++) { const t = makeToolCall('grep'); itemsA.push(t); col.appendChild(t.item) }
  tg.startToolGroupObserver()
  await tick()
  ok(!!headerOf(col), '会话 A 形成组头')
  const headerA = headerOf(col)
  ok(headerA.getAttribute('data-dsao-tg-size') === '10', 'A 组规模 10')

  // 会话切换：React 整列替换（10 个 flowItem 全移除 + 新列 append）
  for (const t of itemsA) col.removeChild(t.item)
  const itemsB = []
  for (let i = 0; i < 3; i++) { const t = makeToolCall('bash'); itemsB.push(t); col.appendChild(t.item) }
  await tick()

  ok(tg.scanStats.converged >= 1, '批替换触发 converge（converged 计数 > 0）')
  const headerB = headerOf(col)
  ok(!!headerB, 'converge 后新组头存在')
  ok(headerB !== headerA, '新组头不是旧头（旧头已拆）')
  ok(headerB.getAttribute('data-dsao-tg-size') === '3', 'B 组规模 3')
  ok(document.querySelectorAll('[data-dsao-tg-header]').length === 1, '全文档只有一个组头')
}

// ─────────────────────────────────────────────────────────────
// 2. 小规模移除（≤7 行）不触发 converge，走普通 full scan
// ─────────────────────────────────────────────────────────────
{
  const tg = loadSrcModule()
  const col = document.createElement('div')
  document.body.appendChild(col)
  const items = []
  for (let i = 0; i < 4; i++) { const t = makeToolCall('read'); items.push(t); col.appendChild(t.item) }
  tg.startToolGroupObserver()
  await tick()
  const before = tg.scanStats.converged
  col.removeChild(items[3].item)
  await tick()
  ok(tg.scanStats.converged === before, '单行移除不触发 converge')
  ok(tg.scanStats.full >= 2, '单行移除走 full scan')
  ok(headerOf(col).getAttribute('data-dsao-tg-size') === '3', '组缩为 3')
}

// ─────────────────────────────────────────────────────────────
// 3. 官方折叠：member 设 hidden → 组头跟随 hidden
// ─────────────────────────────────────────────────────────────
{
  const tg = loadSrcModule()
  const col = document.createElement('div')
  document.body.appendChild(col)
  for (let i = 0; i < 3; i++) col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  await tick()
  const header = headerOf(col)
  ok(!header.hasAttribute('hidden'), '初始组头可见')

  // 官方折叠：给第一个 member 设 hidden="until-found"（官方 React 行为）
  const first = col.querySelector('[data-chat-flow-kind="tool-call"]')
  first.setAttribute('hidden', 'until-found')
  await tick()

  ok(header.hasAttribute('hidden'), 'member hidden 后组头跟随隐藏')
  ok(header.getAttribute('hidden') === 'until-found', '组头 hidden 值与官方一致')

  // 官方展开：移除 hidden → 组头恢复
  first.removeAttribute('hidden')
  await tick()
  ok(!header.hasAttribute('hidden'), 'member 展开后组头恢复可见')
}

// ─────────────────────────────────────────────────────────────
// 4. 中断 turn（turn-error 行独立于折叠）：error 行不破坏组
// ─────────────────────────────────────────────────────────────
{
  const tg = loadSrcModule()
  const col = document.createElement('div')
  document.body.appendChild(col)
  for (let i = 0; i < 3; i++) col.appendChild(makeToolCall('grep').item)
  tg.startToolGroupObserver()
  await tick()

  // 官方在 turn 末尾插入 turn-error 行（TURN_PROCESS_INDEPENDENT_KINDS，
  // 独立于折叠区外）并折叠过程：组头应跟随隐藏而非漂出
  const errRow = new StubElement('div')
  errRow.setAttribute('data-chat-flow-key', 'k' + (keySeq++))
  errRow.setAttribute('data-chat-flow-kind', 'turn-error')
  col.appendChild(errRow)
  const first = col.querySelector('[data-chat-flow-kind="tool-call"]')
  first.setAttribute('hidden', 'until-found')
  await tick()

  ok(headerOf(col).hasAttribute('hidden'), '中断 turn 折叠时组头跟随隐藏（不漂出）')
}

console.log(`turn-fold-sync: ${passed} assertions passed`)
