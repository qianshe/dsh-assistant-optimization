// context.js — extract private-reference context for the prompt enhancer out of
// the live ConversationSnapshot, reading only text leaves.
//
// Four ordered parts, broadest → most specific, because DSH declares that "more
// specific instructions take precedence over broader ones" and a model weighs
// later content more heavily:
//
//   1. Workspace identity   title + path
//   2. Project instructions structure signals from project-scoped AGENTS.md
//   3. Session summary      DSH's own compaction summary, when one exists
//   4. Recent conversation  the tail of user/agent text
//
// The user-global instruction file is deliberately excluded: it describes how
// the agent should behave in general, not what this project is, so it would
// only crowd out project facts. DSH marks it by display path — see
// scopeForDisplayPath in dsh-agent-instructions.

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
  perFile: 420,
  signalsPerFile: 12,
  summary: 700,
  historyTotal: 1200,
  historyItem: 260,
  historyNodes: 6,
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

/** CLAUDE.md duplicates AGENTS.md in practice; keep one voice per directory. */
function isDuplicateDoc(path) {
  return /(?:^|[\\/])CLAUDE(?:\.local)?\.md$/i.test(path)
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
 * The user-global file and duplicate docs are excluded.
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
      if (isDuplicateDoc(section.path)) continue
      var signals = structureSignals(section.lines)
      if (signals.length === 0) continue
      // A later context message supersedes an earlier one for the same file.
      if (seen[section.path] !== undefined) {
        files[seen[section.path]] = { path: section.path, signals: signals }
        continue
      }
      seen[section.path] = files.length
      files.push({ path: section.path, signals: signals })
    }
  }

  // Depth order: the project root's file first, deeper directories after, so
  // the most specific guidance lands last.
  files.sort(function (a, b) {
    var da = a.path.split(/[\\/]/).length
    var db = b.path.split(/[\\/]/).length
    return da === db ? (a.path < b.path ? -1 : 1) : da - db
  })

  var parts = []
  for (var f = 0; f < files.length; f++) {
    parts.push(files[f].path + ': ' + files[f].signals.join('; '))
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

/** Tail of the conversation: newest nodes win the budget, order restored after. */
function readHistory(nodes) {
  var picked = []
  var budget = LIMITS.historyTotal
  for (var i = nodes.length - 1; i >= 0 && picked.length < LIMITS.historyNodes && budget > 0; i--) {
    var node = nodes[i]
    if (node === null || typeof node !== 'object') continue
    var role = ''
    var text = ''
    if (node.kind === 'user') { role = 'User'; text = blockText(node.content) }
    else if (node.kind === 'assistant') { role = 'Agent'; text = blockText(node.blocks) }
    else continue
    var line = compact(text, LIMITS.historyItem)
    if (line === '') continue
    var entry = role + ': ' + line
    budget -= entry.length
    picked.push(entry)
  }
  picked.reverse()
  return picked.join('\n')
}

/** Workspace identity for the session, or '' when it cannot be resolved. */
function readProject(session, sessions, workspaces) {
  var cwd = ''
  var sessionId = session !== null && typeof session === 'object' ? session.sessionId : undefined

  if (sessions !== null && typeof sessions === 'object' && sessionId !== undefined) {
    var byId = sessions.byId
    var row = byId !== null && typeof byId === 'object' ? byId[sessionId] : undefined
    if (row !== null && typeof row === 'object' && typeof row.cwd === 'string') cwd = row.cwd
  }

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
 * Returns owned JSON: no Host object, snapshot, or node is retained.
 */
function readContext(session, sessions, workspaces) {
  var empty = { project: '', instructions: '', summary: '', history: '' }
  if (session === null || typeof session !== 'object') return empty
  var nodes = Array.isArray(session.nodes) ? session.nodes : null
  if (nodes === null) return empty
  return {
    project: readProject(session, sessions, workspaces),
    instructions: readInstructions(nodes),
    summary: readSummary(nodes),
    history: readHistory(nodes),
  }
}

exports.readContext = readContext
exports.readInstructions = readInstructions
exports.readSummary = readSummary
exports.readHistory = readHistory
exports.readProject = readProject
exports.structureSignals = structureSignals
exports.splitSections = splitSections
exports.LIMITS = LIMITS
