// dsh-assistant-optimization — Dynamic Client half (all modules inlined)
//
// Modules included: markers, text-split, tool-diff, tool-group, mermaid,
// wrapper components, settings (TagsSetting only).
// Skipped for dynamic debugging: prompt-enhance, windsurf-key setting
// (those need Host HTTP routes).

// ═══════════════════════════════════════════════════════════════════════
// markers.js
// ═══════════════════════════════════════════════════════════════════════
var DSAO_STORAGE_KEY = "dsao:thinking-markers";
var DSAO_DEFAULT_MARKERS = ["\x3C/think\x3E"];

function loadMarkers() {
  try {
    var raw = localStorage.getItem(DSAO_STORAGE_KEY);
    if (raw) { var p = JSON.parse(raw); if (Array.isArray(p)) return p; }
  } catch (e) {}
  return DSAO_DEFAULT_MARKERS.slice();
}

function saveMarkers(m) {
  try { localStorage.setItem(DSAO_STORAGE_KEY, JSON.stringify(m)); } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// text-split.js
// ═══════════════════════════════════════════════════════════════════════
function splitText(text, markers) {
  var valid = (markers || []).filter(function (m) { return typeof m === "string" && m.length > 0; });
  if (valid.length === 0) return [{ kind: "body", text: text }];
  var segs = [];
  var pos = 0;
  while (pos < text.length) {
    var cut = -1;
    for (var i = 0; i < valid.length; i++) {
      var at = text.indexOf(valid[i], pos);
      if (at !== -1 && (cut === -1 || at < cut)) cut = at;
    }
    if (cut === -1) { segs.push({ kind: "body", text: text.slice(pos) }); break; }
    var reason = text.slice(pos, cut);
    if (reason.trim() !== "") segs.push({ kind: "reason", text: reason });
    pos = cut;
    for (var j = 0; j < valid.length; j++) { if (text.startsWith(valid[j], pos)) { pos += valid[j].length; break; } }
  }
  return segs;
}

function transformBlocks(blocks, markers) {
  if (!markers || markers.length === 0) return blocks;
  var out = [];
  for (var bi = 0; bi < blocks.length; bi++) {
    var b = blocks[bi];
    if (b.kind !== "text") { out.push(b); continue; }
    var segs = splitText(b.text || "", markers);
    for (var si = 0; si < segs.length; si++) {
      var seg = segs[si];
      if (seg.kind === "reason") out.push({ kind: "reasoning", text: seg.text });
      else if (seg.text.trim() !== "") out.push({ kind: "text", text: seg.text });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// tool-diff.js
// ═══════════════════════════════════════════════════════════════════════
function diffToolName(block) {
  if (!block) return '';
  return 'kind' in block ? ((block.call && block.call.name) || '') : (block.name || '')
}

function diffToolArgs(block) {
  if (!block) return null
  var raw = 'kind' in block ? (block.call && block.call.argsRaw) : block.argsRaw
  if (typeof raw !== 'string' || raw === '') return null
  try {
    var parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (e) { return null }
}

function diffView(block) {
  if (!block) return null
  if ('kind' in block) {
    if (block.isError) return null
    return block.resultView || null
  }
  return block.callView || null
}

function diffCountLines(text) {
  if (typeof text !== 'string' || text === '') return 0
  var normalized = text.replace(/\r\n/g, '\n')
  if (normalized === '\n') return 1
  if (normalized.charAt(normalized.length - 1) === '\n') normalized = normalized.slice(0, -1)
  if (normalized === '') return 0
  return normalized.split('\n').length
}

function diffStats(block) {
  var view = diffView(block)
  if (!view || view.card !== 'diff' || !Array.isArray(view.diffs)) return null
  var added = 0, deleted = 0
  for (var i = 0; i < view.diffs.length; i++) {
    var hunk = view.diffs[i]
    if (!hunk) continue
    if (typeof hunk.newText === 'string') added += diffCountLines(hunk.newText)
    if (typeof hunk.oldText === 'string') deleted += diffCountLines(hunk.oldText)
  }
  if (added === 0 && deleted === 0) return null
  return { added: added, deleted: deleted }
}

function diffPath(block) {
  if (!block) return null
  var view = diffView(block)
  if (view && view.card === 'diff' && Array.isArray(view.diffs) && view.diffs.length && typeof view.diffs[0].path === 'string') {
    return view.diffs[0].path
  }
  var args = diffToolArgs(block)
  if (args) return args.file_path || args.path || null
  return null
}

function createDiffBadge(stats) {
  var badge = document.createElement('span')
  badge.setAttribute('data-dsao-diff-badge', '')
  badge.style.cssText = 'display:inline-flex;align-items:baseline;gap:2px;margin-left:6px;flex:none;white-space:nowrap;font-size:12px;line-height:24px;font-weight:600;'
  if (stats.added > 0) {
    var add = document.createElement('span')
    add.textContent = '+' + stats.added
    add.style.color = 'var(--dsw-alias-state-success-primary, #16a34a)'
    badge.appendChild(add)
  }
  if (stats.added > 0 && stats.deleted > 0) {
    var sep = document.createElement('span')
    sep.textContent = '/'
    sep.style.cssText = 'color:var(--dsw-alias-label-secondary,#666)'
    badge.appendChild(sep)
  }
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

function badgeSignature(stats) {
  var parts = []
  if (stats.added > 0) parts.push('+' + stats.added)
  if (stats.deleted > 0) parts.push('-' + stats.deleted)
  return parts.join(' / ')
}

function ensureBadge(container, block) {
  if (!container || !container.querySelectorAll) return
  var stats = block ? diffStats(block) : null
  var link = container.querySelector('[class*="fileLink"]')
  var olds = container.querySelectorAll('[data-dsao-diff-badge]')
  if (!stats || !link || !link.parentNode) {
    for (var k = 0; k < olds.length; k++) {
      if (olds[k].parentNode) olds[k].parentNode.removeChild(olds[k])
    }
    return
  }
  var next = link.nextElementSibling
  if (next && next.getAttribute && next.getAttribute('data-dsao-diff-badge') === '' &&
      next.title === badgeSignature(stats) && olds.length === 1) {
    return
  }
  for (var i = 0; i < olds.length; i++) {
    var o = olds[i]
    if (o.parentNode) o.parentNode.removeChild(o)
  }
  link.style.flex = '0 1 auto'
  var badge = createDiffBadge(stats)
  link.parentNode.insertBefore(badge, link.nextSibling)
}

// ═══════════════════════════════════════════════════════════════════════
// tool-group.js
// ═══════════════════════════════════════════════════════════════════════
var GROUPABLE_TOOLS = {
  'bash': true, 'pwsh': true,
  'read': true, 'write': true, 'edit': true, 'str_replace_editor': true,
  'grep': true, 'glob': true,
  'web_search': true, 'web_fetch': true,
  'skill_search': true, 'skill_load': true
};

var GROUPABLE_PREFIXES = ['mcp__', 'ssh_'];

function toolNameOf(flowItem) {
  if (!flowItem || !flowItem.querySelector) return '';
  var row = flowItem.querySelector('[data-tool]');
  if (row) {
    var name = row.getAttribute('data-tool') || '';
    if (name) return name;
  }
  var sample = flowItem.querySelector('[data-sample]');
  if (sample) {
    var sampleName = sample.getAttribute('data-sample') || '';
    if (sampleName) return sampleName;
  }
  return '';
}

function isGroupableTool(flowItem) {
  var name = toolNameOf(flowItem);
  if (!name) return false;
  if (GROUPABLE_TOOLS[name]) return true;
  for (var i = 0; i < GROUPABLE_PREFIXES.length; i++) {
    if (name.indexOf(GROUPABLE_PREFIXES[i]) === 0) return true;
  }
  return false;
}

var TOOL_GROUP_CSS = [
  '[data-dsao-tg-collapsed]{display:none!important}',
  '.dsao-tg-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;',
  '  font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);',
  '  background:transparent;border:none;border-radius:0;',
  '  min-width:0;transition:color 120ms}',
  '.dsao-tg-headerIcon{flex-shrink:0;display:inline-flex;align-items:center;',
  '  color:var(--dsw-alias-label-caption);margin-right:8px}',
  '.dsao-tg-headerLabel{font-weight:400;color:var(--dsw-alias-label-secondary);',
  '  white-space:nowrap}',
  '.dsao-tg-headerSep{background:var(--dsw-alias-label-caption);border-radius:1px;',
  '  flex:none;width:2px;height:2px;margin:0 8px}',
  '.dsao-tg-headerCount{text-overflow:ellipsis;white-space:nowrap;min-width:0;',
  '  color:var(--dsw-alias-label-tertiary);flex:auto;font-size:14px;line-height:24px;',
  '  overflow:hidden}',
  '.dsao-tg-headerSpacer{flex:auto}',
  '.dsao-tg-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;',
  '  color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}',
  '.dsao-tg-chevron{display:inline-block;transition:transform 180ms ease;',
  '  font-size:14px;line-height:1;color:var(--dsw-alias-label-secondary)}',
  '.dsao-tg-header[data-dsao-tg-state="expanded"] .dsao-tg-chevron{transform:rotate(90deg)}',
  '.dsao-tg-header[data-dsao-tg-state="collapsed"] .dsao-tg-chevron{transform:rotate(0deg)}',
  '.dsao-tg-header:hover .dsao-tg-headerLabel{color:var(--dsw-alias-label-primary)}'
].join('');

var _tgStyleInjected = false;

function tgEnsureStyles() {
  if (_tgStyleInjected) return;
  if (typeof document === 'undefined') return;
  if (document.getElementById('dsao-tool-group-css')) { _tgStyleInjected = true; return; }
  var style = document.createElement('style');
  style.id = 'dsao-tool-group-css';
  style.textContent = TOOL_GROUP_CSS;
  document.head.appendChild(style);
  _tgStyleInjected = true;
}

var TOOL_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 1.5L1.5 3.5L3 5L1.5 6.5L3.5 8.5L5 7L6.5 8.5L8.5 6.5L7 5L8.5 3.5L6.5 1.5L5 3L3.5 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" fill="none"/><circle cx="11.5" cy="11.5" r="3" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>';
var TG_CHEVRON = '\u276F';

function isTransparentNode(el) {
  if (!el || !el.getAttribute) return false;
  var kind = el.getAttribute('data-chat-flow-kind');
  if (kind !== 'assistant-step') return false;
  if (el.textContent && el.textContent.trim().length > 0) return false;
  if (el.offsetHeight > 0) return false;
  return true;
}

function detectGroups(root) {
  if (!root || !root.querySelectorAll) return [];
  var items = root.querySelectorAll('[data-chat-flow-kind="tool-call"]');
  if (items.length === 0) return [];
  var groups = [];
  var current = [];
  for (var i = 0; i < items.length; i++) {
    var el = items[i];
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

function areConsecutive(a, b) {
  if (!a || !b) return false;
  if (a.parentNode !== b.parentNode) return false;
  if (a.nextElementSibling === b) return true;
  var sibling = a.nextElementSibling;
  while (sibling && sibling !== b) {
    if (!isTransparentNode(sibling)) return false;
    sibling = sibling.nextElementSibling;
  }
  return sibling === b;
}

function createGroupHeader(groupSize) {
  var header = document.createElement('div');
  header.className = 'dsao-tg-header';
  header.setAttribute('data-dsao-tg-header', '');
  header.setAttribute('data-dsao-tg-state', 'collapsed');
  header.setAttribute('role', 'button');
  header.setAttribute('tabindex', '0');
  header.setAttribute('aria-expanded', 'false');
  var icon = document.createElement('span');
  icon.className = 'dsao-tg-headerIcon';
  icon.innerHTML = TOOL_ICON_SVG;
  var label = document.createElement('span');
  label.className = 'dsao-tg-headerLabel';
  label.textContent = '\u5DE5\u5177\u8C03\u7528';
  var sep = document.createElement('span');
  sep.className = 'dsao-tg-headerSep';
  sep.setAttribute('aria-hidden', 'true');
  var summary = document.createElement('span');
  summary.className = 'dsao-tg-headerCount';
  summary.setAttribute('data-dsao-tg-count', '');
  summary.textContent = groupSize + ' \u4E2A\u8C03\u7528';
  var spacer = document.createElement('span');
  spacer.className = 'dsao-tg-headerSpacer';
  var toggle = document.createElement('span');
  toggle.className = 'dsao-tg-toggle';
  var toggleLabel = document.createElement('span');
  toggleLabel.setAttribute('data-dsao-tg-toggle-label', '');
  toggleLabel.textContent = '\u5C55\u5F00';
  var chevron = document.createElement('span');
  chevron.className = 'dsao-tg-chevron';
  chevron.textContent = TG_CHEVRON;
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

function applyCollapse(header, group) {
  header.setAttribute('data-dsao-tg-state', 'collapsed');
  header.setAttribute('aria-expanded', 'false');
  for (var i = 1; i < group.length; i++) group[i].setAttribute('data-dsao-tg-collapsed', '');
  var count = header.querySelector('[data-dsao-tg-count]');
  if (count) count.textContent = group.length + ' \u4E2A\u8C03\u7528';
  var toggleLabel = header.querySelector('[data-dsao-tg-toggle-label]');
  if (toggleLabel) toggleLabel.textContent = '\u5C55\u5F00';
}

function applyExpand(header, group) {
  header.setAttribute('data-dsao-tg-state', 'expanded');
  header.setAttribute('aria-expanded', 'true');
  for (var i = 1; i < group.length; i++) group[i].removeAttribute('data-dsao-tg-collapsed');
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

function applyGroup(group) {
  var first = group[0];
  var existingHeader = first.previousElementSibling;
  var headerExists = existingHeader && existingHeader.getAttribute &&
    existingHeader.getAttribute('data-dsao-tg-header') === '';
  if (headerExists) {
    var oldSize = parseInt(existingHeader.getAttribute('data-dsao-tg-size') || '0', 10);
    if (oldSize !== group.length) {
      existingHeader.parentNode.removeChild(existingHeader);
      headerExists = false;
    }
  }
  for (var i = 0; i < group.length; i++) {
    var pos = i === 0 ? 'first' : (i === group.length - 1 ? 'last' : 'middle');
    group[i].setAttribute('data-dsao-tg-pos', pos);
  }
  if (!headerExists) {
    var header = createGroupHeader(group.length);
    header.setAttribute('data-dsao-tg-size', String(group.length));
    first.parentNode.insertBefore(header, first);
    var toggleFn = function () { toggleGroup(header, group); };
    header.addEventListener('click', function (e) { e.stopPropagation(); toggleFn(); });
    header.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggleFn(); }
    });
    applyCollapse(header, group);
    setupAutoCollapse(header, group);
  } else {
    existingHeader.setAttribute('data-dsao-tg-size', String(group.length));
    var state = existingHeader.getAttribute('data-dsao-tg-state');
    if (state === 'collapsed') {
      for (var j = 1; j < group.length; j++) group[j].setAttribute('data-dsao-tg-collapsed', '');
    }
    if (existingHeader._dsaoAutoCollapse) existingHeader._dsaoAutoCollapse.group = group;
  }
}

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
        if (currentState === 'expanded') applyCollapse(autoData.header, autoData.group);
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

function nextSignificantSibling(el) {
  var sibling = el.nextElementSibling;
  while (sibling) {
    if (isTransparentNode(sibling)) { sibling = sibling.nextElementSibling; continue; }
    return sibling;
  }
  return null;
}

function prevSignificantSibling(el) {
  var sibling = el.previousElementSibling;
  while (sibling) {
    if (isTransparentNode(sibling)) { sibling = sibling.previousElementSibling; continue; }
    return sibling;
  }
  return null;
}

function cleanupStaleMarkers(root) {
  if (!root) return;
  var headers = root.querySelectorAll('[data-dsao-tg-header]');
  for (var h = 0; h < headers.length; h++) {
    var header = headers[h];
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
      if (prev.getAttribute && prev.getAttribute('data-chat-flow-kind') !== 'tool-call') break;
    }
    if (!hasHeader) {
      el.removeAttribute('data-dsao-tg-pos');
      el.removeAttribute('data-dsao-tg-collapsed');
    }
  }
}

function scanToolGroups(root) {
  if (!root || !root.querySelectorAll) return;
  tgEnsureStyles();
  cleanupStaleMarkers(root);
  var groups = detectGroups(root);
  for (var i = 0; i < groups.length; i++) applyGroup(groups[i]);
}

function startToolGroupObserver() {
  if (typeof document === 'undefined') return function () {};
  tgEnsureStyles();
  var scan = function () { scanToolGroups(document.body); };
  scan();
  var obs = new MutationObserver(scan);
  obs.observe(document.body, { childList: true, subtree: true });
  return function () { obs.disconnect(); };
}

// ═══════════════════════════════════════════════════════════════════════
// mermaid.js
// ═══════════════════════════════════════════════════════════════════════
var _mermaidLoaded = null;
var _mermaidSeq = 0;
var _mermaidDrag = { active: null };
var _mermaidLayouts = [];
var _mermaidWinResizeBound = false;
var CANVAS_WIDE_RATIO = 0.75;
var CANVAS_TALL_RATIO = 1.2;

function _ensureDragListeners() {
  if (_mermaidDrag.listenersAdded) return;
  _mermaidDrag.listenersAdded = true;
  document.addEventListener("mousemove", function (e) { if (!_mermaidDrag.active) return; _mermaidDrag.active.onMove(e.clientX, e.clientY); });
  document.addEventListener("mouseup", function () { if (_mermaidDrag.active) { _mermaidDrag.active.viewport.style.cursor = "grab"; _mermaidDrag.active = null; } });
}

function _ensureWindowResizeListener() {
  if (_mermaidWinResizeBound || typeof window === "undefined") return;
  _mermaidWinResizeBound = true;
  window.addEventListener("resize", function () {
    for (var i = 0; i < _mermaidLayouts.length; i++) { try { _mermaidLayouts[i](); } catch (e) {} }
  });
}

function loadMermaid() {
  if (_mermaidLoaded) return _mermaidLoaded;
  if (typeof window === "undefined" || !window.document) return Promise.resolve(null);
  if (window.mermaid) {
    window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { useMaxWidth: false } });
    _mermaidLoaded = Promise.resolve(window.mermaid);
    return _mermaidLoaded;
  }
  _mermaidLoaded = new Promise(function (resolve) {
    var s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    s.onload = function () {
      if (window.mermaid) {
        window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { useMaxWidth: false } });
        resolve(window.mermaid);
      } else { _mermaidLoaded = null; resolve(null); }
    };
    s.onerror = function () { _mermaidLoaded = null; resolve(null); };
    document.head.appendChild(s);
  });
  return _mermaidLoaded;
}

function _cleanupMermaidTemp(id) {
  var candidates = [id, "d" + id];
  for (var i = 0; i < candidates.length; i++) {
    var node = document.getElementById(candidates[i]);
    if (node && node.parentNode) node.parentNode.removeChild(node);
  }
}

function renderMermaidBlock(el, code) {
  loadMermaid().then(function (mermaid) {
    if (!mermaid) return;
    var id = "mmd-" + (++_mermaidSeq);
    try {
      mermaid.render(id, code).then(function (result) {
        _cleanupMermaidTemp(id);
        _mountMermaid(el, result.svg);
      }).catch(function () { _cleanupMermaidTemp(id); });
    } catch (e) { _cleanupMermaidTemp(id); }
  });
}

function _mountMermaid(el, svgHtml) {
  _ensureDragListeners();
  var container = document.createElement("div");
  container.className = "dsao-mermaid";
  container.style.cssText = "position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin:8px auto;display:block;cursor:grab;user-select:none;box-sizing:border-box";
  var toolbar = document.createElement("div");
  toolbar.style.cssText = "position:absolute;top:6px;right:6px;display:flex;gap:4px;z-index:10;background:var(--dsw-alias-bg-module-platform,rgba(255,255,255,0.92));border-radius:6px;padding:2px;box-shadow:0 1px 3px rgba(0,0,0,0.12)";
  var btnStyle = "cursor:pointer;border:none;background:none;padding:4px 8px;font-size:16px;line-height:1;border-radius:4px;color:var(--dsw-alias-label-primary)";
  function mkBtn(glyph, title) {
    var b = document.createElement("button");
    b.style.cssText = btnStyle; b.textContent = glyph; b.title = title;
    b.addEventListener("mouseenter", function () { b.style.background = "var(--dsw-alias-interactive-bg-hover)"; });
    b.addEventListener("mouseleave", function () { b.style.background = "none"; });
    return b;
  }
  var btnReset = mkBtn("\u21BA", "Reset");
  toolbar.appendChild(btnReset);
  var svgWrap = document.createElement("div");
  svgWrap.style.cssText = "position:absolute;left:0;top:0;transform-origin:top left;display:block;padding:12px;box-sizing:border-box";
  svgWrap.innerHTML = svgHtml;
  var svgEl = svgWrap.querySelector("svg");
  var natW = 0, natH = 0;
  if (svgEl) {
    var vb = (svgEl.getAttribute("viewBox") || "").split(/\s+/);
    if (vb.length === 4) { natW = parseFloat(vb[2]) || 0; natH = parseFloat(vb[3]) || 0; }
    if (natW > 0) svgEl.style.width = natW + "px";
    if (natH > 0) svgEl.style.height = natH + "px";
    svgEl.style.display = "block";
  }
  if (natW > 0) { svgWrap.style.width = (natW + 24) + "px"; svgWrap.style.height = (natH + 24) + "px"; }
  container.appendChild(svgWrap); container.appendChild(toolbar);
  var boxW = el.clientWidth || 600;
  var parent = el.parentElement;
  container.style.width = "100%";
  if (parent) parent.replaceChild(container, el);
  var isWide = !(natW > 0 && natH > 0) || natW >= natH;
  var pad = 24;
  var canvasW = 0, canvasH = 0, fit = 1;
  var scale = 1, tx = 0, ty = 0;
  function apply() {
    var x = (canvasW - (natW + pad) * scale) / 2 + tx;
    var y = (canvasH - (natH + pad) * scale) / 2 + ty;
    svgWrap.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
  }
  function layout() {
    canvasW = container.clientWidth || boxW;
    canvasH = Math.round(canvasW * (isWide ? CANVAS_WIDE_RATIO : CANVAS_TALL_RATIO));
    fit = (natW > 0 && natH > 0) ? Math.min(canvasW / (natW + pad), canvasH / (natH + pad)) : 1;
    container.style.height = canvasH + "px";
    scale = fit; tx = 0; ty = 0;
    apply();
  }
  function clampScale(s) { return Math.max(0.3, Math.min(5, s)); }
  btnReset.addEventListener("click", function () { scale = fit; tx = 0; ty = 0; apply(); });
  layout();
  _mermaidLayouts.push(layout);
  _ensureWindowResizeListener();
  if (typeof ResizeObserver !== "undefined" && parent) {
    new ResizeObserver(function () { layout(); }).observe(parent);
  }
  container.addEventListener("mousedown", function (e) {
    var lastX = e.clientX, lastY = e.clientY;
    _mermaidDrag.active = { viewport: container, onMove: function (cx, cy) { tx += cx - lastX; ty += cy - lastY; lastX = cx; lastY = cy; apply(); } };
    container.style.cursor = "grabbing"; e.preventDefault();
  });
  container.addEventListener("wheel", function (e) { e.preventDefault(); scale = clampScale(scale * (e.deltaY > 0 ? 0.9 : 1.1)); apply(); }, { passive: false });
  var touchDrag = false, tX = 0, tY = 0;
  container.addEventListener("touchstart", function (e) { if (e.touches.length === 1) { touchDrag = true; tX = e.touches[0].clientX; tY = e.touches[0].clientY; } }, { passive: true });
  container.addEventListener("touchmove", function (e) { if (!touchDrag || e.touches.length !== 1) return; e.preventDefault(); tx += e.touches[0].clientX - tX; ty += e.touches[0].clientY - tY; tX = e.touches[0].clientX; tY = e.touches[0].clientY; apply(); }, { passive: false });
  container.addEventListener("touchend", function () { touchDrag = false; });
  apply();
}

function processMermaidBlocks(root) {
  if (!root || !root.querySelectorAll) return;
  var blocks = root.querySelectorAll(".md-code-block");
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    if (block.dataset.dsaoMermaid) continue;
    var banner = block.firstElementChild; if (!banner) continue;
    var inner = banner.firstElementChild; if (!inner) continue;
    var infoDiv = inner.firstElementChild;
    if (!infoDiv || infoDiv.textContent.trim().toLowerCase() !== "mermaid") continue;
    var pre = block.querySelector("pre"); var code = pre ? pre.textContent : "";
    if (!code.trim()) continue;
    block.dataset.dsaoMermaid = "1";
    renderMermaidBlock(block, code.trim());
  }
}

function startMermaidObserver() {
  if (typeof document === "undefined") return function () {};
  var scan = function () { processMermaidBlocks(document.body); };
  scan();
  var obs = new MutationObserver(scan);
  obs.observe(document.body, { childList: true, subtree: true });
  return function () { obs.disconnect(); };
}

// ═══════════════════════════════════════════════════════════════════════
// Slot finders (from wrapper.js)
// ═══════════════════════════════════════════════════════════════════════
var _officialRendererCache = null;

function findOfficialRenderer(slots) {
  if (_officialRendererCache) return _officialRendererCache;
  try {
    var entries = slots.entries("conversation.chat.node");
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.options.key === "assistant-step" && (e.options.priority || 0) === 0) {
        _officialRendererCache = e.component;
        return _officialRendererCache;
      }
    }
  } catch (err) {}
  return null;
}

