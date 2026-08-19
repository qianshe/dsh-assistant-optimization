// dsh-assistant-optimization — Client bundle
//
// Uses window.__ModuleLoader__.load() multi-registration to split concerns:
//   dsao/markers    — localStorage marker management
//   dsao/text-split — text splitting logic
//   dsao/tool-diff  — file-tool diff line count badges
//   dsao/wrapper    — assistant-step + tool-call wrappers
//   dsao/mermaid    — mermaid DOM observer + SVG rendering
//   dsao/settings   — settings page UI
//   dsh-assistant-optimization — main plugin entry (requires the above)

// ── dsao/markers ─────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/markers",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var STORAGE_KEY = "dsao:thinking-markers";
		var DEFAULT_MARKERS = ["\x3C/think\x3E"];

		function loadMarkers() {
			try {
				var raw = localStorage.getItem(STORAGE_KEY);
				if (raw) { var p = JSON.parse(raw); if (Array.isArray(p)) return p; }
			} catch (e) {}
			return DEFAULT_MARKERS.slice();
		}
		function saveMarkers(m) {
			try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch (e) {}
		}

		exports.loadMarkers = loadMarkers;
		exports.saveMarkers = saveMarkers;
		return module.exports;
	}
});

// ── dsao/text-split ──────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/text-split",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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

		exports.splitText = splitText;
		exports.transformBlocks = transformBlocks;
		return module.exports;
	}
});

