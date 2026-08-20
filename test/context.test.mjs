// Verify private-reference extraction: the user-global AGENTS.md never leaks,
// project instructions collapse to structure signals in depth order, and the
// compaction summary and history tail are read from the live snapshot shape.
// Run: node test/context.test.mjs
import assert from 'node:assert/strict'
import { loadBundleModule } from './load-module.mjs'

const context = loadBundleModule('dsao/context')

// A context body exactly as dsh-agent-instructions renders it: the framed
// system-reminder, the shared intro, then one section per instruction file.
function instructionBody(files) {
  const parts = [
    '<system-reminder>',
    'The following workspace instructions may be relevant to your work. Use them as guidance when applicable.',
  ]
  for (const file of files) {
    parts.push('')
    if (file.additional === true) {
      parts.push(`Additional instructions from: ${file.path}`)
      parts.push('')
      parts.push('These instructions apply to work under `sub`. Use them as guidance when relevant; more specific instructions take precedence.')
    } else {
      parts.push(`Instructions from: ${file.path}`)
    }
    parts.push('')
    parts.push(file.content)
  }
  parts.push('</system-reminder>')
  return parts.join('\n')
}

function contextNode(files) {
  return {
    kind: 'context',
    form: 'instructions',
    content: [{ type: 'text', text: instructionBody(files) }],
    provenance: { role: 'inject', label: files.map((f) => f.path).join(', ') },
  }
}

const GLOBAL_CONTENT = [
  '# Global Agent Instructions',
  '',
  '## Decision Priority',
  '- **Conflict Resolution**：规则冲突时按顺序执行。',
  '- **Scope Control**：不擅自扩大目标。',
].join('\n')

const PROJECT_CONTENT = [
  '# dsh-assistant-optimization',
  '',
  '## Architecture',
  '- **Slot shadowing**: register at priority -1 and delegate back to the official component.',
  '- **Idempotent DOM**: cleanup runs before the anchor lookup.',
  '',
  '## Verification',
  '1. Run the node test suites before claiming completion.',
].join('\n')

const SUB_CONTENT = [
  '## Client bundle rules',
  '- Plain JS only: no JSX, no TypeScript, no import.',
].join('\n')

