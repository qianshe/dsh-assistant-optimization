// Verify the prompt-enhance button places itself just left of the primary
// button group (send alone when idle; stop+send while an interrupt is
// available) and cleans up independently of its React anchor.
//
// The placement helpers are exercised straight off the shipped bundle via
// its exports, not a local re-implementation — the mirrors that predated the
// two-primary-button fix let this exact regression pass unnoticed.
// Run: node test/prompt-enhance.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
import { installStubDocument, StubElement } from './dom-stub.mjs'

installStubDocument()

// The module only needs React.useRef/useEffect shapes at load time; the DOM
// helpers under test are plain functions reached through the module's exports.
// createElement records what the mount would render so we can assert that a
// subagent composer renders nothing while a normal composer renders the span.
const renderCalls = []
const reactStub = {
  useRef: () => ({ current: null }),
  useEffect: () => {},
  createElement: (type, props) => { renderCalls.push({ type, props }); return null },
}
const contextStub = {
  readContext: () => ({ project: '', cwd: '', instructions: '', summary: '', history: '', replies: '' }),
}
const promptEnhance = loadBundleModule('dsao/prompt-enhance', (id) =>
  id === 'react' ? reactStub : id === 'dsao/context' ? contextStub : {})

assert.equal(promptEnhance.ENDPOINT, '/api/dsao/prompt-enhance', 'endpoint must match the host route')
assert.equal(typeof promptEnhance.PromptEnhanceMount, 'function', 'mount component must be exported')
assert.equal(typeof promptEnhance.ensurePlacement, 'function', 'ensurePlacement must be exported')
assert.equal(typeof promptEnhance.findPrimary, 'function', 'findPrimary must be exported')

// Rebuild the trailing row the official InputBar renders: plugin items, the
// model seat, the context meter, then the primary send button last. When
// `interruptible` (a running subagent) the stop button is a second primary
// button rendered between the meter and the send button.
function buildTrailing({ interruptible = false } = {}) {
  const trailing = new StubElement('div')
  trailing.className = 'InputBar_trailing'
  const anchor = trailing.appendChild(new StubElement('span'))
  anchor.setAttribute('data-dsao-enhance-anchor', '')
  const model = trailing.appendChild(new StubElement('div'))
  model.className = 'ModelSelect_root'
  const meter = trailing.appendChild(new StubElement('div'))
  meter.className = 'ContextMeter_root'

  let stop = null
  if (interruptible) {
    stop = trailing.appendChild(new StubElement('button'))
    stop.className = 'InputBar_primary InputBar_interruptible'
    stop.setAttribute('data-input-stop', '')
  }

  const send = trailing.appendChild(new StubElement('button'))
  send.className = 'InputBar_primary'
  send.setAttribute('aria-label', 'send')

  return { trailing, anchor, model, meter, stop, send }
}

function makeButton() {
  const btn = new StubElement('button')
  btn.setAttribute('data-dsao-enhance-btn', '')
  return btn
}

// 1. Idle: a single primary button (send) — the button lands immediately
//    before it, right after the meter.
{
  const { trailing, meter, send } = buildTrailing()
  const btn = makeButton()
  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, send, 'button must sit directly before the send button')
  assert.equal(meter.nextElementSibling, btn, 'button must follow the context meter')
}

// 2. Running subagent: the stop button is a second primary before send. The
//    button must go before the STOP button (the first primary), so stop and
//    send stay adjacent and the stop button is not displaced.
{
  const { trailing, meter, stop, send } = buildTrailing({ interruptible: true })
  assert.notEqual(stop, null, 'interruptible build must include the stop button')
  const btn = makeButton()
  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, stop, 'button must sit before the stop button, not between stop and send')
  assert.equal(stop.nextElementSibling, send, 'stop button must stay adjacent to the send button')
  assert.equal(meter.nextElementSibling, btn, 'button must follow the context meter')
}

// 3. Placement is idempotent: no churn on repeat calls.
{
  const { trailing } = buildTrailing()
  const btn = makeButton()
  promptEnhance.ensurePlacement(trailing, btn)
  const before = trailing.children.length
  promptEnhance.ensurePlacement(trailing, btn)
  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(trailing.children.length, before, 'repeat placement must not duplicate children')
  assert.equal(trailing.children.filter((c) => c.getAttribute('data-dsao-enhance-btn') === '').length, 1, 'exactly one button')
}

// 4. The interrupt stop appears after the button already landed (an idle
//    composer transitions to a running subagent). The button must re-anchor
//    to before the new first primary, keeping the stop/send pair intact.
{
  const { trailing, send } = buildTrailing()
  const btn = makeButton()
  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, send, 'button sits before send while idle')

  const stop = new StubElement('button')
  stop.className = 'InputBar_primary'
  stop.setAttribute('aria-label', 'stop')
  trailing.insertBefore(stop, send)

  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(btn.nextElementSibling, stop, 'button must re-anchor to before the newly-added stop')
  assert.equal(stop.nextElementSibling, send, 'stop and send must stay adjacent')
}

// 5. Losing the send button removes the orphan instead of early-returning.
{
  const { trailing, send } = buildTrailing()
  const btn = makeButton()
  promptEnhance.ensurePlacement(trailing, btn)
  trailing.removeChild(send)
  promptEnhance.ensurePlacement(trailing, btn)
  assert.equal(btn.parentNode, null, 'an absent send button must drop the orphaned button')
}

// 6. A subagent composer renders nothing at all: no hidden anchor, so no
//    button, no placement, no network logic.
{
  const subagentSession = {
    sessionId: 'sa-1',
    subagent: { address: { mode: 'continuable' }, parentAvailable: true },
  }
  const before = renderCalls.length
  promptEnhance.PromptEnhanceMount({
    useSession: () => subagentSession,
    useInput: () => ({ draft: '继续', phase: 'plain' }),
    inputActions: { setDraft: () => {} },
  })
  assert.equal(renderCalls.length, before, 'subagent composer must not render the anchor span')
}

// 7. A normal (non-subagent) composer still renders the hidden anchor.
{
  const normalSession = { sessionId: 's-1', subagent: null }
  const before = renderCalls.length
  const el = promptEnhance.PromptEnhanceMount({
    useSession: () => normalSession,
    useInput: () => ({ draft: '继续', phase: 'plain' }),
    useChat: () => ({ legacy: { nodes: [] } }),
    inputActions: { setDraft: () => {} },
  })
  assert.equal(renderCalls.length, before + 1, 'normal composer must render the hidden anchor')
  assert.equal(el, null, 'createElement stub returns null as the element')
  assert.equal(renderCalls[before].type, 'span', 'the anchor must be a span')
  assert.equal(renderCalls[before].props['data-dsao-enhance-anchor'], '', 'the anchor marker attribute must be set')
}

console.log('prompt-enhance: 7 scenarios passed')
