// tool-group.js — collapse consecutive tool-call flow items into a group.
// Exports: startToolGroupObserver
// Requires: nothing (pure DOM + observer helpers)
//
// Pattern: same MutationObserver + idempotent DOM injection as
// tool-diff.js's annotateToolDiffs and mermaid.js's startMermaidObserver.
// We never move React-owned nodes — only add data-* attributes and inject
// a sibling header div that React does not own.

// ── Groupable tools (inclusion list) ──────────────────────────────────────

// Only these "real work" tools participate in grouping. Everything else
// (todo_write, subagent, worker, explorer, oracle, momus, workflow, ralph,
// code_simplifier_*, ask_user_question, delivery_check, phase_advance, …)
// is naturally excluded without needing to enumerate dynamic delegation names.
//
// The tool name is read from the [data-tool] attribute on ToolRow's root div.
var GROUPABLE_TOOLS = {
  // Shell
  'bash': true,
  'pwsh': true,
  // File I/O
  'read': true,
  'write': true,
  'edit': true,
  'str_replace_editor': true,
  // Search
  'grep': true,
  'glob': true,
  // Web
  'web_search': true,
  'web_fetch': true,
  // Skills
  'skill_search': true,
  'skill_load': true
};

// Prefix match for tool families with dynamic suffixes.
var GROUPABLE_PREFIXES = [
  'mcp__',   // MCP tools: mcp__mcp_router__tavily_search, etc.
  'ssh_'     // SSH tools: ssh_exec, ssh_upload, ssh_tunnel, etc.
];

/**
 * Read the tool name from a tool-call flow item by querying its inner
 * ToolRow / view root element. Different tool views expose the tool name
 * through different data attributes:
 *
 *   - ToolRow (read, write, edit, grep, glob, web_search, etc.):
 *       <div data-tool="read" ...>
 *   - BashRow (bash-specific custom view, NOT ToolRow-based):
 *       <div data-sample="bash" data-variant="bash" ...>
 *
 * We check data-tool first, then data-sample, then fall back to scanning
 * the visible title text for known tool names.
 */
function toolNameOf(flowItem) {
  if (!flowItem || !flowItem.querySelector) return '';
  // 1. ToolRow: <div data-tool="read">
  var row = flowItem.querySelector('[data-tool]');
  if (row) {
    var name = row.getAttribute('data-tool') || '';
    if (name) return name;
  }
  // 2. BashRow: <div data-sample="bash">
  var sample = flowItem.querySelector('[data-sample]');
  if (sample) {
    var sampleName = sample.getAttribute('data-sample') || '';
    if (sampleName) return sampleName;
  }
  return '';
}

/**
 * Returns true if this flow item should participate in grouping.
 * Unknown / unregistered tool names are NOT grouped (safe default).
 */
function isGroupableTool(flowItem) {
  var name = toolNameOf(flowItem);
  if (!name) return false;
  if (GROUPABLE_TOOLS[name]) return true;
  for (var i = 0; i < GROUPABLE_PREFIXES.length; i++) {
    if (name.indexOf(GROUPABLE_PREFIXES[i]) === 0) return true;
  }
  return false;
}

// ── CSS ─────────────────────────────────────────────────────────────────

// Styled to match the official ToolRow / DisclosureRow visual language:
//   - No background box (transparent, blends with the chat column)
//   - Same font metrics as .o3BgMG_summary (14px / 24px line-height)
//   - Same color tokens: label-secondary for title, label-caption for meta
//   - Leading icon + title + sep + summary pattern (like DisclosureRow)
//   - Only the interactive affordances (toggle text, chevron) are distinguished
var CSS = [
  '[data-dsao-tg-collapsed]{display:none!important}',
  // Header row mirrors ToolRow's .o3BgMG_root + .o3BgMG_row visual weight:
  // transparent background, same line-height, clickable, no visible border.
  '.dsao-tg-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;',
  '  font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);',
  '  background:transparent;border:none;border-radius:0;',
  '  min-width:0;transition:color 120ms}',
  // Leading icon — same slot as ToolRow .o3BgMG_leading
  '.dsao-tg-headerIcon{flex-shrink:0;display:inline-flex;align-items:center;',
  '  color:var(--dsw-alias-label-caption);margin-right:8px}',
  // Title — matches .o3BgMG_title (font-weight 400)
  '.dsao-tg-headerLabel{font-weight:400;color:var(--dsw-alias-label-secondary);',
  '  white-space:nowrap}',
  // Separator dot — matches .o3BgMG_sep exactly
  '.dsao-tg-headerSep{background:var(--dsw-alias-label-caption);border-radius:1px;',
  '  flex:none;width:2px;height:2px;margin:0 8px}',
  // Summary / count — matches .o3BgMG_summary (tertiary, ellipsis, auto flex)
  '.dsao-tg-headerCount{text-overflow:ellipsis;white-space:nowrap;min-width:0;',
  '  color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;',
  '  overflow:hidden}',
  // Spacer + toggle on the right
  '.dsao-tg-headerSpacer{flex:auto}',
  '.dsao-tg-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;',
  '  color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}',
  // Chevron — matches .o3BgMG_chevron color + transition
  '.dsao-tg-chevron{display:inline-block;transition:transform 180ms ease;',
  '  font-size:14px;line-height:1;color:var(--dsw-alias-label-secondary)}',
  '.dsao-tg-header[data-dsao-tg-state="expanded"] .dsao-tg-chevron{transform:rotate(90deg)}',
  '.dsao-tg-header[data-dsao-tg-state="collapsed"] .dsao-tg-chevron{transform:rotate(0deg)}',
  // Subtle hover — only the label brightens, no background box
  '.dsao-tg-header:hover .dsao-tg-headerLabel{color:var(--dsw-alias-label-primary)}'
].join('');

