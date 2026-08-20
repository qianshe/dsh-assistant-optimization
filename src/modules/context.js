// context.js — extract private-reference context for the prompt enhancer out of
// the live ConversationSnapshot, reading only text leaves.
//
// Five ordered parts, broadest → most specific, because DSH declares that "more
// specific instructions take precedence over broader ones" and a model weighs
// later content more heavily:
//
//   1. Workspace identity   title + path
//   2. Project instructions structure signals from project-scoped AGENTS.md and
//                           its .local overlay (CLAUDE.md when no AGENTS exists)
//   3. Session summary      DSH's own compaction summary, when one exists
//   4. Recent user asks     what was requested
//   5. Recent agent results what was finished
//
// Parts 4 and 5 are a pair: asks record intent, replies record accomplished
// fact, and a draft like "接着改" or "还是有问题" needs both to resolve.
//
// Two exclusions keep the reference free of anything a rewrite could wrongly
// restate as fact:
//
//   - The user-global instruction file describes how the agent should behave in
//     general, not what this project is. DSH marks it by display path — see
//     scopeForDisplayPath in dsh-agent-instructions.
//   - Inside an agent reply, fenced code blocks, table rows, and any sentence
//     containing a standalone quantity are dropped. That is where transient
//     literals live; the conclusion prose around them is what resolves a
//     reference.

// Display paths DSH uses for the single user-global instruction file.
var GLOBAL_PATHS = ['~/.dsh/AGENTS.md', '$DSH_HOME/AGENTS.md']

// Section headings emitted by dsh-agent-instructions (sectionText /
// additionalSectionText). The captured group is the display path. Note the
// renderer capitalizes them differently — "Instructions from:" but "Additional
// instructions from:" — so the match is case-insensitive.
var SECTION_RE = /^(?:Additional\s+)?instructions\s+from:[ \t]*(.+?)[ \t]*$/i

// Fixed prose the instruction renderer wraps around every section; it addresses
// the agent, not the enhancer, so it is stripped before extraction.
var BOILERPLATE_RE = /^(?:These instructions apply to work under|The following workspace instructions may be relevant|This complete workspace instruction baseline|No workspace instructions are currently active|Workspace instruction budget|Instructions from:|Additional instructions from:)/i

var LIMITS = {
  instructionsTotal: 900,
  signalsPerFile: 12,
  summary: 700,
  // Asks and replies get separate budgets so neither side crowds the other out:
  // together they form "what was requested → what was finished".
  asksTotal: 800,
  historyItem: 220,
  historyNodes: 5,
  repliesTotal: 700,
  replyItem: 200,
  replyNodes: 4,
  replySentences: 2,
}

/** Collapse whitespace, drop blanks and duplicate lines, then cap. */
function compact(text, max) {
  var seen = Object.create(null)
  var lines = []
  var raw = String(text == null ? '' : text).split(/\r?\n/)
  for (var i = 0; i < raw.length; i++) {
    var line = raw[i].replace(/\s+/g, ' ').trim()
    if (line === '') continue
    var key = line.toLowerCase()
    if (seen[key] === true) continue
    seen[key] = true
    lines.push(line)
  }
  var out = lines.join('\n')
  return out.length > max ? out.slice(0, max) + '…' : out
}

function clip(text, max) {
  var out = String(text == null ? '' : text).trim()
  return out.length > max ? out.slice(0, max) + '…' : out
}

