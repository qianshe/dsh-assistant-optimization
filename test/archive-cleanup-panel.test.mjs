// Verify the archived-session settings page AS SHIPPED: the component is read
// out of lib/client.js (the bundle the browser actually runs) and driven with a
// hook-shaped test React, so the render tree, the two-step delete gate, the four
// states (loading / empty / error / result), the a11y wiring, and the exact
// fetch payloads are exercised rather than re-implemented.
//
// The harness keeps effects to the single mount pass (a real component fetches
// once on mount); every interaction is `click -> drain promises -> settle`,
// which is what React's own act() loop gives you.
// Run: node test/archive-cleanup-panel.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'

const { createArchiveCleanupSection, formatBytes, formatDay, CSS_LINES, projectName, workspaceText, workspacePaths } = loadBundleModule('dsao/archive-cleanup')

/** Scan report in the exact shape lib/archive-cleanup.js produces. */
function reportFixture(overrides = {}) {
  return {
    archivedIds: ['session-a', 'session-b', 'session-c'],
    items: [
      {
        id: 'session-a',
        cwd: 'D:\\proj\\one',
        live: false,
        running: false,
        attached: false,
        path: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-a\\session.jsonl.zstd',
        dirPath: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-a',
        bytes: 1572864,
        mtime: '2026-09-01T08:00:00.000Z',
        workspaces: [{ id: 'w1', title: 'one', path: 'D:\\proj\\one' }],
      },
      {
        id: 'session-b',
        cwd: 'D:\\proj\\one',
        live: true,
        running: true,
        attached: true,
        path: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-b\\session.jsonl.zstd',
        dirPath: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-b',
        bytes: 2048,
        mtime: '2026-09-05T08:00:00.000Z',
        workspaces: [{ id: 'w1', title: 'one', path: 'D:\\proj\\one' }],
      },
    ],
    missing: [{ id: 'session-c', live: false, running: false, attached: false, workspaces: [{ id: 'w1', title: 'one', path: 'D:\\proj\\one' }], reason: 'no-stored-log' }],
    live: ['session-b'],
    running: ['session-b'],
    totalBytes: 1574912,
    deletableIds: ['session-a', 'session-c'],
    forceDeletableIds: ['session-b'],
    unarchivableIds: ['session-a', 'session-c'],
    capabilities: { archivePrune: true, checkpointDelete: true, detach: true, force: true },
    storedCount: 29,
    archivedCount: 3,
    ...overrides,
  }
}