var _styleInjected = false;

function ensureStyles() {
  if (_styleInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsao-tool-group-css')) { _styleInjected = true; return; }
  var style = document.createElement('style');
  style.id = 'dsao-tool-group-css';
  style.textContent = CSS;
  document.head.appendChild(style);
  _styleInjected = true;
}

// ── SVG icon (matches IconApiOutline14 from ui-primitives) ────────────────

var TOOL_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 1.5L1.5 3.5L3 5L1.5 6.5L3.5 8.5L5 7L6.5 8.5L8.5 6.5L7 5L8.5 3.5L6.5 1.5L5 3L3.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><circle cx="11.5" cy="11.5" r="3" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
var CHEVRON = '\u276F';

// ── Group detection ──────────────────────────────────────────────────────

/**
 * Walk the children of each chat column container and build groups of
 * consecutive tool-call flow items, skipping "transparent" nodes (empty
 * assistant-steps with no visible text) between them.
 *
 * Transparent nodes: any element with data-chat-flow-kind="assistant-step"
 * that has no text content and zero rendered height. These are the DSH
 * runtime's placeholder steps between tool calls that produce no visible
 * assistant text.
 */
function isTransparentNode(el) {
  if (!el || !el.getAttribute) return false;
  var kind = el.getAttribute('data-chat-flow-kind');
  if (kind !== 'assistant-step') return false;
  // Empty if no text content and no rendered height
  if (el.textContent && el.textContent.trim().length > 0) return false;
  if (el.offsetHeight > 0) return false;
  return true;
}

/**
 * Query all tool-call flow items in DOM order and split into consecutive groups.
 * Two tool-call items are "consecutive" if every element between them (within
 * the same parent) is a transparent node.
 * Non-groupable tools (todo_write, subagent, etc.) break the chain.
 */
function detectGroups(root) {
  if (!root || !root.querySelectorAll) return [];
  var items = root.querySelectorAll('[data-chat-flow-kind="tool-call"]');
  if (items.length === 0) return [];

  var groups = [];
  var current = [];

  for (var i = 0; i < items.length; i++) {
    var el = items[i];

    // Non-groupable tools break the grouping chain — flush current group.
    if (!isGroupableTool(el)) {
      if (current.length >= 2) groups.push(current);
      current = [];
      continue;
    }

    if (current.length === 0) {
      current.push(el);
    } else {
      var last = current[current.length - 1];
      if (areConsecutive(last, el)) {
        current.push(el);
      } else {
        if (current.length >= 2) groups.push(current);
        current = [el];
      }
    }
  }
  if (current.length >= 2) groups.push(current);
  return groups;
}

/**
 * Check if two tool-call flow items are "consecutive": same parent and every
 * element sibling between them is transparent (empty assistant-step).
 */
function areConsecutive(a, b) {
  if (!a || !b) return false;
  // Must share the same parent
  if (a.parentNode !== b.parentNode) return false;
  // Fast path: immediate siblings
  if (a.nextElementSibling === b) return true;

  var sibling = a.nextElementSibling;
  while (sibling && sibling !== b) {
    if (!isTransparentNode(sibling)) return false;
    sibling = sibling.nextElementSibling;
  }
  return sibling === b;
}

// ── Header creation ──────────────────────────────────────────────────────

function createHeader(groupSize) {
  var header = document.createElement('div');
  header.className = 'dsao-tg-header';
  header.setAttribute('data-dsao-tg-header', '');
  header.setAttribute('data-dsao-tg-state', 'collapsed');
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');

  // Leading icon (same slot as ToolRow .o3BgMG_leading)
  var icon = document.createElement('span');
  icon.className = 'dsao-tg-headerIcon';
  icon.innerHTML = TOOL_ICON_SVG;

  // Title (matches .o3BgMG_title)
  var label = document.createElement('span');
  label.className = 'dsao-tg-headerLabel';
  label.textContent = '\u5DE5\u5177\u8C03\u7528';

  // Separator dot (matches .o3BgMG_sep)
  var sep = document.createElement('span');
  sep.className = 'dsao-tg-headerSep';
  sep.setAttribute('aria-hidden', 'true');

  // Summary line — shows count in tertiary color (matches .o3BgMG_summary)
  var summary = document.createElement('span');
  summary.className = 'dsao-tg-headerCount';
  summary.setAttribute('data-dsao-tg-count', '');
  summary.textContent = groupSize + ' \u4E2A\u8C03\u7528';

  // Spacer
  var spacer = document.createElement('span');
  spacer.className = 'dsao-tg-headerSpacer';

  // Toggle (matches .o3BgMG_chevron style)
  var toggle = document.createElement('span');
  toggle.className = 'dsao-tg-toggle';
  var toggleLabel = document.createElement('span');
  toggleLabel.setAttribute('data-dsao-tg-toggle-label', '');
  toggleLabel.textContent = '\u5C55\u5F00';
  var chevron = document.createElement('span');
  chevron.className = 'dsao-tg-chevron';
  chevron.textContent = CHEVRON;
  toggle.appendChild(toggleLabel);
  toggle.appendChild(chevron);

  header.appendChild(icon);
  header.appendChild(label);
  header.appendChild(sep);
  header.appendChild(summary);
  header.appendChild(spacer);
  header.appendChild(toggle);

  return header;
}

// ── Collapse / Expand ────────────────────────────────────────────────────

function applyCollapse(header, group) {
  header.setAttribute('data-dsao-tg-state', 'collapsed');
  header.setAttribute('aria-expanded', 'false');
  for (var i = 1; i < group.length; i++) {
    group[i].setAttribute('data-dsao-tg-collapsed', '');
  }
  var count = header.querySelector('[data-dsao-tg-count]');
  if (count) count.textContent = group.length + ' \u4E2A\u8C03\u7528';
  var toggleLabel = header.querySelector('[data-dsao-tg-toggle-label]');
  if (toggleLabel) toggleLabel.textContent = '\u5C55\u5F00';
}

function applyExpand(header, group) {
  header.setAttribute('data-dsao-tg-state', 'expanded');
  header.setAttribute('aria-expanded', 'true');
  for (var i = 1; i < group.length; i++) {
    group[i].removeAttribute('data-dsao-tg-collapsed');
  }
  var count = header.querySelector('[data-dsao-tg-count]');
  if (count) count.textContent = '';
  var toggleLabel = header.querySelector('[data-dsao-tg-toggle-label]');
  if (toggleLabel) toggleLabel.textContent = '\u6536\u8D77';
}

function toggleGroup(header, group) {
  var state = header.getAttribute('data-dsao-tg-state');
  if (state === 'collapsed') applyExpand(header, group);
  else applyCollapse(header, group);
}

// ── Group marking ────────────────────────────────────────────────────────

function markGroupItem(el, pos) {
  el.setAttribute('data-dsao-tg-pos', pos);
}

function unmarkGroupItem(el) {
  el.removeAttribute('data-dsao-tg-pos');
  el.removeAttribute('data-dsao-tg-collapsed');
}

/**
 * Apply grouping to one group of consecutive tool-call items.
 * Idempotent: if the header already exists and group size matches, update in place.
 */
function applyGroup(group) {
  var first = group[0];
  var existingHeader = first.previousElementSibling;
  var headerExists = existingHeader && existingHeader.getAttribute &&
    existingHeader.getAttribute('data-dsao-tg-header') === '';

  // If group size changed, remove old header and re-create
  if (headerExists) {
    var oldSize = parseInt(existingHeader.getAttribute('data-dsao-tg-size') || '0', 10);
    if (oldSize !== group.length) {
      existingHeader.parentNode.removeChild(existingHeader);
      headerExists = false;
    }
  }

  // Mark items
  for (var i = 0; i < group.length; i++) {
    var pos = i === 0 ? 'first' : (i === group.length - 1 ? 'last' : 'middle');
    markGroupItem(group[i], pos);
  }

  if (!headerExists) {
    var header = createHeader(group.length);
    header.setAttribute('data-dsao-tg-size', String(group.length));
    first.parentNode.insertBefore(header, first);

    // Bind toggle
    var toggleFn = function () { toggleGroup(header, group); };
    header.addEventListener('click', function (e) { e.stopPropagation(); toggleFn(); });
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFn(); }
    });

    // Apply default collapsed state
    applyCollapse(header, group);

    // Auto-collapse: when header leaves viewport, collapse back to default
    setupAutoCollapse(header, group);
  } else {
    // Header exists and size matches — ensure collapse state is consistent
    existingHeader.setAttribute('data-dsao-tg-size', String(group.length));
    var state = existingHeader.getAttribute('data-dsao-tg-state');
    if (state === 'collapsed') {
      for (var j = 1; j < group.length; j++) group[j].setAttribute('data-dsao-tg-collapsed', '');
    }
    if (existingHeader._dsaoAutoCollapse) {
      existingHeader._dsaoAutoCollapse.group = group;
    }
  }
}

