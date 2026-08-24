// Verify budget-limited content embedding and the new result format:
// explicit file list + per-file limited code, no keyword/config lines,
// and every failure mode degrades to a marker instead of an error.
// Run: node --test test/content-embed.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { formatSearchResult, resolveContentBudgets } from '../lib/fast-context/content-embed.js'

/** Deterministic budgets (bypass the env-var resolution). */
const BUDGETS = { totalMaxBytes: 12288, fileMaxBytes: 3072, rangeMaxLines: 120, lineMaxChars: 400 }

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

test('explicit file list with embedded code; no keyword or config lines', () => {
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
    assert.ok(out.includes(`  [1/2] ${a} (L1-10)`))
    assert.ok(out.includes(`  [2/2] ${b} (L5-8)`))
    assert.ok(out.includes('```ts\n'))
    assert.ok(out.includes('```python\n'))
    assert.ok(out.includes('1: '))
    assert.ok(out.includes('5: '))
    assert.ok(!out.includes('grep keywords'))
    assert.ok(!out.includes('[config]'))
  })
})

test('embeds real file content under the budgets', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'src/a.ts', 10, (i) => `export const v${i} = ${i}`)
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 10]] }], { budgets: BUDGETS })

    assert.ok(out.includes('1: export const v1 = 1'))
    assert.ok(out.includes('10: export const v10 = 10'))
    assert.ok(!out.includes('omitted'))
  })
})

test('per-range line cap truncates long ranges with a marker', () => {
  return withTempDir((dir) => {
    const path = makeFile(dir, 'big.ts', 300)
    const out = formatSearchResult([{ full_path: path, ranges: [[1, 300]] }], { budgets: BUDGETS })

    assert.ok(out.includes('120: line 120 content'))
    assert.ok(!out.includes('121: line 121'))
    assert.ok(out.includes('(L121-300 omitted; use read for the rest)'))
  })
})

test('total budget exhaustion marks later files, never throws', () => {
  return withTempDir((dir) => {
    const a = makeFile(dir, 'a.ts', 200)
    const b = makeFile(dir, 'b.ts', 200)
    const c = makeFile(dir, 'c.ts', 200)
    // Tight budgets: file cap 1024B, total cap 2048B → the third file must
    // land on a budget marker.
    const tight = { totalMaxBytes: 2048, fileMaxBytes: 1024, rangeMaxLines: 120, lineMaxChars: 400 }
    const out = formatSearchResult(
      [
        { full_path: a, ranges: [[1, 200]] },
        { full_path: b, ranges: [[1, 200]] },
        { full_path: c, ranges: [[1, 200]] },
      ],
      { budgets: tight },
    )

    assert.ok(out.includes('  [3/3] '))
    assert.ok(out.includes('(content omitted: budget exhausted; use read L1-200)'))
    // The marker belongs to file 3: no code fence follows its header line.
    const idx = out.indexOf('  [3/3] ')
    assert.ok(!out.slice(idx).includes('```ts\n1: '))
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

test('include_content=false yields a path+range list only', () => {
  const files = [{ full_path: 'C:/proj/src/a.ts', ranges: [[1, 10], [50, 60]] }]
  const out = formatSearchResult(files, { includeContent: false, budgets: BUDGETS })

  assert.ok(out.includes('  [1/1] C:/proj/src/a.ts (L1-10, L50-60)'))
  assert.ok(!out.includes('```'))
  assert.ok(!out.includes('omitted'))
})

test('a salvaged file without ranges gets a preview', () => {
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
  const names = ['FC_CONTENT_MAX_BYTES', 'FC_CONTENT_FILE_MAX_BYTES', 'FC_CONTENT_MAX_LINES_PER_RANGE', 'FC_CONTENT_LINE_MAX_CHARS']
  for (const n of names) saved[n] = process.env[n]
  try {
    for (const n of names) delete process.env[n]
    const defaults = resolveContentBudgets()
    assert.equal(defaults.totalMaxBytes, 12288)
    assert.equal(defaults.fileMaxBytes, 3072)
    assert.equal(defaults.rangeMaxLines, 120)
    assert.equal(defaults.lineMaxChars, 400)

    process.env.FC_CONTENT_MAX_BYTES = '10' // below min → clamped to 1024
    process.env.FC_CONTENT_MAX_LINES_PER_RANGE = '99999' // above max → 500
    const clamped = resolveContentBudgets()
    assert.equal(clamped.totalMaxBytes, 1024)
    assert.equal(clamped.rangeMaxLines, 500)
  } finally {
    for (const [n, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[n]
      else process.env[n] = v
    }
  }
})