/** React double: state slots in hook order, effects only on mount, walkable tree. */
function createHarness() {
  const state = { slots: [], dirty: false, cursor: 0 }
  let effects = []
  let tree = null
  const React = {
    useState(initial) {
      const index = state.cursor
      if (state.slots.length <= index) state.slots.push(typeof initial === 'function' ? initial() : initial)
      state.cursor += 1
      const setter = (next) => {
        state.slots[index] = typeof next === 'function' ? next(state.slots[index]) : next
        state.dirty = true
      }
      return [state.slots[index], setter]
    },
    useRef(initial) {
      const index = state.cursor
      if (state.slots.length <= index) state.slots.push({ current: initial })
      state.cursor += 1
      return state.slots[index]
    },
    useEffect(fn) {
      effects.push(fn)
    },
    createElement(type, props, ...children) {
      return {
        type,
        props: props || {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
      }
    },
  }

  function body(component) {
    state.cursor = 0
    state.dirty = false
    effects = []
    // A single function component with no children to reconcile: call it, and
    // what it returns IS the tree (React.createElement(component) alone would
    // discard the rendered output).
    tree = component()
    return effects
  }

  /** Re-render until no setter fires (the settle half of act()). */
  function settle(component, limit = 16) {
    for (let i = 0; i < limit && state.dirty; i += 1) body(component)
    return tree
  }

  function mount(component) {
    const mountedEffects = body(component)
    for (const effect of mountedEffects) effect()
    return settle(component)
  }

  return {
    React,
    mount,
    settle,
    get tree() {
      return tree
    },
  }
}

const drain = (times = 8) => {
  let chain = Promise.resolve()
  for (let i = 0; i < times; i += 1) chain = chain.then(() => new Promise((resolve) => setTimeout(resolve, 0)))
  return chain
}

function texts(node, bucket = []) {
  if (typeof node === 'string' || typeof node === 'number') bucket.push(String(node))
  else if (node && typeof node === 'object') for (const child of node.children || []) texts(child, bucket)
  return bucket
}

function findByType(node, type, bucket = []) {
  if (node && typeof node === 'object') {
    if (node.type === type) bucket.push(node)
    for (const child of node.children || []) findByType(child, type, bucket)
  }
  return bucket
}

function byClass(node, className, bucket = []) {
  if (node && typeof node === 'object') {
    if (typeof node.props.className === 'string' && node.props.className.split(' ').includes(className)) bucket.push(node)
    for (const child of node.children || []) byClass(child, className, bucket)
  }
  return bucket
}

/** Visible button labels, in DOM order. */
function buttonLabels(tree) {
  return findByType(tree, 'button').map((node) => texts(node).join(''))
}

function buttonByText(tree, needle) {
  return findByType(tree, 'button').find((node) => texts(node).join('').includes(needle))
}

function checkboxNodes(tree) {
  // Row checkboxes only — the toolbar's force-mode toggle is excluded.
  return findByType(tree, 'input').filter((node) => node.props.type === 'checkbox'
    && String(node.props.className).indexOf('--force') < 0)
}

function forceToggle(tree) {
  return findByType(tree, 'input').find((node) => String(node.props.className).indexOf('--force') >= 0)
}

/** Concatenated visible text across several nodes (texts() walks one node). */
function textsAll(nodes) {
  return nodes.map((node) => texts(node).join(' ')).join(' ')
}

/** Panel with a scripted fetch; returns the harness plus every request made. */
function panel(responseFor, rows = () => ({
  byId: {
    'session-a': { label: '归档测试甲' },
    'session-b': { label: '归档测试乙' },
    'session-c': { label: '归档测试丙' },
  },
})) {
  const harness = createHarness()
  const requests = []
  global.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    requests.push({ url, method, body: init && init.body ? JSON.parse(init.body) : undefined })
    const payload = await responseFor(method, init)
    return { ok: true, status: 200, json: async () => payload }
  }
  const { ArchiveCleanupSection } = createArchiveCleanupSection(harness.React, rows)
  return { harness, requests, ArchiveCleanupSection }
}

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('formatters read well at both ends of the scale', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1536), '1.50 KB')
  assert.equal(formatBytes(1572864), '1.50 MB')
  assert.equal(formatBytes(1073741824), '1.00 GB')
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatDay('2026-09-01T08:00:00.000Z'), '2026-09-01')
  assert.equal(formatDay(null), '—')
  assert.equal(formatDay('nonsense'), '—')
})

