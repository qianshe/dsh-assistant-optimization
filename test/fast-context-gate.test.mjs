// Verify the key gate on context_search: with no resolvable key the tool
// and its prompt section are both absent; with a key both appear, the prompt
// stays minimal, and the tool still executes.
// Run: node --test test/fast-context-gate.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applyFastContextTool } from '../lib/fast-context/tool.js'
import { resolveWindsurfKey, writeKeyFile, readKeyFile, clearKeyFile, keyFilePath } from '../lib/fast-context/key-source.js'

/**
 * A context stub that records tool and prompt-section registrations.
 * `services` decides which optional services exist, mirroring ctx.get.
 */
function mountCtx(services) {
  const tools = []
  const sections = []
  const toolsService = services.tools === null ? undefined : {
    register: (definition) => { tools.push(definition); return () => {} },
  }
  const promptService = services.systemPrompt === null ? undefined : {
    section: (s) => { sections.push(s); return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'tools' ? toolsService : name === 'systemPrompt' ? promptService : undefined),
    effect: (callback) => callback(),
  }
  return { ctx, tools, sections }
}

/** An isolated DSH_HOME so the test never touches the real key file. */
function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'dsao-fc-test-'))
  const saved = { DSH_HOME: process.env.DSH_HOME, WINDSURF_API_KEY: process.env.WINDSURF_API_KEY, DSAO_FC_AUTO_KEY: process.env.DSAO_FC_AUTO_KEY }
  process.env.DSH_HOME = home
  delete process.env.WINDSURF_API_KEY
  // Local discovery off: this host may have Windsurf installed, and the
  // no-key case must be reproducible everywhere.
  process.env.DSAO_FC_AUTO_KEY = '0'
  return Promise.resolve(run(home)).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(home, { recursive: true, force: true })
  })
}

test('no key: neither the tool nor its prompt section is registered', async () => {
  await withTempHome(async () => {
    const resolved = await resolveWindsurfKey()
    assert.equal(resolved.key, '')
    assert.equal(resolved.source, 'none')

    const { ctx, tools, sections } = mountCtx({})
    const result = await applyFastContextTool(ctx)

    assert.equal(result.registered, false)
    assert.deepEqual(tools, [], 'no tool may be registered without a key')
    assert.deepEqual(sections, [], 'no prompt section may be registered without a key')
  })
})

test('manual key file: tool + minimal prompt section are registered', async () => {
  await withTempHome(async (home) => {
    const path = writeKeyFile('test-key-abcdef')
    assert.equal(path, join(home, 'dsao-windsurf-key'))
    assert.equal(readKeyFile(), 'test-key-abcdef')

    const resolved = await resolveWindsurfKey()
    assert.equal(resolved.key, 'test-key-abcdef')
    assert.equal(resolved.source, 'file')

    const { ctx, tools, sections } = mountCtx({})
    const result = await applyFastContextTool(ctx)

    assert.equal(result.registered, true)
    assert.equal(result.source, 'file')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].name, 'context_search')
    assert.equal(typeof tools[0].execute, 'function')
    assert.equal(tools[0].parameters.query.required, true)
    assert.equal(tools[0].output.schema.type, 'string')

    assert.equal(sections.length, 1)
    assert.equal(sections[0].name, 'dsao:tool:fast-context')
    assert.equal(sections[0].order, 150)

    // Minimality gate: the guidance is paid for on every turn. Keep it short,
    // and keep examples/background out.
    const text = sections[0].text
    assert.equal(typeof text, 'string')
    assert.ok(text.length < 400, `prompt section too long: ${text.length} chars`)
    assert.ok(/context_search/.test(text), 'must name the tool')
    assert.ok(!text.includes('```'), 'no code fences')
    assert.ok(!/example/i.test(text), 'no examples')
  })
})

test('env key wins over the manual file', async () => {
  await withTempHome(async () => {
    writeKeyFile('file-key')
    process.env.WINDSURF_API_KEY = 'env-key'
    const resolved = await resolveWindsurfKey()
    assert.equal(resolved.key, 'env-key')
    assert.equal(resolved.source, 'env')
  })
})

test('the manual key file round-trips and clears', async () => {
  await withTempHome(async () => {
    assert.equal(readKeyFile(), '')
    assert.equal(clearKeyFile(), false)

    // A key pasted with quotes or a trailing newline still resolves.
    writeKeyFile('  "quoted-key"  ')
    assert.equal(readKeyFile(), 'quoted-key')
    assert.ok(existsSync(keyFilePath()))
    assert.match(readFileSync(keyFilePath(), 'utf8'), /\n$/)

    assert.equal(clearKeyFile(), true)
    assert.equal(readKeyFile(), '')
  })
})

test('a missing tools service disables registration without throwing', async () => {
  await withTempHome(async () => {
    writeKeyFile('test-key')
    const { ctx, sections } = mountCtx({ tools: null })
    const result = await applyFastContextTool(ctx)
    assert.equal(result.registered, false)
    assert.match(result.detail, /tools service/)
    assert.deepEqual(sections, [])
  })
})

test('a missing systemPrompt service still registers the tool', async () => {
  await withTempHome(async () => {
    writeKeyFile('test-key')
    const { ctx, tools, sections } = mountCtx({ systemPrompt: null })
    const result = await applyFastContextTool(ctx)
    assert.equal(result.registered, true)
    assert.equal(tools.length, 1)
    assert.deepEqual(sections, [])
  })
})

test('execute rejects a blank query and a non-directory project_path', async () => {
  await withTempHome(async (home) => {
    writeKeyFile('test-key')
    const { ctx, tools } = mountCtx({})
    await applyFastContextTool(ctx)
    const tool = tools[0]
    const exec = { signal: new AbortController().signal }

    await assert.rejects(() => tool.execute({ query: '   ' }, exec), /non-empty string/)
    await assert.rejects(
      () => tool.execute({ query: 'find the parser', project_path: join(home, 'nope') }, exec),
      /not readable/,
    )
  })
})
