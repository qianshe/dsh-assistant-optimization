// dsh-assistant-optimization — Client bundle
//
// Uses window.__ModuleLoader__.load() multi-registration to split concerns:
//   dsao/markers    — localStorage marker management
//   dsao/text-split — text splitting logic
//   dsao/tool-diff  — file-tool diff line count badges
//   dsao/tool-group — consecutive tool-call grouping + collapse
//   dsao/wrapper    — assistant-step + tool-call wrappers
//   dsao/mermaid    — mermaid DOM observer + SVG rendering
//   dsao/resume-gate — ▶ 门控纯函数（FR-1 谓词）
//   dsao/resume-continuity — 续跑 marker 行的呈现（空泡→继续提示）
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

// ── dsao/tool-group ──────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/tool-group",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var GROUPABLE_TOOLS = {
			"bash": true, "pwsh": true,
			"read": true, "write": true, "edit": true, "str_replace_editor": true,
			"grep": true, "glob": true, "context_search": true,
			"web_search": true, "web_fetch": true,
			"describe_image": true, "read_image": true,
			"skill_search": true, "skill_load": true,
			"work_note": true, "tu": true
		};
		// 会话切换判定阈值：React 换会话时整列 keyed flowItem 批替换。正常操作
		// （单行更新、分页加载更多）最多移除 1-2 行，远低于此值。
		var CONVERGE_REMOVAL_THRESHOLD = 8;

		var GROUPABLE_PREFIXES = ["mcp__", "ssh_"];

		function toolNameOf(flowItem) {
			if (!flowItem || !flowItem.querySelector) return "";
			var row = flowItem.querySelector("[data-tool]");
			if (row) {
				var name = row.getAttribute("data-tool") || "";
				if (name) return name;
			}
			var sample = flowItem.querySelector("[data-sample]");
			if (sample) {
				var sampleName = sample.getAttribute("data-sample") || "";
				if (sampleName) return sampleName;
			}
			return "";
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

		var CSS = [
			"[data-dsao-tg-collapsed]{display:none!important}",
			".dsao-tg-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:0;min-width:0;transition:color 120ms}",
			".dsao-tg-headerIcon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);margin-right:6px;position:relative}",
			".dsao-tg-headerCount{font-weight:400;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-secondary);flex:auto;font-size:14px;line-height:24px;overflow:hidden}",
			".dsao-tg-headerSpacer{flex:auto}",
			".dsao-tg-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}",
			".dsao-tg-chevron{display:inline-flex;transition:transform 180ms ease;color:var(--dsw-alias-label-secondary)}",
			'.dsao-tg-header[data-dsao-tg-state="expanded"] .dsao-tg-chevron{transform:rotate(90deg)}',
			'.dsao-tg-header[data-dsao-tg-state="collapsed"] .dsao-tg-chevron{transform:rotate(0deg)}',
			".dsao-tg-header:hover .dsao-tg-headerCount{color:var(--dsw-alias-label-primary)}",
			"[data-dsao-tg-pos]{padding-left:20px}"
		].join("");

		var _styleInjected = false;

		function ensureStyles() {
			if (_styleInjected) return;
			if (typeof document === "undefined") return;
			if (document.getElementById("dsao-tool-group-css")) { _styleInjected = true; return; }
			var style = document.createElement("style");
			style.id = "dsao-tool-group-css";
			style.textContent = CSS;
			document.head.appendChild(style);
			_styleInjected = true;
		}

		var TOOL_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M12.3368 1.53569L11.931 4.43172H14.8086V5.79673H11.7404L11.1962 9.67859H14.2839V11.0436H11.0056L10.4994 14.6529L9.14873 14.4643L9.62731 11.0436H5.75876L5.25252 14.6529L3.90186 14.4643L4.38043 11.0436H1.69141V9.67859H4.57104L5.11417 5.79673H2.21609V4.43172H5.30581L5.73724 1.34713L7.08995 1.53569L6.68414 4.43172H10.5527L10.9841 1.34713L12.3368 1.53569ZM5.94937 9.67859H9.81791L10.361 5.79673H6.49353L5.94937 9.67859Z" fill="currentColor"/></svg>';
		var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/></svg>';
		var CHEVRON = "\u276F";

		// A chat flow item whose content has not rendered yet (empty text).
		// Treated as if not present: it neither splits a group nor counts as
		// "content after" one. Only real flow items carry data-chat-flow-key.
		function isTransparentNode(el) {
			if (!el || !el.getAttribute) return false;
			if (el.getAttribute("data-chat-flow-key") === null) return false;
			if (el.textContent && el.textContent.trim().length > 0) return false;
			return true;
		}

		function isTurnFoldHeader(el) {
			return !!(el && el.getAttribute && el.getAttribute("data-dsao-tf-header") !== null);
		}

		function areConsecutive(a, b) {
			if (!a || !b) return false;
			if (a.parentNode !== b.parentNode) return false;
			if (a.nextElementSibling === b) return true;
			var sibling = a.nextElementSibling;
			while (sibling && sibling !== b) {
				if (!isTransparentNode(sibling) && !isTurnFoldHeader(sibling)) return false;
				sibling = sibling.nextElementSibling;
			}
			return sibling === b;
		}

		function detectGroups(root) {
			if (!root || !root.querySelectorAll) return [];
			var items = root.querySelectorAll("[data-chat-flow-kind=\"tool-call\"]");
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

		function uniqueToolNames(group) {
			var seen = {};
			var names = [];
			for (var i = 0; i < group.length; i++) {
				var name = toolNameOf(group[i]);
				if (name && !seen[name]) { seen[name] = true; names.push(name); }
			}
			return names;
		}

		function summaryText(group) {
			var names = uniqueToolNames(group);
			return names.join("\u3001") + " \u00B7 " + group.length + " \u4E2A\u5DE5\u5177";
		}

		function createHeader(group) {
			var header = document.createElement("div");
			header.className = "dsao-tg-header";
			header.setAttribute("data-dsao-tg-header", "");
			header.setAttribute("data-dsao-tg-state", "collapsed");
			header.setAttribute("role", "button");
			header.setAttribute("tabindex", "0");
			header.setAttribute("aria-expanded", "false");
			var icon = document.createElement("span");
			icon.className = "dsao-tg-headerIcon";
			icon.innerHTML = TOOL_ICON_SVG;
			var summary = document.createElement("span");
			summary.className = "dsao-tg-headerCount";
			summary.setAttribute("data-dsao-tg-summary", "");
			summary.textContent = summaryText(group);
			var spacer = document.createElement("span");
			spacer.className = "dsao-tg-headerSpacer";
			var toggle = document.createElement("span");
			toggle.className = "dsao-tg-toggle";
			var chevron = document.createElement("span");
			chevron.className = "dsao-tg-chevron";
			chevron.innerHTML = CHEVRON_SVG;
			toggle.appendChild(chevron);
			header.appendChild(icon);
			header.appendChild(summary);
			header.appendChild(spacer);
			header.appendChild(toggle);
			return header;
		}

		function applyCollapse(header, group) {
			header.setAttribute("data-dsao-tg-state", "collapsed");
			header.setAttribute("aria-expanded", "false");
			for (var i = 0; i < group.length; i++) {
				group[i].setAttribute("data-dsao-tg-collapsed", "");
			}
			var summary = header.querySelector("[data-dsao-tg-summary]");
			if (summary) summary.textContent = summaryText(group);
		}

		function applyExpand(header, group) {
			header.setAttribute("data-dsao-tg-state", "expanded");
			header.setAttribute("aria-expanded", "true");
			for (var i = 0; i < group.length; i++) {
				group[i].removeAttribute("data-dsao-tg-collapsed");
			}
		}

		function toggleGroup(header, group) {
			var state = header.getAttribute("data-dsao-tg-state");
			if (state === "collapsed") applyExpand(header, group);
			else applyCollapse(header, group);
		}

		function collectGroupFromHeader(header) {
			var items = [];
			var node = header.nextElementSibling;
			while (node) {
				if (isTransparentNode(node) || isTurnFoldHeader(node)) { node = node.nextElementSibling; continue; }
				if (!node.getAttribute || node.getAttribute("data-chat-flow-kind") !== "tool-call") break;
				if (!isGroupableTool(node)) break;
				items.push(node);
				node = node.nextElementSibling;
			}
			return items;
		}

		function markGroupItem(el, pos) {
			el.setAttribute("data-dsao-tg-pos", pos);
		}

		function unmarkGroupItem(el) {
			el.removeAttribute("data-dsao-tg-pos");
			el.removeAttribute("data-dsao-tg-collapsed");
		}

		function applyGroup(group) {
			var first = group[0];
			var existingHeader = first.previousElementSibling;
			while (existingHeader) {
				if (existingHeader.getAttribute && existingHeader.getAttribute("data-dsao-tg-header") !== null) break;
				if (existingHeader.getAttribute && existingHeader.getAttribute("data-chat-flow-key") !== null) { existingHeader = null; break; }
				existingHeader = existingHeader.previousElementSibling;
			}
			var headerExists = !!(existingHeader && existingHeader.getAttribute &&
				existingHeader.getAttribute("data-dsao-tg-header") === "");
			if (headerExists) {
				var oldSize = parseInt(existingHeader.getAttribute("data-dsao-tg-size") || "0", 10);
				if (oldSize !== group.length) {
					existingHeader.parentNode.removeChild(existingHeader);
					headerExists = false;
				}
			}
			for (var i = 0; i < group.length; i++) {
				var pos = i === 0 ? "first" : (i === group.length - 1 ? "last" : "middle");
				markGroupItem(group[i], pos);
			}
			if (!headerExists) {
				var header = createHeader(group);
				header.setAttribute("data-dsao-tg-size", String(group.length));
				first.parentNode.insertBefore(header, first);
				header.addEventListener("click", function (e) {
					e.stopPropagation();
					header.setAttribute("data-dsao-tg-user", "");
					var liveGroup = collectGroupFromHeader(header);
					if (liveGroup.length >= 2) toggleGroup(header, liveGroup);
				});
				header.addEventListener("keydown", function (e) {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault(); e.stopPropagation();
						header.setAttribute("data-dsao-tg-user", "");
						var liveGroup = collectGroupFromHeader(header);
						if (liveGroup.length >= 2) toggleGroup(header, liveGroup);
					}
				});
				// See groupShouldExpand: the latest group stays expanded for the
				// whole turn until real flow content arrives after it; on a page
				// load (no active turn) every group collapses.
				var shouldExpand = groupShouldExpand(group);
				if (shouldExpand) {
					applyExpand(header, group);
				} else {
					applyCollapse(header, group);
				}
			} else {
				existingHeader.setAttribute("data-dsao-tg-size", String(group.length));
				var state = existingHeader.getAttribute("data-dsao-tg-state");
				if (state === "collapsed") {
					for (var j = 0; j < group.length; j++) group[j].setAttribute("data-dsao-tg-collapsed", "");
				}
			}
		}

		function isItemRunning(item) {
			if (!item || !item.querySelectorAll) return false;
			var stateEls = item.querySelectorAll("[data-state]");
			for (var i = 0; i < stateEls.length; i++) {
				if (stateEls[i].getAttribute("data-state") === "running") return true;
			}
			return false;
		}

		// CSS-module class of the official turn-status row ("Deep diving…");
		// the hash prefix changes between builds, the suffix is stable.
		var TURN_STATUS_SELECTOR = '[class*="_turnStatus"]';

		// True while a turn is actively in flight. The official chat view keeps
		// the turn-status row mounted below all flow items for the whole turn,
		// so its presence is the reliable "turn not finished" signal; the
		// data-state="running" probe (tool/think rows) covers the same window
		// as a fallback. On a page load / settled conversation the status row
		// is absent and no row is running, so this returns false and every
		// group collapses by default.
		function isTurnActive() {
			if (typeof document === "undefined" || !document.querySelector) return false;
			if (document.querySelector('[data-state="running"]')) return true;
			return document.querySelector(TURN_STATUS_SELECTOR) !== null;
		}

		// Mutation node that can change group state: any real flow item (any
		// kind — text, think, tool, user), our group header, or the
		// turn-status chrome row (its mount/unmount marks turn start/end).
		function isRelevantNode(node) {
			if (!node || node.nodeType !== 1) return false;
			if (node.getAttribute) {
				if (node.getAttribute("data-chat-flow-key") !== null) return true;
				if (node.getAttribute("data-dsao-tg-header") === "") return true;
			}
			if (typeof node.matches === "function" && node.matches(TURN_STATUS_SELECTOR)) return true;
			return false;
		}

		// Only real chat flow nodes (the per-node seats) carry data-chat-flow-key;
		// everything else rendered in the column (turn-status row, pending
		// steering bubbles, load-older button) is chrome, not content.
		function isFlowItem(el) {
			return !!(el && el.getAttribute && el.getAttribute("data-chat-flow-key") !== null);
		}

		function isGroupRunning(group) {
			for (var i = 0; i < group.length; i++) {
				if (isItemRunning(group[i])) return true;
			}
			return false;
		}

		function hasContentAfterGroup(group) {
			var last = group[group.length - 1];
			var next = nextSignificantSibling(last);
			if (!next) return false;
			if (next.getAttribute && next.getAttribute("data-chat-flow-kind") === "tool-call" && isGroupableTool(next)) return false;
			return true;
		}

		// Resting state for a group: expanded while any of its tools is running,
		// or while the turn is still active and no real flow content follows the
		// group yet (the "Deep diving…" status row does not count as content);
		// collapsed once real content arrives after it, or on a settled load.
		function groupShouldExpand(group) {
			return isGroupRunning(group) || (isTurnActive() && !hasContentAfterGroup(group));
		}

		function manageLatestGroup(groups) {
			if (!groups || groups.length === 0) return;
			var latestGroup = groups[groups.length - 1];
			var first = latestGroup[0];
			var header = first.previousElementSibling;
			if (!header || !header.getAttribute || header.getAttribute("data-dsao-tg-header") !== "") return;
			if (header.getAttribute("data-dsao-tg-user") === "") return;
			var state = header.getAttribute("data-dsao-tg-state");
			if (groupShouldExpand(latestGroup)) {
				if (state === "collapsed") applyExpand(header, latestGroup);
			} else if (state !== "collapsed") {
				applyCollapse(header, latestGroup);
			}
		}

		function nextSignificantSibling(el) {
			var sibling = el.nextElementSibling;
			while (sibling) {
				if (isTurnFoldHeader(sibling)) { sibling = sibling.nextElementSibling; continue; }
				if (!isFlowItem(sibling)) { sibling = sibling.nextElementSibling; continue; }
				if (isTransparentNode(sibling)) { sibling = sibling.nextElementSibling; continue; }
				return sibling;
			}
			return null;
		}

		function prevSignificantSibling(el) {
			var sibling = el.previousElementSibling;
			while (sibling) {
				if (isTransparentNode(sibling) || isTurnFoldHeader(sibling)) { sibling = sibling.previousElementSibling; continue; }
				return sibling;
			}
			return null;
		}

		function cleanupStaleMarkers(root) {
			if (!root) return;
			var headers = root.querySelectorAll("[data-dsao-tg-header]");
			for (var h = 0; h < headers.length; h++) {
				var header = headers[h];
				var count = 0;
				var node = header;
				while (true) {
					node = nextSignificantSibling(node);
					if (!node || !node.getAttribute || node.getAttribute("data-chat-flow-kind") !== "tool-call") break;
					count++;
				}
				if (count < 2) {
				if (header.parentNode) header.parentNode.removeChild(header);
			}
			}
			var marked = root.querySelectorAll("[data-dsao-tg-pos]");
			for (var m = 0; m < marked.length; m++) {
				var el = marked[m];
				var hasHeader = false;
				var prev = el;
				while (true) {
					prev = prevSignificantSibling(prev);
					if (!prev) break;
					if (prev.getAttribute && prev.getAttribute("data-dsao-tg-header") === "") { hasHeader = true; break; }
					if (prev.getAttribute && prev.getAttribute("data-chat-flow-kind") !== "tool-call") break;
				}
				if (!hasHeader) unmarkGroupItem(el);
			}
		}

		// ── Incremental scan machinery ──────────────────────────────────────
		// The scan is split into cost tiers chosen from what the mutation
		// batch actually changed. Steady-state streaming — one flow item
		// appended at the tail, or a data-state flip — must not re-run the
		// O(body) detect+apply over every group; only invalidation events
		// (removals, batch adds, conversation switches, turn-status mount)
		// do a full scan. This is the "compute once on open, then manage only
		// the latest group in real time" model, with a full-scan fallback for
		// anything that is not a pure single-node tail append.
		var scanStats = { full: 0, tail: 0, attr: 0, ignored: 0, converged: 0 };
		var lastLatest = null; // latest group (node array) after the last scan
		// Mutation batches that arrive inside one debounce window are merged
		// here (a later batch must not replace an earlier tail add): full wins
		// over tail, two distinct tail adds in one window collapse to full,
		// and attr adds nothing (the scan that runs re-evaluates state).
		var pending = null; // null | { full: bool, item: el|null }

		// The previous groupable tool-call before el, skipping transparent
		// nodes; null when a non-transparent non-groupable node (or the start
		// of the column) intervenes. Walking back this way yields the maximal
		// consecutive groupable run ending at the new item.
		function prevGroupableTool(el) {
			var sibling = el.previousElementSibling;
			while (sibling) {
				if (isTransparentNode(sibling) || isTurnFoldHeader(sibling)) { sibling = sibling.previousElementSibling; continue; }
				if (sibling.getAttribute &&
				    sibling.getAttribute("data-chat-flow-kind") === "tool-call" &&
				    isGroupableTool(sibling)) return sibling;
				return null;
			}
			return null;
		}

		// The maximal consecutive groupable run ending at endItem (walks back).
		function computeTailRun(endItem) {
			var run = [endItem];
			var cur = endItem;
			while (true) {
				var prev = prevGroupableTool(cur);
				if (!prev) break;
				run.unshift(prev);
				cur = prev;
			}
			return run;
		}

		// The full O(body) pipeline: clean stale markers, re-detect every
		// group, apply them, and manage the latest. Used on invalidation and
		// for the initial load.
		function fullPipeline(root) {
			if (!root || !root.querySelectorAll) return;
			ensureStyles();
			cleanupStaleMarkers(root);
			var groups = detectGroups(root);
			for (var i = 0; i < groups.length; i++) {
				applyGroup(groups[i]);
			}
			manageLatestGroup(groups);
			lastLatest = groups.length ? groups[groups.length - 1] : null;
			// 官方 turn 折叠同步：dsh 0.1.2+ 原生折叠对 process member 设
			// hidden="until-found"（React 管理），但我们的组头是列的外来节点，
			// 官方不折叠它 —— 折叠后组头会漂在 turn 折叠区外。这里让组头跟随
			// 同组首个官方成员的 hidden 状态（折叠随官方走）。
			syncHeadersToTurnFolds(groups);
		}

		// ── 官方 turn 折叠同步 ─────────────────────────────────────────────
		// 对每个组：读第一个成员的 hidden 属性；有 hidden 就给组头也设
		// hidden（DOM 隐藏），没有就移除。幂等：直接对齐，不做 diff。
		// 展开时官方移除 hidden，attr 扫描（hidden 翻转触发）自动恢复。
		function syncHeadersToTurnFolds(groups) {
			if (!groups) {
				var all = document.querySelectorAll("[data-dsao-tg-header]");
				for (var i = 0; i < all.length; i++) syncOneHeader(all[i]);
				return;
			}
			for (var j = 0; j < groups.length; j++) {
				var header = headerOfGroup(groups[j]);
				if (header) syncOneHeader(header);
			}
		}

		// 组头元素：applyGroup 把头插在组首项之前。从组首项向前找头。
		function headerOfGroup(group) {
			if (!group || !group.length) return null;
			var sibling = group[0].previousElementSibling;
			while (sibling) {
				if (sibling.getAttribute && sibling.getAttribute("data-dsao-tg-header") !== null) return sibling;
				if (isTransparentNode(sibling)) { sibling = sibling.previousElementSibling; continue; }
				return null;
			}
			return null;
		}

		function syncOneHeader(header) {
			if (!header || !header.parentNode) return;
			// 找组头的第一个组员（头后面的第一个 tool-call flowItem）
			var member = header.nextElementSibling;
			while (member) {
				if (member.getAttribute && member.getAttribute("data-chat-flow-kind") === "tool-call") break;
				if (isTransparentNode(member)) { member = member.nextElementSibling; continue; }
				break;
			}
			if (!member) return;
			var folded = member.hasAttribute("hidden");
			if (folded) header.setAttribute("hidden", "until-found");
			else header.removeAttribute("hidden");
		}

		// Public full scan (initial load / manual). Backward-compatible shape.
		function scanToolGroups(root) {
			fullPipeline(root);
		}

		function performFullScan() {
			fullPipeline(document.body);
			scanStats.full++;
		}

		// One flow item was appended at the tail: re-detect only the tail run
		// (O(run)) instead of the whole body.
		function performTailScan(item) {
			if (!item || !item.parentNode) { performFullScan(); return; }
			ensureStyles();
			if (item.getAttribute("data-chat-flow-key") !== null &&
			    item.getAttribute("data-chat-flow-kind") === "tool-call" &&
			    isGroupableTool(item)) {
				var run = computeTailRun(item);
				if (run.length >= 2) {
					applyGroup(run);
					lastLatest = run;
					manageLatestGroup([run]);
				}
				// run.length < 2: a new singleton — the latest group is unchanged.
			} else {
				// A non-groupable flow item at the tail breaks the run and is
				// now "content after" the last group → re-evaluate that group.
				if (lastLatest && lastLatest.length) manageLatestGroup([lastLatest]);
			}
			scanStats.tail++;
		}

		// Only a data-state flipped: group membership is unchanged, so just
		// re-evaluate the latest group's expand/collapse (O(latest group)).
		function performAttrScan() {
			if (lastLatest && lastLatest.length) manageLatestGroup([lastLatest]);
			// 官方折叠的 hidden 翻转可发生在任意 turn（点开旧折叠头），
			// 每次属性扫描都同步全部组头的 hidden 跟随状态。
			syncHeadersToTurnFolds(null);
			scanStats.attr++;
		}

		// Classify a mutation batch into a scan tier.
		// Returns { mode: "full" | "tail" | "attr" | "ignore", item? }.
		// Our own header writes are ignored (only applyGroup/cleanupStaleMarkers
		// touch data-dsao-tg-header), so a scan never re-triggers itself.
		function classifyMutations(mutations) {
			var hasRemoval = false;
			var hasChrome = false; // the turn-status row was added
			var addedFlow = [];
			var attrState = false;
			var removedFlowCount = 0;

			function isHeader(node) {
				return !!(node && node.nodeType === 1 && node.getAttribute &&
					node.getAttribute("data-dsao-tg-header") === "");
			}
			function collectFlow(node) {
				if (!node || node.nodeType !== 1) return;
				if (node.getAttribute && node.getAttribute("data-chat-flow-key") !== null) addedFlow.push(node);
				if (node.querySelectorAll) {
					var fs = node.querySelectorAll("[data-chat-flow-key]");
					for (var i = 0; i < fs.length; i++) addedFlow.push(fs[i]);
				}
			}
			function hasTurnStatus(node) {
				if (!node || node.nodeType !== 1) return false;
				if (typeof node.matches === "function" && node.matches(TURN_STATUS_SELECTOR)) return true;
				return !!(node.querySelector && node.querySelector(TURN_STATUS_SELECTOR));
			}

			for (var i = 0; i < mutations.length; i++) {
				var m = mutations[i];
				if (m.type === "attributes") {
					if (m.attributeName === "data-state" || m.attributeName === "hidden") attrState = true;
					continue;
				}
				var removed = m.removedNodes;
				if (removed) {
					for (var k = 0; k < removed.length; k++) {
						var rn = removed[k];
						if (rn.nodeType !== 1) continue;
						if (isHeader(rn)) continue; // our own cleanup — ignore
					if (isRelevantNode(rn) || (rn.querySelector && rn.querySelector("[data-chat-flow-key]"))) {
						hasRemoval = true;
						removedFlowCount++;
					}
					}
				}
				var added = m.addedNodes;
				if (added) {
					for (var j = 0; j < added.length; j++) {
						var node = added[j];
						if (!node || node.nodeType !== 1) continue;
						if (isHeader(node)) continue; // our own write — ignore
						if (hasTurnStatus(node)) { hasChrome = true; continue; }
						collectFlow(node);
					}
				}
			}

			var uniq = [];
			for (var d = 0; d < addedFlow.length; d++) {
				if (uniq.indexOf(addedFlow[d]) < 0) uniq.push(addedFlow[d]);
			}
			addedFlow = uniq;

			// 会话切换判定：一批移除里 flowItem 数 >= CONVERGE_REMOVAL_THRESHOLD，
			// 说明 React 把整列 keyed 子元素换掉了（不是常规单行更新）。此时旧注入头
			// （React 不管理的外来节点）会原地留存并漂进新会话的列，必须走 converge
			// （拆全部注入 + 重建）而不是普通 full scan。
			if (removedFlowCount >= CONVERGE_REMOVAL_THRESHOLD) return { mode: "converge" };
			if (hasRemoval || hasChrome) return { mode: "full" };
			if (addedFlow.length === 0) return { mode: attrState ? "attr" : "ignore" };
			if (addedFlow.length > 1) return { mode: "full" };
			// Exactly one added flow item: incremental only if it sits at the
			// tail of the same flow column as the existing groups.
			var item = addedFlow[0];
			if (nextSignificantSibling(item) !== null) return { mode: "full" };
			if (lastLatest && lastLatest.length && item.parentNode !== lastLatest[0].parentNode) return { mode: "full" };
			return { mode: "tail", item: item };
		}

		// ── Session-switch reset ─────────────────────────────────────────────

		/**
		 * Remove every tool-group injection from the live DOM and drop the
		 * module-level state that still references the previous session's nodes.
		 *
		 * Injected headers are foreign nodes React never owns: on a conversation
		 * switch React replaces only its keyed children, so our headers survive in
		 * place and pile into the new session's column (turn numbers/positions then
		 * read as garbage). The turn-fold mount calls this when the session changes,
		 * then re-runs scanToolGroups to rebuild headers for the current DOM.
		 */
		function resetToolGroups() {
			// 本模块（lib 版）的滞后状态只有 pending/lastLatest——与 src 版
			// （多 pendingSignal/confirmTimer）已分叉，此处只允许引用本作用域
			// 真实存在的变量，否则 ReferenceError 会炸掉调用方的整个收敛流程。
			pending = null;
			lastLatest = null;
			if (typeof document === "undefined") return;
			var headers = document.querySelectorAll("[data-dsao-tg-header]");
			for (var i = 0; i < headers.length; i++) {
				if (headers[i].parentNode) headers[i].parentNode.removeChild(headers[i]);
			}
			var marked = document.querySelectorAll("[data-dsao-tg-pos],[data-dsao-tg-collapsed]");
			for (var j = 0; j < marked.length; j++) {
				marked[j].removeAttribute("data-dsao-tg-pos");
				marked[j].removeAttribute("data-dsao-tg-collapsed");
			}
		}

		function startToolGroupObserver() {
			if (typeof document === "undefined") return function () {};
			ensureStyles();
			var scanTimer = null;
			var onMutations = function (mutations) {
				var c = classifyMutations(mutations);
				if (c.mode === "ignore") { scanStats.ignored++; return; }
				// 会话切换：先拆掉全部注入（含上一会话残留的头），再全量重建。
				// 拆与建同帧完成（不防抖），避免新会话旧头闪现。
				if (c.mode === "converge") {
					resetToolGroups();
					performFullScan();
					scanStats.converged++;
					if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
					pending = null;
					return;
				}
				if (!pending) pending = { full: false, item: null };
				if (c.mode === "full") {
					pending.full = true;
				} else if (c.mode === "tail") {
					// Two distinct tail adds inside one window = a batch → full.
					if (pending.item !== null) pending.full = true;
					else pending.item = c.item;
				}
				// c.mode === "attr": nothing to accumulate; the scan that runs
				// re-evaluates the latest group's state.
				if (scanTimer) clearTimeout(scanTimer);
				scanTimer = setTimeout(function () {
					scanTimer = null;
					var done = pending;
					pending = null;
					if (!done) return;
					if (done.full) performFullScan();
					else if (done.item) performTailScan(done.item);
					else performAttrScan();
				}, 80);
			};
			performFullScan(); // initial load: one full scan, caches lastLatest
			var obs = new MutationObserver(onMutations);
			obs.observe(document.body, {
				childList: true, subtree: true,
				attributes: true,
				// hidden：dsh 0.1.2+ 官方 turn 折叠对 process member 设/移除
				// hidden="until-found"，组头需要跟随同步（见 syncHeadersToTurnFolds）。
				attributeFilter: ["data-state", "hidden"]
			});
			return function () {
				if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
				pending = null;
				obs.disconnect();
			};
		}

		exports.startToolGroupObserver = startToolGroupObserver;
		exports.scanToolGroups = scanToolGroups;
		exports.resetToolGroups = resetToolGroups;
		exports.detectGroups = detectGroups;
		exports.isGroupableTool = isGroupableTool;
		exports.areConsecutive = areConsecutive;
		exports.isTransparentNode = isTransparentNode;
		exports.classifyMutations = classifyMutations;
		exports.scanStats = scanStats;
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
		var _mermaidLayouts = [];
		var _winResizeBound = false;
		var CANVAS_WIDE_RATIO = 0.75;
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
			if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { useMaxWidth: false } }); _mermaidLoaded = Promise.resolve(window.mermaid); return _mermaidLoaded; }
			_mermaidLoaded = new Promise(function (resolve) {
				var s = document.createElement("script");
				s.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
				s.onload = function () {
					if (window.mermaid) { window.mermaid.initialize({ startOnLoad: false, theme: "default", securityLevel: "loose", flowchart: { useMaxWidth: false } }); resolve(window.mermaid); }
					else { _mermaidLoaded = null; resolve(null); }
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
				var b = document.createElement("button"); b.style.cssText = btnStyle; b.textContent = glyph; b.title = title;
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

		exports.TagsSetting = TagsSetting;

		// ── Windsurf API Key setting ─────────────────────────────────────
		// Manual entry for the fast-context tool's key. The host resolves keys
		// as: WINDSURF_API_KEY env → this manual file → local auto-read. With
		// no key the tool is not registered, so the status line doubles as the
		// "why is the tool missing" answer. Changes apply on next restart; the
		// value is never echoed back beyond a 4+4 preview.
		var KEY_ENDPOINT = "/api/dsao/windsurf-key";
		var SOURCE_LABELS = {
			env: "环境变量",
			file: "手动填写",
			auto: "自动读取",
			none: "未配置"
		};
		function WindsurfKeySetting() {
			var s = React.useState(null), status = s[0], setStatus = s[1];
			var inp = React.useState(""), input = inp[0], setInput = inp[1];
			var busy = React.useState(false), isBusy = busy[0], setBusy = busy[1];
			var note = React.useState(""), noteMsg = note[0], setNote = note[1];

			React.useEffect(function () {
				var cancelled = false;
				fetch(KEY_ENDPOINT, { method: "GET" })
					.then(function (r) { return r.json(); })
					.then(function (data) { if (!cancelled) setStatus(data); })
					.catch(function () { if (!cancelled) setStatus({ present: false, source: "none" }); });
				return function () { cancelled = true; };
			}, []);

			function refresh() {
				fetch(KEY_ENDPOINT, { method: "GET" })
					.then(function (r) { return r.json(); })
					.then(function (data) { setStatus(data); })
					.catch(function () {});
			}
			function save() {
				var k = input.trim();
				if (k === "" || isBusy) return;
				setBusy(true); setNote("");
				fetch(KEY_ENDPOINT, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) })
					.then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
					.then(function (res) {
						setInput("");
						if (res.ok) { setNote("已保存，重启后生效"); setStatus({ present: true, source: "file", preview: k.slice(0, 4) + "…" + k.slice(-4) }); }
						else setNote("保存失败：" + (res.data && res.data.error ? res.data.error : "未知错误"));
					})
					.catch(function (e) { setNote("保存失败：" + e.message); })
					.then(function () { setBusy(false); });
			}
			function clear() {
				if (isBusy) return;
				setBusy(true); setNote("");
				fetch(KEY_ENDPOINT, { method: "DELETE" })
					.then(function (r) { return r.json(); })
					.then(function () { setNote("已清除，重启后生效"); refresh(); })
					.catch(function (e) { setNote("清除失败：" + e.message); })
					.then(function () { setBusy(false); });
			}

			var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
			var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
			var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "160px" };
			var btnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };
			var statusStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", whiteSpace: "nowrap" };
			var noteStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px" };

			var statusText = status === null ? "读取中…" : (status.present ? (status.preview || "") + " · " + (SOURCE_LABELS[status.source] || status.source) : (SOURCE_LABELS[status.source] || "未配置"));

			var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Devin Key");
			var rightCol = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", maxWidth: "560px" } },
				React.createElement("div", { style: statusStyle }, statusText),
				React.createElement("input", { type: "password", value: input, disabled: isBusy, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") save(); }, placeholder: "粘贴 key 后保存…", style: inputStyle }),
				React.createElement("button", { style: btnStyle, disabled: isBusy || input.trim() === "", onClick: save }, "保存"),
				React.createElement("button", { style: btnStyle, disabled: isBusy || status === null || !status.present, onClick: clear }, "清除"),
				noteMsg !== "" ? React.createElement("div", { style: noteStyle }, noteMsg) : null);
			return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
		}
		exports.WindsurfKeySetting = WindsurfKeySetting;

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
		//   1. 项目标识     workspace title + path
		//   2. 项目指令     项目级 AGENTS.md 与其 .local 覆盖层的结构信号
		//                   （目录内没有 AGENTS 时用 CLAUDE.md）
		//   3. 会话摘要     DSH 自己的 compaction summary
		//   4. 近期用户提问 请求了什么
		//   5. 近期执行结果 完成了什么
		//
		// 4 与 5 是一对：提问记录意图，回复记录既成事实，"接着改""还是有问题"
		// 这类草稿必须两者兼备才能解析。
		//
		// 两处排除，都是为了让参考里不含任何会被改写误当作事实复述的内容：
		//   - 全局 ~/.dsh/AGENTS.md 讲的是 agent 通用行为，不是本项目事实。
		//   - agent 回复内部，代码块、表格行、含独立数值的句子被丢弃——瞬时字面量
		//     就住在那里；围绕它们的结论散文才是解析依据。

		var GLOBAL_PATHS = ["~/.dsh/AGENTS.md", "$DSH_HOME/AGENTS.md"];
		// 注意渲染器两种标题大小写不同（"Instructions from:" 与
		// "Additional instructions from:"），所以忽略大小写匹配。
		var SECTION_RE = /^(?:Additional\s+)?instructions\s+from:[ \t]*(.+?)[ \t]*$/i;
		var BOILERPLATE_RE = /^(?:These instructions apply to work under|The following workspace instructions may be relevant|This complete workspace instruction baseline|No workspace instructions are currently active|Workspace instruction budget|Instructions from:|Additional instructions from:)/i;

		var LIMITS = {
			instructionsTotal: 900,
			signalsPerFile: 12,
			summary: 700,
			// 提问与回复各自独立预算，任一侧都不会挤掉另一侧：
			// 两者合起来才构成「请求了什么 → 完成了什么」。
			asksTotal: 800,
			historyItem: 220,
			historyNodes: 5,
			repliesTotal: 700,
			replyItem: 200,
			replyNodes: 4,
			replySentences: 2
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

		function dirOf(path) {
			var at = path.replace(/\\/g, "/").lastIndexOf("/");
			return at < 0 ? "." : path.slice(0, at);
		}

		/**
		 * 排定同一目录下的指令候选优先级。
		 *
		 * DSH 先探 AGENTS.md 再探 CLAUDE.md，各自之后再探 .local 覆盖层。两个族说的
		 * 是同一件事（只是面向不同 agent），所以每个目录只保留胜出的那个族。但
		 * .local 覆盖层不是重复品：它是共享文件旁边的个人层（通常被 gitignore），
		 *  DSH 两份都注入，只有去空白后内容完全一致时才折叠（见
		 * dedupInstructionFilesByDirectory）。因此覆盖层与其 base 并存，且排在 base
		 * 之后，与 DSH「更具体者优先」的方向一致。
		 *
		 * README.md 不会进入会话上下文——Host 在完全没有指令文件时才兜底读它。
		 * @returns 0 AGENTS.md，1 AGENTS.local.md，2 CLAUDE.md，3 CLAUDE.local.md，-1 其他。
		 */
		function docRank(path) {
			var name = path.replace(/\\/g, "/").split("/").pop();
			if (/^AGENTS\.md$/i.test(name)) return 0;
			if (/^AGENTS\.local\.md$/i.test(name)) return 1;
			if (/^CLAUDE\.md$/i.test(name)) return 2;
			if (/^CLAUDE\.local\.md$/i.test(name)) return 3;
			return -1;
		}

		/** 候选属于哪个族：同目录内 AGENTS 族胜过 CLAUDE 族。 */
		function docFamily(rank) {
			return rank < 2 ? "agents" : "claude";
		}

		/** 该候选是个人覆盖层还是共享文件。 */
		function isOverlay(rank) {
			return rank === 1 || rank === 3;
		}

		/** 只取各条规则的标题与规则名：让 AGENTS.md 变长的是规则正文，增强器只需知道有哪些约束。 */
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
					var rank = docRank(section.path);
					if (rank < 0) continue;
					var signals = structureSignals(section.lines);
					if (signals.length === 0) continue;

					// 同一文件的较晚上下文消息覆盖较早的那条。
					if (seen[section.path] !== undefined) {
						files[seen[section.path]].signals = signals;
						continue;
					}

					files.push({
						path: section.path,
						dir: dirOf(section.path),
						rank: rank,
						family: docFamily(rank),
						overlay: isOverlay(rank),
						signals: signals
					});
					seen[section.path] = files.length - 1;
				}
			}

			// 每个目录只留一个族：该目录存在任一 AGENTS 文件时，CLAUDE 文件连同其
			// 覆盖层一并丢弃。
			var agentsDirs = Object.create(null);
			for (var a = 0; a < files.length; a++) {
				if (files[a].family === "agents") agentsDirs[files[a].dir] = true;
			}
			var chosen = [];
			for (var c = 0; c < files.length; c++) {
				if (files[c].family === "claude" && agentsDirs[files[c].dir] === true) continue;
				chosen.push(files[c]);
			}

			// 先按深度：项目根在前、子目录在后；同目录内再按 rank，让共享文件排在
			// 个人覆盖层之前。
			chosen.sort(function (x, y) {
				var dx = x.path.split(/[\\/]/).length;
				var dy = y.path.split(/[\\/]/).length;
				if (dx !== dy) return dx - dy;
				if (x.dir !== y.dir) return x.dir < y.dir ? -1 : 1;
				return x.rank - y.rank;
			});

			var parts = [];
			for (var p = 0; p < chosen.length; p++) {
				parts.push(chosen[p].path + ": " + chosen[p].signals.join("; "));
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

		/**
		 * 只取用户自己的提问尾巴。与 readReplies 配对使用：提问记录意图，回复记录
		 * 既成事实，"继续 / 接着 / 还是有问题"这类指代必须两者兼备才能解析。
		 */
		function readHistory(nodes) {
			var picked = [];
			var budget = LIMITS.asksTotal;
			for (var i = nodes.length - 1; i >= 0 && picked.length < LIMITS.historyNodes && budget > 0; i--) {
				var node = nodes[i];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "user") continue;
				var line = compact(blockText(node.content), LIMITS.historyItem);
				if (line === "") continue;
				budget -= line.length;
				picked.push(line);
			}
			picked.reverse();
			return picked.join("\n");
		}

		/**
		 * 剥掉 agent 回复中承载瞬时字面量的部分。
		 *
		 * 代码块与表格行才是上次泄漏的真正来源：改写把示例代码块里的字节数当成现状
		 * 陈述了出来。内联反引号内容保留（只脱掉反引号），因为 ensureBadge、
		 * lib/client.js 属于身份——那正是改写应当能够指名的东西。
		 */
		function stripLiteralBlocks(text) {
			var lines = String(text == null ? "" : text).split(/\r?\n/);
			var kept = [];
			var fenced = false;
			for (var i = 0; i < lines.length; i++) {
				var line = lines[i];
				if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
				if (fenced) continue;
				if (/^\s*\|/.test(line)) continue;
				if (/^\s*[-=]{3,}\s*$/.test(line)) continue;
				kept.push(line.replace(/`([^`]+)`/g, "$1"));
			}
			return kept.join("\n");
		}

		/**
		 * 句中是否含独立数值：数字未与字母粘连。身份得以存活（pkg-7、
		 * deepseek-v4-flash、AGENTS.md），因为它们的数字前是字母或连字符；
		 * 度量值则不然（340、+2/-1、64KB）。
		 */
		function hasQuantity(sentence) {
			return /(?:^|[^A-Za-z0-9_.\-])[+\u00b1-]?\d/.test(sentence);
		}

		/** 按中英文两种终止符切句。 */
		function sentences(text) {
			var out = [];
			var raw = String(text).split(/(?<=[.!?\u3002\uff01\uff1f\uff1b;])\s*|\n+/);
			for (var i = 0; i < raw.length; i++) {
				var s = raw[i].replace(/\s+/g, " ").trim();
				if (s !== "") out.push(s);
			}
			return out;
		}

		/**
		 * 一个 turn 的结论回复，取其前若干不含数值的句子。
		 *
		 * 整句丢弃而非把数字从句中抹掉：占位符可能被原样抄进输出，就地剥离又会留下
		 * "改成 priority" 这样的残句。数值密集的句子本就是细节句，而结论句通常不带
		 * 数字。
		 */
		function conclusionText(node) {
			var prose = stripLiteralBlocks(blockText(node.blocks));
			var list = sentences(prose);
			var kept = [];
			for (var i = 0; i < list.length && kept.length < LIMITS.replySentences; i++) {
				if (hasQuantity(list[i])) continue;
				kept.push(list[i]);
			}
			return compact(kept.join(" "), LIMITS.replyItem);
		}

		/**
		 * agent 实际完成了什么，每个近期 turn 一行。
		 *
		 * DSH 的一个 assistant turn 跨多个 step——工具调用、过程叙述，最后是结论。
		 * AssistantMessageNode 带 turn 与 step，所以同 turn 内 step 最大的那条即为
		 * 该轮结论，更早的 step 是工作笔记。interrupted 前缀不是结论，跳过。
		 */
		function readReplies(nodes) {
			var byTurn = Object.create(null);
			var order = [];

			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (node === null || typeof node !== "object") continue;
				if (node.kind !== "assistant") continue;
				if (node.interrupted === true) continue;
				// 没有 turn 号的节点无法分组，用 seq 自成一组，避免被静默丢弃。
				var turn = typeof node.turn === "number" ? node.turn : "seq:" + node.seq;
				var step = typeof node.step === "number" ? node.step : 0;
				var held = byTurn[turn];
				if (held === undefined) {
					byTurn[turn] = { step: step, node: node };
					order.push(turn);
					continue;
				}
				if (step >= held.step) byTurn[turn] = { step: step, node: node };
			}

			var picked = [];
			var budget = LIMITS.repliesTotal;
			for (var t = order.length - 1; t >= 0 && picked.length < LIMITS.replyNodes && budget > 0; t--) {
				var line = conclusionText(byTurn[order[t]].node);
				if (line === "") continue;
				budget -= line.length;
				picked.push(line);
			}
			picked.reverse();
			return picked.join("\n");
		}

		/** 会话的工作区根目录；会话列表里没有该行时返回 ""。 */
		function readCwd(session, sessions) {
			var sessionId = session !== null && typeof session === "object" ? session.sessionId : undefined;
			if (sessions === null || typeof sessions !== "object" || sessionId === undefined) return "";
			var byId = sessions.byId;
			var row = byId !== null && typeof byId === "object" ? byId[sessionId] : undefined;
			if (row === null || typeof row !== "object" || typeof row.cwd !== "string") return "";
			return row.cwd;
		}

		function readProject(session, sessions, workspaces) {
			var cwd = readCwd(session, sessions);

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

		/**
		 * 返回自有 JSON：不保留任何 Host 对象、snapshot 或 node。
		 *
		 * cwd 一并回传，让 Host 能自己兜底读指令文件：对话窗口可能已把指令上下文
		 * 滚出 nodes，项目也可能根本没有指令文件（那时 README.md 是最后手段，
		 * 由 Host 负责读取）。
		 */
		function readContext(session, sessions, workspaces) {
			var empty = { project: "", cwd: "", instructions: "", summary: "", history: "", replies: "" };
			if (session === null || typeof session !== "object") return empty;
			var nodes = Array.isArray(session.nodes) ? session.nodes : null;
			if (nodes === null) return empty;
			return {
				project: readProject(session, sessions, workspaces),
				cwd: readCwd(session, sessions),
				instructions: readInstructions(nodes),
				summary: readSummary(nodes),
				history: readHistory(nodes),
				replies: readReplies(nodes)
			};
		}

		exports.readContext = readContext;
		exports.readInstructions = readInstructions;
		exports.readSummary = readSummary;
		exports.readHistory = readHistory;
		exports.readReplies = readReplies;
		exports.readProject = readProject;
		exports.readCwd = readCwd;
		exports.structureSignals = structureSignals;
		exports.splitSections = splitSections;
		exports.docRank = docRank;
		exports.docFamily = docFamily;
		exports.isOverlay = isOverlay;
		exports.stripLiteralBlocks = stripLiteralBlocks;
		exports.hasQuantity = hasQuantity;
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
		var IDLE_TITLE = "Prompt \u589e\u5f3a";
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
			'[data-dsao-enhance-btn][data-state="busy"] .dsao-enh-label{max-width:52px;opacity:1;margin-left:4px}',
			"[data-dsao-enhance-btn]{position:relative}",
			"[data-dsao-enhance-btn]::after{content:attr(data-dsao-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:#fff;font-size:12px;line-height:1;padding:6px 10px;border-radius:6px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .15s ease .3s;z-index:100;}",
			"[data-dsao-enhance-btn]:not(:disabled):hover::after{opacity:1}"
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
			return buttons.length === 0 ? null : buttons[0];
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

		/** 把 refBytes 诊断压成一行，写进按钮 tooltip。 */
		function searchSummary(llmCalls, searches) {
			var c = typeof llmCalls === "number" ? llmCalls : 0;
			var s = typeof searches === "number" ? searches : 0;
			return c + " \u8c03\u7528 / " + s + " \u641c\u7d22";
		}

		/**
		 * 读取响应体，非 JSON 时不让解析错误盖掉真正的原因。
		 *
		 * webserver 的 fallback 用纯文本 "not found" 回 404，直接 res.json() 会抛
		 * "Unexpected token 'o'"，把「路由没注册」这个事实藏起来。
		 */
		function readBody(res) {
			return res.text().then(function (raw) {
				try {
					var parsed = JSON.parse(raw);
					return parsed !== null && typeof parsed === "object" ? parsed : {};
				} catch (e) {
					var snippet = raw.replace(/\s+/g, " ").trim().slice(0, 80);
					return { error: "HTTP " + res.status + (snippet === "" ? "" : ": " + snippet) };
				}
			});
		}

		function requestEnhance(payload, signal) {
			return fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
				signal: signal
			}).then(function (res) {
				return readBody(res).then(function (bag) {
					if (!res.ok || typeof bag.text !== "string") {
						var reason = typeof bag.error === "string" ? bag.error : "HTTP " + res.status;
						var err = new Error(reason);
						err.refBytes = bag.refBytes;
						throw err;
					}
					return { text: bag.text, refBytes: bag.refBytes, llmCalls: bag.llmCalls, searches: bag.searches };
				});
			});
		}

		/**
		 * 注册在 conversation.input.right（渲染在模型选择器之前），只输出一个隐藏
		 * 锚点，真正的按钮是插入到同一个 .trailing 容器里、第一个 primary 按钮之前的
		 * 原生 DOM 节点——那里没有 slot，且按钮不归 React 所有，所以落位幂等、清理独立。
		 * 取第一个 primary（而非最后一个）是为了在子代理运行中的停止按钮出现时，增强
		 * 按钮插到停止组之前，不会夹在停止与发送之间把停止按钮挤走。
		 *
		 * 私有参考由 dsao/context 从 slot props 里的实时 snapshot 提取，只读文本
		 * 叶子，四段有序（项目标识 / 项目指令结构信号 / 会话摘要 / 近期对话）。
		 * Host 回传的 refBytes 会写进 tooltip，便于判断改写不理想是上下文太薄
		 * 还是提示词的问题。
		 */
		function PromptEnhanceMount(props) {
			// 子代理会话不渲染增强按钮：props.session.subagent 非空表示这是被
			// 委派 agent 自己的输入流，按钮只会占据工具行，运行中还会挤开中断
			// 控件。这里先判定，effect 里提前返回，末尾也不渲染锚点。
			var isSubagent = props.session !== null && typeof props.session === "object" &&
				props.session.subagent !== null && props.session.subagent !== undefined;

			var markerRef = React.useRef(null);
			var apiRef = React.useRef(null);
			var stateRef = React.useRef({ blocked: true, busy: false });
			var draftRef = React.useRef("");
			var actionsRef = React.useRef(null);
			var lastRefRef = React.useRef("");
			var contextRef = React.useRef({ project: "", cwd: "", instructions: "", summary: "", history: "" });

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
				if (isSubagent) return;
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
				btn.setAttribute("data-dsao-tip", IDLE_TITLE);
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
						btn.setAttribute("data-dsao-tip", BUSY_TITLE);
						btn.style.opacity = "1";
						btn.style.color = "var(--dsw-alias-brand-primary)";
						btn.style.background = "var(--dsw-alias-bg-layer-2)";
						icon.style.display = "none";
						spinner.style.display = "";
						return;
					}
					btn.setAttribute("data-state", "idle");
					btn.setAttribute("data-dsao-tip", idleTip());
					btn.style.opacity = s.blocked ? "0.4" : "1";
					btn.style.background = "transparent";
					spinner.style.display = "none";
					icon.style.display = "";
				};

				var idleTip = function () {
					var diag = lastRefRef.current;
					return diag === "" ? IDLE_TITLE : IDLE_TITLE + " \u00b7 " + diag;
				};

				var settle = function (ok, why) {
					clearSettle();
					icon.setAttribute("d", ok ? PATH_CHECK : PATH_SPARKLE);
					btn.style.color = ok ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)";
					btn.setAttribute("data-dsao-tip", ok ? idleTip() : "Prompt \u589e\u5f3a\u5931\u8d25\uff1a" + why);
					settleTimer = setTimeout(function () {
						icon.setAttribute("d", PATH_SPARKLE);
						btn.style.color = IDLE_COLOR;
						btn.setAttribute("data-dsao-tip", idleTip());
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
						cwd: ref.cwd,
						instructions: ref.instructions,
						summary: ref.summary,
						history: ref.history,
						replies: ref.replies
					}, controller.signal).then(function (reply) {
						if (reply.text.trim() !== "") actions.setDraft(reply.text);
						lastRefRef.current = searchSummary(reply.llmCalls, reply.searches);
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

			return isSubagent ? null : React.createElement("span", {
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

// ── dsao/resume-gate ─────────────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/resume-gate",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var RESUMABLE_KINDS = { aborted: true, error: true };

		function lastTurnReasonKind(timeline) {
			if (!timeline || !timeline.turns || typeof timeline.turns.forEach !== "function") return undefined;
			var lastTurn = null;
			var lastTurnNum = -1;
			timeline.turns.forEach(function (turn) {
				if (turn && turn.status === "closed" && typeof turn.turn === "number" && turn.turn > lastTurnNum) {
					lastTurnNum = turn.turn;
					lastTurn = turn;
				}
			});
			if (!lastTurn || !lastTurn.end) return undefined;
			var reason = lastTurn.end.data && lastTurn.end.data.reason;
			if (!reason || typeof reason.kind !== "string") return undefined;
			return reason.kind;
		}

		function canResume(session, draft) {
			if (session === null || session === undefined || typeof session !== "object") {
				return { canResume: false, reason: "no-session" };
			}
			if (session.subagent !== null && session.subagent !== undefined) {
				return { canResume: false, reason: "subagent" };
			}
			if (session.running === true) {
				return { canResume: false, reason: "running" };
			}
			if (typeof draft === "string" && draft.trim() !== "") {
				return { canResume: false, reason: "draft-not-empty" };
			}
			var queue = Array.isArray(session.queue) ? session.queue : [];
			for (var i = 0; i < queue.length; i++) {
				var item = queue[i];
				if (item !== null && item !== undefined && item.placement === "queued") {
					return { canResume: false, reason: "queue-pending" };
				}
			}
			var kind = lastTurnReasonKind(session.chat && session.chat.timeline);
			if (kind === undefined) {
				return { canResume: false, reason: "no-terminal" };
			}
			if (!RESUMABLE_KINDS[kind]) {
				return { canResume: false, reason: "terminal-" + kind, terminalKind: kind };
			}
			return { canResume: true, terminalKind: kind };
		}

		exports.RESUMABLE_KINDS = RESUMABLE_KINDS;
		exports.lastTurnReasonKind = lastTurnReasonKind;
		exports.canResume = canResume;
		return module.exports;
	}
});


// ── dsao/resume-button（CSS 叠加：隐藏官方 icon + 显示 ▶） ────────────────
window.__ModuleLoader__.load({
	id: "dsao/resume-button",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var RESUME_ENDPOINT = '/api/dsao/resume'
		var SVG_NS = 'http://www.w3.org/2000/svg'
		var PATH_PLAY = 'M3 2v12l11-6z'

		function ensureStyles(doc) {
			if (doc.getElementById('dsao-resume-btn-css') !== null) return
			var style = doc.createElement('style')
			style.id = 'dsao-resume-btn-css'
			style.textContent = [
				'[data-dsao-resume] > svg:not([data-dsao-play]){display:none}',
				'[data-dsao-resume]{position:relative}',
				'[data-dsao-resume]::after{',
					'content:attr(data-dsao-tip);',
					'position:absolute;',
					'bottom:calc(100% + 6px);',
					'left:50%;',
					'transform:translateX(-50%);',
					'background:var(--dsw-alias-tooltip-bg,#2c2c2e);',
					'color:#fff;',
					'font-size:12px;',
					'line-height:1;',
					'padding:6px 10px;',
					'border-radius:6px;',
					'white-space:nowrap;',
					'pointer-events:none;',
					'opacity:0;',
					'transition:opacity .15s ease .3s;',
					'z-index:100;',
				'}',
				'[data-dsao-resume]:hover::after{opacity:1}',
			].join('')
			doc.head.appendChild(style)
		}

		function findPrimaryButton(trailing) {
			if (!trailing || typeof trailing.querySelector !== 'function') return null
			var btn = trailing.querySelector('button[class*="primary"]')
			return btn || null
		}

		function makePlaySvg(doc) {
			var playSvg = doc.createElementNS(SVG_NS, 'svg')
			playSvg.setAttribute('viewBox', '0 0 16 16')
			playSvg.setAttribute('width', '16')
			playSvg.setAttribute('height', '16')
			playSvg.setAttribute('aria-hidden', 'true')
			playSvg.setAttribute('data-dsao-play', '')
			var path = doc.createElementNS(SVG_NS, 'path')
			path.setAttribute('d', PATH_PLAY)
			path.setAttribute('fill', 'currentColor')
			playSvg.appendChild(path)
			return playSvg
		}

		function createResumeButton(React, gateMod) {
			function ResumeMount(props) {
				var markerRef = React.useRef(null)
				var sessionRef = React.useRef(props.session)
				var draftRef = React.useRef(typeof (props.input && props.input.draft) === 'string' ? props.input.draft : '')

				React.useEffect(function () {
					var marker = markerRef.current
					if (!marker || !marker.parentNode) return
					var doc = marker.ownerDocument
					var trailing = marker.parentNode
					while (
						trailing &&
						(typeof trailing.querySelector !== 'function' ||
							trailing.querySelector('button[class*="primary"]') === null)
					) {
						trailing = trailing.parentNode
					}
					if (!trailing) return

					ensureStyles(doc)

					var active = false
					var busy = false
					var settleTimer = null
					var hijackedBtn = null

					function clearSettle() {
						if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
					}

					function requestResume(sessionId) {
						return fetch(RESUME_ENDPOINT, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ sessionId: sessionId }),
						}).then(function (res) {
							return res.text().then(function (raw) {
								var bag
								try { bag = JSON.parse(raw) } catch (e) { bag = {} }
								if (!res.ok || bag.accepted !== true) {
									throw new Error(typeof bag.error === 'string' ? bag.error : 'HTTP ' + res.status)
								}
								return bag
							})
						})
					}

					function activate(btn) {
						if (!btn) return
						if (active && hijackedBtn === btn) return
						if (active && hijackedBtn !== btn) deactivate()
						hijackedBtn = btn
						active = true
						btn.setAttribute('data-dsao-resume', '')
						btn.setAttribute('data-dsao-tip', '断点续发')
						btn.setAttribute('aria-label', '断点续发')
						btn.removeAttribute('disabled')
						if (!btn.querySelector('svg[data-dsao-play]')) {
							btn.appendChild(makePlaySvg(doc))
						}
						installClickHijack(btn)
					}

					function deactivate() {
						if (!active) return
						if (hijackedBtn) {
							removeClickHijack(hijackedBtn)
							hijackedBtn.removeAttribute('data-dsao-resume')
							hijackedBtn.removeAttribute('data-dsao-tip')
							hijackedBtn.removeAttribute('aria-label')
							var playSvg = hijackedBtn.querySelector('svg[data-dsao-play]')
							if (playSvg) playSvg.remove()
						}
						active = false
						hijackedBtn = null
					}

					function installClickHijack(btn) {
						if (btn._dsaoHijackRemover) return
						function onCaptureClick(ev) {
							ev.stopPropagation()
							ev.preventDefault()
							if (busy) return
							var snap = sessionRef.current
							var verdict = gateMod.canResume(snap, draftRef.current)
							if (verdict.canResume !== true) return
							var sessionId = snap && typeof snap.sessionId === 'string' ? snap.sessionId : ''
							if (sessionId === '') return
							deactivate()
							busy = true
							requestResume(sessionId).then(function () {
								settleTimer = setTimeout(function () { busy = false; poll() }, 1200)
							}).catch(function () {
								settleTimer = setTimeout(function () { busy = false; poll() }, 2600)
							})
						}
						btn.addEventListener('click', onCaptureClick, true)
						btn._dsaoHijackRemover = function () {
							btn.removeEventListener('click', onCaptureClick, true)
							btn._dsaoHijackRemover = null
						}
					}

					function removeClickHijack(btn) {
						if (btn && typeof btn._dsaoHijackRemover === 'function') {
							btn._dsaoHijackRemover()
						}
					}

					function poll() {
						if (busy) return
						var verdict = gateMod.canResume(sessionRef.current, draftRef.current)
						var shouldActivate = verdict.canResume === true
						var btn = findPrimaryButton(trailing)
						if (!btn) return
						if (shouldActivate) {
							activate(btn)
						} else {
							deactivate()
						}
					}

					var timer = setInterval(poll, 400)

					var domObs = new MutationObserver(function () {
						if (!active) return
						var btn = findPrimaryButton(trailing)
						if (!btn || btn !== hijackedBtn) {
							hijackedBtn = null
							poll()
						} else {
							if (!btn.hasAttribute('data-dsao-resume')) {
								btn.setAttribute('data-dsao-resume', '')
								btn.setAttribute('data-dsao-tip', '断点续发')
								btn.setAttribute('aria-label', '断点续发')
							}
							if (!btn.querySelector('svg[data-dsao-play]')) btn.appendChild(makePlaySvg(doc))
							if (!btn._dsaoHijackRemover) installClickHijack(btn)
						}
					})
					domObs.observe(trailing, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] })

					poll()

					return function () {
						domObs.disconnect()
						clearInterval(timer)
						clearSettle()
						deactivate()
					}
				})

				React.useEffect(function () {
					sessionRef.current = props.session
					draftRef.current = typeof (props.input && props.input.draft) === 'string' ? props.input.draft : ''
				})

				return React.createElement('span', {
					ref: markerRef,
					'data-dsao-resume-anchor': '',
					style: { display: 'none' },
				})
			}

			return { ResumeMount: ResumeMount }
		}

		exports.createResumeButton = createResumeButton
		exports.RESUME_ENDPOINT = RESUME_ENDPOINT
		exports.findPrimaryButton = findPrimaryButton
		exports.ensureStyles = ensureStyles

		return module.exports;
	}
});

// ── dsao/resume-continuity ───────────────────────────────────────────────
window.__ModuleLoader__.load({
	id: "dsao/resume-continuity",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var HINT_TEXT = '已从中断处继续'

		// ── React-layer shadow (mechanism A) ──────────────────────────────

		var _officialUserCache = null
		var _slotsRef = null
		function provideSlots(slots) {
			_slotsRef = slots
			_officialUserCache = null
			try {
				var entries = slots.entries('conversation.chat.node')
				if (entries) {
					for (var i = 0; i < entries.length; i++) {
						var e = entries[i]
						if (e.options && e.options.key === 'user' && (e.options.priority ?? 0) === 0) {
							_officialUserCache = e.component
							break
						}
					}
				}
			} catch (err) {}
		}
		function findOfficialUserRenderer(slots) {
			if (_officialUserCache) return _officialUserCache
			var s = slots || _slotsRef
			if (!s) return null
			try {
				var entries = s.entries('conversation.chat.node')
				if (!entries) return null
				for (var i = 0; i < entries.length; i++) {
					var e = entries[i]
					if (e.options && e.options.key === 'user' && (e.options.priority ?? 0) === 0) {
						_officialUserCache = e.component
						return _officialUserCache
					}
				}
			} catch (err) {}
			return null
		}

		function isResumeMarker(node) {
			if (node === null || node === undefined || typeof node !== 'object') return false
			var data = node.data
			if (data === null || data === undefined || typeof data !== 'object') return false
			var source = data.source
			if (source === null || source === undefined || typeof source !== 'object' || source.dsaoResume !== true) {
				return false
			}
			var content = data.content
			if (!Array.isArray(content)) return false
			if (content.length === 0) return true
			if (content.length === 1 && content[0] && content[0].type === 'text' && String(content[0].text || '').trim() === '') {
				return true
			}
			return false
		}

		// ── DOM-layer fallback (mechanism B) ──────────────────────────────

		function startResumeHintObserver() {
			if (typeof document === 'undefined') return function () {}
			var ROW_SEL = '.gdEzaW_userRow'
			var BUBBLE_SEL = '.gdEzaW_bubble'
			var STACK_SEL = '.gdEzaW_userStack'

			function processRow(row) {
				if (!row || row.hasAttribute('data-dsao-resume-collapsed')) return
				var bubble = row.querySelector(BUBBLE_SEL)
				if (bubble) return
				var stack = row.querySelector(STACK_SEL)
				if (!stack) return
				var stackText = String(stack.textContent || '').trim()
				if (stackText !== '') return
				if (stack.querySelector('img')) return
				row.setAttribute('data-dsao-resume-collapsed', '')
				var hint = document.createElement('div')
				hint.setAttribute('data-dsao-resume-hint', '')
				hint.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;padding:0 2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:1.4;user-select:none'
				var line = document.createElement('span')
				line.style.cssText = 'width:14px;height:1px;flex:none;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:0.6'
				hint.appendChild(line)
				hint.appendChild(document.createTextNode(HINT_TEXT))
				while (row.firstChild) row.removeChild(row.firstChild)
				row.appendChild(hint)
				row.style.alignItems = 'flex-start'
			}

			function scan(root) {
				try {
					var rows = root.querySelectorAll(ROW_SEL + ':not([data-dsao-resume-collapsed])')
					for (var i = 0; i < rows.length; i++) processRow(rows[i])
				} catch (err) {}
			}

			scan(document)
			var obs = new MutationObserver(function (mutations) {
				for (var i = 0; i < mutations.length; i++) {
					var m = mutations[i]
					for (var j = 0; j < m.addedNodes.length; j++) {
						var node = m.addedNodes[j]
						if (node.nodeType !== 1) continue
						if (node.matches && node.matches(ROW_SEL)) processRow(node)
						else if (node.querySelector) scan(node)
					}
				}
				scan(document)
			})
			obs.observe(document.body, { childList: true, subtree: true })
			return function () { obs.disconnect() }
		}

		function createResumeContinuity(React) {
			function ResumeMarkerAwareUserNode(props) {
				var node = props && props.node
				if (isResumeMarker(node)) {
					return React.createElement('div', {
						'data-dsao-resume-hint': '',
						style: {
							display: 'flex',
							alignItems: 'center',
							gap: '6px',
							margin: '2px 0',
							padding: '0 2px',
							color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
							fontSize: '11px',
							lineHeight: 1.4,
							userSelect: 'none',
						},
					},
						React.createElement('span', {
							style: {
								width: '14px', height: '1px', flex: 'none',
								background: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
								opacity: 0.6,
							},
						}),
						HINT_TEXT
					)
				}
				var Official = findOfficialUserRenderer(props.slots || (props._dsaoSlots || null))
				if (Official === null) return null
				return React.createElement(Official, props)
			}
			return { ResumeMarkerAwareUserNode: ResumeMarkerAwareUserNode }
		}

		exports.provideSlots = provideSlots
		exports.createResumeContinuity = createResumeContinuity
		exports.isResumeMarker = isResumeMarker
		exports.findOfficialUserRenderer = findOfficialUserRenderer
		exports.startResumeHintObserver = startResumeHintObserver
		exports.HINT_TEXT = HINT_TEXT

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
		var toolGroup = require("dsao/tool-group");
		var settings = require("dsao/settings");
		var promptEnhance = require("dsao/prompt-enhance");
		var resumeGate = require("dsao/resume-gate");
		var resumeButton = require("dsao/resume-button");
		var resumeContinuity = require("dsao/resume-continuity");

		function apply(ctx) {
			// dsh 0.1.2+：声明式服务（exports.inject = ["slots"]）让 cordis 把本 fiber
			// 挂起等待 slots 服务就绪。ctx.get("slots") 这种无声明探测在并发启动
			// （shell 对 boot manifest Promise.all）中竞速官方渲染器，未就绪时拿到
			// undefined 而静默退出——旧版顺序启动恰好掩盖了这一点。与 host 半体
			// 的 inject = ['webServer'] 同源同因。
			var slots = ctx.slots;
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

			// 2b. Settings page: Windsurf key entry (manual half of the key chain)
			slots.inject("settings.general.item", function () {
				return slots.register(
					{ name: "settings.general.item", id: "windsurf-key", order: 40 },
					function () { return React.createElement(settings.WindsurfKeySetting); }
				);
			});

			// 3. Prompt enhance button in the composer tool row
			slots.inject("conversation.input.right", function () {
				return slots.register(
					{ name: "conversation.input.right", id: "dsao-prompt-enhance", order: 100, locale: "conversation" },
					promptEnhance.PromptEnhanceMount
				);
			});

			// 3b. 断点续发播放键：同槽位兄弟节点（order 101），门控点亮、
			//     点击调用 /api/dsao/resume 免输入唤醒（PRD §14 Phase 2）。
			slots.inject("conversation.input.right", function () {
				return slots.register(
					{ name: "conversation.input.right", id: "dsao-resume", order: 101, locale: "conversation" },
					resumeButton.createResumeButton(React, resumeGate).ResumeMount
				);
			});
			// 3c. 续跑行呈现：遮蔽 key:'user' 的官方渲染器，把续跑 marker 的空块
			//     用户消息渲染为「已从中断处继续」内联提示（项2 空白行 + 项4 连续性）。
			//     ResumeMarkerAwareUserNode 由工厂创建（模块拿 React 走 DI，不直接导出组件），
			//     必须经 createResumeContinuity 实例化——直接引用模块属性是 undefined，
			//     会让 React 抛 #130（element type undefined，经槽位边界让位官方渲染器后
			//     仅表现为控制台报错）。
			resumeContinuity.provideSlots(slots);
			var resumeRC = resumeContinuity.createResumeContinuity(React);
			slots.inject("conversation.chat.node", function () {
				return slots.register(
					{ name: "conversation.chat.node", key: "user", priority: -1, locale: "conversation" },
					function (rawProps) {
						return React.createElement(resumeRC.ResumeMarkerAwareUserNode, rawProps);
					}
				);
			});
			// 4. Mermaid post-processor
			ctx.effect(function () { return mermaid.startMermaidObserver(); });

			// 5. Tool-call grouping: collapse consecutive tool-call rows into a group
			ctx.effect(function () { return toolGroup.startToolGroupObserver(); });

			// 6. 断点续发行折叠：DOM 层后备，把官方渲染的空 marker 气泡替换为
			//    「已从中断处继续」提示行（slot 遮蔽未生效时的双保险）。
			ctx.effect(function () { return resumeContinuity.startResumeHintObserver(); });
		}

		exports.inject = ["slots"];
		exports.apply = apply;
		return module.exports;
	}
});