test('the 项目 column shows project names, never a path', async () => {
  // The column is narrow and scanned by eye: a Windows path wastes it. The
  // name comes from the workspace title, else the folder off its path, else
  // the folder off the session cwd; the full path stays in the hover detail.
  assert.equal(projectName('D:\\proj\\one'), 'one')
  assert.equal(projectName('/srv/proj/two/'), 'two')
  assert.equal(projectName('single'), 'single')
  assert.equal(projectName(''), '')

  assert.equal(workspaceText({ workspaces: [{ id: 'w1', title: 'one', path: 'D:\\proj\\one' }] }), 'one')
  // A workspace that never got a title still reads as its folder name.
  assert.equal(workspaceText({ workspaces: [{ id: 'w2', title: '', path: 'D:\\proj\\untitled' }] }), 'untitled')
  // No workspace at all: fall back to the cwd's name, not the cwd.
  assert.equal(workspaceText({ workspaces: [], cwd: 'D:\\proj\\three' }), 'three')
  assert.equal(workspaceText({ workspaces: [], cwd: '' }), '未分组')
  // The legacy string shape an older host could emit still yields a name.
  assert.equal(workspaceText({ workspaces: ['D:\\proj\\legacy'] }), 'legacy')

  const withUntitled = {
    ...reportFixture(),
    items: [
      ...reportFixture().items,
      {
        id: 'session-d',
        cwd: 'D:\\proj\\untitled',
        live: false,
        running: false,
        attached: false,
        path: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-d\\session.jsonl.zstd',
        dirPath: 'C:\\home\\.dsh\\sessions\\--cwd--\\session-d',
        bytes: 1024,
        mtime: '2026-09-06T08:00:00.000Z',
        workspaces: [{ id: 'w2', title: '', path: 'D:\\proj\\untitled' }],
      },
    ],
    archivedIds: ['session-a', 'session-b', 'session-c', 'session-d'],
    deletableIds: ['session-a', 'session-c', 'session-d'],
    unarchivableIds: ['session-a', 'session-c', 'session-d'],
    archivedCount: 4,
  }
  const { harness, ArchiveCleanupSection } = panel(async () => withUntitled)
  harness.mount(ArchiveCleanupSection)
  await drain()
  const tree = harness.settle(ArchiveCleanupSection)
  const projectCells = byClass(tree, 'dsao-ac-td--muted').map((node) => texts(node).join(''))
  // Rows are the stored items first (a, b, d), then the missing-log row (c).
  assert.deepEqual(projectCells, ['one', 'one', 'untitled', 'one'], 'one cell per row, name only')
  assert.equal(/\\|:/.test(projectCells.join('')), false, 'no path separator or drive letter renders in the column')
  // …and the path is still one hover away.
  const titles = byClass(tree, 'dsao-ac-td--muted').map((node) => node.props.title)
  assert.deepEqual(titles, ['D:\\proj\\one', 'D:\\proj\\one', 'D:\\proj\\untitled', 'D:\\proj\\one'])
  assert.equal(workspacePaths({ workspaces: [{ id: 'w2', title: 'x', path: 'D:\\proj\\untitled' }], cwd: 'D:\\ignore' }), 'D:\\proj\\untitled')
})

test('the page stylesheet speaks only in host design tokens', () => {
  // No hardcoded colors: the host ships a light and a dark value for every
  // alias, so a literal hex silently breaks one of the two themes.
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS_LINES), false, 'found a literal color')
  assert.equal(/rgba?\(/.test(CSS_LINES), false, 'found a literal rgba')
  const unknown = [...CSS_LINES.matchAll(/var\((--[a-z0-9-]+)/g)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith('--dsw-alias-'))
  assert.deepEqual(unknown, [], 'every var() must be a dsh alias')
  // The states inline styles cannot express are exactly why this file exists.
  for (const need of [':hover', ':focus-visible', ':disabled', 'position:sticky', 'prefers-reduced-motion', 'accent-color', 'font-variant-numeric']) {
    assert.ok(CSS_LINES.includes(need), `missing ${need}`)
  }
  // Danger comes from the danger tokens, not from a made-up one.
  assert.match(CSS_LINES, /--dsw-alias-interactive-bg-hover-danger/)
  assert.match(CSS_LINES, /--dsw-alias-state-error-primary/)
})

test('loading state: skeleton rows and a busy label until the scan resolves', () => {
  const harness = createHarness()
  let release
  global.fetch = () => new Promise((resolve) => {
    release = () => resolve({ ok: true, status: 200, json: async () => reportFixture() })
  })
  const { ArchiveCleanupSection } = createArchiveCleanupSection(harness.React, () => null)
  const tree = harness.mount(ArchiveCleanupSection)
  assert.equal(byClass(tree, 'dsao-ac-skel').length, 3, 'three skeleton rows')
  assert.ok(buttonLabels(tree).includes('扫描中…'), buttonLabels(tree).join(' | '))
  assert.equal(byClass(tree, 'dsao-ac-stat').length, 0, 'no stats before the data lands')
  assert.equal(byClass(tree, 'dsao-ac-row').length, 0)
  release()
})