function findOfficialView(slots, toolName) {
  try {
    var entries = slots.entries('tool.call.toolview');
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.options.key === toolName && (e.options.priority || 0) === 0) return e.component;
    }
  } catch (err) {}
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// Wrapper components (from wrapper.js)
// ═══════════════════════════════════════════════════════════════════════
function WrappedAssistantStep(props) {
  var officialRenderer = props._officialRenderer;
  var ms = React.useState(loadMarkers());
  var markers = ms[0];

  React.useEffect(function () {
    function handler() { ms[1](loadMarkers()); }
    window.addEventListener("dsao:markers-changed", handler);
    return function () { window.removeEventListener("dsao:markers-changed", handler); };
  }, []);

  if (!officialRenderer) return null;
  var fp = Object.assign({}, props._rawProps || {});
  if (!markers || markers.length === 0) return React.createElement(officialRenderer, fp);
  var node = props.node;
  var data = node && node.data;
  if (!data || !data.blocks) return React.createElement(officialRenderer, fp);
  var hasText = false;
  for (var i = 0; i < data.blocks.length; i++) { if (data.blocks[i].kind === "text") { hasText = true; break; } }
  if (!hasText) return React.createElement(officialRenderer, fp);
  var newBlocks = transformBlocks(data.blocks, markers);
  var newData = Object.assign({}, data, { blocks: newBlocks });
  var newNode = Object.assign({}, node, { data: newData });
  var newProps = Object.assign({}, props._rawProps || {}, { node: newNode });
  return React.createElement(officialRenderer, newProps);
}