// ── dsao/tool-diff ────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/tool-diff",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		function toolName(block) {
			if (!block) return "";
			return "kind" in block ? ((block.call && block.call.name) || "") : (block.name || "");
		}

		function toolArgs(block) {
			if (!block) return null;
			var raw = "kind" in block ? (block.call && block.call.argsRaw) : block.argsRaw;
			if (typeof raw !== "string" || raw === "") return null;
			try {
				var parsed = JSON.parse(raw);
				return parsed && typeof parsed === "object" ? parsed : null;
			} catch (e) {
				return null;
			}
		}

		function isFileMutationTool(block) {
			var name = toolName(block);
			if (name === "write" || name === "edit") return true;
			if (name !== "str_replace_editor") return false;
			var args = toolArgs(block);
			return !!args && args.command === "str_replace";
		}

		function countLines(text) {
			if (typeof text !== "string" || text === "") return 0;
			var normalized = text.replace(/\r\n/g, "\n");
			if (normalized === "\n") return 1;
			if (normalized.charAt(normalized.length - 1) === "\n") normalized = normalized.slice(0, -1);
			if (normalized === "") return 0;
			return normalized.split("\n").length;
		}

		function diffStats(block) {
			if (!block) return null;
			var view = "kind" in block ? (block.resultView || block.callView || null) : (block.callView || null);
			if (!view || view.card !== "diff" || !Array.isArray(view.diffs)) return null;
			var added = 0, deleted = 0;
			for (var i = 0; i < view.diffs.length; i++) {
				var hunk = view.diffs[i];
				if (!hunk) continue;
				if (typeof hunk.newText === "string") added += countLines(hunk.newText);
				if (typeof hunk.oldText === "string") deleted += countLines(hunk.oldText);
			}
			if (added === 0 && deleted === 0) return null;
			return { added: added, deleted: deleted };
		}

		function diffPath(block) {
			if (!block) return null;
			var view = "kind" in block ? (block.resultView || block.callView || null) : (block.callView || null);
			if (view && view.card === "diff" && Array.isArray(view.diffs) && view.diffs.length && typeof view.diffs[0].path === "string") {
				return view.diffs[0].path;
			}
			var args = toolArgs(block);
			if (args) return args.file_path || args.path || null;
			return null;
		}

		function normalizePathText(value) {
			return String(value || "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
		}

		function findPathTarget(row, path) {
			if (!row || !path) return null;
			var normalized = normalizePathText(path);
			var els = row.querySelectorAll('button, [role="button"], a, span');
			for (var i = 0; i < els.length; i++) {
				var el = els[i];
				if (normalizePathText(el.textContent || "") === normalized) return el;
			}
			return null;
		}

		function collectBlocks(block, out) {
			if (!block) return;
			out[block.callId] = block;
			var subs = block.subCalls || [];
			for (var i = 0; i < subs.length; i++) collectBlocks(subs[i], out);
		}

		function createBadge(stats) {
			var badge = document.createElement("span");
			badge.setAttribute("data-dsao-diff-badge", "");
			badge.style.cssText = "display:inline-flex;align-items:baseline;gap:2px;margin-left:6px;flex:none;white-space:nowrap;font-size:12px;line-height:24px;font-weight:600;";
			if (stats.added > 0) {
				var add = document.createElement("span");
				add.textContent = "+" + stats.added;
				add.style.color = "var(--dsw-alias-state-success-primary, #16a34a)";
				badge.appendChild(add);
			}
			if (stats.added > 0 && stats.deleted > 0) badge.appendChild(document.createTextNode("/"));
			if (stats.deleted > 0) {
				var del = document.createElement("span");
				del.textContent = "-" + stats.deleted;
				del.style.color = "var(--dsw-alias-state-error-primary, #dc2626)";
				badge.appendChild(del);
			}
			var titleParts = [];
			if (stats.added > 0) titleParts.push("+" + stats.added);
			if (stats.deleted > 0) titleParts.push("-" + stats.deleted);
			badge.title = titleParts.join(" / ");
			return badge;
		}

		function annotateToolDiffs(rootEl, root) {
			if (!rootEl || !root || !rootEl.querySelectorAll) return;
			var byId = {};
			collectBlocks(root, byId);
			var rows = rootEl.querySelectorAll("[data-chat-call-id]");
			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				var callId = row.getAttribute("data-chat-call-id");
				var block = callId ? byId[callId] : undefined;
				if (!block) continue;
				if (!isFileMutationTool(block)) continue;
				var stats = diffStats(block);
				if (!stats) continue;
				var olds = row.querySelectorAll("[data-dsao-diff-badge]");
				for (var j = 0; j < olds.length; j++) {
					var oldEl = olds[j];
					if (oldEl.parentNode) oldEl.parentNode.removeChild(oldEl);
				}
				var link = row.querySelector('[class*="fileLink"]');
				var path = diffPath(block);
				var target = link || findPathTarget(row, path) || row.querySelector('[class*="summary"]');
				if (!target || !target.parentNode) continue;
				target.style.flex = "0 1 auto";
				var badge = createBadge(stats);
				target.parentNode.insertBefore(badge, target.nextSibling);
				row.setAttribute("data-dsao-tool-diff", "1");
			}
		}

		exports.diffStats = diffStats;
		exports.annotateToolDiffs = annotateToolDiffs;
		return module.exports;
	}
});

