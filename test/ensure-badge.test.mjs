// Verify ensureBadge converges on the live DOM, including the running → errored
// transition that leaves a stale badge behind.
// Run: node test/ensure-badge.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'
import { installStubDocument, buildToolRow, swapToErrorSummary, badgesIn } from './dom-stub.mjs'

installStubDocument()
const toolDiff = loadBundleModule('dsao/tool-diff')

const diffView = { card: 'diff', diffs: [{ path: 'a.js', oldText: 'x\n', newText: 'y\nz\n' }] }
const running = { callView: diffView }
const settled = { kind: 'tool-result', isError: false, resultView: diffView, callView: diffView }
const errored = { kind: 'tool-result', isError: true, resultView: null, callView: diffView }

function badgeText(container) {
  const [badge] = badgesIn(container)
  return badge === undefined ? null : badge.children.map((c) => c.textContent).join('')
}

// 1. A running call gets a badge right after the file link.
{
  const { container, summary } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  assert.equal(badgesIn(container).length, 1, 'running call should get one badge')
  assert.equal(summary.nextElementSibling, badgesIn(container)[0], 'badge must sit right after the file link')
  assert.equal(badgeText(container), '+2/-1', 'badge should read +2/-1')
}

// 2. Repeated calls are idempotent: same node, no churn.
{
  const { container } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  const first = badgesIn(container)[0]
  toolDiff.ensureBadge(container, running)
  toolDiff.ensureBadge(container, running)
  assert.equal(badgesIn(container).length, 1, 'repeat calls must not duplicate the badge')
  assert.equal(badgesIn(container)[0], first, 'repeat calls must not replace the badge node')
}

// 3. Changed counts rebuild the badge.
{
  const { container } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  toolDiff.ensureBadge(container, {
    callView: { card: 'diff', diffs: [{ path: 'a.js', oldText: null, newText: 'one\ntwo\nthree\n' }] },
  })
  assert.equal(badgesIn(container).length, 1, 'a rebuild must leave exactly one badge')
  assert.equal(badgeText(container), '+3', 'badge should follow the new counts')
}

// 4. The regression: a streaming call that ends in an error. The official row
//    swaps the file link for an error summary, so the stale badge must still be
//    removed even though no file link remains to anchor to.
{
  const { container, row, summary } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  assert.equal(badgesIn(container).length, 1, 'precondition: badge injected while streaming')

  swapToErrorSummary(row, summary)
  toolDiff.ensureBadge(container, errored)
  assert.equal(badgesIn(container).length, 0, 'errored call must drop the stale badge')
}

// 5. Same transition without the DOM swap (result arrives before re-render):
//    suppression is driven by the block, not only by the missing link.
{
  const { container } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  toolDiff.ensureBadge(container, errored)
  assert.equal(badgesIn(container).length, 0, 'errored block must drop the badge even with the link present')
}

// 6. A row that renders as errored from the start never gets a badge.
{
  const { container } = buildToolRow({ errored: true })
  toolDiff.ensureBadge(container, errored)
  assert.equal(badgesIn(container).length, 0, 'an errored row must not gain a badge')
}

// 7. running → settled keeps the badge (the ordinary success path).
{
  const { container } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  toolDiff.ensureBadge(container, settled)
  assert.equal(badgesIn(container).length, 1, 'settled success should keep one badge')
  assert.equal(badgeText(container), '+2/-1', 'settled counts should match the result view')
}

// 8. A missing block clears the badge instead of throwing.
{
  const { container } = buildToolRow()
  toolDiff.ensureBadge(container, running)
  toolDiff.ensureBadge(container, null)
  assert.equal(badgesIn(container).length, 0, 'a null block must clear the badge')
}

console.log('ensure-badge: 8 scenarios passed')
