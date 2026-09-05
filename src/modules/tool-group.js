
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

		/**
		 * Collect text content OUTSIDE [data-variant="think"] subtrees: start
		 * from el.textContent and subtract every think row's own text, at ANY
		 * depth (real DOM nests them: flowItem > markdown root > body >
		 * ProcessReasoning > ReasoningRow). think rows' texts are disjoint;
		 * split/join each away and the remainder is the non-think content.
		 * Test stub: textContent is the element's OWN text (flat model), so
		 * the subtraction is a no-op and the return value is already correct.
		 */
		function textOutsideThink(el) {
			var remaining = typeof el.textContent === "string" ? el.textContent : "";
			var thinks = el.querySelectorAll ? el.querySelectorAll("[data-variant=\"think\"]") : [];
			for (var i = 0; i < thinks.length; i++) {
				var t = typeof thinks[i].textContent === "string" ? thinks[i].textContent : "";
				if (t && remaining.indexOf(t) !== -1) {
					remaining = remaining.split(t).join("");
				}
			}
			return remaining;
		}

		/**
		 * 纯思考步判定：assistant-step 流项里只有 think/reasoning 折叠行、无其他
		 * 可见内容。这类步骤对分组是"透明"的——工具调用之间仅隔纯思考步时仍并入
		 * 同组（thinking 不参与分组边界判断）；折叠组时随跨度一起收起，展示沿用
		 * 既有 reasoning 折叠行（展开态原样显示，无新增形态）。
		 * 文本步（think + 正文）不是纯思考步，仍是分组边界。
		 */
		function isThinkingOnlyNode(el) {
			if (!el || !el.getAttribute) return false;
			if (el.getAttribute("data-chat-flow-kind") !== "assistant-step") return false;
			if (!el.querySelector) return false;
			var hasThink = false;
			try { hasThink = !!el.querySelector("[data-variant=\"think\"]"); } catch (e) { return false; }
			if (!hasThink) return false;
			return textOutsideThink(el).replace(/\s+/g, "").length === 0;
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
				if (!isTransparentNode(sibling) && !isThinkingOnlyNode(sibling) && !isTurnFoldHeader(sibling)) return false;
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

		// 组跨度内的纯思考步（从组头走到末成员——覆盖 header 与组首成员之间的
		// thinking）：随组标记缩进（复用成员的 data-dsao-tg-pos 20px 规则），折叠时
		// 一并收起、展开时恢复——展示沿用既有 reasoning 折叠行。
		function thinkingStepsInSpan(header, lastMember) {
			var out = [];
			if (!header || !lastMember) return out;
			var node = header.nextElementSibling;
			while (node && node !== lastMember) {
				if (isThinkingOnlyNode(node)) out.push(node);
				node = node.nextElementSibling;
			}
			return out;
		}

		function markSpanThinking(header, group, collapsed) {
			var thinks = thinkingStepsInSpan(header, group[group.length - 1]);
			for (var i = 0; i < thinks.length; i++) {
				thinks[i].setAttribute("data-dsao-tg-pos", "middle");
				if (collapsed) thinks[i].setAttribute("data-dsao-tg-collapsed", "");
				else thinks[i].removeAttribute("data-dsao-tg-collapsed");
			}
		}

		function applyCollapse(header, group) {
			header.setAttribute("data-dsao-tg-state", "collapsed");
			header.setAttribute("aria-expanded", "false");
			for (var i = 0; i < group.length; i++) {
				group[i].setAttribute("data-dsao-tg-collapsed", "");
			}
			markSpanThinking(header, group, true);
			var summary = header.querySelector("[data-dsao-tg-summary]");
			if (summary) summary.textContent = summaryText(group);
		}

		function applyExpand(header, group) {
			header.setAttribute("data-dsao-tg-state", "expanded");
			header.setAttribute("aria-expanded", "true");
			for (var i = 0; i < group.length; i++) {
				group[i].removeAttribute("data-dsao-tg-collapsed");
			}
			markSpanThinking(header, group, false);
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
				if (isTransparentNode(node) || isThinkingOnlyNode(node) || isTurnFoldHeader(node)) { node = node.nextElementSibling; continue; }
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
				if (existingHeader.getAttribute && existingHeader.getAttribute("data-chat-flow-key") !== null &&
					!isThinkingOnlyNode(existingHeader)) { existingHeader = null; break; }
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
					markSpanThinking(existingHeader, group, true);
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
			// 组头定位走跳过链（headerOfGroup）：头与组首之间可能隔着纯思考步，
			// 直接取 previousElementSibling 会在该场景下丢头（自动展开/收起失效）。
			var header = headerOfGroup(latestGroup);
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
				if (isTransparentNode(sibling) || isThinkingOnlyNode(sibling)) { sibling = sibling.nextElementSibling; continue; }
				return sibling;
			}
			return null;
		}

		function prevSignificantSibling(el) {
			var sibling = el.previousElementSibling;
			while (sibling) {
				if (isTransparentNode(sibling) || isThinkingOnlyNode(sibling) || isTurnFoldHeader(sibling)) { sibling = sibling.previousElementSibling; continue; }
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
			// 纯思考步的组标记全清（pos+collapsed）：活组的 markSpanThinking 在本轮
			// fullPipeline 后段重新标记（cleanup → detect → apply 顺序保证自愈），
			// 解散组的孤儿不残留。
			var collapsedThinks = root.querySelectorAll("[data-dsao-tg-collapsed]");
			for (var ct = 0; ct < collapsedThinks.length; ct++) {
				if (isThinkingOnlyNode(collapsedThinks[ct])) {
					collapsedThinks[ct].removeAttribute("data-dsao-tg-collapsed");
					collapsedThinks[ct].removeAttribute("data-dsao-tg-pos");
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
				if (!hasHeader) { unmarkGroupItem(el); continue; }
				// 流项中途过渡（纯思考步长出正文 → 变回边界）：不保留组缩进
				var kind = el.getAttribute ? el.getAttribute("data-chat-flow-kind") : null;
				if (kind !== "tool-call" && !isThinkingOnlyNode(el)) unmarkGroupItem(el);
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
				if (isTransparentNode(sibling) || isThinkingOnlyNode(sibling) || isTurnFoldHeader(sibling)) { sibling = sibling.previousElementSibling; continue; }
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
		// ── 视口锚定补偿（与 turn-fold 同款技术）──────────────────────────
		// 「加载更早」/ 会话切换时组头插入与组折叠让锚点上方塌缩 → 正在看的内容
		// 跳出视口。变更用「首视口元素锚点」括起来：变更前后各测一次 rect，差值
		// 写回 scrollTop。仅 full scan 生效——tail/attr 的变更都在尾部或高度中性。
		// 测试 stub 无 getBoundingClientRect → 直接跳过。
		function captureColumnAnchor(column) {
		  if (typeof column.getBoundingClientRect !== "function") return null;
		  var doc = column.ownerDocument || document;
		  var container = null;
		  var el = column.parentElement;
		  while (el && el.nodeType === 1) {
		    var mode = null;
		    try { mode = doc.defaultView.getComputedStyle(el).overflowY; } catch (e) {}
		    if (mode !== "auto" && mode !== "scroll" && el.style &&
		        (el.style.overflowY === "auto" || el.style.overflowY === "scroll")) {
		      mode = el.style.overflowY;
		    }
		    if (mode === "auto" || mode === "scroll") { container = el; break; }
		    el = el.parentElement;
		  }
		  if (!container) container = doc.scrollingElement || doc.documentElement;
		  var cRect = container.getBoundingClientRect();
		  var items = column.querySelectorAll("[data-chat-flow-key]");
		  for (var i = 0; i < items.length; i++) {
		    var item = items[i];
		    if (item.hasAttribute("data-dsao-tf-hidden") || item.hasAttribute("data-dsao-tg-collapsed")) continue;
		    var r = item.getBoundingClientRect();
		    if (r.bottom >= cRect.top && r.top <= cRect.bottom) {
		      return { el: item, top: r.top, container: container };
		    }
		  }
		  return null;
		}

		function restoreColumnAnchor(anchor) {
		  if (!anchor) return;
		  var el = anchor.el;
		  var r = el.getBoundingClientRect();
		  if (r.height === 0 && r.top === 0) {
		    // 锚点行被收起：挂到所属组头/折叠头（块首代表元素）
		    var header = null;
		    var prev = el.previousElementSibling;
		    while (prev) {
		      if (prev.getAttribute && (prev.getAttribute("data-dsao-tg-header") !== null ||
		          prev.getAttribute("data-dsao-tf-header") !== null)) { header = prev; break; }
		      if (prev.getAttribute && prev.getAttribute("data-chat-flow-key") !== null &&
		          !prev.hasAttribute("data-dsao-tg-collapsed") && !prev.hasAttribute("data-dsao-tf-hidden")) break;
		      prev = prev.previousElementSibling;
		    }
		    if (!header) return;
		    el = header;
		    r = el.getBoundingClientRect();
		  }
		  var delta = r.top - anchor.top;
		  if (delta > 0.5 || delta < -0.5) anchor.container.scrollTop += delta;
		}

		function fullPipeline(root) {
			if (!root || !root.querySelectorAll) return;
			ensureStyles();
			// 列域扫描：组/标记/思考行都活在 [data-chat-flow] 列内，按列收窄查询
			// （body 全树扫描会把侧栏/设置面板一起遍历）。单列时直接用列做根。
			var columns = (root.getAttribute && root.getAttribute("data-chat-flow") !== null)
				? [root]
				: Array.prototype.slice.call(root.querySelectorAll("[data-chat-flow]"));
			if (columns.length === 0) columns = [root];
			var anchors = [];
			for (var c0 = 0; c0 < columns.length; c0++) anchors.push(captureColumnAnchor(columns[c0]));
			var groups = [];
			for (var c = 0; c < columns.length; c++) {
				cleanupStaleMarkers(columns[c]);
				var columnGroups = detectGroups(columns[c]);
				for (var g0 = 0; g0 < columnGroups.length; g0++) groups.push(columnGroups[g0]);
			}
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
			for (var r0 = 0; r0 < anchors.length; r0++) restoreColumnAnchor(anchors[r0]);
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
				if (isTransparentNode(sibling) || isThinkingOnlyNode(sibling)) { sibling = sibling.previousElementSibling; continue; }
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
				if (isTransparentNode(member) || isThinkingOnlyNode(member)) { member = member.nextElementSibling; continue; }
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
			// 官方折叠同步在增量路径也要生效：turn 结束时 turn-tail/错误行以
			// tail add 到达、官方同时翻转成员 hidden——只靠全扫会让组头的
			// 跟随隐藏滞后（真实时序里下一次全扫可能很久不来）。
			syncHeadersToTurnFolds(null);
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
		exports.isThinkingOnlyNode = isThinkingOnlyNode;
		exports.textOutsideThink = textOutsideThink;
		exports.classifyMutations = classifyMutations;
		exports.scanStats = scanStats;