// ── dsao/wrapper ─────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/wrapper",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var textSplit = require("dsao/text-split");
		var markersMod = require("dsao/markers");
		var toolDiff = require("dsao/tool-diff");

		var _officialRendererCache = null;
		var _toolRendererCache = null;

		function findOfficialRenderer(slots) {
			if (_officialRendererCache) return _officialRendererCache;
			try {
				var entries = slots.entries("conversation.chat.node");
				if (!entries) return null;
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i];
					if (e.options.key === "assistant-step" && (e.options.priority ?? 0) === 0) {
						_officialRendererCache = e.component;
						return _officialRendererCache;
					}
				}
			} catch (err) {}
			return null;
		}

		function findToolRenderer(slots) {
			if (_toolRendererCache) return _toolRendererCache;
			try {
				var entries = slots.entries("conversation.chat.node");
				if (!entries) return null;
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i];
					if (e.options.key === "tool-call" && (e.options.priority ?? 0) === 0) {
						_toolRendererCache = e.component;
						return _toolRendererCache;
					}
				}
			} catch (err) {}
			return null;
		}

		function WrappedAssistantStep(props) {
			var officialRenderer = props._officialRenderer;
			var ms = React.useState(markersMod.loadMarkers());
			var markers = ms[0];

			React.useEffect(function () {
				function handler() { ms[1](markersMod.loadMarkers()); }
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
			var newBlocks = textSplit.transformBlocks(data.blocks, markers);
			var newData = Object.assign({}, data, { blocks: newBlocks });
			var newNode = Object.assign({}, node, { data: newData });
			var newProps = Object.assign({}, props._rawProps || {}, { node: newNode });
			return React.createElement(officialRenderer, newProps);
		}

		function WrappedToolCallTree(props) {
			var officialRenderer = props._officialRenderer;
			var ref = React.useRef(null);
			var node = props.node;
			var root = node && node.data && node.data.root;
			React.useEffect(function () {
				if (!ref.current) return;
				if (root && toolDiff.annotateToolDiffs) toolDiff.annotateToolDiffs(ref.current, root);
				var obs = new MutationObserver(function () {
					if (root && toolDiff.annotateToolDiffs) toolDiff.annotateToolDiffs(ref.current, root);
				});
				obs.observe(ref.current, { childList: true, subtree: true, characterData: true });
				return function () { obs.disconnect(); };
			}, [root, officialRenderer]);
			if (!officialRenderer) return null;
			return React.createElement("div", { ref: ref, className: "dsao-tool-call-wrapper", style: { display: "contents" } },
				React.createElement(officialRenderer, props._rawProps || {})
			);
		}

		exports.WrappedAssistantStep = WrappedAssistantStep;
		exports.WrappedToolCallTree = WrappedToolCallTree;
		exports.findOfficialRenderer = findOfficialRenderer;
		exports.findToolRenderer = findToolRenderer;
		return module.exports;
	}
});

// ── dsao/mermaid ─────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/mermaid",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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
			if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" }); _mermaidLoaded = Promise.resolve(window.mermaid); return _mermaidLoaded; }
			_mermaidLoaded = new Promise(function (resolve) {
				var s = document.createElement("script");
				s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
				s.onload = function () {
					if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose" }); resolve(window.mermaid); }
					else { _mermaidLoaded = null; resolve(null); }
				};
				s.onerror = function () { _mermaidLoaded = null; resolve(null); };
				document.head.appendChild(s);
			});
			return _mermaidLoaded;
		}

		function renderMermaidBlock(el, code) {
			loadMermaid().then(function (mermaid) {
				if (!mermaid) return;
				var id = "mmd-" + (++_mermaidSeq);
				try { mermaid.render(id, code).then(function (result) { _mountMermaid(el, result.svg); }).catch(function () {}); } catch (e) {}
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
				var b = document.createElement("button"); b.style.cssText = btnStyle; b.textContent = glyph; b.title = title;
				b.addEventListener("mouseenter", function () { b.style.background = "var(--dsw-alias-interactive-bg-hover)"; });
				b.addEventListener("mouseleave", function () { b.style.background = "none"; });
				return b;
			}
			var btnIn = mkBtn("\u2795", "Zoom In"), btnOut = mkBtn("\u2796", "Zoom Out"), btnReset = mkBtn("\u21BA", "Reset");
			toolbar.appendChild(btnIn); toolbar.appendChild(btnOut); toolbar.appendChild(btnReset);
			var viewport = document.createElement("div");
			viewport.style.cssText = "overflow:hidden;cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;min-height:80px;max-height:500px";
			var svgWrap = document.createElement("div");
			svgWrap.style.cssText = "transform-origin:center center;display:inline-block;padding:12px";
			svgWrap.innerHTML = svgHtml;
			viewport.appendChild(svgWrap); container.appendChild(toolbar); container.appendChild(viewport);
			var scale = 1, tx = 0, ty = 0;
			function apply() { svgWrap.style.transform = "translate(" + tx + "px," + ty + "px) scale(" + scale + ")"; }
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
		return module.exports;
	}
});

