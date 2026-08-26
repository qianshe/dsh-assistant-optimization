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
  'context_search': true,
  // Web
  'web_search': true,
  'web_fetch': true,
  // Image / inspection
  'describe_image': true,
  'read_image': true,
  // Skills
  'skill_search': true,
  'skill_load': true,
  // Interactive / utility
  'work_note': true,
  'tu': true
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
  // Header row mirrors ToolRow's .o3BgMG_root + .o3BgMG_row:
  // transparent, 24px line-height, no border, clickable.
  '.dsao-tg-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;',
  '  font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);',
  '  background:transparent;border:none;border-radius:0;',
  '  min-width:0;transition:color 120ms}',
  // Leading icon — 16px flex container, vertically centered, 6px right gap.
  // Matches BashRow's .CY-8Ka_leading exactly.
  '.dsao-tg-headerIcon{width:16px;height:16px;flex:none;',
  '  display:inline-flex;align-items:center;justify-content:center;',
  '  color:var(--dsw-alias-label-tertiary);margin-right:6px;position:relative}',
  // Summary — tool names + count, matches .o3BgMG_summary styling
  '.dsao-tg-headerCount{font-weight:400;text-overflow:ellipsis;white-space:nowrap;min-width:0;',
  '  color:var(--dsw-alias-label-secondary);flex:auto;font-size:14px;line-height:24px;',
  '  overflow:hidden}',
  // Spacer + toggle on the right
  '.dsao-tg-headerSpacer{flex:auto}',
  '.dsao-tg-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;',
  '  color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}',
  // Chevron — official DSH IconChevronRightOutline14 path
  '.dsao-tg-chevron{display:inline-flex;align-items:center;transition:transform 180ms ease;',
  '  color:var(--dsw-alias-label-secondary)}',
  '.dsao-tg-header[data-dsao-tg-state="expanded"] .dsao-tg-chevron{transform:rotate(90deg)}',
  '.dsao-tg-header[data-dsao-tg-state="collapsed"] .dsao-tg-chevron{transform:rotate(0deg)}',
  // Subtle hover — summary brightens
  '.dsao-tg-header:hover .dsao-tg-headerCount{color:var(--dsw-alias-label-primary)}',
  // Indent tool-call items inside a group for visual hierarchy
  '[data-dsao-tg-pos]{padding-left:20px}'
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

// ── SVG icons ────────────────────────────────────────────────────────────

// Leading icon: DSH's IconCodeOutline16 (# grid glyph) — clean, recognizable,
// conveys "code/tool execution". 14px render inside 16px container.
var TOOL_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<path fill-rule="evenodd" clip-rule="evenodd" d="M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z" fill="currentColor"/>'
  + '</svg>';

// Chevron: official DSH IconChevronRightOutline14 path (rotates 90° when expanded).
var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/>'
  + '</svg>';
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
  // Has meaningful text → not transparent.
  // Don't check offsetHeight or children — CSS padding/min-height on
  // empty containers and React-rendered empty wrappers can make them
  // appear non-empty when they're visually blank.
  if (el.textContent && el.textContent.trim().length > 0) return false;
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

/**
 * Collect unique tool names from a group, preserving first-appearance order.
 * Returns a deduplicated array, e.g. ["read", "grep", "bash"].
 */
function uniqueToolNames(group) {
  var seen = {};
  var names = [];
  for (var i = 0; i < group.length; i++) {
    var name = toolNameOf(group[i]);
    if (name && !seen[name]) {
      seen[name] = true;
      names.push(name);
    }
  }
  return names;
}

/**
 * Build the summary text for a group: unique tool names joined by "、" +
 * " · N tools" (Chinese: " · N 个工具").
 * e.g. "read、grep、bash · 5 个工具"
 */
function summaryText(group) {
  var names = uniqueToolNames(group);
  return names.join('\u3001') + ' \u00B7 ' + group.length + ' \u4E2A\u5DE5\u5177';
}

// ── Header creation ──────────────────────────────────────────────────────

