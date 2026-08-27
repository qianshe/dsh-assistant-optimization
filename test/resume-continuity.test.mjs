// Verify the resume-marker row handling: only the dsaoResume empty-block
// user node collapses to the hint; ordinary user rows delegate untouched.
// Run: node test/resume-continuity.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'

const m = loadBundleModule('dsao/resume-continuity', () => ({}))

// 1. Marker shapes.
assert.equal(m.isResumeMarker({ data: { content: [], source: { kind: 'user', dsaoResume: true } } }), true)
assert.equal(m.isResumeMarker({ data: { content: [{ type: 'text', text: ' \n' }], source: { kind: 'user', dsaoResume: true } } }), true)

// 2. Ordinary user rows must never collapse.
assert.equal(m.isResumeMarker({ data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } } }), false)
assert.equal(m.isResumeMarker({ data: { content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } } }), false, 'sentinel without flag stays visible')
assert.equal(m.isResumeMarker({ data: { content: [], source: { kind: 'user' } } }), false, 'empty block WITHOUT the flag stays visible')
assert.equal(m.isResumeMarker({ data: { content: [{ type: 'image', attachment: {} }], source: { kind: 'user', dsaoResume: true } } }), false, 'non-text blocks are not a marker')

// 3. Junk tolerance.
for (const junk of [null, undefined, {}, { data: null }, { data: {} }]) {
  assert.equal(m.isResumeMarker(junk), false)
}

// 4. Hint text constant (copy contract, PRD FR-10 family).
assert.equal(m.HINT_TEXT, '已从中断处继续')

// 5. Shadow component branch: marker renders the hint node; ordinary row with
//    no official renderer found returns null (never crashes the chat flow).
{
  const R = m.createResumeContinuity({ createElement: (type, props) => ({ type, props }) })
  const Comp = R.ResumeMarkerAwareUserNode
  const markerOut = Comp({ node: { data: { content: [], source: { kind: 'user', dsaoResume: true } } } })
  assert.equal(markerOut.type, 'div')
  assert.equal(markerOut.props['data-dsao-resume-hint'], '')
  assert.equal(Comp({ node: { data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }, slots: null }), null)
}

// 6. Official renderer discovery via provideSlots.
{
  const official = function Official() {}
  const slots = {
    entries: () => [
      { options: { key: 'user', priority: -1 }, component: function Shadow() {} },
      { options: { key: 'user', priority: 0 }, component: official },
    ],
  }
  m.createResumeContinuity({}).provideSlots(slots)
  const found = m.findOfficialUserRenderer(slots)
  assert.equal(found, official)
}

console.log('resume-continuity: all assertions passed')