// ── Auto-collapse via IntersectionObserver ────────────────────────────────

function setupAutoCollapse(header, group) {
  if (typeof IntersectionObserver === 'undefined') return;
  if (header._dsaoAutoCollapse) return;

  var autoData = { header: header, group: group, wasVisible: true };
  header._dsaoAutoCollapse = autoData;

  var observer = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var isVisible = entry.isIntersecting;
      if (!isVisible && autoData.wasVisible) {
        var currentState = autoData.header.getAttribute('data-dsao-tg-state');
        if (currentState === 'expanded') {
          applyCollapse(autoData.header, autoData.group);
        }
      }
      autoData.wasVisible = isVisible;
    }
  }, { threshold: 0 });

  observer.observe(header);
  autoData.observer = observer;
}

function cleanupAutoCollapse(header) {
  if (header._dsaoAutoCollapse && header._dsaoAutoCollapse.observer) {
    header._dsaoAutoCollapse.observer.disconnect();
    header._dsaoAutoCollapse = null;
  }
}

/**
 * Walk forward from `el`, skipping transparent nodes, and return
 * the next "significant" element sibling (or null).
 */
function nextSignificantSibling(el) {
  var sibling = el.nextElementSibling;
  while (sibling) {
    if (isTransparentNode(sibling)) {
      sibling = sibling.nextElementSibling;
      continue;
    }
    return sibling;
  }
  return null;
}

