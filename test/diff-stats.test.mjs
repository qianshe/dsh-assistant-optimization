// Verify diffStats suppresses the badge for errored file-mutation calls.
// Run: node test/diff-stats.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
import { installStubDocument } from './dom-stub.mjs'

installStubDocument()
const toolDiff = loadBundleModule('dsao/tool-diff')

const diffView = { card: 'diff', diffs: [{ path: 'a.js', oldText: 'x\n', newText: 'y\nz\n' }] }

// 1. Successful settled edit → badge shows counts.
assert.deepEqual(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: diffView, callView: diffView }),
  { added: 2, deleted: 1 },
  'successful edit should report stats',
)

// 2. Errored edit → no badge, even though callView still describes the intent.
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: true, resultView: null, callView: diffView }),
  null,
  'errored edit must not report stats',
)

// 3. An errored call whose resultView still carries a diff card is still suppressed.
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: true, resultView: diffView, callView: diffView }),
  null,
  'isError must win over a diff-shaped result view',
)

// 4. Settled call with no diff result view → no badge (no callView fallback).
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: null, callView: diffView }),
  null,
  'settled call without a diff result view must not fall back to callView',
)

// 5. Running call → callView is the only source, badge shows early.
assert.deepEqual(
  toolDiff.diffStats({ callView: diffView }),
  { added: 2, deleted: 1 },
  'running call should report stats from callView',
)

// 6. Empty diff → no badge.
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: { card: 'diff', diffs: [] } }),
  null,
  'empty diff should not report stats',
)

// 7. A non-diff card on the result side → no badge.
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: { card: 'terminal' } }),
  null,
  'a non-diff card should not report stats',
)

console.log('diff-stats: 7 assertions passed')