// 1. The global file is excluded while the project file survives.
{
  const out = context.readInstructions([
    contextNode([
      { path: '~/.dsh/AGENTS.md', content: GLOBAL_CONTENT },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  assert.ok(out.includes('AGENTS.md'), 'the project file must be reported')
  assert.ok(!out.includes('Global Agent Instructions'), 'the global heading must not leak')
  assert.ok(!out.includes('Conflict Resolution'), 'a global rule name must not leak')
  assert.ok(!out.includes('~/.dsh/AGENTS.md'), 'the global path must not be named')
  assert.ok(out.includes('Slot shadowing'), 'a project rule name must be kept')
}

// 2. The $DSH_HOME spelling of the global path is excluded too.
{
  const out = context.readInstructions([
    contextNode([{ path: '$DSH_HOME/AGENTS.md', content: GLOBAL_CONTENT }]),
  ])
  assert.equal(out, '', 'a global-only context must produce nothing')
}

// 3. Rule prose is dropped; only headings and rule names survive.
{
  const out = context.readInstructions([contextNode([{ path: 'AGENTS.md', content: PROJECT_CONTENT }])])
  assert.ok(out.includes('Architecture'), 'headings are signals')
  assert.ok(out.includes('Idempotent DOM'), 'a bolded rule name is a signal')
  assert.ok(!out.includes('delegate back to the official component'), 'rule prose must be dropped')
  assert.ok(!out.includes('These instructions apply to work under'), 'renderer boilerplate must be dropped')
  assert.ok(!out.includes('system-reminder'), 'the frame must be stripped')
}

// 4. Depth order: the root file first, deeper directories last, so the most
//    specific guidance lands closest to the draft.
{
  const out = context.readInstructions([
    contextNode([
      { path: 'src/modules/AGENTS.md', content: SUB_CONTENT, additional: true },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  const rootAt = out.indexOf('AGENTS.md: ')
  const subAt = out.indexOf('src/modules/AGENTS.md')
  assert.ok(rootAt >= 0 && subAt >= 0, 'both files must be reported')
  assert.ok(rootAt < subAt, 'the root file must come before the nested one')
}

// 5. CLAUDE.md yields to AGENTS.md in the same directory, but stands in when
//    AGENTS.md is absent — a project may ship only CLAUDE.md.
{
  const both = context.readInstructions([
    contextNode([
      { path: 'CLAUDE.md', content: '# Claude\n- Duplicate doc rule' },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  assert.ok(!both.includes('Duplicate doc rule'), 'CLAUDE.md must yield to AGENTS.md')
  assert.ok(both.includes('Architecture'), 'AGENTS.md must be read')
  assert.equal(both.split('\n').length, 1, 'one directory contributes one doc')

  const claudeOnly = context.readInstructions([
    contextNode([{ path: 'CLAUDE.md', content: '# Claude\n- Claude only rule' }]),
  ])
  assert.ok(claudeOnly.includes('Claude only rule'), 'CLAUDE.md stands in when AGENTS.md is absent')

  // Order within a message must not matter.
  const reversed = context.readInstructions([
    contextNode([
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
      { path: 'CLAUDE.md', content: '# Claude\n- Duplicate doc rule' },
    ]),
  ])
  assert.ok(!reversed.includes('Duplicate doc rule'), 'AGENTS.md wins regardless of section order')

  // Each directory decides independently.
  const perDir = context.readInstructions([
    contextNode([
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
      { path: 'src/CLAUDE.md', content: '# Sub\n- Nested claude rule', additional: true },
    ]),
  ])
  assert.ok(perDir.includes('Nested claude rule'), 'a nested directory may contribute CLAUDE.md')
}

// 6. A later context message supersedes an earlier one for the same file.
{
  const out = context.readInstructions([
    contextNode([{ path: 'AGENTS.md', content: '# Old\n- Stale rule' }]),
    contextNode([{ path: 'AGENTS.md', content: '# New\n- Fresh rule' }]),
  ])
  assert.ok(out.includes('Fresh rule'), 'the newer version must win')
  assert.ok(!out.includes('Stale rule'), 'the older version must be replaced')
  assert.equal(out.split('\n').length, 1, 'one file must produce one line')
}

// 7. The compaction summary is read, newest first.
{
  const nodes = [
    { kind: 'compaction', summary: 'earlier summary' },
    { kind: 'user', content: [{ type: 'text', text: 'hi' }] },
    { kind: 'compaction', summary: 'latest summary' },
  ]
  assert.equal(context.readSummary(nodes), 'latest summary', 'the latest summary wins')
  assert.equal(context.readSummary([{ kind: 'compaction', summary: null }]), '', 'a null summary yields nothing')
  assert.equal(context.readSummary([]), '', 'no compaction yields nothing')
}

// 8. History reads both node shapes, skips reasoning, and keeps chronology.
{
  const nodes = [
    { kind: 'user', content: [{ type: 'text', text: 'first ask' }] },
    {
      kind: 'assistant',
      blocks: [
        { kind: 'reasoning', text: 'internal thought' },
        { kind: 'text', text: 'first answer' },
      ],
    },
    { kind: 'tool-result', content: [{ type: 'text', text: 'tool noise' }] },
    { kind: 'user', content: [{ type: 'text', text: 'second ask' }] },
  ]
  const out = context.readHistory(nodes)
  assert.deepEqual(out.split('\n'), ['User: first ask', 'Agent: first answer', 'User: second ask'], 'chronological user/agent text only')
  assert.ok(!out.includes('internal thought'), 'reasoning must be skipped')
  assert.ok(!out.includes('tool noise'), 'tool results must be skipped')
}

// 9. History keeps the newest nodes when the node budget is exceeded.
{
  const nodes = []
  for (let i = 1; i <= 10; i++) nodes.push({ kind: 'user', content: [{ type: 'text', text: `ask ${i}` }] })
  const lines = context.readHistory(nodes).split('\n')
  assert.equal(lines.length, context.LIMITS.historyNodes, 'the node cap applies')
  assert.equal(lines[lines.length - 1], 'User: ask 10', 'the newest node is kept')
  assert.equal(lines[0], 'User: ask 5', 'the oldest kept node is the newest six')
}

// 10. Workspace identity resolves through cwd, with a basename fallback.
{
  const session = { sessionId: 's1', nodes: [] }
  const sessions = { byId: { s1: { cwd: 'D:/myProject/tools/dsh-assistant-optimization' } } }
  const workspaces = { items: [{ path: 'D:/myProject/tools/dsh-assistant-optimization', title: 'DSAO' }] }
  assert.equal(
    context.readProject(session, sessions, workspaces),
    'DSAO (D:/myProject/tools/dsh-assistant-optimization)',
    'a matching workspace supplies the title',
  )
  assert.equal(
    context.readProject(session, sessions, { items: [] }),
    'dsh-assistant-optimization (D:/myProject/tools/dsh-assistant-optimization)',
    'an unmatched cwd falls back to its basename',
  )
  assert.equal(context.readProject(session, { byId: {} }, workspaces), '', 'no cwd yields nothing')
}

// 11. readContext degrades safely and never throws on a foreign shape.
{
  const empty = { project: '', cwd: '', instructions: '', summary: '', history: '' }
  assert.deepEqual(context.readContext(null, null, null), empty, 'a null session is safe')
  assert.deepEqual(context.readContext({ nodes: 'nope' }, null, null), empty, 'a non-array nodes field is safe')
  const out = context.readContext({ sessionId: 's1', nodes: [contextNode([{ path: 'AGENTS.md', content: PROJECT_CONTENT }])] }, null, null)
  assert.ok(out.instructions.includes('Architecture'), 'instructions are extracted without session/workspace stores')
  assert.equal(out.project, '', 'project identity is empty without a cwd')
  assert.equal(out.cwd, '', 'cwd is empty without a session row')
}

// 12. Caps are enforced.
{
  const long = ['# Big'].concat(Array.from({ length: 40 }, (_, i) => `- Rule ${i} name: prose`)).join('\n')
  const out = context.readInstructions([contextNode([{ path: 'AGENTS.md', content: long }])])
  assert.ok(out.length <= context.LIMITS.instructionsTotal + 1, 'the instruction cap applies')
  const signals = context.structureSignals(long.split('\n'))
  assert.ok(signals.length <= context.LIMITS.signalsPerFile, 'the per-file signal cap applies')
}

// 13. cwd rides along so the Host can fall back to reading a file itself.
{
  const session = { sessionId: 's1', nodes: [] }
  const sessions = { byId: { s1: { cwd: 'D:/p/app' } } }
  assert.equal(context.readCwd(session, sessions), 'D:/p/app', 'the session cwd is reported')
  assert.equal(context.readCwd(session, null), '', 'no session store yields nothing')
  assert.equal(context.readCwd({ nodes: [] }, sessions), '', 'no sessionId yields nothing')
  assert.equal(context.readContext(session, sessions, null).cwd, 'D:/p/app', 'readContext carries cwd')
}

// 14. docRank fixes the per-directory preference and rejects other docs.
{
  assert.equal(context.docRank('AGENTS.md'), 0, 'AGENTS.md is preferred')
  assert.equal(context.docRank('src/AGENTS.local.md'), 0, 'a local overlay counts as AGENTS')
  assert.equal(context.docRank('CLAUDE.md'), 1, 'CLAUDE.md is the runner-up')
  assert.equal(context.docRank('README.md'), -1, 'README never enters the session path')
  assert.equal(context.docRank('docs/NOTES.md'), -1, 'an unrelated doc is rejected')
}

console.log('context: 14 scenarios passed')
