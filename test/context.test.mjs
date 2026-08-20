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

// 5. Per directory, one FAMILY wins: CLAUDE yields to AGENTS but stands in when
//    no AGENTS file exists. Family selection takes the overlay with it.
{
  const both = context.readInstructions([
    contextNode([
      { path: 'CLAUDE.md', content: '# Claude\n- Duplicate doc rule' },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  assert.ok(!both.includes('Duplicate doc rule'), 'CLAUDE.md must yield to AGENTS.md')
  assert.ok(both.includes('Architecture'), 'AGENTS.md must be read')
  assert.equal(both.split('\n').length, 1, 'one family per directory')

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

  // Losing a family drops its overlay too.
  const withOverlay = context.readInstructions([
    contextNode([
      { path: 'CLAUDE.md', content: '# C\n- Claude rule: x' },
      { path: 'CLAUDE.local.md', content: '# CL\n- Claude local: y' },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  assert.ok(!withOverlay.includes('Claude local'), "the losing family's overlay is dropped too")
  assert.equal(withOverlay.split('\n').length, 1, 'only the winning family remains')

  // Each directory decides independently.
  const perDir = context.readInstructions([
    contextNode([
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
      { path: 'src/CLAUDE.md', content: '# Sub\n- Nested claude rule', additional: true },
    ]),
  ])
  assert.ok(perDir.includes('Nested claude rule'), 'a nested directory may contribute CLAUDE.md')
}

// 5b. A `.local` overlay is the personal layer beside the shared file, not a
//     duplicate of it. DSH injects both and collapses them only when their
//     trimmed content matches, so both survive here, base first — the overlay is
//     the more specific of the two.
{
  const out = context.readInstructions([
    contextNode([
      { path: 'AGENTS.local.md', content: '# Local\n- 本机环境: proxy on 7897' },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  const lines = out.split('\n')
  assert.equal(lines.length, 2, 'the shared file and its overlay both survive')
  assert.ok(lines[0].startsWith('AGENTS.md:'), 'the shared file comes first')
  assert.ok(lines[1].startsWith('AGENTS.local.md:'), 'the personal overlay comes last')
  assert.ok(out.includes('Architecture'), 'shared signals are kept')
  assert.ok(out.includes('本机环境'), 'overlay signals are kept')

  // A nested overlay still sorts after its own directory's shared file, and both
  // sort after the project root.
  const nested = context.readInstructions([
    contextNode([
      { path: 'src/AGENTS.local.md', content: '# SL\n- Nested local: a', additional: true },
      { path: 'src/AGENTS.md', content: '# S\n- Nested shared: b', additional: true },
      { path: 'AGENTS.md', content: PROJECT_CONTENT },
    ]),
  ])
  const order = nested.split('\n').map((line) => line.split(':')[0])
  assert.deepEqual(order, ['AGENTS.md', 'src/AGENTS.md', 'src/AGENTS.local.md'], 'root, then nested shared, then nested overlay')
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

// 8. History carries the user's own asks only. Agent replies are the source of
//    the values a rewrite would wrongly restate as fact, so they never enter the
//    reference — the pollution is removed rather than policed by a rule.
{
  const nodes = [
    { kind: 'user', content: [{ type: 'text', text: 'first ask' }] },
    {
      kind: 'assistant',
      blocks: [
        { kind: 'reasoning', text: 'internal thought' },
        { kind: 'text', text: 'project 52 / instructions 340 / summary 0' },
      ],
    },
    { kind: 'tool-result', content: [{ type: 'text', text: 'tool noise' }] },
    { kind: 'user', content: [{ type: 'text', text: 'second ask' }] },
  ]
  const out = context.readHistory(nodes)
  assert.deepEqual(out.split('\n'), ['first ask', 'second ask'], 'chronological user asks, unlabelled')
  assert.ok(!out.includes('project 52'), 'agent-supplied values must not reach the reference')
  assert.ok(!out.includes('internal thought'), 'reasoning must be skipped')
  assert.ok(!out.includes('tool noise'), 'tool results must be skipped')
  assert.ok(!out.includes('Agent'), 'no agent turn is represented at all')
}

// 9. History keeps the newest asks when the node budget is exceeded.
{
  const nodes = []
  for (let i = 1; i <= 10; i++) nodes.push({ kind: 'user', content: [{ type: 'text', text: `ask ${i}` }] })
  const lines = context.readHistory(nodes).split('\n')
  assert.equal(lines.length, context.LIMITS.historyNodes, 'the node cap applies')
  assert.equal(lines[lines.length - 1], 'ask 10', 'the newest ask is kept')
  assert.equal(lines[0], `ask ${10 - context.LIMITS.historyNodes + 1}`, 'the kept window is the newest N')
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
  const empty = { project: '', cwd: '', instructions: '', summary: '', history: '', replies: '' }
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
  assert.equal(context.docRank('src/AGENTS.local.md'), 1, 'the AGENTS overlay ranks after its base')
  assert.equal(context.docRank('CLAUDE.md'), 2, 'CLAUDE.md is the runner-up family')
  assert.equal(context.docRank('CLAUDE.local.md'), 3, 'the CLAUDE overlay ranks last')
  assert.equal(context.docRank('README.md'), -1, 'README never enters the session path')
  assert.equal(context.docRank('docs/NOTES.md'), -1, 'an unrelated doc is rejected')

  assert.equal(context.docFamily(0), 'agents', 'AGENTS.md is the agents family')
  assert.equal(context.docFamily(1), 'agents', 'its overlay is the same family')
  assert.equal(context.docFamily(2), 'claude', 'CLAUDE.md is the claude family')
  assert.equal(context.docFamily(3), 'claude', 'its overlay is the same family')

  assert.equal(context.isOverlay(0), false, 'a shared file is not an overlay')
  assert.equal(context.isOverlay(1), true, 'AGENTS.local.md is an overlay')
  assert.equal(context.isOverlay(2), false, 'CLAUDE.md is not an overlay')
  assert.equal(context.isOverlay(3), true, 'CLAUDE.local.md is an overlay')
}

// 15. stripLiteralBlocks removes where transient literals live, and keeps the
//     identities. Fenced blocks were the actual source of the earlier leak: a
//     rewrite pasted byte counts out of an illustrative example.
{
  const text = [
    'Prose before.',
    '```js',
    'const REF_CAPS = { history: 1200 }',
    '```',
    '| col | col |',
    '|---|---|',
    '| 340 | 52 |',
    '---',
    'Prose with `ensureBadge` and `lib/client.js`.',
  ].join('\n')
  const out = context.stripLiteralBlocks(text)
  assert.ok(!out.includes('REF_CAPS'), 'fenced code is removed')
  assert.ok(!out.includes('340'), 'table rows are removed')
  assert.ok(out.includes('Prose before.'), 'prose survives')
  assert.ok(out.includes('ensureBadge'), 'an inline identity survives')
  assert.ok(out.includes('lib/client.js'), 'an inline path survives')
  assert.ok(!out.includes('`'), 'the backticks themselves are dropped')
}

// 16. hasQuantity separates a measurement from an identity: a digit glued to a
//     letter or following a hyphen is part of a name, not a value.
{
  for (const identity of ['pkg-7 已运行', 'deepseek-v4-flash', 'AGENTS.md 读到了', '改成蓝色', 'no digits here']) {
    assert.equal(context.hasQuantity(identity), false, `${identity} must read as an identity`)
  }
  for (const quantity of ['15 条 → 12 条', '+2/-1', '64KB 上限', 'priority: -1', 'about 900 chars']) {
    assert.equal(context.hasQuantity(quantity), true, `${quantity} must read as a measurement`)
  }
}

// 17. readReplies takes one conclusion per turn: the highest step, quantity-free
//     sentences only, interrupted prefixes skipped.
{
  const reply = [
    '按钮已恢复，注入层修好了。',
    '',
    '| 项 | 内容 |',
    '|---|---|',
    '| 删 | 独立规则 |',
    '',
    '```js',
    'project 52 / instructions 340',
    '```',
    '',
    '根因是 `readHistory` 把 agent 回复也注入了。',
    '15 条精简到 12 条。',
  ].join('\n')

  const nodes = [
    { kind: 'user', content: [{ type: 'text', text: '按钮不见了' }] },
    { kind: 'assistant', turn: 1, step: 0, blocks: [{ kind: 'text', text: '先看一下 slot 注册。' }] },
    { kind: 'assistant', turn: 1, step: 3, blocks: [{ kind: 'reasoning', text: '内部思考' }, { kind: 'text', text: reply }] },
    { kind: 'user', content: [{ type: 'text', text: '继续' }] },
    { kind: 'assistant', turn: 2, step: 1, interrupted: true, blocks: [{ kind: 'text', text: '被打断的前缀' }] },
  ]

  const out = context.readReplies(nodes)
  assert.ok(out.includes('按钮已恢复'), 'the conclusion is carried')
  assert.ok(out.includes('readHistory'), 'an identity inside the conclusion survives')
  assert.ok(!out.includes('先看一下'), 'an earlier step is not the conclusion')
  assert.ok(!out.includes('project 52'), 'fenced values never reach the reference')
  assert.ok(!out.includes('15 条'), 'a sentence carrying a quantity is dropped whole')
  assert.ok(!out.includes('内部思考'), 'reasoning is skipped')
  assert.ok(!out.includes('被打断'), 'an interrupted prefix is not a conclusion')
  assert.equal(out.split('\n').length, 1, 'one line per turn with a usable conclusion')

  // Asks and replies are a pair, each with its own budget.
  assert.equal(context.readHistory(nodes), '按钮不见了\n继续', 'asks are unchanged')
  const ctxOut = context.readContext({ sessionId: 's1', nodes }, null, null)
  assert.ok(ctxOut.replies.includes('按钮已恢复'), 'readContext carries replies')
  assert.ok(ctxOut.history.includes('继续'), 'readContext still carries asks')
}

// 18. A turn whose conclusion is entirely quantities contributes nothing rather
//     than a stump, and a node without turn/step is still considered.
{
  const allNumbers = [
    { kind: 'assistant', turn: 1, step: 0, blocks: [{ kind: 'text', text: '12 条规则，900 字符。' }] },
  ]
  assert.equal(context.readReplies(allNumbers), '', 'a quantity-only conclusion is dropped')

  const noTurn = [
    { kind: 'assistant', seq: 7, blocks: [{ kind: 'text', text: '改完了。' }] },
  ]
  assert.ok(context.readReplies(noTurn).includes('改完了'), 'a node without a turn number still counts')

  assert.equal(context.readReplies([]), '', 'no assistant nodes yield nothing')
}

// 19. The reply budget caps turns and per-line length.
{
  const nodes = []
  for (let i = 1; i <= 10; i++) {
    nodes.push({ kind: 'assistant', turn: i, step: 0, blocks: [{ kind: 'text', text: `完成了第 X 项工作，一切正常。` }] })
  }
  const lines = context.readReplies(nodes).split('\n')
  assert.ok(lines.length <= context.LIMITS.replyNodes, 'the reply node cap applies')

  const long = 'a'.repeat(400) + '。'
  const one = context.readReplies([{ kind: 'assistant', turn: 1, step: 0, blocks: [{ kind: 'text', text: long }] }])
  assert.ok(one.length <= context.LIMITS.replyItem + 1, 'the per-reply cap applies')
}

console.log('context: 20 scenarios passed')