test('mount fetches once and renders the inventory with a11y wiring', async () => {
  const { harness, requests, ArchiveCleanupSection } = panel(async () => reportFixture())
  harness.mount(ArchiveCleanupSection)
  await drain()
  const tree = harness.settle(ArchiveCleanupSection)
  const body = texts(tree).join(' ')

  assert.equal(requests.length, 1, 'exactly one scan request on mount')
  assert.deepEqual(requests[0], { url: '/api/dsao/archives', method: 'GET', body: undefined })
  assert.match(body, /^归档会话/)
  assert.match(body, /归档在 dsh 里只是显示过滤/)
  assert.match(body, /归档 3 条/)
  assert.match(body, /正文合计 1\.50 MB/)
  assert.match(body, /正文已不存在 1 条/)
  assert.match(body, /运行中 1 条/)
  assert.match(body, /本机共 29 条会话记录/)
  assert.match(body, /删除不可恢复：正文就是那段历史的唯一副本/)
  assert.ok(body.includes('归档测试甲'), 'titles resolve from the client session list')
  assert.equal(byClass(tree, 'dsao-ac-stat').length, 4, 'four stat chips')
  // one stored row per item + one for the missing id
  assert.equal(findByType(tree, 'tbody')[0].children.length, 3)
  assert.equal(byClass(tree, 'dsao-ac-row').length, 3)
  // the live row and the missing-log row read as pills, not suffixes glued to a title
  assert.deepEqual(byClass(tree, 'dsao-ac-pill').map((node) => texts(node).join('')), ['运行中', '正文缺失'])
  // …and they share one row with the title: the pill must never wrap under it
  const cells = byClass(tree, 'dsao-ac-nameCell')
  assert.equal(cells.length, 3, 'one name cell per row')
  assert.deepEqual(cells.map((node) => texts(node).join(' ')), [
    '归档测试甲',
    '归档测试乙 运行中',
    '归档测试丙 正文缺失',
  ])
  assert.equal(byClass(tree, 'dsao-ac-row').length, 3)
  // the per-row export link targets the shipped export route with this session id
  const exportLink = findByType(tree, 'a').find((node) => String(node.props.href).includes('/api/session.export'))
  assert.equal(exportLink.props.href, '/api/session.export?sessionId=session-a&includeDescendants=false')
  assert.equal(exportLink.props['aria-label'], '导出 归档测试甲 的会话日志')
  const boxes = checkboxNodes(tree)
  assert.equal(boxes.length, 3)
  assert.equal(boxes[1].props.disabled, true, 'a live session cannot be picked')
  assert.equal(boxes[0].props.disabled, false)
  assert.equal(boxes[0].props['aria-label'], '选择会话 归档测试甲')
  // every row checkbox has an associated <label for=…>, so the title is a click target
  assert.deepEqual(findByType(tree, 'label').filter((node) => node.props.htmlFor !== undefined).map((node) => node.props.htmlFor), boxes.map((node) => node.props.id))
  assert.equal(findByType(tree, 'th').every((node) => node.props.scope === 'col'), true, 'table headers are scoped')
  assert.equal(harness.tree.props['aria-busy'], 'false')
  // selection is visible on the row, not only on the box
  boxes[0].props.onChange()
  harness.settle(ArchiveCleanupSection)
  assert.equal(byClass(harness.tree, 'dsao-ac-row--on').length, 1)
})

test('empty state says so instead of rendering a header-only table', async () => {
  const empty = { ...reportFixture(), archivedIds: [], items: [], missing: [], live: [], totalBytes: 0, deletableIds: [], unarchivableIds: [], archivedCount: 0 }
  const { harness, ArchiveCleanupSection } = panel(async () => empty)
  harness.mount(ArchiveCleanupSection)
  await drain()
  const tree = harness.settle(ArchiveCleanupSection)
  assert.match(texts(tree).join(' '), /没有归档会话，无需清理。/)
  assert.equal(byClass(tree, 'dsao-ac-row').length, 0)
  assert.equal(buttonByText(tree, '删除'), undefined, 'no destructive affordance with nothing to delete')
})

