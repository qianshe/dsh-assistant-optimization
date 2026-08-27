// Minimal DOM stub: just enough for the bundle modules under test. The
// original covered createBadge/ensureBadge and prompt-enhance placement
// (element creation, sibling-aware insertion/removal, attribute + class
// substring selectors). It has since grown the surface the tool-group and
// mermaid observer tests need: a MutationObserver with real record batching,
// document-order comparisons, closest/matches, and a document with body/head.
// Hand-rolled on purpose — the plugin's only build step is `node --check`,
// and the tests must not need a jsdom dependency.

const DOCUMENT_POSITION_FOLLOWING = 4
const DOCUMENT_POSITION_PRECEDING = 2

/** Pre-order rank among nodes under the stub root (0-based). -1 if unattached. */
function subtreeSize(n) {
  let s = 1
  for (const c of n.children) s += subtreeSize(c)
  return s
}

function docIndex(node) {
  const root = globalThis.__stubRoot
  if (!root) return -1
  let p = node
  while (p && p !== root) p = p.parent
  if (p !== root) return -1
  const path = []
  for (let cur = node; cur !== root; cur = cur.parent) path.unshift(cur)
  let preceding = 0
  for (const child of path) {
    for (const sib of child.parent.children) {
      if (sib === child) break
      preceding += subtreeSize(sib)
    }
  }
  return preceding
}

/**
 * Compound-selector matcher (no combinators): optional tag, then any mix of
 * `.class`, `[attr]`, `[attr="value"]`, `[class*="substr"]`.
 */
function matchesSelector(el, selector) {
  let rest = selector
  let tag = null
  const tm = /^([A-Za-z][\w-]*)/.exec(rest)
  if (tm) { tag = tm[0].toUpperCase(); rest = rest.slice(tag.length) }
  while (rest.length > 0) {
    const cm = /^\.[\w-]+/.exec(rest)
    if (cm && rest.startsWith(cm[0])) {
      const cls = cm[0].slice(1)
      if (!(' ' + el.className + ' ').includes(' ' + cls + ' ')) return false
      rest = rest.slice(cm[0].length)
      continue
    }
    const am = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(rest)
    if (am && rest === am[0]) {
      const val = el.getAttribute(am[1])
      if (am[2] === undefined) { if (val === null) return false }
      else if (val !== am[2]) return false
      rest = ''
      continue
    }
    const csm = /^\[class\*="([^"]+)"\]$/.exec(rest)
    if (csm && rest === csm[0]) {
      if (!el.className.includes(csm[1])) return false
      rest = ''
      continue
    }
    throw new Error(`stub: unsupported selector fragment "${rest}" (in "${selector}")`)
  }
  if (tag !== null && el.tagName !== tag) return false
  return true
}

const observers = new Set()

function emitToObservers(record) {
  for (const obs of [...observers]) obs._queue(record)
}

function emitChildList(parent, added, removed) {
  if (!parent) return
  emitToObservers({ type: 'childList', target: parent, addedNodes: added, removedNodes: removed })
}

function emitAttr(el, name, oldValue) {
  emitToObservers({ type: 'attributes', target: el, attributeName: name, oldValue })
}

class StubMutationObserver {
  constructor(callback) {
    this.callback = callback
    this.target = null
    this.options = null
    this.records = []
    this._scheduled = false
    observers.add(this)
  }

  observe(target, options) {
    this.target = target
    this.options = options || {}
  }

  disconnect() {
    this.target = null
    this.records.length = 0
    observers.delete(this)
  }

  _delivers(record) {
    const t = this.target
    if (!t) return false
    let n = record.target
    if (n !== t) {
      let inside = false
      let p = n.parent
      while (p) { if (p === t) { inside = true; break }; p = p.parent }
      if (!inside) return false
      if (!this.options.subtree) return false
    }
    if (record.type === 'childList') return !!this.options.childList
    if (record.type === 'attributes') {
      if (!this.options.attributes) return false
      if (this.options.attributeFilter && this.options.attributeFilter.length > 0 &&
          this.options.attributeFilter.indexOf(record.attributeName) < 0) return false
      return true
    }
    return false
  }

