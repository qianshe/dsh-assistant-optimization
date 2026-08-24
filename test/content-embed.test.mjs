// Verify the two-section result format (file list first, content after)
// and the budget-limited embedding: ranges ship completely (no per-range
// line cap), byte budgets truncate from the tail with a marker, and every
// failure mode degrades to a marker instead of an error.
// Run: node --test test/content-embed.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { formatSearchResult, resolveContentBudgets } from '../lib/fast-context/content-embed.js'

/** Deterministic budgets (bypass the env-var resolution). */
const BUDGETS = { totalMaxBytes: 49152, fileMaxBytes: 16384, lineMaxChars: 400 }

function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'dsao-fc-content-'))
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

/** Write a file with `count` lines of `line(i)` content. */
function makeFile(dir, name, count, makeLine = (i) => `line ${i} content`) {
  const path = join(dir, name)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Array.from({ length: count }, (_, i) => makeLine(i + 1)).join('\n') + '\n')
  return path
}

test('two independent sections: complete file list first, content after', () => {
  return withTempDir((dir) => {
    const a = makeFile(dir, 'src/a.ts', 10)
    const b = makeFile(dir, 'src/b.py', 10)
    const out = formatSearchResult(
      [
        { full_path: a, ranges: [[1, 10]] },
        { full_path: b, ranges: [[5, 8]] },
      ],
      { budgets: BUDGETS },
    )

    assert.ok(out.startsWith('Found 2 relevant files.'))
    const listIdx = out.indexOf('Files:')
    const contentIdx = out.indexOf('Contents:')
    assert.ok(listIdx > -1, 'the list section header is present')
    assert.ok(contentIdx > -1, 'the content section header is present')
    assert.ok(listIdx < contentIdx, 'the list section comes before the content section')

    // The list section is code-free and complete.
    const listSection = out.slice(listIdx, contentIdx)
    assert.ok(!listSection.includes('```'), 'the list section carries no code fences')
    assert.ok(listSection.includes(`  [1/2] ${a} (L1-10)`))
    assert.ok(listSection.includes(`  [2/2] ${b} (L5-8)`))

    // The content section carries the code, in list order, with no config noise.
    const contentSection = out.slice(contentIdx)
    assert.ok(contentSection.includes('```ts\n'))
    assert.ok(contentSection.includes('```python\n'))
    assert.ok(contentSection.includes('1: '))
    assert.ok(contentSection.includes('5: '))
    assert.ok(!out.includes('grep keywords'))
    assert.ok(!out.includes('[config]'))
  })
})

test('a range is embedded completely — no per-range line cap', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'big.ts', 300)
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 300]] }], { budgets: BUDGETS })

    assert.ok(out.includes('1: line 1 content'))
    assert.ok(out.includes('300: line 300 content'), 'the last line of the range is present')
    assert.ok(!out.includes('omitted'), 'a range that fits the byte budgets ships without a marker')
  })
})

test('a range exceeding the byte budgets is truncated from the tail with a marker', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'big.ts', 300)
    const tight = { totalMaxBytes: 4096, fileMaxBytes: 2048, lineMaxChars: 400 }
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 300]] }], { budgets: tight })

    assert.ok(out.includes('1: line 1 content'))
    const m = out.match(/\(L(\d+)-300 omitted: content budget; use read for the rest\)/)
    assert.ok(m, 'the tail-omission marker is present')
    // The marker starts exactly where the embedded lines end.
    const lastEmbedded = out.split('\n').filter((l) => /^\d+: line \d+ content$/.test(l)).pop()
    assert.equal(Number(m[1]), Number(lastEmbedded.split(':')[0]) + 1)
  })
})