function WrappedToolCallRow(props) {
  var official = props._officialRenderer;
  var ref = React.useRef(null);
  var block = props.block;

  React.useEffect(function () {
    if (!ref.current) return;
    ensureBadge(ref.current, block);
    var obs = new MutationObserver(function () {
      if (ref.current) ensureBadge(ref.current, block);
    });
    obs.observe(ref.current, { childList: true, subtree: true });
    return function () { obs.disconnect(); };
  }, [block, official]);

  if (!official) return null;
  return React.createElement(
    'div',
    { ref: ref, className: 'dsao-tool-view-row', style: { display: 'contents' } },
    React.createElement(official, props._rawProps || {})
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Settings — TagsSetting (from settings.js)
// ═══════════════════════════════════════════════════════════════════════
function TagsSetting() {
  var m = React.useState(loadMarkers()), markers = m[0], setMarkers = m[1];
  var inp = React.useState(""), input = inp[0], setInput = inp[1];

  function syncMarkers() {
    var updated = loadMarkers();
    setMarkers(updated.slice());
    window.dispatchEvent(new Event("dsao:markers-changed"));
  }
  function add() {
    var t = input.trim(); if (!t) return;
    var current = loadMarkers();
    if (!current.includes(t)) { current.push(t); saveMarkers(current); }
    setInput(""); syncMarkers();
  }
  function remove(tag) {
    var current = loadMarkers().filter(function (m) { return m !== tag; });
    saveMarkers(current); syncMarkers();
  }

  var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
  var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
  var chipStyle = { display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "6px", background: "var(--dsw-alias-interactive-bg-hover)", fontSize: "13px" };
  var xStyle = { cursor: "pointer", color: "var(--dsw-alias-label-tertiary)", border: "none", background: "none", padding: "0 2px", fontSize: "16px", lineHeight: "1" };
  var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "100px" };
  var addBtnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };

  var chipEls = [];
  for (var ci = 0; ci < markers.length; ci++) {
    chipEls.push(React.createElement("span", { key: markers[ci], style: chipStyle }, markers[ci], React.createElement("button", { style: xStyle, onClick: function (tag) { return function () { remove(tag); }; }(markers[ci]) }, "\u00D7")));
  }
  var inputGroup = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flex: "0 0 auto" } }, React.createElement("input", { value: input, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") add(); }, placeholder: "Add marker...", style: inputStyle }), React.createElement("button", { onClick: add, style: addBtnStyle }, "Add"));
  var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Thinking Tag Markers");
  var rightCol = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flex: "1 1 auto", minWidth: "0", maxWidth: "560px" } }, React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", justifyContent: "flex-end", flex: "1 1 auto", minWidth: "0" } }, chipEls), inputGroup);
  return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
}

