// Minimal DOM stub: just enough for createBadge/ensureBadge and the
// prompt-enhance button placement, which only need element creation,
// sibling-aware insertion/removal, two attribute selectors, and the
// tag+class-substring selector for finding the primary buttons. Keeping it
// hand-rolled avoids a jsdom dependency for a plugin whose only build step
// is `node --check`.

class StubElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parent = null
    this.attrs = Object.create(null)
    this.style = {}
    this.textContent = ''
    this.title = ''
    this.className = ''
  }

  get parentNode() {
    return this.parent
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }

  getAttribute(name) {
    return name in this.attrs ? this.attrs[name] : null
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
    return node
  }

  removeChild(node) {
    const at = this.children.indexOf(node)
    if (at < 0) throw new Error('removeChild: node is not a child')
    this.children.splice(at, 1)
    node.parent = null
    return node
  }

  /** Replace a child in place, the way a React re-render swaps one element for another. */
  replaceChild(next, prev) {
    const at = this.children.indexOf(prev)
    if (at < 0) throw new Error('replaceChild: node is not a child')
    this.children[at] = next
    next.parent = this
    prev.parent = null
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

  descendants() {
    const out = []
    for (const child of this.children) {
      out.push(child)
      out.push(...child.descendants())
    }
    return out
  }

  /**
   * Supports `[class*="..."]`, and `tag[class*="..."]` (the latter is what
   * prompt-enhance's findPrimary queries for the primary send/stop buttons).
   */
  querySelector(selector) {
    const substring = /^\[class\*="(.+)"\]$/.exec(selector)
    if (substring !== null) return this.descendants().find((el) => el.className.includes(substring[1])) ?? null
    throw new Error(`stub querySelector: unsupported selector ${selector}`)
  }

  /**
   * Supports `[attr]` presence, and `tag[class*="..."]` — the same two shapes
   * the shipped bundle queries.
   */
  querySelectorAll(selector) {
    const presence = /^\[([\w-]+)\]$/.exec(selector)
    if (presence !== null) return this.descendants().filter((el) => el.getAttribute(presence[1]) !== null)
    const tagClass = /^([A-Za-z]+)\[class\*="(.+)"\]$/.exec(selector)
    if (tagClass !== null) {
      const tag = tagClass[1].toUpperCase()
      const substr = tagClass[2]
      return this.descendants().filter((el) => el.tagName === tag && el.className.includes(substr))
    }
    throw new Error(`stub querySelectorAll: unsupported selector ${selector}`)
  }
}

/** Install the stub as the global `document` so bundle modules can evaluate. */
export function installStubDocument() {
  globalThis.document = {
    createElement: (tagName) => new StubElement(tagName),
    createTextNode: (text) => {
      const node = new StubElement('#text')
      node.textContent = String(text)
      return node
    },
  }
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

export { StubElement }