/** Read text out of a ContentBlock[] (`type`) or an AssistantBlock[] (`kind`). */
function blockText(blocks) {
  if (!Array.isArray(blocks)) return ''
  var parts = []
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (b === null || typeof b !== 'object') continue
    var tag = typeof b.type === 'string' ? b.type : (typeof b.kind === 'string' ? b.kind : '')
    // Reasoning is intentionally skipped: it is not a durable project fact.
    if (tag === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/**
 * Split one instruction context body into its per-file sections.
 * The display path is written into the body itself, so this is exact rather
 * than a guess derived from provenance labels.
 */
function splitSections(body) {
  var lines = String(body == null ? '' : body)
    .replace(/<\/?system-reminder>/g, '')
    .split(/\r?\n/)
  var sections = []
  var current = null
  for (var i = 0; i < lines.length; i++) {
    var match = SECTION_RE.exec(lines[i])
    if (match !== null) {
      current = { path: match[1], lines: [] }
      sections.push(current)
      continue
    }
    if (current !== null) current.lines.push(lines[i])
  }
  return sections
}

function isGlobalPath(path) {
  for (var i = 0; i < GLOBAL_PATHS.length; i++) {
    if (path === GLOBAL_PATHS[i]) return true
  }
  return false
}

function dirOf(path) {
  var at = path.replace(/\\/g, '/').lastIndexOf('/')
  return at < 0 ? '.' : path.slice(0, at)
}

/**
 * Rank one instruction candidate within its directory.
 *
 * DSH probes AGENTS.md before CLAUDE.md, and each of those before its `.local`
 * overlay. The two families say the same thing for different agents, so only the
 * preferred family is kept per directory. A `.local` overlay is NOT a duplicate:
 * it is the personal, usually git-ignored layer beside the shared file, and DSH
 * injects both — it collapses them only when their trimmed content is identical
 * (see dedupInstructionFilesByDirectory in dsh-agent-instructions). So the
 * overlay is kept alongside its base and ordered after it, matching DSH's
 * "more specific takes precedence" direction.
 *
 * README.md never reaches the session context — the Host reads it as a last
 * resort when no instruction file exists at all.
 *
 * @returns 0 AGENTS.md, 1 AGENTS.local.md, 2 CLAUDE.md, 3 CLAUDE.local.md, -1 other.
 */
function docRank(path) {
  var name = path.replace(/\\/g, '/').split('/').pop()
  if (/^AGENTS\.md$/i.test(name)) return 0
  if (/^AGENTS\.local\.md$/i.test(name)) return 1
  if (/^CLAUDE\.md$/i.test(name)) return 2
  if (/^CLAUDE\.local\.md$/i.test(name)) return 3
  return -1
}

/** Which family a ranked candidate belongs to: AGENTS beats CLAUDE per directory. */
function docFamily(rank) {
  return rank < 2 ? 'agents' : 'claude'
}

/** Whether a ranked candidate is the personal overlay rather than the shared file. */
function isOverlay(rank) {
  return rank === 1 || rank === 3
}
}

/**
 * Reduce one instruction file to its structure signals: headings, plus the
 * first clause of each bullet. Full rule prose is what makes AGENTS.md long,
 * and the enhancer only needs to know which constraints exist.
 */
function structureSignals(lines) {
  var out = []
  for (var i = 0; i < lines.length && out.length < LIMITS.signalsPerFile; i++) {
    var line = lines[i].trim()
    if (line === '') continue
    if (BOILERPLATE_RE.test(line)) continue

    var heading = /^#{1,6}\s+(.+)$/.exec(line)
    if (heading !== null) {
      out.push(heading[1].replace(/\s+/g, ' ').trim())
      continue
    }

    var bullet = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line)
    if (bullet === null) continue
    var text = bullet[1]
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    // A bolded/backticked lead followed by a separator is the rule's name;
    // keep the name and drop the explanation.
    var named = /^([^:：—]{2,60})\s*[:：—]/.exec(text)
    var signal = named !== null ? named[1].trim() : text
    if (signal === '') continue
    out.push(signal)
  }
  return out
}

/**
 * Project-scoped instruction structure, ordered broadest → most specific.
 *
 * The user-global file is excluded. Per directory, one FAMILY wins — AGENTS when
 * present, otherwise CLAUDE — but that family's shared file and its `.local`
 * overlay both survive, because the overlay is the personal layer beside the
 * shared one rather than a duplicate of it.
 */
function readInstructions(nodes) {
  var files = []
  var seen = Object.create(null)

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind !== 'context' || node.form !== 'instructions') continue

    var sections = splitSections(blockText(node.content))
    for (var s = 0; s < sections.length; s++) {
      var section = sections[s]
      if (isGlobalPath(section.path)) continue
      var rank = docRank(section.path)
      if (rank < 0) continue
      var signals = structureSignals(section.lines)
      if (signals.length === 0) continue

      // A later context message supersedes an earlier one for the same file.
      if (seen[section.path] !== undefined) {
        files[seen[section.path]].signals = signals
        continue
      }

      files.push({
        path: section.path,
        dir: dirOf(section.path),
        rank: rank,
        family: docFamily(rank),
        overlay: isOverlay(rank),
        signals: signals,
      })
      seen[section.path] = files.length - 1
    }
  }

  // One family per directory: a CLAUDE file is dropped where any AGENTS file
  // exists in the same directory, taking its overlay with it.
  var agentsDirs = Object.create(null)
  for (var a = 0; a < files.length; a++) {
    if (files[a].family === 'agents') agentsDirs[files[a].dir] = true
  }
  var chosen = []
  for (var c = 0; c < files.length; c++) {
    if (files[c].family === 'claude' && agentsDirs[files[c].dir] === true) continue
    chosen.push(files[c])
  }

  // Depth first so the project root leads and nested directories land last, then
  // rank so a directory's shared file precedes its personal overlay.
  chosen.sort(function (x, y) {
    var dx = x.path.split(/[\\/]/).length
    var dy = y.path.split(/[\\/]/).length
    if (dx !== dy) return dx - dy
    if (x.dir !== y.dir) return x.dir < y.dir ? -1 : 1
    return x.rank - y.rank
  })

  var parts = []
  for (var p = 0; p < chosen.length; p++) {
    parts.push(chosen[p].path + ': ' + chosen[p].signals.join('; '))
  }
  return compact(parts.join('\n'), LIMITS.instructionsTotal)
}