function createHeader(group) {
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

  // Summary line — tool names + count (matches .o3BgMG_summary)
  var summary = document.createElement('span');
  summary.className = 'dsao-tg-headerCount';
  summary.setAttribute('data-dsao-tg-summary', '');
  summary.textContent = summaryText(group);

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
  chevron.innerHTML = CHEVRON_SVG;
  toggle.appendChild(toggleLabel);
  toggle.appendChild(chevron);

  header.appendChild(icon);
  header.appendChild(summary);
  header.appendChild(spacer);
  header.appendChild(toggle);

  return header;
}

// ── Collapse / Expand ────────────────────────────────────────────────────

function applyCollapse(header, group) {
  header.setAttribute('data-dsao-tg-state', 'collapsed');
  header.setAttribute('aria-expanded', 'false');
  for (var i = 0; i < group.length; i++) {
    group[i].setAttribute('data-dsao-tg-collapsed', '');
  }
  var summary = header.querySelector('[data-dsao-tg-summary]');
  if (summary) summary.textContent = summaryText(group);
  var toggleLabel = header.querySelector('[data-dsao-tg-toggle-label]');
  if (toggleLabel) toggleLabel.textContent = '\u5C55\u5F00';
}

function applyExpand(header, group) {
  header.setAttribute('data-dsao-tg-state', 'expanded');
  header.setAttribute('aria-expanded', 'true');
  for (var i = 0; i < group.length; i++) {
    group[i].removeAttribute('data-dsao-tg-collapsed');
  }
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
 *
 * Initial state: if any tool is running, start expanded; otherwise collapsed.
 * The auto-manage logic in manageLatestGroup() handles subsequent transitions
 * for the latest group only.
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
    var header = createHeader(group);
    header.setAttribute('data-dsao-tg-size', String(group.length));
    first.parentNode.insertBefore(header, first);

    // Bind toggle — user clicks always override auto state
    var toggleFn = function () { toggleGroup(header, group); };
    header.addEventListener('click', function (e) { e.stopPropagation(); toggleFn(); });
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFn(); }
    });

    // Initial state: expanded if running, collapsed otherwise.
    // Auto-state tracks the lifecycle: running → done → collapsed.
    if (isGroupRunning(group)) {
      applyExpand(header, group);
      header.setAttribute('data-dsao-tg-auto', 'running');
    } else {
      applyCollapse(header, group);
      header.setAttribute('data-dsao-tg-auto', 'collapsed');
    }
  } else {
    // Header exists and size matches — ensure collapse DOM consistency only.
    // Do NOT change the logical state here; manageLatestGroup handles that.
    existingHeader.setAttribute('data-dsao-tg-size', String(group.length));
    var state = existingHeader.getAttribute('data-dsao-tg-state');
    if (state === 'collapsed') {
      for (var j = 0; j < group.length; j++) group[j].setAttribute('data-dsao-tg-collapsed', '');
    }
  }
}

// ── Running-state detection ──────────────────────────────────────────────

/**
 * Check if a single tool-call flow item has any inner element marked as
 * "running" (data-state="running"). DSH's ToolRow and BashRow both set
 * data-state on their root elements while the tool is in-flight.
 */
function isItemRunning(item) {
  if (!item || !item.querySelectorAll) return false;
  var stateEls = item.querySelectorAll('[data-state]');
  for (var i = 0; i < stateEls.length; i++) {
    if (stateEls[i].getAttribute('data-state') === 'running') return true;
  }
  return false;
}

/**
 * Returns true if ANY item in the group is still running.
 */
function isGroupRunning(group) {
  for (var i = 0; i < group.length; i++) {
    if (isItemRunning(group[i])) return true;
  }
  return false;
}

/**
 * Returns true if content that will NOT be absorbed into the group has
 * appeared after the last item — i.e., new content warrants auto-collapsing.
 *
 * Only groupable tool-call items get absorbed into the same group on the
 * next scan. Everything else (assistant text, thinking, subagent calls,
 * task-management tools, etc.) breaks the group and should trigger collapse.
 */
function hasContentAfterGroup(group) {
  var last = group[group.length - 1];
  var next = nextSignificantSibling(last);
  if (!next) return false;
  // A groupable tool-call sibling will be absorbed into the group → don't collapse
  if (next.getAttribute && next.getAttribute('data-chat-flow-kind') === 'tool-call' && isGroupableTool(next)) return false;
  return true;
}