  _queue(record) {
    if (!this._delivers(record)) return
    this.records.push(record)
    if (this._scheduled) return
    this._scheduled = true
    queueMicrotask(() => {
      this._scheduled = false
      const batch = this.records.splice(0)
      if (batch.length && this.callback) this.callback(batch, this)
    })
  }
}

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.nodeType = tagName === '#text' ? 3 : 1
    this.children = []
    this.parent = null
    this.attrs = Object.create(null)
    this.dataset = {}
    this.style = {}
    this.textContent = ''
    this.title = ''
    this.className = ''
  }

  get parentNode() {
    return this.parent
  }

  // Event hooks: the bundle attaches click/keydown/resize listeners. Tests
  // drive behavior by mutating attributes directly, so these are no-ops.
  addEventListener() {}
  removeEventListener() {}

  setAttribute(name, value) {
    const v = String(value)
    const old = name in this.attrs ? this.attrs[name] : null
    if (old === v) return // live DOM emits no record for an unchanged value
    this.attrs[name] = v
    emitAttr(this, name, old)
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null
  }

  removeAttribute(name) {
    if (!(name in this.attrs)) return
    const old = this.attrs[name]
    delete this.attrs[name]
    emitAttr(this, name, old)
  }

  /** Detach from the current parent, the way live DOM insertion relocates a node. */
  detach() {
    if (this.parent !== null) this.parent.removeChild(this)
    return this
  }

  appendChild(node) {
    node.detach()
    node.parent = this
    this.children.push(node)
    emitChildList(this, [node], [])
    return node
  }

  insertBefore(node, ref) {
    if (ref !== null && ref !== undefined && this.children.indexOf(ref) < 0) {
      throw new Error('insertBefore: reference node is not a child')
    }
    // Detach BEFORE resolving the index: relocating a node inside the same
    // parent shifts every position after it.
    node.detach()
    const at = ref === null || ref === undefined ? this.children.length : this.children.indexOf(ref)
    node.parent = this
    this.children.splice(at, 0, node)
    emitChildList(this, [node], [])
    return node
  }

  removeChild(node) {
    const at = this.children.indexOf(node)
    if (at < 0) throw new Error('removeChild: node is not a child')
    this.children.splice(at, 1)
    node.parent = null
    emitChildList(this, [], [node])
    return node
  }

  /** Replace a child in place, the way a React re-render swaps one element for another. */
  replaceChild(next, prev) {
    const at = this.children.indexOf(prev)
    if (at < 0) throw new Error('replaceChild: node is not a child')
    this.children[at] = next
    next.parent = this
    prev.parent = null
    emitChildList(this, [next], [prev])
    return prev
  }

  get nextSibling() {
    if (this.parent === null) return null
    const at = this.parent.children.indexOf(this)
    return this.parent.children[at + 1] ?? null
  }

  get nextElementSibling() {
    return this.nextSibling
  }

  get previousElementSibling() {
    if (this.parent === null) return null
    const at = this.parent.children.indexOf(this)
    return this.parent.children[at - 1] ?? null
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  descendants() {
    const out = []
    for (const child of this.children) {
      out.push(child)
      out.push(...child.descendants())
    }
    return out
  }

  matches(selector) {
    return matchesSelector(this, selector)
  }

  closest(selector) {
    let el = this
    while (el) {
      if (el.matches && el.matches(selector)) return el
      el = el.parent
    }
    return null
  }

  compareDocumentPosition(other) {
    const a = docIndex(this)
    const b = docIndex(other)
    if (a < 0 || b < 0) return 0
    if (b > a) return DOCUMENT_POSITION_FOLLOWING
    if (b < a) return DOCUMENT_POSITION_PRECEDING
    return 0
  }

  /**
   * Compound selectors (no combinators): optional tag, then any mix of
   * `.class`, `[attr]`, `[attr="value"]`, `[class*="substr"]` — a superset
   * of the shapes the shipped bundle queries.
   */
  querySelector(selector) {
    return this.descendants().find((el) => matchesSelector(el, selector)) ?? null
  }

  querySelectorAll(selector) {
    return this.descendants().filter((el) => matchesSelector(el, selector))
  }
}

/** Install the stub as the global `document` so bundle modules can evaluate. */
export function installStubDocument() {
  observers.clear()
  const html = new StubElement('html')
  const head = new StubElement('head')
  const body = new StubElement('body')
  html.appendChild(head)
  html.appendChild(body)
  globalThis.__stubRoot = html
  const walk = (el, id) => {
    if ((el.id !== undefined && el.id === id) || el.getAttribute('id') === id) return el
    for (const c of el.children) {
      const r = walk(c, id)
      if (r) return r
    }
    return null
  }
  globalThis.document = {
    createElement: (tagName) => new StubElement(tagName),
    createTextNode: (text) => {
      const node = new StubElement('#text')
      node.textContent = String(text)
      return node
    },
    documentElement: html,
    head,
    body,
    getElementById: (id) => walk(html, id),
    querySelector: (sel) => html.querySelector(sel),
    querySelectorAll: (sel) => html.querySelectorAll(sel),
  }
  globalThis.MutationObserver = StubMutationObserver
}

/** Let one observer microtask + one 80ms debounce window (plus margin) elapse. */
export function tick(ms = 250) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Build a collapsed tool row shaped like the official ToolRow output. */
export function buildToolRow({ errored = false, path = 'src/app.js' } = {}) {
  const container = new StubElement('div')
  const row = container.appendChild(new StubElement('div'))
  row.className = 'o3BgMG_row'
  row.appendChild(new StubElement('span')).className = 'o3BgMG_sep'

  // The official row renders a fileLink button only while failureLine is null;
  // an errored call gets an errorSummary span in that seat instead.
  const summary = new StubElement(errored ? 'span' : 'button')
  summary.className = errored ? 'o3BgMG_summary o3BgMG_errorSummary' : 'o3BgMG_fileLink'
  summary.textContent = errored ? 'Error: edit requires reading the file first' : path
  row.appendChild(summary)

  return { container, row, summary }
}

/** Swap the row's file link for an error summary, as a React re-render would. */
export function swapToErrorSummary(row, link) {
  const span = new StubElement('span')
  span.className = 'o3BgMG_summary o3BgMG_errorSummary'
  span.textContent = 'Error: edit requires reading the file first'
  row.replaceChild(span, link)
  return span
}

export function badgesIn(container) {
  return container.querySelectorAll('[data-dsao-diff-badge]')
}

export { StubElement, StubMutationObserver }