test('total budget exhaustion marks later files, never throws', () => {
  return withTempDir((dir) => {
    const a = makeFile(dir, 'a.ts', 200)
    const b = makeFile(dir, 'b.ts', 200)
    const c = makeFile(dir, 'c.ts', 200)
    const tight = { totalMaxBytes: 2048, fileMaxBytes: 1024, lineMaxChars: 400 }
    const out = formatSearchResult(
      [
        { full_path: a, ranges: [[1, 200]] },
        { full_path: b, ranges: [[1, 200]] },
        { full_path: c, ranges: [[1, 200]] },
      ],
      { budgets: tight },
    )

    assert.ok(out.includes('(content omitted: budget exhausted; use read L1-200)'))
    // The marker belongs to file 3: nothing after its content-section header
    // ships a code fence.
    const afterContents = out.slice(out.indexOf('Contents:'))
    const c3 = afterContents.indexOf('  [3/3] ')
    assert.ok(!afterContents.slice(c3).includes('```ts\n'))
  })
})

test('per-line char truncation guards long lines', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'long.js', 5, (i) => `x${i} ${'y'.repeat(1000)}`)
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 5]] }], { budgets: BUDGETS })
    const line = out.split('\n').find((l) => l.startsWith('1: '))
    assert.ok(line.length <= `1: `.length + 400, `line exceeds the char budget: ${line.length}`)
    // Truncation is silent by design (no ellipsis suffix).
  })
})

test('a missing file degrades to a marker, not an error', () => {
  const out = formatSearchResult(
    [{ full_path: 'C:/nowhere/gone.ts', ranges: [[1, 10]] }],
    { budgets: BUDGETS },
  )
  assert.ok(out.includes('(content unavailable: file no longer exists)'))
  // The list section still carries the entry.
  assert.ok(out.includes('Files:'))
  assert.ok(out.includes('C:/nowhere/gone.ts'))
})

test('a binary file is skipped with a marker', () => {
  return withTempDir((dir) => {
    const path = join(dir, 'blob.bin')
    writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 10]] }], { budgets: BUDGETS })
    assert.ok(out.includes('(content skipped: binary file)'))
  })
})

test('an out-of-bounds range is reported as such', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'small.ts', 10)
    const out = formatSearchResult([{ full_path: path, ranges: [[50, 80]] }], { budgets: BUDGETS })
    assert.ok(out.includes('(range L50-80 is out of file bounds)'))
  })
})

test('include_content=false yields only the file list section', () => {
  const files = [{ full_path: 'C:/proj/src/a.ts', ranges: [[1, 10], [50, 60]] }]
  const out = formatSearchResult(files, { includeContent: false, budgets: BUDGETS })

  assert.ok(out.includes('Files:'))
  assert.ok(out.includes('  [1/1] C:/proj/src/a.ts (L1-10, L50-60)'))
  assert.ok(!out.includes('Contents:'), 'no content section')
  assert.ok(!out.includes('```'), 'no code fences')
})

test('a salvaged file without ranges gets a preview in the content section', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'salvaged.ts', 100)
    const out = formatSearchResult([{ full_path: path, ranges: [] }], { budgets: BUDGETS })

    assert.ok(out.includes('(preview)'))
    assert.ok(out.includes('1: line 1 content'))
    assert.ok(out.includes('40: line 40 content'))
    assert.ok(!out.includes('41: line 41'))
  })
})

test('an empty file list says so plainly', () => {
  assert.equal(formatSearchResult([], { budgets: BUDGETS }), 'No files found.')
})

test('resolveContentBudgets clamps env values to sane bounds', () => {
  const saved = {}
  const names = ['FC_CONTENT_MAX_BYTES', 'FC_CONTENT_FILE_MAX_BYTES', 'FC_CONTENT_LINE_MAX_CHARS']
  for (const n of names) saved[n] = process.env[n]
  try {
    for (const n of names) delete process.env[n]
    const defaults = resolveContentBudgets()
    assert.equal(defaults.totalMaxBytes, 49152)
    assert.equal(defaults.fileMaxBytes, 16384)
    assert.equal(defaults.lineMaxChars, 400)
    assert.equal('rangeMaxLines' in defaults, false, 'the per-range line cap is gone')

    process.env.FC_CONTENT_MAX_BYTES = '10' // below min → clamped to 1024
    process.env.FC_CONTENT_FILE_MAX_BYTES = '999999' // above max → 131072
    const clamped = resolveContentBudgets()
    assert.equal(clamped.totalMaxBytes, 1024)
    assert.equal(clamped.fileMaxBytes, 131072)
  } finally {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
  }
})
