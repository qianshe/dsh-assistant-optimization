// tool-diff.js — add colored diff line counts to file-mutation tool rows.
// Exports: diffStats, annotateToolDiffs
// Requires: nothing (pure data + DOM helpers)

function toolName(block) {
  if (!block) return '';
  return 'kind' in block ? ((block.call && block.call.name) || '') : (block.name || '')
}

function toolArgs(block) {
  if (!block) return null
  var raw = 'kind' in block ? (block.call && block.call.argsRaw) : block.argsRaw
  if (typeof raw !== 'string' || raw === '') return null
  try {
    var parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (e) {
    return null
  }
}

function isFileMutationTool(block) {
  var name = toolName(block)
  if (name === 'write' || name === 'edit') return true
  if (name !== 'str_replace_editor') return false
  var args = toolArgs(block)
  return !!args && args.command === 'str_replace'
}

function countLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  var normalized = text.replace(/\r\n/g, '\n')
  if (normalized === '\n') return 1
  if (normalized.charAt(normalized.length - 1) === '\n') normalized = normalized.slice(0, -1)
  if (normalized === '') return 0
  return normalized.split('\n').length
}

/** Count added/deleted lines from a file-mutation tool life-cycle block. */
function diffStats(block) {
  if (!block) return null
  var view = 'kind' in block
    ? (block.resultView || block.callView || null)
    : (block.callView || null)
  if (!view || view.card !== 'diff' || !Array.isArray(view.diffs)) return null
  var added = 0
  var deleted = 0
  for (var i = 0; i < view.diffs.length; i++) {
    var hunk = view.diffs[i]
    if (!hunk) continue
    if (typeof hunk.newText === 'string') added += countLines(hunk.newText)
    if (typeof hunk.oldText === 'string') deleted += countLines(hunk.oldText)
  }
  if (added === 0 && deleted === 0) return null
  return { added: added, deleted: deleted }
}

function diffPath(block) {
  if (!block) return null
  var view = 'kind' in block
    ? (block.resultView || block.callView || null)
    : (block.callView || null)
  if (view && view.card === 'diff' && Array.isArray(view.diffs) && view.diffs.length && typeof view.diffs[0].path === 'string') {
    return view.diffs[0].path
  }
  var args = toolArgs(block)
  if (args) return args.file_path || args.path || null
  return null
}

function normalizePathText(value) {
  return String(value || '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

function findPathTarget(row, path) {
  if (!row || !path) return null
  var normalized = normalizePathText(path)
  var els = row.querySelectorAll('button, [role="button"], a, span')
  for (var i = 0; i < els.length; i++) {
    var el = els[i]
    if (normalizePathText(el.textContent || '') === normalized) return el
  }
  return null
}

function collectBlocks(block, out) {
  if (!block) return
  out[block.callId] = block
  var subs = block.subCalls || []
  for (var i = 0; i < subs.length; i++) collectBlocks(subs[i], out)
}

function createBadge(stats) {
  var badge = document.createElement('span')
  badge.setAttribute('data-dsao-diff-badge', '')
  badge.style.cssText = 'display:inline-flex;align-items:baseline;gap:2px;margin-left:6px;flex:none;white-space:nowrap;font-size:12px;line-height:24px;font-weight:600;'
  if (stats.added > 0) {
    var add = document.createElement('span')
    add.textContent = '+' + stats.added
    add.style.color = 'var(--dsw-alias-state-success-primary, #16a34a)'
    badge.appendChild(add)
  }
  if (stats.added > 0 && stats.deleted > 0) badge.appendChild(document.createTextNode('/'))
  if (stats.deleted > 0) {
    var del = document.createElement('span')
    del.textContent = '-' + stats.deleted
    del.style.color = 'var(--dsw-alias-state-error-primary, #dc2626)'
    badge.appendChild(del)
  }
  var titleParts = []
  if (stats.added > 0) titleParts.push('+' + stats.added)
  if (stats.deleted > 0) titleParts.push('-' + stats.deleted)
  badge.title = titleParts.join(' / ')
  return badge
}

/** Annotate every file-mutation row already rendered by the official tool tree. */
function annotateToolDiffs(rootEl, root) {
  if (!rootEl || !root || !rootEl.querySelectorAll) return
  var byId = {}
  collectBlocks(root, byId)
  var rows = rootEl.querySelectorAll('[data-chat-call-id]')
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    var callId = row.getAttribute('data-chat-call-id')
    var block = callId ? byId[callId] : undefined
    if (!block) continue
    if (!isFileMutationTool(block)) continue
    var stats = diffStats(block)
    if (!stats) continue

    var olds = row.querySelectorAll('[data-dsao-diff-badge]')
    for (var j = 0; j < olds.length; j++) {
      var oldEl = olds[j]
      if (oldEl.parentNode) oldEl.parentNode.removeChild(oldEl)
    }

    var path = diffPath(block)
    var link = row.querySelector('[class*="fileLink"]')
    var target = link || findPathTarget(row, path) || row.querySelector('[class*="summary"]')
    if (!target || !target.parentNode) continue
    // Keep the path sized to its text so the badge sits directly after it
    // instead of being pushed to the right edge by the row's fill layout.
    target.style.flex = '0 1 auto'
    var badge = createBadge(stats)
    target.parentNode.insertBefore(badge, target.nextSibling)
    row.setAttribute('data-dsao-tool-diff', '1')
  }
}

exports.diffStats = diffStats
exports.annotateToolDiffs = annotateToolDiffs