test('a failed scan renders an error banner with a working retry', async () => {
  const harness = createHarness()
  let calls = 0
  global.fetch = async () => {
    calls += 1
    if (calls === 1) return { ok: false, status: 503, json: async () => ({ error: 'archive cleanup needs the sessionPersistence service' }) }
    return { ok: true, status: 200, json: async () => reportFixture() }
  }
  const { ArchiveCleanupSection } = createArchiveCleanupSection(harness.React, () => null)
  harness.mount(ArchiveCleanupSection)
  await drain()
  let tree = harness.settle(ArchiveCleanupSection)
  const banner = byClass(tree, 'dsao-ac-banner--error')
  assert.equal(banner.length, 1, 'one error banner')
  assert.equal(banner[0].props.role, 'alert', 'errors announce themselves')
  assert.match(texts(banner[0]).join(' '), /扫描失败：archive cleanup needs the sessionPersistence service/)
  assert.equal(byClass(tree, 'dsao-ac-skel').length, 0, 'a failed scan must not keep shimmering')
  assert.equal(byClass(tree, 'dsao-ac-row').length, 0, 'no table over an error')
  buttonByText(tree, '重试').props.onClick()
  await drain()
  tree = harness.settle(ArchiveCleanupSection)
  assert.equal(byClass(tree, 'dsao-ac-banner--error').length, 0, 'a successful retry clears the banner')
  assert.equal(byClass(tree, 'dsao-ac-row').length, 3)
})

test('delete is two-step, announces itself, and only then posts confirm:true', async () => {
  const { harness, requests, ArchiveCleanupSection } = panel(async (method) => (method === 'POST'
    ? {
        action: 'delete',
        deleted: [{ id: 'session-a', log: 'removed', bytes: 1048576, checkpoint: 'removed', cwd: 'D:\\proj\\one' }],
        refused: [],
        errors: [],
        archivePruned: true,
      }
    : reportFixture()))
  harness.mount(ArchiveCleanupSection)
  await drain()
  harness.settle(ArchiveCleanupSection)

  checkboxNodes(harness.tree)[0].props.onChange()
  harness.settle(ArchiveCleanupSection)
  assert.ok(buttonLabels(harness.tree).includes('删除 1 条'), `labels: ${buttonLabels(harness.tree).join(' | ')}`)
  const idle = buttonByText(harness.tree, '删除 1 条')
  assert.equal(idle.props.className, 'dsao-ac-btn dsao-ac-btn--danger')
  assert.equal(idle.props['aria-label'], '删除选中的 1 条会话')

  idle.props.onClick()
  harness.settle(ArchiveCleanupSection)
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'the first click sends nothing')
  const armed = buttonByText(harness.tree, '再点一次确认删除 1 条')
  assert.ok(armed, `arming must rewrite the label, got ${buttonLabels(harness.tree).join(' | ')}`)
  assert.match(texts(armed).join(''), /释放 1\.50 MB/, 'the armed label states what the click buys')
  assert.equal(armed.props.className, 'dsao-ac-btn dsao-ac-btn--armed')
  assert.match(texts(harness.tree).join(' '), /8 秒内未再次点击会自动取消/)

  armed.props.onClick()
  await drain()
  const post = requests.find((request) => request.method === 'POST')
  assert.deepEqual(post, { url: '/api/dsao/archives', method: 'POST', body: { action: 'delete', ids: ['session-a'], confirm: true, force: false } })
  harness.settle(ArchiveCleanupSection)
  const result = byClass(harness.tree, 'dsao-ac-banner--ok')
  assert.equal(result.length, 1)
  assert.equal(result[0].props.role, 'status', 'the result is announced politely, not assertively')
  assert.match(texts(result[0]).join(' '), /已删除 1 条 · 释放 1\.00 MB/)
  // the page re-scans after a destructive write so the list never lies
  assert.equal(requests.filter((request) => request.method === 'GET').length, 2)
})

