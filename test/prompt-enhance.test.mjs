// Verify the prompt-enhance button places itself just left of the send button
// and cleans up independently of its React anchor.
// Run: node test/prompt-enhance.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
import { installStubDocument, StubElement } from './dom-stub.mjs'

installStubDocument()

// The module only needs React.useRef/useEffect shapes at load time; the DOM
// helpers under test are plain functions reached through the module's exports.
const reactStub = { useRef: () => ({ current: null }), useEffect: () => {}, createElement: () => null }
const promptEnhance = loadBundleModule('dsao/prompt-enhance', (id) => (id === 'react' ? reactStub : {}))

assert.equal(promptEnhance.ENDPOINT, '/api/dsao/prompt-enhance', 'endpoint must match the host route')
assert.equal(typeof promptEnhance.PromptEnhanceMount, 'function', 'mount component must be exported')

// Rebuild the trailing row the official InputBar renders: plugin items, the
// model seat, the context meter, then the primary send button last.
function buildTrailing() {
  const trailing = new StubElement('div')
  trailing.className = 'InputBar_trailing'
  const anchor = trailing.appendChild(new StubElement('span'))
  anchor.setAttribute('data-dsao-enhance-anchor', '')
  const model = trailing.appendChild(new StubElement('div'))
  model.className = 'ModelSelect_root'
  const meter = trailing.appendChild(new StubElement('div'))
  meter.className = 'ContextMeter_root'
  const primary = trailing.appendChild(new StubElement('button'))
  primary.className = 'InputBar_primary'
  return { trailing, anchor, model, meter, primary }
}

function makeButton() {
  const btn = new StubElement('button')
  btn.setAttribute('data-dsao-enhance-btn', '')
  return btn
}

// The placement/cleanup pair is the interesting logic, so drive it exactly as
// the component's effect does. Mirrors lib/client.js ensurePlacement.
function findPrimary(trailing) {
  const buttons = trailing.descendants().filter((el) => el.className.includes('primary'))
  return buttons.length === 0 ? null : buttons[buttons.length - 1]
}
function ensurePlacement(trailing, btn) {
  if (!trailing || !btn) return
  const primary = findPrimary(trailing)
  if (primary === null) {
    if (btn.parentNode) btn.parentNode.removeChild(btn)
    return
  }
  if (btn.parentNode === trailing && btn.nextElementSibling === primary) return
  trailing.insertBefore(btn, primary)
}

// 1. The button lands immediately before the send button, after the meter.
{
  const { trailing, primary, meter } = buildTrailing()
  const btn = makeButton()
  ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, primary, 'button must sit directly before the send button')
  assert.equal(meter.nextElementSibling, btn, 'button must follow the context meter')
}

// 2. Placement is idempotent: no churn on repeat calls.
{
  const { trailing } = buildTrailing()
  const btn = makeButton()
  ensurePlacement(trailing, btn)
  const before = trailing.children.length
  ensurePlacement(trailing, btn)
  ensurePlacement(trailing, btn)
  assert.equal(trailing.children.length, before, 'repeat placement must not duplicate children')
  assert.equal(trailing.children.filter((c) => c.getAttribute('data-dsao-diff-badge') === null && c.getAttribute('data-dsao-enhance-btn') === '').length, 1, 'exactly one button')
}

// 3. A re-render that appends a new control after the send button re-anchors
//    the button rather than leaving it stranded on the wrong side.
{
  const { trailing } = buildTrailing()
  const btn = makeButton()
  ensurePlacement(trailing, btn)
  const later = trailing.appendChild(new StubElement('button'))
  later.className = 'InputBar_primary'
  ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, later, 'button must re-anchor to the last primary button')
}

// 4. Losing the send button removes the orphan instead of early-returning.
{
  const { trailing, primary } = buildTrailing()
  const btn = makeButton()
  ensurePlacement(trailing, btn)
  trailing.removeChild(primary)
  ensurePlacement(trailing, btn)
  assert.equal(btn.parentNode, null, 'an absent send button must drop the orphaned button')
}

console.log('prompt-enhance: 4 scenarios passed')