// ═══════════════════════════════════════════════════════════════════════
// Plugin apply — register all Client UI
// ═══════════════════════════════════════════════════════════════════════
return {
  apply: function (ctx) {
    var slots = ctx.get("slots");
    if (slots === undefined) return;

    // 1. Wrap official assistant-step renderer (priority -1 shadows priority 0)
    slots.inject("conversation.chat.node", function () {
      return slots.register(
        { name: "conversation.chat.node", key: "assistant-step", priority: -1, locale: "conversation" },
        function (rawProps) {
          var official = findOfficialRenderer(slots);
          var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
          return React.createElement(WrappedAssistantStep, wrapperProps);
        }
      );
    });

    // 1b. Wrap official tool-call view (write/edit) at tool.call.toolview
    var diffKeys = ['write', 'edit'];
    for (var di = 0; di < diffKeys.length; di++) {
      (function (key) {
        slots.inject("tool.call.toolview", function () {
          return slots.register(
            { name: "tool.call.toolview", key: key, priority: -1, locale: "conversation" },
            function (rawProps) {
              var official = findOfficialView(slots, key);
              var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
              return React.createElement(WrappedToolCallRow, wrapperProps);
            }
          );
        });
      })(diffKeys[di]);
    }

    // 2. Settings page — Thinking Tag Markers
    slots.inject("settings.general.item", function () {
      return slots.register(
        { name: "settings.general.item", id: "thinking-tags", order: 30 },
        function () { return React.createElement(TagsSetting); }
      );
    });

    // 4. Mermaid post-processor
    ctx.effect(function () { return startMermaidObserver(); });

    // 5. Tool-call grouping: collapse consecutive tool-call rows
    ctx.effect(function () { return startToolGroupObserver(); });
  }
}