test('changing the selection disarms a pending confirm', async () => {
  const { harness, requests, ArchiveCleanupSection } = panel(async () => reportFixture())
  harness.mount(ArchiveCleanupSection)
  await drain()
  harness.settle(ArchiveCleanupSection)
  const boxes = checkboxNodes(harness.tree)
  boxes[0].props.onChange()
  harness.settle(ArchiveCleanupSection)
  buttonByText(harness.tree, '删除 1 条').props.onClick()
  harness.settle(ArchiveCleanupSection)
  assert.ok(buttonByText(harness.tree, '再点一次'), 'armed')
  boxes[1].props.onChange()
  harness.settle(ArchiveCleanupSection)
  assert.equal(buttonByText(harness.tree, '再点一次'), undefined, 'a selection change must drop the armed state')
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0)
})

test('restoring is one click and never posts confirm', async () => {
  const { harness, requests, ArchiveCleanupSection } = panel(async (method) => (method === 'POST'
    ? { action: 'restore', restored: ['session-a'], refused: [], archivePruned: true }
    : reportFixture()))
  harness.mount(ArchiveCleanupSection)
  await drain()
  harness.settle(ArchiveCleanupSection)
  checkboxNodes(harness.tree)[0].props.onChange()
  harness.settle(ArchiveCleanupSection)
  buttonByText(harness.tree, '取消归档 1 条').props.onClick()
  await drain()
  assert.deepEqual(requests.find((request) => request.method === 'POST').body, { action: 'restore', ids: ['session-a'] })
  harness.settle(ArchiveCleanupSection)
  assert.match(texts(harness.tree).join(' '), /已取消归档 1 条/)
})

test('picking everything skips the live row, and clearing works', async () => {
  const { harness, ArchiveCleanupSection } = panel(async () => reportFixture())
  harness.mount(ArchiveCleanupSection)
  await drain()
  harness.settle(ArchiveCleanupSection)
  buttonByText(harness.tree, '全选可删').props.onClick()
  harness.settle(ArchiveCleanupSection)
  // deletableIds excludes the live session, so the delete count is 2
  assert.ok(buttonLabels(harness.tree).some((label) => label.includes('删除 2 条')), buttonLabels(harness.tree).join(' | '))
  assert.equal(checkboxNodes(harness.tree).filter((node) => node.props.checked === true).length, 2)
  buttonByText(harness.tree, '清空选择').props.onClick()
  harness.settle(ArchiveCleanupSection)
  assert.equal(checkboxNodes(harness.tree).filter((node) => node.props.checked === true).length, 0)
  assert.equal(buttonByText(harness.tree, '取消归档 0 条').props.disabled, true)
})

test('refusals, uncleanable archive sets and missing write paths are all reported', async () => {
  const { harness, requests, ArchiveCleanupSection } = panel(async (method) => (method === 'POST'
    ? {
        action: 'delete',
        deleted: [],
        refused: [{ id: 'session-a', reason: 'live-session' }],
        errors: [],
        archivePruned: false,
      }
    : reportFixture({ capabilities: { archivePrune: false, checkpointDelete: false, detach: true } })))
  harness.mount(ArchiveCleanupSection)
  await drain()
  let tree = harness.settle(ArchiveCleanupSection)
  const caps = textsAll(byClass(tree, 'dsao-ac-banner--warn'))
  assert.match(caps, /当前宿主未暴露归档名单写入口/)
  assert.match(caps, /投影缓存行未能就地删除/)

  checkboxNodes(tree)[0].props.onChange()
  harness.settle(ArchiveCleanupSection)
  buttonByText(harness.tree, '删除 1 条').props.onClick()
  harness.settle(ArchiveCleanupSection)
  buttonByText(harness.tree, '再点一次').props.onClick()
  await drain()
  tree = harness.settle(ArchiveCleanupSection)
  // a partial outcome must not render in the success tone
  assert.equal(byClass(tree, 'dsao-ac-banner--ok').length, 0)
  const body = textsAll(byClass(tree, 'dsao-ac-banner--warn'))
  assert.match(body, /拒绝 1 条（live-session）/)
  assert.match(body, /归档名单未能写入/)
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1)
})