/** The latest compaction summary: DSH's own condensation of the conversation. */
function readSummary(nodes) {
  for (var i = nodes.length - 1; i >= 0; i--) {
    var node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind !== 'compaction') continue
    if (typeof node.summary !== 'string' || node.summary.trim() === '') continue
    return clip(compact(node.summary, LIMITS.summary * 2), LIMITS.summary)
  }
  return ''
}

/**
 * Tail of the user's own asks. Paired with readReplies, which supplies what the
 * agent actually did — asks record intent, replies record accomplished fact, and
 * resolving "继续 / 接着 / 还是有问题" needs both.
 *
 * Newest nodes win the budget; chronological order is restored after.
 */
function readHistory(nodes) {
  var picked = []
  var budget = LIMITS.asksTotal
  for (var i = nodes.length - 1; i >= 0 && picked.length < LIMITS.historyNodes && budget > 0; i--) {
    var node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind !== 'user') continue
    var line = compact(blockText(node.content), LIMITS.historyItem)
    if (line === '') continue
    budget -= line.length
    picked.push(line)
  }
  picked.reverse()
  return picked.join('\n')
}

/**
 * Strip the parts of an agent reply that carry transient literals.
 *
 * Fenced code blocks and table rows are the actual source of the leak this
 * guards against: an earlier rewrite pasted byte counts it found in a fenced
 * example and stated them as current fact. Inline backticks are kept (with the
 * ticks removed) because `ensureBadge` or `lib/client.js` is an identity — the
 * very thing a rewrite should be able to name.
 */
function stripLiteralBlocks(text) {
  var lines = String(text == null ? '' : text).split(/\r?\n/)
  var kept = []
  var fenced = false
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    if (/^\s*```/.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    // Markdown table rows and their separator.
    if (/^\s*\|/.test(line)) continue
    if (/^\s*[-=]{3,}\s*$/.test(line)) continue
    kept.push(line.replace(/`([^`]+)`/g, '$1'))
  }
  return kept.join('\n')
}

/**
 * True when a sentence contains a standalone quantity: a digit not glued to a
 * letter. Identities survive (pkg-7, deepseek-v4-flash, AGENTS.md) because their
 * digits follow a letter or a hyphen; measurements do not (340, +2/-1, 64KB).
 */
function hasQuantity(sentence) {
  return /(?:^|[^A-Za-z0-9_.\-])[+\u00b1-]?\d/.test(sentence)
}

/** Split prose into sentences across both Latin and CJK terminators. */
function sentences(text) {
  var out = []
  var raw = String(text).split(/(?<=[.!?。！？；;])\s*|\n+/)
  for (var i = 0; i < raw.length; i++) {
    var s = raw[i].replace(/\s+/g, ' ').trim()
    if (s !== '') out.push(s)
  }
  return out
}

/**
 * One turn's concluding reply, reduced to its first quantity-free sentences.
 *
 * Whole sentences are dropped rather than editing numbers out of them: a
 * placeholder could be copied into the output verbatim, and stripping in place
 * leaves stumps like "改成 priority". A sentence dense with numbers is a detail
 * sentence anyway, while the conclusion sentence usually carries none.
 */
function conclusionText(node) {
  var prose = stripLiteralBlocks(blockText(node.blocks))
  var list = sentences(prose)
  var kept = []
  for (var i = 0; i < list.length && kept.length < LIMITS.replySentences; i++) {
    if (hasQuantity(list[i])) continue
    kept.push(list[i])
  }
  return compact(kept.join(' '), LIMITS.replyItem)
}