/**
 * Walk backward from `el`, skipping transparent nodes, and return
 * the previous "significant" element sibling (or null).
 */
function prevSignificantSibling(el) {
  var sibling = el.previousElementSibling;
  while (sibling) {
    if (isTransparentNode(sibling)) {
      sibling = sibling.previousElementSibling;
      continue;
    }
    return sibling;
  }
  return null;
}

// ── Cleanup ──────────────────────────────────────────────────────────────

function cleanupStaleMarkers(root) {
  if (!root) return;
  var headers = root.querySelectorAll('[data-dsao-tg-header]');
  for (var h = 0; h < headers.length; h++) {
    var header = headers[h];
    // Count tool-call items forward from the header, skipping empty assistant-steps
    var count = 0;
    var node = header;
    while (true) {
      node = nextSignificantSibling(node);
      if (!node || !node.getAttribute || node.getAttribute('data-chat-flow-kind') !== 'tool-call') break;
      count++;
    }
    if (count < 2) {
      cleanupAutoCollapse(header);
      if (header.parentNode) header.parentNode.removeChild(header);
    }
  }

  var marked = root.querySelectorAll('[data-dsao-tg-pos]');
  for (var m = 0; m < marked.length; m++) {
    var el = marked[m];
    var hasHeader = false;
    var prev = el;
    while (true) {
      prev = prevSignificantSibling(prev);
      if (!prev) break;
      if (prev.getAttribute && prev.getAttribute('data-dsao-tg-header') === '') { hasHeader = true; break; }
      // If we hit a non-tool-call significant node, the chain is broken
      if (prev.getAttribute && prev.getAttribute('data-chat-flow-kind') !== 'tool-call') break;
    }
    if (!hasHeader) unmarkGroupItem(el);
  }
}

// ── Main scan ────────────────────────────────────────────────────────────

function scanToolGroups(root) {
  if (!root || !root.querySelectorAll) return;
  ensureStyles();
  cleanupStaleMarkers(root);
  var groups = detectGroups(root);
  for (var i = 0; i < groups.length; i++) {
    applyGroup(groups[i]);
  }
}

// ── Observer ─────────────────────────────────────────────────────────────

function startToolGroupObserver() {
  if (typeof document === 'undefined') return function () {};
  ensureStyles();
  var scan = function () { scanToolGroups(document.body); };
  scan();
  var obs = new MutationObserver(scan);
  obs.observe(document.body, { childList: true, subtree: true });
  return function () { obs.disconnect(); };
}

exports.startToolGroupObserver = startToolGroupObserver;
exports.scanToolGroups = scanToolGroups;
exports.detectGroups = detectGroups;
exports.isGroupableTool = isGroupableTool;
exports.areConsecutive = areConsecutive;
exports.isTransparentNode = isTransparentNode;