test('force mode unlocks attached rows, relabels the action, and posts force:true', async () => {
  const posts = []
  const harness = createHarness()
  global.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    if (method === 'POST') {
      posts.push(JSON.parse(init.body))
      return { ok: true, status: 200, json: async () => ({ action: 'delete', deleted: [{ id: 'session-b', log: 'removed', bytes: 2048, checkpoint: 'removed', forced: true, cancelled: true }], refused: [], errors: [], archivePruned: true }) }
    }
    return { ok: true, status: 200, json: async () => reportFixture() }
  }
  const { ArchiveCleanupSection } = createArchiveCleanupSection(harness.React, () => ({ byId: { 'session-b': { label: '归档测试乙' } } }))
  harness.mount(ArchiveCleanupSection)
  await drain()
  let tree = harness.settle(ArchiveCleanupSection)

  // Without force: the running row is locked, and no toggle text lies about it.
  assert.equal(checkboxNodes(tree)[1].props.disabled, true, 'attached row locked before force mode')
  const toggle = forceToggle(tree)
  assert.ok(toggle, 'the force toggle renders when capabilities.force')
  assert.equal(toggle.props.checked, false)

  toggle.props.onChange()
  tree = harness.settle(ArchiveCleanupSection)
  assert.equal(checkboxNodes(tree)[1].props.disabled, false, 'force mode unlocks the attached row')

  checkboxNodes(tree)[1].props.onChange()
  tree = harness.settle(ArchiveCleanupSection)
  assert.ok(buttonLabels(tree).some((label) => label.includes('强制删除 1 条（含 1 条运行中）')), buttonLabels(tree).join(' | '))
  buttonByText(tree, '强制删除 1 条').props.onClick()
  tree = harness.settle(ArchiveCleanupSection)
  assert.ok(buttonLabels(tree).some((label) => label.includes('再点一次确认强制删除 1 条')))
  buttonByText(tree, '再点一次').props.onClick()
  await drain()
  assert.deepEqual(posts[0], { action: 'delete', ids: ['session-b'], confirm: true, force: true })
  harness.settle(ArchiveCleanupSection)
  // the cancelled-then-deleted outcome is announced honestly, not as a plain delete
  assert.match(texts(harness.tree).join(' '), /其中 1 条已先中止运行中的回合/)
})

test('the session currently open in this GUI can never be picked, even in force mode', async () => {
  const harness = createHarness()
  global.fetch = async () => ({ ok: true, status: 200, json: async () => reportFixture() })
  const { ArchiveCleanupSection } = createArchiveCleanupSection(harness.React, () => ({
    current: 'session-a',
    byId: { 'session-a': { label: '正在看的会话' } },
  }))
  harness.mount(ArchiveCleanupSection)
  await drain()
  let tree = harness.settle(ArchiveCleanupSection)
  assert.equal(checkboxNodes(tree)[0].props.disabled, true, 'the current session is locked by default')
  forceToggle(tree).props.onChange()
  tree = harness.settle(ArchiveCleanupSection)
  assert.equal(checkboxNodes(tree)[0].props.disabled, true, 'force mode does not unlock self-deletion')
  assert.deepEqual(byClass(tree, 'dsao-ac-pill').map((node) => texts(node).join(' ')).filter((t) => t.includes('当前')), ['当前会话'])
  // 全选可删 in force mode still skips the current session
  buttonByText(tree, '全选可删').props.onClick()
  tree = harness.settle(ArchiveCleanupSection)
  assert.ok(buttonLabels(tree).some((label) => label.includes('删除 2 条')), `expected 2 (not 3) picked: ${buttonLabels(tree).join(' | ')}`)
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
