// Verify diffStats suppresses the badge for errored file-mutation calls.
// Run: node test/diff-stats.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Extract the dsao/tool-diff module factory out of the static bundle and
// evaluate it with a minimal stub environment (no DOM needed for diffStats).
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const start = bundle.indexOf('id: "dsao/tool-diff"')
assert.ok(start > 0, 'tool-diff module not found in bundle')
const factoryStart = bundle.indexOf('factory: function (require) {', start)
const bodyStart = bundle.indexOf('{', factoryStart + 'factory: function (require)'.length) + 1

// Balance braces to find the factory end.
let depth = 1
let i = bodyStart
while (depth > 0 && i < bundle.length) {
  const ch = bundle[i]
  if (ch === '{') depth++
  else if (ch === '}') depth--
  else if (ch === '"' || ch === "'") {
    const quote = ch
    i++
    while (i < bundle.length && bundle[i] !== quote) {
      if (bundle[i] === '\\') i++
      i++
    }
  } else if (ch === '/' && bundle[i + 1] === '/') {
    while (i < bundle.length && bundle[i] !== '\n') i++
  }
  i++
}
const body = bundle.slice(bodyStart, i - 1)

// createBadge touches document; stub just enough for module evaluation.
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  createTextNode: () => ({}),
}
const factory = new Function('require', body)
const toolDiff = factory(() => ({}))

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

// 3. Settled call with no diff result view → no badge (no callView fallback).
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: null, callView: diffView }),
  null,
  'settled call without a diff result view must not fall back to callView',
)

// 4. Running call → callView is the only source, badge shows early.
assert.deepEqual(
  toolDiff.diffStats({ callView: diffView }),
  { added: 2, deleted: 1 },
  'running call should report stats from callView',
)

// 5. Empty diff → no badge.
assert.equal(
  toolDiff.diffStats({ kind: 'tool-result', isError: false, resultView: { card: 'diff', diffs: [] } }),
  null,
  'empty diff should not report stats',
)

console.log('diff-stats: 5 assertions passed')
