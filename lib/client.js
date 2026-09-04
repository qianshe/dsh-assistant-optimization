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
//   dsao/turn-fold — 已完成 turn 过程折叠（一行「已完成 · 时长」+ 总结回复）
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
		var scanStats = { full: 0, tail: 0, attr: 0, ignored: 0 };
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
					if (m.attributeName === "data-state") attrState = true;
					continue;
				}
				var removed = m.removedNodes;
				if (removed) {
					for (var k = 0; k < removed.length; k++) {
						var rn = removed[k];
						if (rn.nodeType !== 1) continue;
						if (isHeader(rn)) continue; // our own cleanup — ignore
						if (isRelevantNode(rn) || (rn.querySelector && rn.querySelector("[data-chat-flow-key]"))) hasRemoval = true;
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
				attributes: true, attributeFilter: ["data-state"]
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

// ── dsao/turn-fold（turn 过程折叠：「运行中 · 计时」行 + 「已完成 · 时长」折叠头 + 总结回复） ──
window.__ModuleLoader__.load({
	id: "dsao/turn-fold",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// 行为规格：
		//   · turn 运行中：在该 turn 内容顶部注入「运行中 · 计时」行（每秒跳动，
		//     不折叠内容）。不依赖 DSH 底部 "Deep diving…" 行（它计时要 15 秒才显示）。
		//   · turn 结束（turn-tail 节点出现 = 结论来了）：运行中行移除，自动收起
		//     该 turn 的过程节点（thinking、工具调用、中间正文、重试/上下文行），
		//     只保留：
		//       - 一行折叠头「已完成 · 时长」（出错/停止的 turn 显示对应状态，可点开）
		//       - 该 turn 的总结性回复（官方 turn-tail.closing 定位）
		//       - 用户消息（user/steering/command）与结果行（turn-error 等）
		//   · 点折叠头展开看全过程，再点收起；偏好只存内存（刷新后默认收起）。
		//
		// 数据源（全部来自会话快照）：
		//   session.chat.order / nodes / locations.getTurn(n) / timeline.turns
		//   turn-tail 节点 data.closing.finalNode.seq → 总结性回复定位
		//
		// DOM 层（沿用 tool-group 模式）：
		//   过程 flowItem 加 data-dsao-tf-hidden（display:none!important）
		//   第一个过程节点前注入 data-dsao-tf-header 折叠头
		//   MutationObserver 只响应 flowItem 增删（不追流式文本），80ms 防抖

		var STORAGE_KEY = "dsao:turn-fold-enabled";

		var TERMINAL_LABELS = {
			completed: "已完成",
			aborted: "已停止",
			error: "已出错",
			"max-tokens": "已截断"
		};

		function loadEnabled() {
			try {
				var raw = localStorage.getItem(STORAGE_KEY);
				if (raw !== null) return raw === "1";
			} catch (e) {}
			return true;
		}

		function saveEnabled(v) {
			try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch (e) {}
			try { window.dispatchEvent(new Event("dsao:turn-fold-changed")); } catch (e) {}
		}

		function formatDuration(ms) {
			// 与 DSH 原生 turn 计时（formatRunDuration 中文模板）一致：42秒 / 3分05秒
			var total = Math.max(0, Math.floor(ms / 1000));
			var minutes = Math.floor(total / 60);
			var seconds = total % 60;
			if (minutes > 0) return minutes + "分" + String(seconds).padStart(2, "0") + "秒";
			return total + "秒";
		}

		function terminalLabel(reasonKind) {
			return TERMINAL_LABELS[reasonKind] || "已完成";
		}

		/**
		 * 续跑 marker 判定（与 resume-continuity.isResumeMarker 同一数据契约）：
		 * 用户节点 + source.dsaoResume 标记 + 空 content（或纯空白 text 块）。
		 * 本地实现保持 turn-fold 零依赖（单文件加载环境可独立运行）。
		 */
		function isResumeMarkerNode(node) {
			if (!node || node.kind !== "user") return false;
			var data = node.data;
			if (!data || typeof data !== "object") return false;
			var source = data.source;
			if (!source || typeof source !== "object" || source.dsaoResume !== true) return false;
			var content = data.content;
			if (!Array.isArray(content)) return false;
			if (content.length === 0) return true;
			return content.length === 1 && content[0] && content[0].type === "text" &&
				String(content[0].text || "").trim() === "";
		}

		/**
		 * 纯函数：判断节点是否为"过程节点"（turn 折叠时应隐藏）。
		 * closingSeq 为该 turn 总结性回复的 finalNode.seq（null = 无文本回复）。
		 */
		function isProcessNode(node, closingSeq) {
			var kind = node && node.kind;
			if (kind === "user" || kind === "steering" || kind === "command") return false;
			if (kind === "turn-tail" || kind === "turn-error" || kind === "turn-max-tokens") return false;
			if (kind === "unknown") return false;
			if (kind === "assistant-step") {
				var fn = node.data && node.data.finalNode;
				return !(closingSeq !== null && fn && fn.seq === closingSeq);
			}
			return true;
		}

		/**
		 * 纯函数：把「中断续跑」拆出的相邻 turn 归并为一个折叠组（链模型）。
		 * 链判定：turn 号连续 + 后段首节点是续跑 marker（isResumeMarkerNode）相连；
		 * 除末段外各段以 aborted/error 收尾；链内全部 closed。覆盖手动停止续跑、
		 * 报错（含上游 400）后继续、停→续→停→续链式多段。
		 * 无过程节点的纯报错段（本无 fold）同样并入链——修复「错误行+marker 裸露
		 * 在折叠头之外」的截图态。
		 * 归并语义：组 id = 首段 turn 号；非末段除真实用户输入外全部转为折叠隐藏
		 * （半截回复、组内 marker、错误行、turn-tail 动作行）；末段保留 closing +
		 * tail + 错误行，隐藏其 marker 与过程；文案取末段状态 + 各段活跃时长之和。
		 * 展开态显示链内全部历史（含被收起的 marker/错误行）。
		 */
		function mergeResumeFolds(plan, nodes, locations, turnMeta) {
			if (!turnMeta) return;
			var turnNums = [];
			plan.turnOf.forEach(function (tn) {
				if (turnNums.indexOf(tn) < 0) turnNums.push(tn);
			});
			if (turnNums.length < 2) return;
			turnNums.sort(function (a, b) { return a - b; });

			function keysOf(t) {
				return locations && typeof locations.getTurn === "function" ? locations.getTurn(t) : null;
			}
			function isMarkerLed(t) {
				var keys = keysOf(t);
				if (!keys || keys.length === 0) return false;
				return isResumeMarkerNode(nodes.get(keys[0]));
			}

			// 切链：连续号 + marker 相连扩展；非 closed turn 切断（运行末段不并入）。
			var chains = [];
			var cur = null;
			for (var i = 0; i < turnNums.length; i++) {
				var tn = turnNums[i];
				var meta = turnMeta[tn];
				if (!meta || meta.status !== "closed") {
					if (cur !== null) { chains.push(cur); cur = null; }
					continue;
				}
				if (cur !== null) {
					var prevTn = cur[cur.length - 1];
					var prevMeta = turnMeta[prevTn];
					var prevResumable = prevMeta.reasonKind === "aborted" || prevMeta.reasonKind === "error";
					if (tn === prevTn + 1 && prevResumable && isMarkerLed(tn)) {
						cur.push(tn);
						continue;
					}
					chains.push(cur);
				}
				cur = [tn];
			}
			if (cur !== null) chains.push(cur);

			var foldByTurn = {};
			for (var f = 0; f < plan.folds.length; f++) foldByTurn[plan.folds[f].turn] = plan.folds[f];

			var merged = [];
			for (var c = 0; c < chains.length; c++) {
				var chain = chains[c];
				if (chain.length === 1) {
					if (foldByTurn[chain[0]]) merged.push(foldByTurn[chain[0]]);
					continue;
				}
				var sTurn = chain[0];
				var eTurn = chain[chain.length - 1];
				var eMeta = turnMeta[eTurn];
				var eFold = foldByTurn[eTurn];
				var hiddenKeys = [];
				var hiddenSeen = {};
				var chainSteering = 0;
				for (var g = 0; g < chain.length; g++) {
					var t = chain[g];
					var keys = keysOf(t);
					if (!keys) continue;
					var isFinalSeg = t === eTurn;
					for (var ki = 0; ki < keys.length; ki++) {
						var key = keys[ki];
						var node = nodes.get(key);
						var markerUser = !!node && node.kind === "user" && isResumeMarkerNode(node);
						var realUser = !!node && node.kind === "user" && !markerUser;
						if (node && node.kind === "steering") chainSteering++;
						// 非末段：只留真实输入；末段：marker 与插话收起，closing/tail/error
						// 保留，过程沿用 eFold.hiddenKeys（补入集合）。
						var keep = isFinalSeg ? (!markerUser && node.kind !== "steering") : realUser;
						if (!keep && !hiddenSeen[key]) {
							hiddenSeen[key] = true;
							hiddenKeys.push(key);
						}
					}
					if (isFinalSeg && eFold) {
						for (var h = 0; h < eFold.hiddenKeys.length; h++) {
							var hk = eFold.hiddenKeys[h];
							if (!hiddenSeen[hk]) { hiddenSeen[hk] = true; hiddenKeys.push(hk); }
						}
					}
				}
				if (hiddenKeys.length === 0) continue; // 无可折叠内容 → 不建组
				var totalMs = null;
				for (g = 0; g < chain.length; g++) {
					var m = turnMeta[chain[g]];
					if (m && typeof m.runMs === "number") totalMs = (totalMs === null ? 0 : totalMs) + m.runMs;
				}
				var label = terminalLabel(eMeta.reasonKind);
				merged.push({
					turn: sTurn,
					hiddenKeys: hiddenKeys,
					anchorKey: hiddenKeys[0], // push 按链内流序 → 首个即流序首个隐藏节点
					closingKey: eFold ? eFold.closingKey : null,
					reasonKind: eMeta.reasonKind,
					label: label,
					runMs: totalMs,
					steeringCount: chainSteering,
					headerText: label + (totalMs !== null ? " · " + formatDuration(totalMs) : "")
				});
				// 位置域归属整链改写到组 id（tg 头隐藏依赖它）
				for (g = 0; g < chain.length; g++) {
					var sk = keysOf(chain[g]);
					if (sk) {
						for (var s2 = 0; s2 < sk.length; s2++) plan.turnOf.set(sk[s2], sTurn);
					}
				}
			}
			plan.folds = merged;
		}

		/**
		 * 纯函数：从会话快照生成折叠计划。
		 * 返回 { keySet: Set<key>, folds: [...], runs: [...] }
		 * folds: [{ turn, hiddenKeys, anchorKey, closingKey, reasonKind, label, runMs, headerText }]
		 *   closingKey 为该 turn 总结性回复（closing）所在 assistant-step 的 key，
		 *   折叠态下用于一并收起其内部 thinking 行。只包含"有过程可折叠"的已完成 turn。
		 * runs: [{ turn, startTime, anchorKey, before }] —— 运行中 turn：
		 *   anchorKey/before 为「运行中」行的插入锚点（第一个过程节点前；
		 *   尚无过程节点时锚到该 turn 最后一个节点之后）。
		 */
	function planTurnFold(session) {
		var plan = { keySet: null, turnOf: new Map(), folds: [], runs: [] };
		var turnMeta = {};
		if (!session || typeof session !== "object") return plan;
			var chat = session.chat;
			if (!chat) return plan;
			var order = Array.isArray(chat.order) ? chat.order : [];
			plan.keySet = new Set(order);
			var nodes = chat.nodes;
			if (!nodes || typeof nodes.get !== "function") return plan;
			var timeline = chat.timeline;
			var locations = chat.locations;
			if (!timeline || !timeline.turns || typeof timeline.turns.forEach !== "function") return plan;

			timeline.turns.forEach(function (turn, turnNum) {
				if (!turn) return;
				var keys = locations && typeof locations.getTurn === "function" ? locations.getTurn(turnNum) : null;
				if (!keys || keys.length === 0) return;
			var i;
			for (i = 0; i < keys.length; i++) plan.turnOf.set(keys[i], turnNum);

			// 链归并所需的逐 turn 元数据（open 段也记录，链遇 open 即断）
			var metaReason = turn.end && turn.end.data && turn.end.data.reason ? turn.end.data.reason.kind : "completed";
			var metaRunMs = null;
			if (turn.start && turn.end && typeof turn.start.time === "number" && typeof turn.end.time === "number") {
				metaRunMs = Math.max(0, turn.end.time - turn.start.time);
			}
			turnMeta[turnNum] = { status: turn.status, reasonKind: metaReason, runMs: metaRunMs };

				// 运行中 turn：注入「运行中 · 计时」行的锚点
				if (turn.status === "open" && turn.start && typeof turn.start.time === "number") {
					var runAnchor = null;
					var runBefore = true;
					for (i = 0; i < keys.length; i++) {
						var rn = nodes.get(keys[i]);
						if (rn && isProcessNode(rn, null)) { runAnchor = keys[i]; break; }
					}
					if (runAnchor === null) {
						runBefore = false;
						for (i = keys.length - 1; i >= 0; i--) {
							if (nodes.get(keys[i])) { runAnchor = keys[i]; break; }
						}
					}
					if (runAnchor !== null) {
						plan.runs.push({ turn: turnNum, startTime: turn.start.time, anchorKey: runAnchor, before: runBefore });
					}
				return;
				}

				if (turn.status !== "closed") return;

				var closingSeq = null;
				for (i = 0; i < keys.length; i++) {
					var n = nodes.get(keys[i]);
					if (n && n.kind === "turn-tail" && n.data && n.data.closing && n.data.closing.finalNode) {
						closingSeq = n.data.closing.finalNode.seq;
						break;
					}
				}

			var hiddenKeys = [];
			var anchorKey = null;
			var closingKey = null;
			var steeringCount = 0;
			for (i = 0; i < keys.length; i++) {
				var node = nodes.get(keys[i]);
				if (!node) continue;
				if (node.kind === "assistant-step" && closingSeq !== null &&
					node.data && node.data.finalNode && node.data.finalNode.seq === closingSeq) {
					closingKey = keys[i];
				}
				// 运行中插话（steering）随组收起：折叠时它是组内叙事的一部分，展开后
				// 原位恢复（时间线不变，codex 同权语义）；command/context 是显式调用/
				// 注入上下文，保持可见。
				if (isProcessNode(node, closingSeq) || node.kind === "steering") {
					if (anchorKey === null) anchorKey = keys[i];
					if (node.kind === "steering") steeringCount++;
					hiddenKeys.push(keys[i]);
				}
			}
			if (hiddenKeys.length === 0) return;

			var runMs = turnMeta[turnNum].runMs;
			var reasonKind = turnMeta[turnNum].reasonKind;
			var label = terminalLabel(reasonKind);
			plan.folds.push({
				turn: turnNum,
				hiddenKeys: hiddenKeys,
				anchorKey: anchorKey,
				closingKey: closingKey,
				reasonKind: reasonKind,
				label: label,
				runMs: runMs,
				steeringCount: steeringCount,
				headerText: label + (runMs !== null ? " · " + formatDuration(runMs) : "")
			});
		});
		mergeResumeFolds(plan, nodes, locations, turnMeta);
		return plan;
	}

		// ── DOM 层 ─────────────────────────────────────────────────────────

		var CSS = [
			"[data-dsao-tf-hidden]{display:none!important}",
			"[data-dsao-tf-closing-folded] [data-variant=\"think\"]{display:none!important}",
			"[data-dsao-tf-process-end]{border-bottom:1px solid var(--dsw-alias-border-l2)}",
			"@keyframes dsao-tf-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
			".dsao-tf-running{display:flex;align-items:center;gap:0;padding:0;cursor:default;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".dsao-tf-runningIcon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);margin-right:6px}",
			".dsao-tf-runningDot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:dsao-tf-pulse 1.2s ease-in-out infinite}",
			".dsao-tf-runningText{font-weight:400;white-space:nowrap;min-width:0}",
			".dsao-tf-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;min-width:0;transition:color 120ms}",
			".dsao-tf-headerIcon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);margin-right:6px}",
			".dsao-tf-headerIcon[data-state=error]{color:var(--dsw-alias-state-error-primary)}",
			".dsao-tf-headerText{font-weight:400;white-space:nowrap;min-width:0}",
			".dsao-tf-headerSpacer{flex:auto}",
			".dsao-tf-steerCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:24px;margin-right:8px;white-space:nowrap}",
			'[data-dsao-tf-steer="0"]{display:none!important}',
			".dsao-tf-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}",
			".dsao-tf-chevron{display:inline-flex;transition:transform 180ms ease;color:var(--dsw-alias-label-secondary)}",
			'.dsao-tf-header[data-dsao-tf-state="expanded"] .dsao-tf-chevron{transform:rotate(90deg)}',
			".dsao-tf-header:hover .dsao-tf-headerText{color:var(--dsw-alias-label-primary)}",
		].join("");

		function ensureStyles(doc) {
			var existing = doc.getElementById("dsao-turn-fold-css");
			if (existing) {
				if (existing.textContent !== CSS) existing.textContent = CSS;
				return;
			}
			var style = doc.createElement("style");
			style.id = "dsao-turn-fold-css";
			style.textContent = CSS;
			doc.head.appendChild(style);
		}

		var ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 4.5l-6.4 7-4.1-3.6 1-1.1 3 2.6 5.4-5.9z" fill="currentColor"/></svg>';
		var ICON_STOP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor"/></svg>';
		var ICON_ERROR = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" fill="currentColor"/></svg>';
		var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.47813 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/></svg>';

		function iconForReason(reasonKind) {
			if (reasonKind === "error") return ICON_ERROR;
			if (reasonKind === "aborted" || reasonKind === "max-tokens") return ICON_STOP;
			return ICON_CHECK;
		}

		function createHeader(fold, doc) {
			var header = doc.createElement("div");
			header.className = "dsao-tf-header";
			header.setAttribute("data-dsao-tf-header", String(fold.turn));
			header.setAttribute("data-dsao-tf-state", "collapsed");
			header.setAttribute("data-dsao-tf-reason", fold.reasonKind);
			header.setAttribute("role", "button");
			header.setAttribute("tabindex", "0");
			header.setAttribute("aria-expanded", "false");
			header.setAttribute("aria-label", fold.headerText);
			header.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))";

			var icon = doc.createElement("span");
			icon.className = "dsao-tf-headerIcon";
			icon.setAttribute("data-state", fold.reasonKind === "error" ? "error" : "ok");
			icon.innerHTML = iconForReason(fold.reasonKind);

			var text = doc.createElement("span");
			text.className = "dsao-tf-headerText";
			text.textContent = fold.headerText;

			var spacer = doc.createElement("span");
			spacer.className = "dsao-tf-headerSpacer";

			// 插话计数：右置独立元素（折叠时显示「N 条插话」），与头文案解耦，
			// updateHeader 随 steeringCount 同步刷新；0 时经 CSS 隐藏。
			var steer = doc.createElement("span");
			steer.className = "dsao-tf-steerCount";
			steer.setAttribute("data-dsao-tf-steer", String(fold.steeringCount || 0));
			steer.textContent = (fold.steeringCount || 0) > 0 ? fold.steeringCount + " 条插话" : "";

			var toggle = doc.createElement("span");
			toggle.className = "dsao-tf-toggle";
			var chevron = doc.createElement("span");
			chevron.className = "dsao-tf-chevron";
			chevron.innerHTML = CHEVRON_SVG;
			toggle.appendChild(chevron);

			header.appendChild(icon);
			header.appendChild(text);
			header.appendChild(spacer);
			header.appendChild(steer);
			header.appendChild(toggle);
			return header;
		}

		function updateHeader(header, fold, expanded) {
			header.setAttribute("data-dsao-tf-state", expanded ? "expanded" : "collapsed");
			header.setAttribute("aria-expanded", expanded ? "true" : "false");
			var text = header.querySelector(".dsao-tf-headerText");
			if (text && text.textContent !== fold.headerText) text.textContent = fold.headerText;
			// 插话计数右置元素：随 steeringCount 同步（0 → CSS 隐藏）
			var steer = header.querySelector(".dsao-tf-steerCount");
			if (steer) {
				var n = fold.steeringCount || 0;
				steer.setAttribute("data-dsao-tf-steer", String(n));
				steer.textContent = n > 0 ? n + " 条插话" : "";
			}
			header.setAttribute("aria-label", fold.headerText +
				((fold.steeringCount || 0) > 0 ? " · " + fold.steeringCount + " 条插话" : ""));
			// 状态图标随 reasonKind 同步刷新：折叠头可能在早期状态创建（如中间段
			// 单独成组时是「已出错」红点），链归并后状态取末段（已完成），文案换而
			// 图标滞留会出现「红点 + 已完成」错位。
			if (header.getAttribute("data-dsao-tf-reason") !== fold.reasonKind) {
				header.setAttribute("data-dsao-tf-reason", fold.reasonKind);
				var icon = header.querySelector(".dsao-tf-headerIcon");
				if (icon) {
					icon.setAttribute("data-state", fold.reasonKind === "error" ? "error" : "ok");
					icon.innerHTML = iconForReason(fold.reasonKind);
				}
			}
		}

		function findHeaderBefore(anchorEl) {
			// Walk backward past non-flow-item siblings (e.g. tool-group headers)
			// to find an existing turn-fold header that may have been separated
			// from its anchor by an injected element.
			var prev = anchorEl && anchorEl.previousElementSibling;
			while (prev) {
				if (prev.getAttribute && prev.getAttribute("data-dsao-tf-header") !== null) return prev;
				if (isFlowItemEl(prev)) break;
				prev = prev.previousElementSibling;
			}
			return null;
		}

		function isFlowItemEl(el) {
			return !!(el && el.getAttribute && el.getAttribute("data-chat-flow-key") !== null);
		}

		// 创建「运行中 · 计时」行（纯状态展示，不可点）。计时文本由 tick 每秒刷新。
		function createRunningRow(run, doc) {
			var row = doc.createElement("div");
			row.className = "dsao-tf-running";
			row.setAttribute("data-dsao-tf-running", String(run.turn));
			row.setAttribute("data-dsao-tf-start", String(run.startTime));
			row.setAttribute("role", "status");
			row.setAttribute("aria-live", "polite");
			row.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))";

			var icon = doc.createElement("span");
			icon.className = "dsao-tf-runningIcon";
			var dot = doc.createElement("span");
			dot.className = "dsao-tf-runningDot";
			icon.appendChild(dot);

			var text = doc.createElement("span");
			text.className = "dsao-tf-runningText";
			text.textContent = runningText(run.startTime);

			row.appendChild(icon);
			row.appendChild(text);
			return row;
		}

		function runningText(startTime) {
			return "运行中 · " + formatDuration(Math.max(0, Date.now() - startTime));
		}

		/**
			* 幂等收敛运行中行：不存在则创建到锚点位置；位置漂移则移动；
			* 起点变化则更新 data-dsao-tf-start。before=true 插在 anchor 前，
			* 否则插在 anchor 后（anchor 是该 turn 最后一个节点）。
		*/
		function ensureRunningRow(column, run, anchorEl) {
			var existing = column.querySelector('[data-dsao-tf-running="' + run.turn + '"]');
			if (run.before) {
				if (!existing) {
					column.insertBefore(createRunningRow(run, column.ownerDocument), anchorEl);
				} else if (anchorEl.previousElementSibling !== existing) {
					column.insertBefore(existing, anchorEl);
				}
			} else {
				if (!existing) {
					column.insertBefore(createRunningRow(run, column.ownerDocument), anchorEl.nextElementSibling);
				} else if (anchorEl.nextElementSibling !== existing) {
					column.insertBefore(existing, anchorEl.nextElementSibling);
				}
			}
			var live = column.querySelector('[data-dsao-tf-running="' + run.turn + '"]');
			if (live && live.getAttribute("data-dsao-tf-start") !== String(run.startTime)) {
				live.setAttribute("data-dsao-tf-start", String(run.startTime));
			}
		}

		function stripColumn(column) {
			var hidden = column.querySelectorAll("[data-dsao-tf-hidden]");
			for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute("data-dsao-tf-hidden");
			var closing = column.querySelectorAll("[data-dsao-tf-closing-folded]");
			for (var n = 0; n < closing.length; n++) closing[n].removeAttribute("data-dsao-tf-closing-folded");
			var endMarks0 = column.querySelectorAll("[data-dsao-tf-process-end]");
			for (var e0 = 0; e0 < endMarks0.length; e0++) {
				endMarks0[e0].removeAttribute("data-dsao-tf-process-end");
				endMarks0[e0].style.borderBottom = "";
			}
			var headers = column.querySelectorAll("[data-dsao-tf-header]");
			for (var j = 0; j < headers.length; j++) {
				if (headers[j].parentNode) headers[j].parentNode.removeChild(headers[j]);
			}
			var running = column.querySelectorAll("[data-dsao-tf-running]");
			for (var r = 0; r < running.length; r++) {
				if (running[r].parentNode) running[r].parentNode.removeChild(running[r]);
			}
			var tg = column.querySelectorAll("[data-dsao-tg-header][data-dsao-tf-hidden]");
			for (var k = 0; k < tg.length; k++) tg[k].removeAttribute("data-dsao-tf-hidden");
		}

		/**
		 * 把折叠计划应用到一列（幂等收敛：按 key 对 diff 隐藏属性，按 turn 对 diff 折叠头）。
		 */
		function applyPlanToColumn(column, plan, expandedSet) {
			var items = column.querySelectorAll("[data-chat-flow-key]");
			if (items.length === 0) return;
			// 列归属校验：全部 key 都不在本会话 order 中 → 不是本会话的列，清掉自己的标记。
			// 部分不匹配（历史分页 prepend 时 session ref 暂时落后）只跳过未知项，不拆列。
			var unknown = 0;
			for (var i = 0; i < items.length; i++) {
				if (!plan.keySet.has(items[i].getAttribute("data-chat-flow-key"))) unknown++;
			}
			// 临时诊断：会话切换键匹配率单行日志（定位「切回会话组头裸露」用，定位后移除）
			try {
				console.debug("[DSAO-TF]", "items=" + items.length, "unknown=" + unknown,
					"folds=" + plan.folds.length, unknown > 0 && unknown === items.length ? "strip" : "apply");
			} catch (e) {}
			if (unknown > 0 && unknown === items.length) {
				stripColumn(column);
				return;
			}

			var byKey = {};
			for (var b = 0; b < items.length; b++) byKey[items[b].getAttribute("data-chat-flow-key")] = items[b];

			var toHide = {};
			var toCloseFold = {};
			var f;
			for (f = 0; f < plan.folds.length; f++) {
				var fold = plan.folds[f];
				if (expandedSet[fold.turn]) continue;
				var hk;
				for (hk = 0; hk < fold.hiddenKeys.length; hk++) toHide[fold.hiddenKeys[hk]] = true;
				if (fold.closingKey) toCloseFold[fold.closingKey] = true;
			}

			var k2;
			for (k2 in byKey) {
				var el = byKey[k2];
				if (toHide[k2]) {
					if (!el.hasAttribute("data-dsao-tf-hidden")) el.setAttribute("data-dsao-tf-hidden", "");
				} else if (el.hasAttribute("data-dsao-tf-hidden")) {
					el.removeAttribute("data-dsao-tf-hidden");
				}
				if (toCloseFold[k2]) {
					if (!el.hasAttribute("data-dsao-tf-closing-folded")) el.setAttribute("data-dsao-tf-closing-folded", "");
				} else if (el.hasAttribute("data-dsao-tf-closing-folded")) {
					el.removeAttribute("data-dsao-tf-closing-folded");
				}
			}

			// tool-group 折叠头隐藏：位置域归属判定。
			// 组头所属 turn = 其后第一个 key 已知 flowItem 的 turn（向前跨越非 flow 节点与
			// key 未知项，如窗口重投影导致的失配成员）；该 turn 已折叠且未被用户展开 → 隐藏。
			// 与成员的 tf-hidden 状态、组头邻接性完全解耦：成员 key 部分失配或组头泄漏
			// 堆叠在折叠区间内时，同样按位置域收起（切回会话冻结态的根因修复）。
			var foldTurns = {};
			for (f = 0; f < plan.folds.length; f++) foldTurns[plan.folds[f].turn] = true;
			var tgHeaders = column.querySelectorAll("[data-dsao-tg-header]");
			for (var t = 0; t < tgHeaders.length; t++) {
				var th = tgHeaders[t];
				var ownerTurn;
				var nx = th.nextElementSibling;
				while (nx) {
					if (nx.getAttribute && nx.getAttribute("data-chat-flow-key") !== null) {
						ownerTurn = plan.turnOf.get(nx.getAttribute("data-chat-flow-key"));
						if (ownerTurn !== undefined) break;
					}
					nx = nx.nextElementSibling;
				}
				// 向后回退：向前走不到已知 key（右侧全为失配成员或已到列尾）时，按左侧
				// 最近已知 flowItem 的 turn 归属。组头只注入在组首成员前，天然落在所属
				// turn 区间内；泄漏头也堆在区间边界上，左侧归属与真实归属一致。两个折叠
				// 区之间无歧义：左侧 turn 已折叠且未展开 → 同样隐藏（失配窗口冻结态兜底）。
				if (ownerTurn === undefined) {
					var pv = th.previousElementSibling;
					while (pv) {
						if (pv.getAttribute && pv.getAttribute("data-chat-flow-key") !== null) {
							ownerTurn = plan.turnOf.get(pv.getAttribute("data-chat-flow-key"));
							if (ownerTurn !== undefined) break;
						}
						pv = pv.previousElementSibling;
					}
				}
				var shouldHideTg = ownerTurn !== undefined && !!foldTurns[ownerTurn] && !expandedSet[ownerTurn];
				if (shouldHideTg) {
					if (!th.hasAttribute("data-dsao-tf-hidden")) th.setAttribute("data-dsao-tf-hidden", "");
				} else if (th.hasAttribute("data-dsao-tf-hidden")) {
					th.removeAttribute("data-dsao-tf-hidden");
				}
			}

			// 折叠头：创建/更新/清理
			var seenTurns = {};
			var validHeaders = {};
			for (f = 0; f < plan.folds.length; f++) {
				var fold2 = plan.folds[f];
				seenTurns[fold2.turn] = true;
				var anchor = byKey[fold2.anchorKey];
				if (!anchor) continue;
				var existing = findHeaderBefore(anchor);
				var expanded = !!expandedSet[fold2.turn];
				if (!existing) {
					existing = createHeader(fold2, column.ownerDocument);
					column.insertBefore(existing, anchor);
				} else if (existing.getAttribute("data-dsao-tf-header") !== String(fold2.turn)) {
					if (existing.parentNode) existing.parentNode.removeChild(existing);
					existing = createHeader(fold2, column.ownerDocument);
					column.insertBefore(existing, anchor);
				}
				updateHeader(existing, fold2, expanded);
				validHeaders[fold2.turn] = existing;
			}
			var stale = column.querySelectorAll("[data-dsao-tf-header]");
			var keptTurns = {};
			for (var s2 = 0; s2 < stale.length; s2++) {
				var el = stale[s2];
				var turnNum = parseInt(el.getAttribute("data-dsao-tf-header"), 10);
				if (!seenTurns[turnNum]) {
					if (el.parentNode) el.parentNode.removeChild(el);
				} else if (validHeaders[turnNum]) {
					// 保锚点邻接头：泄漏头（React 不管理注入节点，切会话原地留存）可能与
					// 正头同 turn 号且堆在列首——按 DOM 顺序保第一个会把对的删掉，
					// 必须按锚点归属保。
					if (el !== validHeaders[turnNum] && el.parentNode) el.parentNode.removeChild(el);
				} else if (keptTurns[turnNum]) {
					// 锚点失配（该 turn 无 valid 头）：退回保第一个
					if (el.parentNode) el.parentNode.removeChild(el);
				} else {
					keptTurns[turnNum] = true;
				}
			}

			// 展开态收尾分割线：过程块与总结回复之间的下划线。折叠态由折叠头的
			// border 承担；展开态落在 closing 前最后一个 flow item 上。复用折叠计划
			// 里的 closingKey 定位，零额外计算；收起时清除（属性 + 内联样式）。
			var processEndSeen = {};
			for (f = 0; f < plan.folds.length; f++) {
				var fold3 = plan.folds[f];
				if (!expandedSet[fold3.turn] || !fold3.closingKey) continue;
				var closingEl = byKey[fold3.closingKey];
				if (!closingEl) continue;
				var prevEl = closingEl.previousElementSibling;
				while (prevEl && !(prevEl.getAttribute && prevEl.getAttribute("data-chat-flow-key") !== null)) {
					prevEl = prevEl.previousElementSibling;
				}
				if (!prevEl) continue;
				if (!prevEl.hasAttribute("data-dsao-tf-process-end")) prevEl.setAttribute("data-dsao-tf-process-end", "");
				prevEl.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))";
				processEndSeen[prevEl.getAttribute("data-chat-flow-key")] = true;
			}
			var endMarks = column.querySelectorAll("[data-dsao-tf-process-end]");
			for (var em = 0; em < endMarks.length; em++) {
				if (!processEndSeen[endMarks[em].getAttribute("data-chat-flow-key")]) {
					endMarks[em].removeAttribute("data-dsao-tf-process-end");
					endMarks[em].style.borderBottom = "";
				}
			}

			// 运行中行：创建/移动/清理（turn 结束 → 该行移除，由折叠头接替）
			var seenRuns = {};
			var r;
			for (r = 0; r < plan.runs.length; r++) {
				var run = plan.runs[r];
				seenRuns[run.turn] = true;
				var runAnchor = byKey[run.anchorKey];
				if (!runAnchor) continue;
				ensureRunningRow(column, run, runAnchor);
			}
			var staleRuns = column.querySelectorAll("[data-dsao-tf-running]");
			for (var sr = 0; sr < staleRuns.length; sr++) {
				var rturn = parseInt(staleRuns[sr].getAttribute("data-dsao-tf-running"), 10);
				if (!seenRuns[rturn] && staleRuns[sr].parentNode) staleRuns[sr].parentNode.removeChild(staleRuns[sr]);
			}

			// 分割线兜底：每次同步对列内所有折叠头/运行行内联补写下边框，
			// 不依赖创建路径与 CSS 注入时序（样式表缓存时仍保证可见）。
			var seps = column.querySelectorAll("[data-dsao-tf-header],[data-dsao-tf-running]");
			for (var sp = 0; sp < seps.length; sp++) {
				seps[sp].style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))";
			}
		}

		// ── React 挂载 ─────────────────────────────────────────────────────

		/**
		 * 挂在 conversation.input.right：渲染不可见锚点，订阅当前会话快照 +
		 * 观察聊天列 DOM 变化，驱动折叠同步。
		 * resetGroups/rescanGroups（可选，DI 自 tool-group）：会话切换收敛时复位
		 * 并重建工具组注入——两个模块的注入头都是 React 不管理的外来节点，必须
		 * 在同一时机一起拆、一起重建，否则泄漏头跨会话堆积（turn 号跨会话碰撞）。
		 */
		function createTurnFold(React, resetGroups, rescanGroups) {
			function TurnFoldMount(props) {
				var markerRef = React.useRef(null);
				var sessionRef = React.useRef(props.session);
				sessionRef.current = props.session;
				var sessionIdRef = React.useRef(props.sessionId);
				sessionIdRef.current = props.sessionId;
				var syncRef = React.useRef(null);
				var convergeRef = React.useRef(null);
				var prevSessionIdRef = React.useRef(null);

				// 会话 id 解析：槽位 prop 缺失时回退到快照上的 sessionId。
				// userExpanded 以此为键——解析不出非空 id 时不读键、不落键，
				// 避免以 undefined/"" 为键造成跨会话展开态污染。
				function resolveSessionId() {
					var id = sessionIdRef.current;
					if (typeof id !== "string" || id === "") {
						var s = sessionRef.current;
						if (s && typeof s.sessionId === "string" && s.sessionId !== "") id = s.sessionId;
					}
					return typeof id === "string" ? id : "";
				}

				React.useEffect(function () {
					var marker = markerRef.current;
					var doc = marker && marker.ownerDocument ? marker.ownerDocument : document;
					if (!doc || !doc.body) return;
					ensureStyles(doc);

					var userExpanded = {};
					var enabled = loadEnabled();
					var timer = null;

					function columnList() {
						return doc.querySelectorAll("[data-chat-flow]");
					}

					// ── 滚动锚定补偿 ─────────────────────────────────────────
					// 「加载更早」场景：DSH 在 prepend 的布局 effect 里同步补偿滚动
					// 锚点，而本插件的折叠在其后异步落地——锚点上方内容塌缩使补偿
					// 失准（视口跳到很下面）。处理：把本次 sync 的 DOM 变更用「首
					// 视口元素锚点」括起来，变更前后各测一次 rect，差值写回
					// scrollTop，钉住正在看的内容。|delta|≤0.5px 不写，避免干扰
					// DSH 的 follow-scroll / toBottom。
					//
					// 底部意图：变更前列已在底部（距底 ≤0.5px）时不做锚点钉住，改走
					// 「钉底」语义（与 DSH follow 一致）：
					//   · 塌缩 → 浏览器自动把 scrollTop 钳到新 floor（落点恰在 floor
					//     上，DSH observed-top 账本把这类钳制归因为自身，follow 不
					//     脱钩）；
					//   · 净增高 → pinFloor 显式写回 floor（与 DSH toBottom 同式，
					//     落在 floor 上，账本归因中性）。
					// 为何必须在底部时弃锚点：锚点钉住的目标是「保住正在读的
					// 内容」（中部阅读语义）；底部读者若仍钉视口顶行，写回会落
					// 在新 floor 上方——converge 的 strip 先把列撑高（floor 静默
					// 下移、无 scroll 事件、DSH 账本不更新），重折叠后顶行被钉
					// 住即偏离 floor 数百 px 起。DSH 把偏离账本 >0.5px 的滚动一
					// 律归因为读端输入：>24px 即脱钩 follow 并把中部位置持久化
					// 进 chatScrollPositions——之后每次打开该会话 restore 中部
					// 位置取代 toBottom（「打开会话后滚动条未定位到底部」的根
					// 因）。
					function scrollContainerOf(column) {
						var el = column.parentElement;
						while (el && el.nodeType === 1) {
							var mode = null;
							try { mode = doc.defaultView.getComputedStyle(el).overflowY; } catch (e) {}
							if (mode !== "auto" && mode !== "scroll" && el.style &&
								(el.style.overflowY === "auto" || el.style.overflowY === "scroll")) {
								mode = el.style.overflowY;
							}
							if (mode === "auto" || mode === "scroll") return el;
							el = el.parentElement;
						}
						return doc.scrollingElement || doc.documentElement;
					}

					function viewportAnchor(column) {
						var container = scrollContainerOf(column);
						var cRect = container.getBoundingClientRect();
						var items = column.querySelectorAll("[data-chat-flow-key]");
						for (var i = 0; i < items.length; i++) {
							var el = items[i];
							if (el.hasAttribute("data-dsao-tf-hidden")) continue;
							var r = el.getBoundingClientRect();
							if (r.bottom >= cRect.top && r.top <= cRect.bottom) {
								return { el: el, top: r.top, container: container };
							}
						}
						return null;
					}

					function restoreAnchor(anchor) {
						var el = anchor.el;
						var r = el.getBoundingClientRect();
						if (r.height === 0 && r.top === 0) {
							// 锚点行本次被折叠：挂到所在组的折叠头上（块首代表元素）
							var header = null;
							var prev = el.previousElementSibling;
							while (prev) {
								if (prev.getAttribute && prev.getAttribute("data-dsao-tf-header") !== null) { header = prev; break; }
								if (prev.getAttribute && prev.getAttribute("data-chat-flow-key") !== null &&
									!prev.hasAttribute("data-dsao-tf-hidden")) break;
								prev = prev.previousElementSibling;
							}
							if (header === null) return; // 定位不到代表元素 → 放弃补偿（不写滚动）
							el = header;
							r = el.getBoundingClientRect();
						}
						var delta = r.top - anchor.top;
						if (delta > 0.5 || delta < -0.5) anchor.container.scrollTop += delta;
					}

					// 变更前的底部状态：距底 ≤0.5px 视为在底部（与 DSH 账本的
					// 0.5px 归因容差同量级）。converge 必须在 strip 前采样
					// （strip 撑高列后 floor 下移，再采样会把「本在底部」误判
					// 为中部）。
					// clientHeight=0（无布局环境 / 未渲染容器）时几何不可测
					// → 底部态不可判定，按中部处理（回退传统锚点补偿；对零
					// 高容器是无害 no-op）。
					function floorState(column) {
						var container = scrollContainerOf(column);
						return {
							container: container,
							atBottom: container.clientHeight > 0 &&
								container.scrollTop + container.clientHeight >= container.scrollHeight - 0.5
						};
					}

					// 钉底（已在底部则无写）：底部意图下「净增高」把底部读
					// 者抛离 floor 时的兜底；写 H 由浏览器钳到 floor，落点
					// 恰在 floor 上，DSH 账本归因中性（floor 落点必然 ≤24px
					// 内 → isAtBottom 恒真）。
					function pinFloor(column) {
						var container = scrollContainerOf(column);
						if (container.scrollTop + container.clientHeight < container.scrollHeight - 0.5) {
							container.scrollTop = container.scrollHeight;
						}
					}

					// 当前折叠计划的隐藏集（本会话、未展开 turn 的 hiddenKeys）。
					// 「存活行」锚点选择用：集内行会被折叠隐藏，不能当稳定锚点。
					function planHiddenSet() {
						var session = sessionRef.current;
						if (!enabled || !session || !session.chat) return null;
						var plan = planTurnFold(session);
						if (!plan.keySet) return null;
						var sid = resolveSessionId();
						var expandedSet = sid !== "" ? (userExpanded[sid] || {}) : {};
						var hidden = {};
						for (var f = 0; f < plan.folds.length; f++) {
							if (expandedSet[plan.folds[f].turn]) continue;
							var hks = plan.folds[f].hiddenKeys;
							for (var k = 0; k < hks.length; k++) hidden[hks[k]] = true;
						}
						return hidden;
					}

					// converge 的锚点选择：视口顶边穿过的第一个「存活行」（不在
					// 当前计划隐藏集里的行）——折叠后仍留在视口顶部的行。判据
					// bottom > 视口顶（与 DSH pagingAnchor 一致）：DSH 切走前
					// saved 位置锚定的正是该行（折叠态顶行只可能是存活行），
					// 钉住它 = 切回视图精确复现切走前状态；净零轮的 strip→
					// refold 把它恰好移回原位，delta=0 不写、视图不变。退化
					// 兜底：视口内无存活行时取首个相交行（viewportAnchor 语义）。
					function survivingAnchor(column, hidden) {
						var container = scrollContainerOf(column);
						var cRect = container.getBoundingClientRect();
						var items = column.querySelectorAll("[data-chat-flow-key]");
						var fallback = null;
						for (var i = 0; i < items.length; i++) {
							var el = items[i];
							if (el.hasAttribute("data-dsao-tf-hidden")) continue;
							var r = el.getBoundingClientRect();
							if (r.bottom < cRect.top || r.top > cRect.bottom) continue;
							if (!fallback) fallback = { el: el, top: r.top, container: container };
							if (r.bottom > cRect.top && !hidden[el.getAttribute("data-chat-flow-key")]) {
								return { el: el, top: r.top, container: container };
							}
						}
						return fallback;
					}

					// bottomIntent / preAnchors：变更前采样的 floorState 与锚点
					// 数组（converge 传入 strip 前采样；锚点必须在 strip 前采样
					// ——重展开会改变视口顶边所在的行，事后重选会把钉住目标漂到
					// 更高的行上）。缺省时在 sync 内采样（此时列尚未被改动，同
					// 样即变更前态；禁用分支逐列在 strip 前采样）。
					function sync(bottomIntent, preAnchors) {
						var session = sessionRef.current;
						var sessionId = resolveSessionId();
						function intentOf(col, idx) {
							return bottomIntent ? !!bottomIntent[idx].atBottom : floorState(col).atBottom;
						}
						function anchorOf(col, idx) {
							return preAnchors && preAnchors[idx] !== undefined ? preAnchors[idx] : viewportAnchor(col);
						}
						if (!enabled) {
							var cols0 = columnList();
							for (var c0 = 0; c0 < cols0.length; c0++) {
								var bottom0 = intentOf(cols0[c0], c0);
								var anchor0 = bottom0 ? null : anchorOf(cols0[c0], c0);
								stripColumn(cols0[c0]);
								if (anchor0) restoreAnchor(anchor0);
								else if (bottom0) pinFloor(cols0[c0]);
							}
							return;
						}
						if (!session || !session.chat) return;
						var plan = planTurnFold(session);
						if (!plan.keySet) return;
						var expandedSet = sessionId !== "" ? (userExpanded[sessionId] || {}) : {};
						var cols = columnList();
						for (var c = 0; c < cols.length; c++) {
							var bottom = intentOf(cols[c], c);
							var anchor = bottom ? null : anchorOf(cols[c], c);
							applyPlanToColumn(cols[c], plan, expandedSet);
							if (anchor) restoreAnchor(anchor);
							else if (bottom) pinFloor(cols[c]);
						}
					}

					function scheduleSync() {
						if (timer !== null) return;
						timer = setTimeout(function () {
							timer = null;
							sync();
						}, 80);
					}
					syncRef.current = scheduleSync;

					// 会话切换收敛：全量拆除两个模块的注入痕迹，再按当前 DOM 重建。
					// 注入头是 React 不管理的外来节点，切换会话时 React 只换 keyed 子元素，
					// 注入头原地留存并堆进新会话的列（「多个 turn / 工具组在外面」的根源）。
					// 顺序：拆（tf 全列 strip + tg 复位）→ tg 全量重建 → tf 立即同步。
					// 直接同步不走防抖：拆与建同帧完成，运行中行不闪烁。
					// 工具组侧故障不允许拖垮折叠同步（此处曾因 lib 与 src 的 tool-group
					// 状态变量分叉抛 ReferenceError，导致 strip 后永不重建 = 折叠消失）：
					// DI 调用整体 try/catch 隔离，rescanGroups 必须显式传根节点。
					function converge() {
						var cols = columnList();
						// 底部意图与锚点都必须在 strip 前采样：
						// · strip 撑高列后 floor 静默下移（无 scroll 事件、DSH
						//   账本不更新），再采样会把「本在底部」误判为中部（见
						//   上方「底部意图」注释）；
						// · 重展开会改变视口顶边所在的行（同一 scrollTop 指向
						//   更高的内容），事后重选锚点会钉住更高的行——对已
						//   收敛列的每一轮 converge 都把中部读者的视图上漂一个
						//   过程块高度，且 DSH 账本按「读端滚动」保存漂后位置
						//   （「切回后既不在底部也不在切走前位置」的根因，逐次
						//   切换累积）。改用 strip 前的「存活行」锚点
						//   （survivingAnchor）：切回时精确复现 DSH restore 的
						//   切走前视图；净零轮 delta=0 不写、视图不变。
						var hidden = planHiddenSet();
						var intent = [];
						var anchors = [];
						for (var i = 0; i < cols.length; i++) {
							intent.push(floorState(cols[i]));
							anchors.push(intent[i].atBottom ? null
								: (hidden ? survivingAnchor(cols[i], hidden) : viewportAnchor(cols[i])));
						}
						for (var j = 0; j < cols.length; j++) stripColumn(cols[j]);
						try {
							if (resetGroups) resetGroups();
							if (rescanGroups) rescanGroups(doc.body);
						} catch (e) {}
						sync(intent, anchors);
					}
					convergeRef.current = converge;

					function hasFlowDelta(mutations) {
						for (var i = 0; i < mutations.length; i++) {
							var m = mutations[i];
							if (m.type !== "childList") continue;
							var list = m.addedNodes.length > 0 ? m.addedNodes : m.removedNodes;
							for (var j = 0; j < list.length; j++) {
								var node = list[j];
								if (!node || node.nodeType !== 1) continue;
								if (node.getAttribute && (node.getAttribute("data-chat-flow-key") !== null ||
									node.getAttribute("data-dsao-tf-header") !== null ||
									node.getAttribute("data-dsao-tg-header") !== null)) return true;
								if (node.querySelectorAll && (node.querySelector("[data-chat-flow-key]") ||
									node.querySelector("[data-dsao-tf-header]") ||
									node.querySelector("[data-dsao-tg-header]"))) return true;
							}
						}
						return false;
					}
					var obs = new MutationObserver(function (muts) {
						if (hasFlowDelta(muts)) scheduleSync();
					});
					obs.observe(doc.body, { childList: true, subtree: true });

					// 运行中行的计时每秒跳动（读取 data-dsao-tf-start，无运行中行时零开销）
					var tickTimer = setInterval(function () {
						var rows = doc.querySelectorAll("[data-dsao-tf-running]");
						for (var i = 0; i < rows.length; i++) {
							var start = parseInt(rows[i].getAttribute("data-dsao-tf-start"), 10);
							if (isNaN(start)) continue;
							var textEl = rows[i].querySelector(".dsao-tf-runningText");
							if (textEl) textEl.textContent = runningText(start);
						}
					}, 1000);

					function onToggle(e) {
						var target = e.target;
						if (!target || !target.closest) return;
						var header = target.closest("[data-dsao-tf-header]");
						if (!header) return;
						e.preventDefault();
						e.stopPropagation();
						var sessionId = resolveSessionId();
						if (sessionId === "") return;
						var turn = parseInt(header.getAttribute("data-dsao-tf-header"), 10);
						if (isNaN(turn)) return;
						if (!userExpanded[sessionId]) userExpanded[sessionId] = {};
						var map = userExpanded[sessionId];
						if (map[turn]) delete map[turn];
						else map[turn] = true;
						sync();
					}
					function onClick(e) { onToggle(e); }
					function onKeydown(e) {
						if (e.key !== "Enter" && e.key !== " ") return;
						var target = e.target;
						if (!target || !target.closest) return;
						if (!target.closest("[data-dsao-tf-header]")) return;
						e.preventDefault();
						e.stopPropagation();
						onToggle(e);
					}
					function onSettingChange() {
						enabled = loadEnabled();
						sync();
					}
					doc.addEventListener("click", onClick);
					doc.addEventListener("keydown", onKeydown);
					window.addEventListener("dsao:turn-fold-changed", onSettingChange);

					sync();

					return function () {
						if (timer !== null) clearTimeout(timer);
						timer = null;
						clearInterval(tickTimer);
						obs.disconnect();
						doc.removeEventListener("click", onClick);
						doc.removeEventListener("keydown", onKeydown);
						window.removeEventListener("dsao:turn-fold-changed", onSettingChange);
						syncRef.current = null;
					};
				}, []);

				// 会话快照变化（含切换会话）→ 收敛 sweep：
				// · 会话 id 变化（含首次挂载）：走全量收敛（拆注入→tg 重建→tf 同步），把
				//   上一会话的注入泄漏在这一步根除；快照可能落后于 DOM（异步分页/部分加载
				//   窗口），主动多轮重跑（0/300/900/2000ms），快照补全后的轮次把状态拉回
				//   正确形态——否则 DOM 静止后没有新 mutation 能再触发同步（冻结态）。
				// · 同会话快照更新（流式 chunk）：只做轻量同步，不拆注入（保住用户手动
				//   展开的工具组与折叠头位置）。
				React.useEffect(function () {
					if (!convergeRef.current) return;
					var sid = resolveSessionId();
					var switched = prevSessionIdRef.current !== sid;
					prevSessionIdRef.current = sid;
					function run() {
						if (switched && convergeRef.current) convergeRef.current();
						else if (syncRef.current) syncRef.current();
					}
					run();
					var t2 = setTimeout(run, 300);
					var t3 = setTimeout(run, 900);
					var t4 = setTimeout(run, 2000);
					return function () { clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
				}, [props.session, props.sessionId]);

				return React.createElement("span", { ref: markerRef, style: { display: "none" } });
			}

			return { TurnFoldMount: TurnFoldMount };
		}

		// ── 设置项 ─────────────────────────────────────────────────────────

		function createTurnFoldSetting(React) {
			function TurnFoldSetting() {
				var s = React.useState(loadEnabled()), enabled = s[0], setEnabled = s[1];

				React.useEffect(function () {
					function handler() { setEnabled(loadEnabled()); }
					window.addEventListener("dsao:turn-fold-changed", handler);
					return function () { window.removeEventListener("dsao:turn-fold-changed", handler); };
				}, []);

				function toggle() {
					var next = !enabled;
					setEnabled(next);
					saveEnabled(next);
				}

				var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
				var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
				var checkStyle = { width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)" };

				var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Turn Folding");
				var rightCol = React.createElement("input", {
					type: "checkbox",
					checked: enabled,
					onChange: toggle,
					style: checkStyle,
					"aria-label": "回合过程折叠"
				});
				return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
			}
			return TurnFoldSetting;
		}

		exports.STORAGE_KEY = STORAGE_KEY;
		exports.TERMINAL_LABELS = TERMINAL_LABELS;
		exports.loadEnabled = loadEnabled;
		exports.saveEnabled = saveEnabled;
		exports.formatDuration = formatDuration;
		exports.terminalLabel = terminalLabel;
		exports.isProcessNode = isProcessNode;
		exports.isResumeMarkerNode = isResumeMarkerNode;
		exports.mergeResumeFolds = mergeResumeFolds;
		exports.planTurnFold = planTurnFold;
		exports.ensureStyles = ensureStyles;
		exports.stripColumn = stripColumn;
		exports.applyPlanToColumn = applyPlanToColumn;
		exports.createRunningRow = createRunningRow;
		exports.ensureRunningRow = ensureRunningRow;
		exports.runningText = runningText;
		exports.createTurnFold = createTurnFold;
		exports.createTurnFoldSetting = createTurnFoldSetting;

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
		var turnFold = require("dsao/turn-fold");

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

			// 2c. Settings page: turn folding toggle
			slots.inject("settings.general.item", function () {
				var TurnFoldSetting = turnFold.createTurnFoldSetting(React);
				return slots.register(
					{ name: "settings.general.item", id: "turn-fold", order: 50 },
					function () { return React.createElement(TurnFoldSetting); }
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
			// 3d. 回合过程折叠：隐藏锚点挂在输入行，同步器观察聊天列 DOM +
			//     会话快照，把已完成 turn 的过程收起为「已完成 · 时长」一行。
			//     会话切换收敛需要拆掉两个模块的注入头再重建（注入头是 React 不管理
			//     的外来节点，跨会话原地泄漏），因此把 tool-group 的复位/重建函数
			//     经 DI 传入——缺省参数下行为退化为纯 tf 同步（测试环境用）。
			slots.inject("conversation.input.right", function () {
				return slots.register(
					{ name: "conversation.input.right", id: "dsao-turn-fold", order: 110, locale: "conversation" },
					turnFold.createTurnFold(React, toolGroup.resetToolGroups, toolGroup.scanToolGroups).TurnFoldMount
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
