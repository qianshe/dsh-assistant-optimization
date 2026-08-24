// mermaid.js — render mermaid code blocks as interactive SVG diagrams
// Exports: startMermaidObserver
// Requires: nothing (pure DOM + CDN)

var _mermaidLoaded = null;
var _mermaidSeq = 0;
var _drag = { active: null };

function _ensureDragListeners() {
  if (_drag.listenersAdded) return;
  _drag.listenersAdded = true;
  document.addEventListener("mousemove", function (e) { if (!_drag.active) return; _drag.active.onMove(e.clientX, e.clientY); });
  document.addEventListener("mouseup", function () { if (_drag.active) { _drag.active.viewport.style.cursor = "grab"; _drag.active = null; } });
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
  container.style.cssText = "position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;margin:8px 0";

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
  var btnIn = mkBtn("\u2795", "Zoom In"), btnOut = mkBtn("\u2796", "Zoom Out"), btnReset = mkBtn("\u21BA", "Reset");
  toolbar.appendChild(btnIn); toolbar.appendChild(btnOut); toolbar.appendChild(btnReset);

  var viewport = document.createElement("div");
  viewport.style.cssText = "overflow:auto;cursor:grab;user-select:none;display:flex;width:100%;min-height:150px;max-height:520px;box-sizing:border-box";
  var svgWrap = document.createElement("div");
  svgWrap.style.cssText = "transform-origin:top left;display:inline-block;padding:12px;margin:auto;flex:0 0 auto;box-sizing:border-box";
  svgWrap.innerHTML = svgHtml;
  // Pin the SVG to its natural size (from the viewBox) so a wide diagram
  // scrolls horizontally instead of being shrunk below legibility, and a tall
  // one scrolls vertically inside the capped viewport instead of being
  // clipped. Margin auto centers it when it fits and keeps the top-left
  // reachable when it overflows.
  var svgEl = svgWrap.querySelector("svg");
  if (svgEl) {
    var vb = (svgEl.getAttribute("viewBox") || "").split(/\s+/);
    if (vb.length === 4) {
      var nw = parseFloat(vb[2]), nh = parseFloat(vb[3]);
      if (isFinite(nw) && nw > 0) svgEl.style.width = nw + "px";
      if (isFinite(nh) && nh > 0) svgEl.style.height = nh + "px";
    }
    svgEl.style.display = "block";
  }
  viewport.appendChild(svgWrap); container.appendChild(toolbar); container.appendChild(viewport);

  // Natural layout size of the wrap (border box, at scale 1). The layout box is
  // resized in apply() so the scrollable range always matches the SCALED visual
  // size — zooming out never leaves a blank region, zooming in never strands
  // content beyond the scroll edge.
  var baseW = svgWrap.offsetWidth, baseH = svgWrap.offsetHeight;
  if (!baseW || !baseH) {
    var nb = (svgEl ? (svgEl.getAttribute("viewBox") || "").split(/\s+/) : []);
    baseW = (nb.length === 4 ? parseFloat(nb[2]) : 0) + 24;
    baseH = (nb.length === 4 ? parseFloat(nb[3]) : 0) + 24;
  }
  var scale = 1, tx = 0, ty = 0;
  function apply() {
    svgWrap.style.width = Math.max(1, baseW * scale) + "px";
    svgWrap.style.height = Math.max(1, baseH * scale) + "px";
    svgWrap.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")";
  }
  function clampScale(s) { return Math.max(0.3, Math.min(5, s)); }
  btnIn.addEventListener("click", function () { scale = clampScale(scale * 1.2); apply(); });
  btnOut.addEventListener("click", function () { scale = clampScale(scale / 1.2); apply(); });
  btnReset.addEventListener("click", function () { scale = 1; tx = 0; ty = 0; apply(); });

  viewport.addEventListener("mousedown", function (e) {
    var lastX = e.clientX, lastY = e.clientY;
    _drag.active = { viewport: viewport, onMove: function (cx, cy) { tx += cx - lastX; ty += cy - lastY; lastX = cx; lastY = cy; apply(); } };
    viewport.style.cursor = "grabbing"; e.preventDefault();
  });
  viewport.addEventListener("wheel", function (e) { e.preventDefault(); scale = clampScale(scale * (e.deltaY > 0 ? 0.9 : 1.1)); apply(); }, { passive: false });
  var touchDrag = false, tX = 0, tY = 0;
  viewport.addEventListener("touchstart", function (e) { if (e.touches.length === 1) { touchDrag = true; tX = e.touches[0].clientX; tY = e.touches[0].clientY; } }, { passive: true });
  viewport.addEventListener("touchmove", function (e) { if (!touchDrag || e.touches.length !== 1) return; e.preventDefault(); tx += e.touches[0].clientX - tX; ty += e.touches[0].clientY - tY; tX = e.touches[0].clientX; tY = e.touches[0].clientY; apply(); }, { passive: false });
  viewport.addEventListener("touchend", function () { touchDrag = false; });

  apply();
  var parent = el.parentElement;
  if (parent) parent.replaceChild(container, el);
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