/**
 * What the agent actually finished, one line per recent turn.
 *
 * A DSH assistant turn spans several steps — tool calls, running narration, then
 * the conclusion. AssistantMessageNode carries `turn` and `step`, so the highest
 * step within a turn is that turn's conclusion; earlier steps are working notes.
 * An `interrupted` prefix is not a conclusion and is skipped.
 */
function readReplies(nodes) {
  var byTurn = Object.create(null)
  var order = []

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    if (node.kind !== 'assistant') continue
    if (node.interrupted === true) continue
    // A node without a turn number cannot be grouped; treat its seq as its own
    // turn so it is still considered rather than silently dropped.
    var turn = typeof node.turn === 'number' ? node.turn : 'seq:' + node.seq
    var step = typeof node.step === 'number' ? node.step : 0
    var held = byTurn[turn]
    if (held === undefined) {
      byTurn[turn] = { step: step, node: node }
      order.push(turn)
      continue
    }
    if (step >= held.step) byTurn[turn] = { step: step, node: node }
  }

  var picked = []
  var budget = LIMITS.repliesTotal
  for (var t = order.length - 1; t >= 0 && picked.length < LIMITS.replyNodes && budget > 0; t--) {
    var line = conclusionText(byTurn[order[t]].node)
    if (line === '') continue
    budget -= line.length
    picked.push(line)
  }
  picked.reverse()
  return picked.join('\n')
}

/** The session's workspace root, or '' when the session list has no row for it. */
function readCwd(session, sessions) {
  var sessionId = session !== null && typeof session === 'object' ? session.sessionId : undefined
  if (sessions === null || typeof sessions !== 'object' || sessionId === undefined) return ''
  var byId = sessions.byId
  var row = byId !== null && typeof byId === 'object' ? byId[sessionId] : undefined
  if (row === null || typeof row !== 'object' || typeof row.cwd !== 'string') return ''
  return row.cwd
}

/** Workspace identity for the session, or '' when it cannot be resolved. */
function readProject(session, sessions, workspaces) {
  var cwd = readCwd(session, sessions)

  var title = ''
  if (workspaces !== null && typeof workspaces === 'object' && Array.isArray(workspaces.items) && cwd !== '') {
    var target = cwd.replace(/[\\/]+$/, '').toLowerCase()
    for (var i = 0; i < workspaces.items.length; i++) {
      var item = workspaces.items[i]
      if (item === null || typeof item !== 'object') continue
      if (typeof item.path !== 'string') continue
      if (item.path.replace(/[\\/]+$/, '').toLowerCase() !== target) continue
      if (typeof item.title === 'string') title = item.title
      break
    }
  }

  if (title === '' && cwd !== '') {
    var segments = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
    title = segments.length === 0 ? '' : segments[segments.length - 1]
  }

  if (title === '' && cwd === '') return ''
  if (cwd === '') return title
  return title === '' ? cwd : title + ' (' + cwd + ')'
}

/**
 * Build the enhancer's private reference from live slot props.
 *
 * `cwd` rides along so the Host can fall back to reading an instruction file
 * itself: the conversation window may have scrolled the instruction context out
 * of `nodes`, and a project may have no instruction file at all (in which case
 * README.md is the last resort — the Host owns that read).
 *
 * Returns owned JSON: no Host object, snapshot, or node is retained.
 */
function readContext(session, sessions, workspaces) {
  var empty = { project: '', cwd: '', instructions: '', summary: '', history: '', replies: '' }
  if (session === null || typeof session !== 'object') return empty
  var nodes = Array.isArray(session.nodes) ? session.nodes : null
  if (nodes === null) return empty
  return {
    project: readProject(session, sessions, workspaces),
    cwd: readCwd(session, sessions),
    instructions: readInstructions(nodes),
    summary: readSummary(nodes),
    history: readHistory(nodes),
    replies: readReplies(nodes),
  }
}

exports.readContext = readContext
exports.readInstructions = readInstructions
exports.readSummary = readSummary
exports.readHistory = readHistory
exports.readReplies = readReplies
exports.readProject = readProject
exports.readCwd = readCwd
exports.structureSignals = structureSignals
exports.splitSections = splitSections
exports.docRank = docRank
exports.docFamily = docFamily
exports.isOverlay = isOverlay
exports.stripLiteralBlocks = stripLiteralBlocks
exports.hasQuantity = hasQuantity
exports.LIMITS = LIMITS