// ── Auto-manage latest group ──────────────────────────────────────────────

/**
 * Manage the expand/collapse lifecycle of the LATEST group only.
 *
 * Rules:
 * 1. If the latest group has running tools → keep expanded.
 * 2. When all tools finish (running → done) → wait for new content.
 * 3. When new content arrives after a "done" group → auto-collapse.
 * 4. Older groups are never touched here — user controls them manually.
 *
 * The lifecycle is tracked via data-dsao-tg-auto:
 *   "running" → tools in-flight, always expanded
 *   "done"    → tools finished, waiting for new content to collapse
 *   "collapsed" → auto-collapsed or initially done, no further action
 */
function manageLatestGroup(groups) {
  if (!groups || groups.length === 0) return;
  var latestGroup = groups[groups.length - 1];
  var first = latestGroup[0];
  var header = first.previousElementSibling;
  if (!header || !header.getAttribute ||
      header.getAttribute('data-dsao-tg-header') !== '') return;

  var running = isGroupRunning(latestGroup);

  if (running) {
    // Rule 1: keep expanded while any tool is running
    if (header.getAttribute('data-dsao-tg-state') === 'collapsed') {
      applyExpand(header, latestGroup);
    }
    header.setAttribute('data-dsao-tg-auto', 'running');
    return;
  }

  // All tools done — check lifecycle state
  var autoState = header.getAttribute('data-dsao-tg-auto') || 'collapsed';

  if (autoState === 'running') {
    header.setAttribute('data-dsao-tg-auto', 'done');
    return;
  }

  if (autoState === 'done' && hasContentAfterGroup(latestGroup)) {
    applyCollapse(header, latestGroup);
    header.setAttribute('data-dsao-tg-auto', 'collapsed');
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
  // Auto-manage expand/collapse for the latest group only
  manageLatestGroup(groups);
}

// ── Observer ─────────────────────────────────────────────────────────────

function startToolGroupObserver() {
  if (typeof document === 'undefined') return function () {};
  ensureStyles();

  var scanTimer = null;

  // Check whether mutations are relevant to tool-grouping (vs typing, scrolling, etc.)
  function hasRelevantMutation(mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      // data-state attribute changes (tool running→ok etc.)
      if (m.type === 'attributes' && m.attributeName === 'data-state') return true;
      // data-dsao-tg-state changes (our own expand/collapse)
      if (m.type === 'attributes' && m.attributeName === 'data-dsao-tg-state') return true;
      // Added/removed nodes
      if (m.addedNodes && m.addedNodes.length > 0) {
        for (var j = 0; j < m.addedNodes.length; j++) {
          var node = m.addedNodes[j];
          if (node.nodeType !== 1) continue;
          if (node.getAttribute && (
            node.getAttribute('data-chat-flow-kind') === 'tool-call' ||
            node.getAttribute('data-chat-flow-kind') === 'assistant-step' ||
            node.getAttribute('data-dsao-tg-header') === ''
          )) return true;
          // Container that might include relevant children
          if (node.querySelector && (
            node.querySelector('[data-chat-flow-kind="tool-call"]') ||
            node.querySelector('[data-chat-flow-kind="assistant-step"]') ||
            node.querySelector('[data-dsao-tg-header]')
          )) return true;
        }
      }
    }
    return false;
  }

  var onMutations = function (mutations) {
    if (!hasRelevantMutation(mutations)) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = null;
      scanToolGroups(document.body);
    }, 80);
  };

  // Initial scan
  scanToolGroups(document.body);

  var obs = new MutationObserver(onMutations);
  obs.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state', 'data-dsao-tg-state']
  });
  return function () {
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    obs.disconnect();
  };
}

exports.startToolGroupObserver = startToolGroupObserver;
exports.scanToolGroups = scanToolGroups;
exports.detectGroups = detectGroups;
exports.isGroupableTool = isGroupableTool;
exports.areConsecutive = areConsecutive;
exports.isTransparentNode = isTransparentNode;
