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

		// 与官方 diffCardModel 一致：已结算的调用只读 resultView，不回退 callView；
		// 出错的文件修改没有 diff card，即使 callView 仍描述了意图中的编辑。
		function diffView(block) {
			if (!block) return null;
			if ("kind" in block) {
				if (block.isError) return null;
				return block.resultView || null;
			}
			return block.callView || null;
		}

		function diffStats(block) {
			var view = diffView(block);
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
			var view = diffView(block);
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
			if (stats.added > 0 && stats.deleted > 0) {
				var sep = document.createElement("span");
				sep.textContent = "/";
				sep.style.cssText = "color:var(--dsw-alias-label-secondary,#666)";
				badge.appendChild(sep);
			}
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
		exports.createBadge = createBadge;
		exports.diffPath = diffPath;

		/** 从 slots 查找 tool.call.toolview 官方 priority 0 组件 */
		function findOfficialView(slots, toolName) {
			try {
				var entries = slots.entries("tool.call.toolview");
				if (!entries) return null;
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i];
					if (e.options.key === toolName && (e.options.priority || 0) === 0) return e.component;
				}
			} catch (err2) {}
			return null;
		}
		exports.findOfficialView = findOfficialView;

		/** 徽章的稳定标识：内容相同则无需触碰 DOM */
		function badgeSignature(stats) {
			var parts = [];
			if (stats.added > 0) parts.push("+" + stats.added);
			if (stats.deleted > 0) parts.push("-" + stats.deleted);
			return parts.join(" / ");
		}

		/**
		 * 幂等徽章注入。
		 *
		 * 清理必须先于 fileLink 查找：官方 ToolRow 只在 failureLine === null 时渲染
		 * fileLink 按钮，出错的行会把它换成 errorSummary span。流式期间注入的徽章是
		 * React 不认识的额外节点，调用转为出错后仍留在 DOM 里，若此时因找不到
		 * fileLink 提前返回，残留徽章就再没有人清除。
		 */
		function ensureBadge(container, block) {
			if (!container || !container.querySelectorAll) return;

			var stats = block ? diffStats(block) : null;
			var link = container.querySelector('[class*="fileLink"]');
			var olds = container.querySelectorAll("[data-dsao-diff-badge]");

			if (!stats || !link || !link.parentNode) {
				for (var k = 0; k < olds.length; k++) {
					if (olds[k].parentNode) olds[k].parentNode.removeChild(olds[k]);
				}
				return;
			}

			var next = link.nextElementSibling;
			if (next && next.getAttribute && next.getAttribute("data-dsao-diff-badge") === "" &&
				next.title === badgeSignature(stats) && olds.length === 1) {
				return;
			}

			for (var j = 0; j < olds.length; j++) {
				var o = olds[j];
				if (o.parentNode) o.parentNode.removeChild(o);
			}
			link.style.flex = "0 1 auto";
			var badge = createBadge(stats);
			link.parentNode.insertBefore(badge, link.nextSibling);
		}

		exports.ensureBadge = ensureBadge;
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

		/** 从 slots 查找 tool.call.toolview 官方 priority 0 组件 */
		function findOfficialView(slots, toolName) {
			try {
				var entries = slots.entries("tool.call.toolview");
				if (!entries) return null;
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i];
					if (e.options.key === toolName && (e.options.priority || 0) === 0) return e.component;
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

		function WrappedToolCallRow(props) {
			var official = props._officialRenderer;
			var ref = React.useRef(null);
			var block = props.block;
			React.useEffect(function () {
				if (!ref.current) return;
				if (toolDiff.ensureBadge) toolDiff.ensureBadge(ref.current, block);
				var obs = new MutationObserver(function () {
					if (ref.current && toolDiff.ensureBadge) toolDiff.ensureBadge(ref.current, block);
				});
				obs.observe(ref.current, { childList: true, subtree: true });
				return function () { obs.disconnect(); };
			}, [block, official]);
			if (!official) return null;
			return React.createElement("div", { ref: ref, className: "dsao-tool-view-row", style: { display: "contents" } },
				React.createElement(official, props._rawProps || {})
			);
		}

		exports.WrappedAssistantStep = WrappedAssistantStep;
		exports.WrappedToolCallRow = WrappedToolCallRow;
		exports.findOfficialRenderer = findOfficialRenderer;
		exports.findToolRenderer = findToolRenderer;
		exports.findOfficialView = findOfficialView;
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

// ── dsao/context ─────────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/context",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 私有参考按 broadest → most specific 排列：DSH 声明 more specific
		// instructions take precedence，且模型对靠后内容印象更强。
		//   1. 项目标识  workspace title + path
		//   2. 项目指令  项目级 AGENTS.md 的结构信号（标题 + 规则名）
		//   3. 会话摘要  DSH 自己的 compaction summary
		//   4. 近期对话  user/agent 文本尾巴
		// 全局 ~/.dsh/AGENTS.md 被刻意排除：它讲的是 agent 通用行为，不是本项目事实。

		var GLOBAL_PATHS = ["~/.dsh/AGENTS.md", "$DSH_HOME/AGENTS.md"];
		// 注意渲染器两种标题大小写不同（"Instructions from:" 与
		// "Additional instructions from:"），所以忽略大小写匹配。
		var SECTION_RE = /^(?:Additional\s+)?instructions\s+from:[ \t]*(.+?)[ \t]*$/i;
		var BOILERPLATE_RE = /^(?:These instructions apply to work under|The following workspace instructions may be relevant|This complete workspace instruction baseline|No workspace instructions are currently active|Workspace instruction budget|Instructions from:|Additional instructions from:)/i;

		var LIMITS = {
			instructionsTotal: 900,
			perFile: 420,
			signalsPerFile: 12,
			summary: 700,
			historyTotal: 1200,
			historyItem: 260,
			historyNodes: 6
		};

		function compact(text, max) {
			var seen = Object.create(null);
			var lines = [];
			var raw = String(text == null ? "" : text).split(/\r?\n/);
			for (var i = 0; i < raw.length; i++) {
				var line = raw[i].replace(/\s+/g, " ").trim();
				if (line === "") continue;
				var key = line.toLowerCase();
				if (seen[key] === true) continue;
				seen[key] = true;
				lines.push(line);
			}
			var out = lines.join("\n");
			return out.length > max ? out.slice(0, max) + "\u2026" : out;
		}

		function clip(text, max) {
			var out = String(text == null ? "" : text).trim();
			return out.length > max ? out.slice(0, max) + "\u2026" : out;
		}

		/** ContentBlock 用 type，AssistantBlock 用 kind；reasoning 跳过。 */
		function blockText(blocks) {
			if (!Array.isArray(blocks)) return "";
			var parts = [];
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (b === null || typeof b !== "object") continue;
				var tag = typeof b.type === "string" ? b.type : (typeof b.kind === "string" ? b.kind : "");
				if (tag === "text" && typeof b.text === "string") parts.push(b.text);
			}
			return parts.join("\n");
		}

		/** displayPath 写在指令正文里，所以切分是精确的而非猜测。 */
		function splitSections(body) {
			var lines = String(body == null ? "" : body).replace(/<\/?system-reminder>/g, "").split(/\r?\n/);
			var sections = [];
			var current = null;
			for (var i = 0; i < lines.length; i++) {
				var match = SECTION_RE.exec(lines[i]);
				if (match !== null) {
					current = { path: match[1], lines: [] };
					sections.push(current);
					continue;
				}
				if (current !== null) current.lines.push(lines[i]);
			}
			return sections;
		}

		function isGlobalPath(path) {
			for (var i = 0; i < GLOBAL_PATHS.length; i++) {
				if (path === GLOBAL_PATHS[i]) return true;
			}
			return false;
		}

		/** CLAUDE.md 实际与 AGENTS.md 重复，每个目录只保留一种声音。 */
		function isDuplicateDoc(path) {
			return /(?:^|[\\/])CLAUDE(?:\.local)?\.md$/i.test(path);
		}

		/** 只取标题与规则名：让 AGENTS.md 变长的是规则正文，增强器只需知道有哪些约束。 */
		function structureSignals(lines) {
			var out = [];
			for (var i = 0; i < lines.length && out.length < LIMITS.signalsPerFile; i++) {
				var line = lines[i].trim();
				if (line === "") continue;
				if (BOILERPLATE_RE.test(line)) continue;

				var heading = /^#{1,6}\s+(.+)$/.exec(line);
				if (heading !== null) {
					out.push(heading[1].replace(/\s+/g, " ").trim());
					continue;
				}

				var bullet = /^(?:[-*+]|\d+\.)\s+(.+)$/.exec(line);
				if (bullet === null) continue;
				var text = bullet[1]
					.replace(/`([^`]+)`/g, "$1")
					.replace(/\*\*([^*]+)\*\*/g, "$1")
					.replace(/\s+/g, " ")
					.trim();
				var named = /^([^:\uff1a\u2014]{2,60})\s*[:\uff1a\u2014]/.exec(text);
				var signal = named !== null ? named[1].trim() : text;
				if (signal === "") continue;
				out.push(signal);
			}
			return out;
		}

		function readInstructions(nodes) {
			var files = [];
			var seen = Object.create(null);

			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "context" || node.form !== "instructions") continue;

				var sections = splitSections(blockText(node.content));
				for (var s = 0; s < sections.length; s++) {
					var section = sections[s];
					if (isGlobalPath(section.path)) continue;
					if (isDuplicateDoc(section.path)) continue;
					var signals = structureSignals(section.lines);
					if (signals.length === 0) continue;
					if (seen[section.path] !== undefined) {
						files[seen[section.path]] = { path: section.path, signals: signals };
						continue;
					}
					seen[section.path] = files.length;
					files.push({ path: section.path, signals: signals });
				}
			}

			// 深度排序：项目根在前、子目录在后，最具体的落在最后。
			files.sort(function (a, b) {
				var da = a.path.split(/[\\/]/).length;
				var db = b.path.split(/[\\/]/).length;
				return da === db ? (a.path < b.path ? -1 : 1) : da - db;
			});

			var parts = [];
			for (var f = 0; f < files.length; f++) {
				parts.push(files[f].path + ": " + files[f].signals.join("; "));
			}
			return compact(parts.join("\n"), LIMITS.instructionsTotal);
		}

		/** 最近一条 compaction 摘要：DSH 自己写的对话浓缩。 */
		function readSummary(nodes) {
			for (var i = nodes.length - 1; i >= 0; i--) {
				var node = nodes[i];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "compaction") continue;
				if (typeof node.summary !== "string" || node.summary.trim() === "") continue;
				return clip(compact(node.summary, LIMITS.summary * 2), LIMITS.summary);
			}
			return "";
		}

		function readHistory(nodes) {
			var picked = [];
			var budget = LIMITS.historyTotal;
			for (var i = nodes.length - 1; i >= 0 && picked.length < LIMITS.historyNodes && budget > 0; i--) {
				var node = nodes[i];
				if (node === null || typeof node !== "object") continue;
				var role = "";
				var text = "";
				if (node.kind === "user") { role = "User"; text = blockText(node.content); }
				else if (node.kind === "assistant") { role = "Agent"; text = blockText(node.blocks); }
				else continue;
				var line = compact(text, LIMITS.historyItem);
				if (line === "") continue;
				var entry = role + ": " + line;
				budget -= entry.length;
				picked.push(entry);
			}
			picked.reverse();
			return picked.join("\n");
		}

		function readProject(session, sessions, workspaces) {
			var cwd = "";
			var sessionId = session !== null && typeof session === "object" ? session.sessionId : undefined;

			if (sessions !== null && typeof sessions === "object" && sessionId !== undefined) {
				var byId = sessions.byId;
				var row = byId !== null && typeof byId === "object" ? byId[sessionId] : undefined;
				if (row !== null && typeof row === "object" && typeof row.cwd === "string") cwd = row.cwd;
			}

			var title = "";
			if (workspaces !== null && typeof workspaces === "object" && Array.isArray(workspaces.items) && cwd !== "") {
				var target = cwd.replace(/[\\/]+$/, "").toLowerCase();
				for (var i = 0; i < workspaces.items.length; i++) {
					var item = workspaces.items[i];
					if (item === null || typeof item !== "object") continue;
					if (typeof item.path !== "string") continue;
					if (item.path.replace(/[\\/]+$/, "").toLowerCase() !== target) continue;
					if (typeof item.title === "string") title = item.title;
					break;
				}
			}

			if (title === "" && cwd !== "") {
				var segments = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
				title = segments.length === 0 ? "" : segments[segments.length - 1];
			}

			if (title === "" && cwd === "") return "";
			if (cwd === "") return title;
			return title === "" ? cwd : title + " (" + cwd + ")";
		}

		/** 返回自有 JSON：不保留任何 Host 对象、snapshot 或 node。 */
		function readContext(session, sessions, workspaces) {
			var empty = { project: "", instructions: "", summary: "", history: "" };
			if (session === null || typeof session !== "object") return empty;
			var nodes = Array.isArray(session.nodes) ? session.nodes : null;
			if (nodes === null) return empty;
			return {
				project: readProject(session, sessions, workspaces),
				instructions: readInstructions(nodes),
				summary: readSummary(nodes),
				history: readHistory(nodes)
			};
		}

		exports.readContext = readContext;
		exports.readInstructions = readInstructions;
		exports.readSummary = readSummary;
		exports.readHistory = readHistory;
		exports.readProject = readProject;
		exports.structureSignals = structureSignals;
		exports.splitSections = splitSections;
		exports.LIMITS = LIMITS;
		return module.exports;
	}
});

// ── dsao/prompt-enhance ──────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/prompt-enhance",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var contextMod = require("dsao/context");

		var ENDPOINT = "/api/dsao/prompt-enhance";
		var SVG_NS = "http://www.w3.org/2000/svg";
		var IDLE_COLOR = "var(--dsw-alias-label-secondary)";
		var IDLE_TITLE = "Prompt \u589e\u5f3a \u2014 \u7528\u5f53\u524d\u6a21\u578b\u6539\u5199\u8349\u7a3f";
		var BUSY_TITLE = "\u6b63\u5728\u589e\u5f3a\u2026";
		var BUSY_LABEL = "\u589e\u5f3a\u4e2d";
		var PATH_SPARKLE = "M6.5 1.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L2.5 5.5l2.9-1.1zM12 9l.65 1.65L14.3 11.3l-1.65.65L12 13.6l-.65-1.65L9.7 11.3l1.65-.65z";
		var PATH_CHECK = "M13.5 4.5l-6.4 7-4.1-3.6 1-1.1 3 2.6 5.4-5.9z";

		var CSS = [
			"@keyframes dsao-enh-spin{to{transform:rotate(360deg)}}",
			"@keyframes dsao-enh-breathe{0%,100%{opacity:.55}50%{opacity:1}}",
			'[data-dsao-enhance-btn][data-state="busy"]{animation:dsao-enh-breathe 1.4s ease-in-out infinite}',
			"[data-dsao-enhance-btn] .dsao-enh-spinner{transform-origin:8px 8px;animation:dsao-enh-spin .7s linear infinite}",
			"[data-dsao-enhance-btn] .dsao-enh-label{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;transition:max-width 180ms ease,opacity 180ms ease,margin-left 180ms ease;margin-left:0}",
			'[data-dsao-enhance-btn][data-state="busy"] .dsao-enh-label{max-width:52px;opacity:1;margin-left:4px}'
		].join("\n");

		function ensureStyles(doc) {
			if (doc.getElementById("dsao-enhance-css") !== null) return;
			var style = doc.createElement("style");
			style.id = "dsao-enhance-css";
			style.textContent = CSS;
			doc.head.appendChild(style);
		}

		function findPrimary(trailing) {
			var buttons = trailing.querySelectorAll('button[class*="primary"]');
			return buttons.length === 0 ? null : buttons[buttons.length - 1];
		}

		/** 幂等落位：先清理（容器被换掉时不留孤儿），位置不对才插入 */
		function ensurePlacement(trailing, btn) {
			if (!trailing || !btn) return;
			var primary = findPrimary(trailing);
			if (primary === null) {
				if (btn.parentNode) btn.parentNode.removeChild(btn);
				return;
			}
			if (btn.parentNode === trailing && btn.nextElementSibling === primary) return;
			trailing.insertBefore(btn, primary);
		}

		function requestEnhance(payload, signal) {
			return fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: signal
			}).then(function (res) {
				return res.json().then(function (body) {
					if (!res.ok || body === null || typeof body !== "object" || typeof body.text !== "string") {
						var reason = body && typeof body.error === "string" ? body.error : "HTTP " + res.status;
						throw new Error(reason);
					}
					return body.text;
				});
			});
		}

		/**
		 * 注册在 conversation.input.right（渲染在模型选择器之前），只输出一个隐藏
		 * 锚点，真正的按钮是插入到同一个 .trailing 容器里、发送按钮之前的原生
		 * DOM 节点——那里没有 slot，且按钮不归 React 所有，所以落位幂等、清理独立。
		 *
		 * 私有参考由 dsao/context 从 slot props 里的实时 snapshot 提取，只读文本
		 * 叶子，四段有序（项目标识 / 项目指令结构信号 / 会话摘要 / 近期对话）。
		 */
		function PromptEnhanceMount(props) {
			var markerRef = React.useRef(null);
			var apiRef = React.useRef(null);
			var stateRef = React.useRef({ blocked: true, busy: false });
			var draftRef = React.useRef("");
			var actionsRef = React.useRef(null);
			var contextRef = React.useRef({ project: "", instructions: "", summary: "", history: "" });

			var input = props.input || {};
			var draft = typeof input.draft === "string" ? input.draft : "";
			var phase = input.phase;
			var blocked = draft.trim() === "" || (phase !== undefined && phase !== "plain");
			draftRef.current = draft;
			actionsRef.current = props.inputActions || null;

			var identity = function (s) { return s; };
			var sessions = typeof props.useSessions === "function" ? props.useSessions(identity) : null;
			var workspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces(identity) : null;
			contextRef.current = contextMod.readContext(props.session, sessions, workspaces);

			React.useEffect(function () {
				var marker = markerRef.current;
				if (!marker || !marker.parentNode) return;
				var doc = marker.ownerDocument;
				var trailing = marker.parentNode;
				while (trailing && findPrimary(trailing) === null) trailing = trailing.parentNode;
				if (!trailing) return;

				ensureStyles(doc);

				var btn = doc.createElement("button");
				btn.type = "button";
				btn.setAttribute("data-dsao-enhance-btn", "");
				btn.setAttribute("data-state", "idle");
				btn.setAttribute("aria-label", "Prompt \u589e\u5f3a");
				btn.title = IDLE_TITLE;
				btn.style.cssText = "display:inline-flex;align-items:center;justify-content:center;height:24px;flex:none;padding:0 4px;margin:0;border:none;border-radius:6px;background:transparent;color:" + IDLE_COLOR + ";cursor:pointer;font:inherit;font-size:12px;line-height:1;transition:background 120ms,color 120ms;";

				var svg = doc.createElementNS(SVG_NS, "svg");
				svg.setAttribute("viewBox", "0 0 16 16");
				svg.setAttribute("width", "14");
				svg.setAttribute("height", "14");
				svg.setAttribute("aria-hidden", "true");
				svg.style.flex = "none";

				var icon = doc.createElementNS(SVG_NS, "path");
				icon.setAttribute("d", PATH_SPARKLE);
				icon.setAttribute("fill", "currentColor");
				svg.appendChild(icon);

				// 忙碌时显示的旋转进度环
				var spinner = doc.createElementNS(SVG_NS, "circle");
				spinner.setAttribute("class", "dsao-enh-spinner");
				spinner.setAttribute("cx", "8");
				spinner.setAttribute("cy", "8");
				spinner.setAttribute("r", "6");
				spinner.setAttribute("fill", "none");
				spinner.setAttribute("stroke", "currentColor");
				spinner.setAttribute("stroke-width", "2");
				spinner.setAttribute("stroke-linecap", "round");
				spinner.setAttribute("stroke-dasharray", "28");
				spinner.setAttribute("stroke-dashoffset", "20");
				spinner.style.display = "none";
				svg.appendChild(spinner);

				var label = doc.createElement("span");
				label.setAttribute("class", "dsao-enh-label");
				label.textContent = BUSY_LABEL;

				btn.appendChild(svg);
				btn.appendChild(label);

				var controller = null;
				var settleTimer = null;
				var clearSettle = function () {
					if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
				};

				var render = function () {
					var s = stateRef.current;
					var off = s.blocked || s.busy;
					btn.disabled = off;
					btn.style.cursor = off ? "default" : "pointer";
					btn.setAttribute("aria-busy", s.busy ? "true" : "false");
					if (s.busy) {
						btn.setAttribute("data-state", "busy");
						btn.title = BUSY_TITLE;
						btn.style.opacity = "1";
						btn.style.color = "var(--dsw-alias-brand-primary)";
						btn.style.background = "var(--dsw-alias-bg-layer-2)";
						icon.style.display = "none";
						spinner.style.display = "";
						return;
					}
					btn.setAttribute("data-state", "idle");
					btn.style.opacity = s.blocked ? "0.4" : "1";
					btn.style.background = "transparent";
					spinner.style.display = "none";
					icon.style.display = "";
				};

				var settle = function (ok, why) {
					clearSettle();
					icon.setAttribute("d", ok ? PATH_CHECK : PATH_SPARKLE);
					btn.style.color = ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
					btn.title = ok ? IDLE_TITLE : "Prompt \u589e\u5f3a\u5931\u8d25\uff1a" + why;
					settleTimer = setTimeout(function () {
						icon.setAttribute("d", PATH_SPARKLE);
						btn.style.color = IDLE_COLOR;
						settleTimer = null;
					}, ok ? 1400 : 2600);
				};

				btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
				btn.addEventListener("mouseenter", function () {
					if (btn.disabled) return;
					btn.style.background = "var(--dsw-alias-bg-layer-2)";
					btn.style.color = "var(--dsw-alias-label-primary)";
				});
				btn.addEventListener("mouseleave", function () {
					if (stateRef.current.busy) return;
					btn.style.background = "transparent";
					if (settleTimer === null) btn.style.color = IDLE_COLOR;
				});
				btn.addEventListener("click", function () {
					if (stateRef.current.busy) return;
					var text = draftRef.current;
					var actions = actionsRef.current;
					if (text.trim() === "" || actions === null) return;
					clearSettle();
					icon.setAttribute("d", PATH_SPARKLE);
					stateRef.current.busy = true;
					render();
					controller = new AbortController();
					var ref = contextRef.current;
					requestEnhance({
						text: text,
						project: ref.project,
						instructions: ref.instructions,
						summary: ref.summary,
						history: ref.history
					}, controller.signal).then(function (next) {
						if (next.trim() !== "") actions.setDraft(next);
						settle(true, "");
					}).catch(function (err) {
						settle(false, err && err.message ? err.message : String(err));
					}).then(function () {
						stateRef.current.busy = false;
						controller = null;
						render();
					});
				});

				apiRef.current = { render: render };
				render();
				ensurePlacement(trailing, btn);

				var obs = new MutationObserver(function () { ensurePlacement(trailing, btn); });
				obs.observe(trailing, { childList: true });

				return function () {
					obs.disconnect();
					clearSettle();
					if (controller !== null) controller.abort();
					if (btn.parentNode) btn.parentNode.removeChild(btn);
					apiRef.current = null;
				};
			}, []);

			React.useEffect(function () {
				stateRef.current.blocked = blocked;
				if (apiRef.current !== null) apiRef.current.render();
			}, [blocked]);

			return React.createElement("span", {
				ref: markerRef,
				"data-dsao-enhance-anchor": "",
				style: { display: "none" }
			});
		}

		exports.PromptEnhanceMount = PromptEnhanceMount;
		exports.ensurePlacement = ensurePlacement;
		exports.findPrimary = findPrimary;
		exports.ENDPOINT = ENDPOINT;
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
		var promptEnhance = require("dsao/prompt-enhance");

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

			// 1b. Wrap official tool-call *view* (write/edit) at leaf-level
			//     tool.call.toolview slot to add file-edit diff badges. Leaf-tier
			//     shadow: does NOT declare children so it never needs renderSlot.
			var diffKeys = ["write", "edit"];
			for (var di = 0; di < diffKeys.length; di++) {
				(function (key) {
					slots.inject("tool.call.toolview", function () {
						return slots.register(
							{ name: "tool.call.toolview", key: key, priority: -1, locale: "conversation" },
							function (rawProps) {
								var official = wrapper.findOfficialView(slots, key);
								var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
								return React.createElement(wrapper.WrappedToolCallRow, wrapperProps);
							}
						);
					});
				})(diffKeys[di]);
			}

			// 2. Settings page
			slots.inject("settings.general.item", function () {
				return slots.register(
					{ name: "settings.general.item", id: "thinking-tags", order: 30 },
					function () { return React.createElement(settings.TagsSetting); }
				);
			});

			// 3. Prompt enhance button in the composer tool row
			slots.inject("conversation.input.right", function () {
				return slots.register(
					{ name: "conversation.input.right", id: "dsao-prompt-enhance", order: 100, locale: "conversation" },
					promptEnhance.PromptEnhanceMount
				);
			});

			// 4. Mermaid post-processor
			ctx.effect(function () { return mermaid.startMermaidObserver(); });
		}

		exports.apply = apply;
		return module.exports;
	}
});
