// mermaid.js — render mermaid code blocks as interactive SVG diagrams
// Exports: startMermaidObserver
// Requires: nothing (pure DOM + CDN)

var _mermaidLoaded = null;
var _mermaidSeq = 0;
var _drag = { active: null };
var _mermaidLayouts = [];
var _winResizeBound = false;

// Two canvas shapes, picked by the diagram's orientation (never its size).
// BOTH are always the full slot width; only the height differs, and the height
// is a fixed multiple of that width:
//   wide (W >= H) -> width x width * 0.6   (landscape box)
//   tall (W <  H) -> width x width * 1.2   (portrait box, height > width)
var CANVAS_WIDE_RATIO = 0.6;
var CANVAS_TALL_RATIO = 1.2;

function _ensureDragListeners() {
  if (_drag.listenersAdded) return;
  _drag.listenersAdded = true;
  document.addEventListener("mousemove", function (e) { if (!_drag.active) return; _drag.active.onMove(e.clientX, e.clientY); });
  document.addEventListener("mouseup", function () { if (_drag.active) { _drag.active.viewport.style.cursor = "grab"; _drag.active = null; } });
}

function _ensureWindowResizeListener() {
  if (_winResizeBound || typeof window === "undefined") return;
  _winResizeBound = true;
  window.addEventListener("resize", function () {
    for (var i = 0; i < _mermaidLayouts.length; i++) {
      try { _mermaidLayouts[i](); } catch (e) {}
    }
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

/**
 * Mermaid v11 injects a temporary container (bearing the render id) into
 * document.body during render. On success it removes the container; on a
 * syntax error it leaves the container — now holding an error SVG — in the
 * DOM, which surfaces as "Syntax error … mermaid version X" at the page
 * bottom. Clean it up on every outcome so errors never reach the UI.
 */
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
  // Fixed canvas: wheel zooms, drag pans — only reset remains.
  var btnReset = mkBtn("\u21BA", "Reset");
  toolbar.appendChild(btnReset);

  var svgWrap = document.createElement("div");
  svgWrap.style.cssText = "position:absolute;left:0;top:0;transform-origin:top left;display:block;padding:12px;box-sizing:border-box";
  svgWrap.innerHTML = svgHtml;
  // Pin the SVG to its natural size (from the viewBox); the fit below scales
  // the wrap via transform, never the SVG layout.
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

  // Canvas is always the full slot width. Orientation only selects the height
  // ratio: wide boxes are flatter, tall boxes are taller. Width follows the
  // slot via CSS 100%; height and contain-fit are recomputed on resize.
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

  // Keep the canvas tracking the slot. ResizeObserver handles direct slot
  // width changes; window resize is the broader compatibility fallback.
  _mermaidLayouts.push(layout);
  _ensureWindowResizeListener();
  if (typeof ResizeObserver !== "undefined" && parent) {
    new ResizeObserver(function () { layout(); }).observe(parent);
  }

  container.addEventListener("mousedown", function (e) {
    var lastX = e.clientX, lastY = e.clientY;
    _drag.active = { viewport: container, onMove: function (cx, cy) { tx += cx - lastX; ty += cy - lastY; lastX = cx; lastY = cy; apply(); } };
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

exports.startMermaidObserver = startMermaidObserver;