// ── dsao/settings ────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/settings",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var markersMod = require("dsao/markers");

		function TagsSetting() {
			var m = React.useState(markersMod.loadMarkers()), markers = m[0], setMarkers = m[1];
			var inp = React.useState(""), input = inp[0], setInput = inp[1];

			function syncMarkers() {
				setMarkers(markersMod.loadMarkers().slice());
				window.dispatchEvent(new Event("dsao:markers-changed"));
			}
			function add() {
				var t = input.trim(); if (!t) return;
				var current = markersMod.loadMarkers();
				if (!current.includes(t)) { current.push(t); markersMod.saveMarkers(current); }
				setInput(""); syncMarkers();
			}
			function remove(tag) {
				var current = markersMod.loadMarkers().filter(function (m) { return m !== tag; });
				markersMod.saveMarkers(current); syncMarkers();
			}

			var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
			var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
			var descStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px" };
			var chipStyle = { display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "6px", background: "var(--dsw-alias-interactive-bg-hover)", fontSize: "13px" };
			var xStyle = { cursor: "pointer", color: "var(--dsw-alias-label-tertiary)", border: "none", background: "none", padding: "0 2px", fontSize: "16px", lineHeight: "1" };
			var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "100px" };
			var addBtnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };

			var chipEls = [];
			for (var ci = 0; ci < markers.length; ci++) {
				chipEls.push(React.createElement("span", { key: markers[ci], style: chipStyle }, markers[ci], React.createElement("button", { style: xStyle, onClick: function (tag) { return function () { remove(tag); }; }(markers[ci]) }, "\u00D7")));
			}
			chipEls.push(React.createElement("input", { key: "_input", value: input, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") add(); }, placeholder: "Add marker...", style: inputStyle }));
			chipEls.push(React.createElement("button", { key: "_add", onClick: add, style: addBtnStyle }, "Add"));

			var leftCol = React.createElement("div", { style: { flexDirection: "column", flex: "1 1 auto", gap: "4px", display: "flex", minWidth: "0" } }, React.createElement("div", { style: titleStyle }, "Thinking Tag Markers"), React.createElement("div", { style: descStyle }, "Split reasoning text before these markers into collapsible blocks."));
			var rightCol = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", justifyContent: "flex-end", maxWidth: "280px" } }, chipEls);
			return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
		}

		exports.TagsSetting = TagsSetting;
		return module.exports;
	}
});

// ── dsh-assistant-optimization (main entry) ──────────────────────────────
window.__ModuleLoader__.load({
	id: "dsh-assistant-optimization",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var wrapper = require("dsao/wrapper");
		var mermaid = require("dsao/mermaid");
		var settings = require("dsao/settings");

		function apply(ctx) {
			var slots = ctx.get("slots");
			if (slots === undefined) return;

			// 1. Wrap official assistant-step renderer
			slots.inject("conversation.chat.node", function () {
				return slots.register(
					{ name: "conversation.chat.node", key: "assistant-step", priority: -1, locale: "conversation" },
					function (rawProps) {
						var official = wrapper.findOfficialRenderer(slots);
						var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
						return React.createElement(wrapper.WrappedAssistantStep, wrapperProps);
					}
				);
			});

			// 1b. Wrap official tool-call renderer to add file-edit diff badges
			slots.inject("conversation.chat.node", function () {
				return slots.register(
					{ name: "conversation.chat.node", key: "tool-call", priority: -1, locale: "conversation" },
					function (rawProps) {
						var official = wrapper.findToolRenderer(slots);
						var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
						return React.createElement(wrapper.WrappedToolCallTree, wrapperProps);
					}
				);
			});

			// 2. Settings page
			slots.inject("settings.general.item", function () {
				return slots.register(
					{ name: "settings.general.item", id: "thinking-tags", order: 30 },
					function () { return React.createElement(settings.TagsSetting); }
				);
			});

			// 3. Mermaid post-processor
			ctx.effect(function () { return mermaid.startMermaidObserver(); });
		}

		exports.apply = apply;
		return module.exports;
	}
});
