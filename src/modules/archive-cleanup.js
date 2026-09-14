
		var ENDPOINT = "/api/dsao/archives";
		var EXPORT_ENDPOINT = "/api/session.export";
		var BYTES_UNITS = ["B", "KB", "MB", "GB", "TB"];
		var CSS_ID = "dsao-archive-cleanup-css";
		// An armed destructive button left standing is a mis-click waiting to happen.
		var ARM_TIMEOUT_MS = 8000;

		/**
		 * 设计令牌：100% 宿主别名（dsh-client-ui-theme 为每个令牌各定义了浅/深两值），
		 * 所以本页随外壳换肤，绝不硬编码颜色。`interactive-bg-*` 是交互色（hover / 选中 /
		 * 危险），`bg-layer-1` 是不透明面，`border-l1..l4` 是递增的描边强度。
		 *
		 * 为什么用 class 而不是 inline style：只有 CSS 能表达 :hover / :active /
		 * :focus-visible / sticky 表头 / prefers-reduced-motion——这四件事正是上一版
		 * 纯 inline 版本缺失的可达性与反馈。
		 */
		var CSS_LINES = [
			".dsao-ac-page{display:flex;flex-direction:column;width:100%;padding:4px 0 28px}",
			".dsao-ac-head{align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:4px;display:flex}",
			".dsao-ac-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:500;line-height:22px}",
			".dsao-ac-lede{color:var(--dsw-alias-label-secondary);max-width:72ch;margin:0 0 14px;font-size:12px;line-height:18px}",
			".dsao-ac-stats{flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:12px;display:flex}",
			".dsao-ac-stat{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:6px;align-items:center;gap:6px;height:24px;padding:0 8px;font-size:12px;line-height:18px;display:inline-flex;font-variant-numeric:tabular-nums}",
			".dsao-ac-stat b{color:var(--dsw-alias-label-primary);font-weight:500}",
			".dsao-ac-count{color:var(--dsw-alias-label-caption);font-size:12px;line-height:18px}",
			".dsao-ac-toolbar{flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;display:flex}",
			".dsao-ac-spacer{flex:1 1 auto}",
			".dsao-ac-btn{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);background:transparent;cursor:pointer;border-radius:6px;align-items:center;gap:6px;height:28px;padding:0 12px;font-family:inherit;font-size:13px;line-height:20px;display:inline-flex;transition:background-color .12s ease,border-color .12s ease}",
			".dsao-ac-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".dsao-ac-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}",
			".dsao-ac-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".dsao-ac-btn:disabled{opacity:.45;cursor:not-allowed}",
			".dsao-ac-btn--danger{color:var(--dsw-alias-state-error-primary)}",
			".dsao-ac-btn--danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".dsao-ac-btn--armed{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-border-l3);font-weight:500}",
			".dsao-ac-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".dsao-ac-banner{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;align-items:flex-start;gap:8px;margin-bottom:10px;padding:8px 10px;font-size:12px;line-height:18px;display:flex}",
			".dsao-ac-banner--error{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".dsao-ac-banner--warn{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-interactive-bg-hover)}",
			".dsao-ac-banner--ok{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}",
			".dsao-ac-scroll{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:8px;max-height:min(56vh,420px);overflow:auto}",
			".dsao-ac-scroll--loading{padding:0 10px}",
			".dsao-ac-table{border-collapse:collapse;table-layout:fixed;width:100%}",
			".dsao-ac-th{color:var(--dsw-alias-label-caption);text-align:left;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;z-index:1;padding:6px 8px;font-weight:400;font-size:12px;line-height:18px}",
			".dsao-ac-th--num{text-align:right}",
			".dsao-ac-td{border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);vertical-align:middle;padding:6px 8px;font-size:12px;line-height:18px}",
			".dsao-ac-td--muted{color:var(--dsw-alias-label-tertiary)}",
			".dsao-ac-td--num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dsao-ac-row{transition:background-color .12s ease}",
			".dsao-ac-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dsao-ac-row:last-child .dsao-ac-td{border-bottom:none}",
			".dsao-ac-row--on,.dsao-ac-row--on:hover{background:var(--dsw-alias-interactive-bg-active)}",
			".dsao-ac-nameCell{align-items:center;gap:6px;min-width:0;display:flex}",
			".dsao-ac-name{text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);cursor:pointer;min-width:0;font-size:13px;line-height:18px;display:block;overflow:hidden}",
			".dsao-ac-row--off .dsao-ac-name{color:var(--dsw-alias-label-dimmed);cursor:default}",
			".dsao-ac-check{accent-color:var(--dsw-alias-brand-primary);cursor:pointer;width:14px;height:14px;margin:0}",
			".dsao-ac-check:disabled{cursor:not-allowed}",
			".dsao-ac-check:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".dsao-ac-checkLabel{align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:18px;display:inline-flex}",
			".dsao-ac-pill{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-state-warn-label);border-radius:999px;white-space:nowrap;flex:0 0 auto;padding:0 6px;font-size:11px;line-height:16px;display:inline-block}",
			".dsao-ac-pill--bad{color:var(--dsw-alias-state-error-primary)}",
			".dsao-ac-link{color:var(--dsw-alias-label-secondary);white-space:nowrap;font-size:12px;text-decoration:none}",
			".dsao-ac-link:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}",
			".dsao-ac-link:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".dsao-ac-skel{border-radius:4px;background:var(--dsw-alias-bg-layer-2);animation:dsao-ac-pulse 1.2s ease-in-out infinite;height:12px;margin:8px 0}",
			"@keyframes dsao-ac-pulse{50%{opacity:.4}}",
			"@media (prefers-reduced-motion: reduce){.dsao-ac-skel{animation:none}.dsao-ac-btn,.dsao-ac-row{transition:none}}",
		].join("\n");

		/** Inject this page's stylesheet once per document (same pattern as the plugin's other modules). */
		function ensureCss(doc) {
			var d = doc || (typeof document !== "undefined" ? document : null);
			if (d === null || d === undefined) return false;
			if (typeof d.getElementById === "function" && d.getElementById(CSS_ID) !== null) return true;
			var style = d.createElement("style");
			style.id = CSS_ID;
			style.textContent = CSS_LINES;
			d.head.appendChild(style);
			return true;
		}

		/** Human-readable byte count; null (unknown size) renders as an em dash. */
		function formatBytes(bytes) {
			if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "—";
			var value = bytes;
			var unit = 0;
			while (value >= 1024 && unit < BYTES_UNITS.length - 1) {
				value /= 1024;
				unit += 1;
			}
			return (unit === 0 ? String(value) : value.toFixed(value < 10 ? 2 : 1)) + " " + BYTES_UNITS[unit];
		}

		/** Short day precision for a transcript's last write; missing values read as "—". */
		function formatDay(iso) {
			if (typeof iso !== "string" || iso === "") return "—";
			var date = new Date(iso);
			if (isNaN(date.getTime())) return "—";
			return date.getFullYear() + "-" + ("0" + (date.getMonth() + 1)).slice(-2) + "-" + ("0" + date.getDate()).slice(-2);
		}

		/** A row label needs the client's own session list: the host inventory carries ids and paths only. */
		function labelOf(rows, id) {
			var row = rows && rows.byId ? rows.byId[id] : undefined;
			if (row === undefined || row === null) return id.slice(0, 12);
			return row.label || row.title || id.slice(0, 12);
		}

		/**
		 * The project column shows *names*, never a path: last segment of a
		 * project directory, with trailing separators tolerated. `D:\proj\one`
		 * and `/srv/proj/one/` both read as `one`.
		 */
		function projectName(text) {
			if (typeof text !== "string" || text === "") return "";
			var trimmed = text.replace(/[\\/]+$/, "");
			var index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
			return index === -1 ? trimmed : trimmed.slice(index + 1);
		}

		/**
		 * 项目列文案：优先工作区标题，其次其目录名，最后回落到 cwd 的目录名；
		 * 一个名字都没有才写「未分组」。完整路径不丢，挪进了单元格的 title 里
		 * （表格一列不该用来展示 Windows 路径）。
		 * 兼容两种宿主形态：`{ id, title, path }` 对象，以及旧构建留下的字符串。
		 */
		function workspaceText(entry) {
			var list = entry.workspaces || [];
			var names = [];
			for (var i = 0; i < list.length; i += 1) {
				var w = list[i];
				var name = "";
				if (typeof w === "string") name = projectName(w);
				else if (w !== null && typeof w === "object") {
					if (typeof w.title === "string" && w.title !== "") name = w.title;
					else if (typeof w.path === "string" && w.path !== "") name = projectName(w.path);
				}
				if (name !== "") names.push(name);
			}
			if (names.length > 0) return names.join("、");
			if (typeof entry.cwd === "string" && entry.cwd !== "") return projectName(entry.cwd);
			return "未分组";
		}

		/** The hover detail behind the 项目 column: the paths the names came from. */
		function workspacePaths(entry) {
			var list = entry.workspaces || [];
			var paths = [];
			for (var i = 0; i < list.length; i += 1) {
				var w = list[i];
				if (typeof w === "string") paths.push(w);
				else if (w !== null && typeof w === "object" && typeof w.path === "string" && w.path !== "") paths.push(w.path);
			}
			if (paths.length === 0 && typeof entry.cwd === "string" && entry.cwd !== "") paths.push(entry.cwd);
			return paths.join("、");
		}

		/**
		 * 设置 →「归档会话」分区页：列出归档会话、按勾选删除（释放磁盘）或取消归档（找回）。
		 *
		 * 归档在 dsh 0.1.2 只是显示过滤：被归档的会话从分组树、扁平列表和搜索里同时被减掉，
		 * 但正文、投影行、工作区记账一分不少地留在 ~/.dsh 下，且官方没有「取消归档」动作。
		 *
		 * 四种状态都建模：loading（骨架行）、empty（无需清理）、error（可重试横幅）、
		 * result（操作结果，成功/部分成功两种语气）。
		 *
		 * 工厂式创建（React / 会话行读取器 / document 走 DI），与 turn-fold 一致：测试环境
		 * 传桩件即可，模块自身不 require 宿主服务。
		 */
		function createArchiveCleanupSection(React, readSessionRows, doc) {
			ensureCss(doc);

			function ArchiveCleanupSection() {
				var scanState = React.useState(null), report = scanState[0], setReport = scanState[1];
				var selState = React.useState({}), selected = selState[0], setSelected = selState[1];
				var busyState = React.useState(false), busy = busyState[0], setBusy = busyState[1];
				var noteState = React.useState(""), note = noteState[0], setNote = noteState[1];
				var toneState = React.useState("ok"), noteTone = toneState[0], setNoteTone = toneState[1];
				var errState = React.useState(""), scanError = errState[0], setScanError = errState[1];
				var armedState = React.useState(false), armed = armedState[0], setArmed = armedState[1];
				var forceState = React.useState(false), forceMode = forceState[0], setForceMode = forceState[1];
				var armTimer = React.useRef(null);
				// The session this GUI tab is viewing: force mode must never offer
				// to delete the conversation the settings dialog is sitting in.
				var currentRows = typeof readSessionRows === "function" ? readSessionRows() : null;
				var currentId = currentRows && typeof currentRows.current === "string" ? currentRows.current : "";

				function disarm() {
					if (armTimer.current !== null) {
						clearTimeout(armTimer.current);
						armTimer.current = null;
					}
					setArmed(false);
				}

				// A pending arm timer must not outlive the page.
				React.useEffect(function () {
					return function () {
						if (armTimer.current !== null) clearTimeout(armTimer.current);
					};
				}, []);

				function scan(silent, isActive) {
					var alive = typeof isActive === "function" ? isActive : function () { return true; };
					setScanError("");
					fetch(ENDPOINT, { method: "GET" })
						.then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
						.then(function (res) {
							if (!alive()) return;
							if (res.ok && res.data && Array.isArray(res.data.items)) {
								setReport(res.data);
								setSelected({});
								disarm();
								if (!silent) setNote("");
							} else {
								setScanError("扫描失败：" + ((res.data && res.data.error) || ("宿主返回 HTTP " + res.status)));
							}
						})
						.catch(function (e) {
							if (alive()) setScanError("扫描失败：" + (e && e.message ? e.message : String(e)));
						});
				}

				React.useEffect(function () {
					var active = true;
					scan(true, function () { return active; });
					return function () { active = false; };
				}, []);

				function post(payload) {
					setBusy(true);
					setNote("");
					return fetch(ENDPOINT, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload),
					})
						.then(function (r) { return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d }; }); })
						.then(function (res) {
							if (!res.ok || !res.data) {
								setNoteTone("error");
								setNote("操作失败：" + ((res.data && res.data.error) || ("HTTP " + res.status)));
								return null;
							}
							var data = res.data;
							var parts = [];
							var tone = "ok";
							if (data.action === "delete") {
								var removed = (data.deleted || []).reduce(function (sum, entry) { return sum + (entry.bytes || 0); }, 0);
								var cancelledCount = (data.deleted || []).filter(function (entry) { return entry.cancelled === true; }).length;
								parts.push("已删除 " + (data.deleted || []).length + " 条 · 释放 " + formatBytes(removed));
								if (cancelledCount > 0) parts.push("其中 " + cancelledCount + " 条已先中止运行中的回合");
								if ((data.refused || []).length > 0) parts.push("拒绝 " + data.refused.length + " 条（" + data.refused.map(function (r) { return r.reason; }).join("、") + "）");
								if ((data.errors || []).length > 0) parts.push("部分步骤失败 " + data.errors.length + " 处");
								if (data.archivePruned === false) parts.push("归档名单未能写入");
								if ((data.errors || []).length > 0 || (data.refused || []).length > 0 || data.archivePruned === false) tone = "warn";
							} else {
								parts.push("已取消归档 " + (data.restored || []).length + " 条");
								if (data.archivePruned === false) parts.push("归档名单未能写入");
								if (data.archivePruned === false) tone = "warn";
							}
							if (data.overflow === true) parts.push("单次上限 512 条，其余未处理");
							setNoteTone(tone);
							setNote(parts.join("；"));
							scan(true);
							return data;
						})
						.catch(function (e) {
							setNoteTone("error");
							setNote("操作失败：" + (e && e.message ? e.message : String(e)));
							return null;
						})
						.then(function (value) { setBusy(false); return value; });
				}

				function toggle(id) {
					disarm();
					setSelected(function (current) {
						var next = Object.assign({}, current);
						if (next[id]) delete next[id];
						else next[id] = true;
						return next;
					});
				}

				function pickDeletable() {
					disarm();
					if (report === null) return;
					var next = {};
					(report.deletableIds || []).forEach(function (id) {
						if (id !== currentId) next[id] = true;
					});
					if (forceMode) {
						(report.forceDeletableIds || []).forEach(function (id) {
							if (id !== currentId) next[id] = true;
						});
					}
					setSelected(next);
				}

				function clearPicked() {
					disarm();
					setSelected({});
				}

				var picked = Object.keys(selected);
				// Bytes the delete will actually reclaim, so the armed label states the
				// gain next to the irreversibility instead of leaving a guess.
				var selectedBytes = 0;
				var selectedAttached = 0;
				var selectedRunning = 0;
				if (report !== null) {
					(report.items || []).concat(report.missing || []).forEach(function (item) {
						if (selected[item.id] !== true) return;
						if (typeof item.bytes === "number") selectedBytes += item.bytes;
						if (item.live === true) selectedAttached += 1;
						if (item.running === true) selectedRunning += 1;
					});
				}
				var needsForce = selectedAttached > 0;

				function removePicked() {
					if (!armed) {
						setArmed(true);
						if (armTimer.current !== null) clearTimeout(armTimer.current);
						armTimer.current = setTimeout(disarm, ARM_TIMEOUT_MS);
						return;
					}
					disarm();
					post({ action: "delete", ids: picked, confirm: true, force: needsForce });
				}
				function restorePicked() {
					disarm();
					post({ action: "restore", ids: picked });
				}

				var items = report && Array.isArray(report.items) ? report.items : [];
				var missing = report && Array.isArray(report.missing) ? report.missing : [];
				var runningCount = items.filter(function (item) { return item.running === true; }).length;
				var attachedCount = items.filter(function (item) { return item.live === true && item.running !== true; }).length;
				var loading = report === null && scanError === "";
				var empty = report !== null && items.length + missing.length === 0;
				var hidden = loading || scanError !== "";
				var rowsData = items.map(function (item) {
					return { entry: item, id: item.id, live: item.live === true, running: item.running === true, bytes: item.bytes, absent: false };
				}).concat(missing.map(function (item) {
					return { entry: item, id: item.id, live: item.live === true, running: false, bytes: null, absent: true };
				}));

				function statChip(label, value) {
					return React.createElement("span", { className: "dsao-ac-stat", key: label },
						label, React.createElement("b", null, value));
				}

				function banner(kind, children, extra) {
					return React.createElement("div", {
						key: kind + note, className: "dsao-ac-banner dsao-ac-banner--" + kind,
						role: kind === "error" ? "alert" : "status",
					}, children, extra);
				}

				var stats = [];
				if (report !== null) {
					stats.push(statChip("归档", (report.archivedIds || []).length + " 条"));
					stats.push(statChip("正文合计", formatBytes(report.totalBytes)));
					if (missing.length > 0) stats.push(statChip("正文已不存在", missing.length + " 条"));
					if (runningCount > 0) stats.push(statChip("运行中", runningCount + " 条"));
					if (attachedCount > 0) stats.push(statChip("已打开", attachedCount + " 条"));
				}

				var rows = [];
				rowsData.forEach(function (row) {
					var id = row.id;
					var checked = selected[id] === true;
					var label = labelOf(typeof readSessionRows === "function" ? readSessionRows() : null, id);
					var boxId = "dsao-ac-cb-" + id;
					var isCurrent = currentId !== "" && id === currentId;
					// attached rows unlock only in force mode; the session being
					// viewed right now never unlocks at all (self-delete guard).
					var locked = isCurrent || (row.live && !forceMode);
					var classes = "dsao-ac-row";
					if (checked) classes += " dsao-ac-row--on";
					if (locked || row.absent) classes += " dsao-ac-row--off";
					rows.push(React.createElement("tr", { key: id, className: classes },
						React.createElement("td", { className: "dsao-ac-td", style: { width: "30px" } },
							React.createElement("input", {
								id: boxId, className: "dsao-ac-check", type: "checkbox",
								checked: checked, disabled: busy || locked,
								onChange: function () { toggle(id); },
								"aria-label": "选择会话 " + label,
							})),
						React.createElement("td", { className: "dsao-ac-td", title: id },
							React.createElement("div", { className: "dsao-ac-nameCell" },
								React.createElement("label", { className: "dsao-ac-name", htmlFor: boxId }, label),
								isCurrent ? React.createElement("span", { className: "dsao-ac-pill" }, "当前会话") : null,
								!isCurrent && row.running ? React.createElement("span", { className: "dsao-ac-pill" }, "运行中") : null,
								!isCurrent && row.live && !row.running ? React.createElement("span", { className: "dsao-ac-pill" }, "已打开") : null,
								row.absent ? React.createElement("span", { className: "dsao-ac-pill dsao-ac-pill--bad" }, "正文缺失") : null)),
						React.createElement("td", { className: "dsao-ac-td dsao-ac-td--muted", title: workspacePaths(row.entry) || row.entry.path },
							workspaceText(row.entry)),
						React.createElement("td", { className: "dsao-ac-td dsao-ac-td--num" }, formatBytes(row.bytes)),
						React.createElement("td", { className: "dsao-ac-td dsao-ac-td--num" }, formatDay(row.entry.mtime)),
						React.createElement("td", { className: "dsao-ac-td dsao-ac-td--num" },
							row.absent ? null : React.createElement("a", {
								className: "dsao-ac-link",
								href: EXPORT_ENDPOINT + "?sessionId=" + encodeURIComponent(id) + "&includeDescendants=false",
								"aria-label": "导出 " + label + " 的会话日志",
							}, "导出"))));
				});

				var caps = (report && report.capabilities) || {};
				var capWarn = [];
				if (report !== null && caps.archivePrune === false) capWarn.push("当前宿主未暴露归档名单写入口：删除后归档 id 仍会留在 workspace.json（无害，但需停 host 手工移除）。");
				if (report !== null && caps.checkpointDelete === false) capWarn.push("投影缓存行未能就地删除：将在下次重启后自然失效。");

				return React.createElement("div", { className: "dsao-ac-page", "aria-busy": busy ? "true" : "false" },
					React.createElement("div", { className: "dsao-ac-head" },
						React.createElement("div", { className: "dsao-ac-title" }, "归档会话"),
						React.createElement("button", {
							className: "dsao-ac-btn", type: "button", disabled: busy,
							onClick: function () { scan(false); },
						}, loading ? "扫描中…" : "刷新")),
					React.createElement("p", { className: "dsao-ac-lede" },
						"归档在 dsh 里只是显示过滤：被归档的会话从分组列表、扁平列表和搜索里同时消失，但正文、投影行与工作区记账一分不少地留在磁盘上，官方也没有「取消归档」入口。这一页把看不见的部分列出来，按勾选释放空间，或原样找回。"),
					scanError !== "" ? banner("error", React.createElement("span", null, scanError),
						React.createElement("button", {
							className: "dsao-ac-btn", type: "button", disabled: busy,
							onClick: function () { scan(false); },
						}, "重试")) : null,
					loading ? React.createElement("div", { className: "dsao-ac-scroll dsao-ac-scroll--loading", "aria-hidden": "true" },
						React.createElement("div", { className: "dsao-ac-skel", style: { width: "38%" } }),
						React.createElement("div", { className: "dsao-ac-skel", style: { width: "62%" } }),
						React.createElement("div", { className: "dsao-ac-skel", style: { width: "47%" } })) : null,
					hidden ? null : React.createElement("div", { className: "dsao-ac-stats" },
						stats,
						React.createElement("span", { className: "dsao-ac-spacer" }),
						report !== null ? React.createElement("span", { className: "dsao-ac-count" },
							"本机共 " + (report.storedCount || 0) + " 条会话记录") : null),
					note !== "" && !loading ? banner(noteTone === "ok" ? "ok" : "warn", note) : null,
					empty ? React.createElement("div", { className: "dsao-ac-hint" }, "没有归档会话，无需清理。") : null,
					hidden || empty ? null : React.createElement("div", { className: "dsao-ac-toolbar" },
						React.createElement("button", { className: "dsao-ac-btn", type: "button", disabled: busy, onClick: pickDeletable }, "全选可删"),
						React.createElement("button", { className: "dsao-ac-btn", type: "button", disabled: busy || picked.length === 0, onClick: clearPicked }, "清空选择"),
						caps.force === true ? React.createElement("label", { className: "dsao-ac-checkLabel" },
							React.createElement("input", {
								className: "dsao-ac-check dsao-ac-check--force", type: "checkbox", checked: forceMode, disabled: busy,
								onChange: function () {
									disarm();
									setForceMode(!forceMode);
								},
								"aria-label": "强制模式：允许删除已打开或运行中的归档会话",
							}, ),
							"强制模式") : null,
						React.createElement("span", { className: "dsao-ac-spacer" }),
						React.createElement("button", {
							className: "dsao-ac-btn", type: "button", disabled: busy || picked.length === 0, onClick: restorePicked,
						}, "取消归档 " + picked.length + " 条"),
						React.createElement("button", {
							className: armed ? "dsao-ac-btn dsao-ac-btn--armed" : "dsao-ac-btn dsao-ac-btn--danger",
							type: "button", disabled: busy || picked.length === 0, onClick: removePicked,
							"aria-label": armed
								? "再次点击确认" + (needsForce ? "强制" : "") + "删除 " + picked.length + " 条会话"
								: (needsForce ? "强制" : "") + "删除选中的 " + picked.length + " 条会话",
						}, armed
							? "再点一次确认" + (needsForce ? "强制" : "") + "删除 " + picked.length + " 条（释放 " + formatBytes(selectedBytes) + "，不可恢复）"
							: (needsForce ? "强制删除 " : "删除 ") + picked.length + " 条"
								+ (selectedRunning > 0 ? "（含 " + selectedRunning + " 条运行中）" : ""))),
					hidden || empty ? null : React.createElement("div", { className: "dsao-ac-hint", style: { marginBottom: "8px" } },
						forceMode
							? "强制模式：已打开/运行中的归档会话可勾选，删除前会先中止其正在执行的回合（排队输入一并丢弃）。未归档的会话在任何模式下都不会被触碰。"
							: "删除不可恢复：正文就是那段历史的唯一副本，需要留档请先用行内「导出」拿走 ZIP。运行中的会话默认不可勾选，未归档的会话永远不会被触碰。",
						armed ? " 8 秒内未再次点击会自动取消。" : ""),
					hidden || empty ? null : React.createElement("div", { className: "dsao-ac-scroll" },
						React.createElement("table", { className: "dsao-ac-table" },
							React.createElement("thead", null, React.createElement("tr", null,
								React.createElement("th", { className: "dsao-ac-th", style: { width: "30px" }, scope: "col" }, ""),
								React.createElement("th", { className: "dsao-ac-th", style: { width: "34%" }, scope: "col" }, "会话"),
								React.createElement("th", { className: "dsao-ac-th", scope: "col" }, "项目"),
								React.createElement("th", { className: "dsao-ac-th dsao-ac-th--num", style: { width: "76px" }, scope: "col" }, "大小"),
								React.createElement("th", { className: "dsao-ac-th dsao-ac-th--num", style: { width: "88px" }, scope: "col" }, "最后写入"),
								React.createElement("th", { className: "dsao-ac-th dsao-ac-th--num", style: { width: "56px" }, scope: "col" }, "操作"))),
							React.createElement("tbody", null, rows))),
					capWarn.length === 0 ? null : banner("warn", capWarn.join(" ")));
			}

			return { ArchiveCleanupSection: ArchiveCleanupSection, formatBytes: formatBytes, formatDay: formatDay };
		}

		exports.createArchiveCleanupSection = createArchiveCleanupSection;
		exports.formatBytes = formatBytes;
		exports.formatDay = formatDay;
		exports.projectName = projectName;
		exports.workspaceText = workspaceText;
		exports.workspacePaths = workspacePaths;
		exports.CSS_LINES = CSS_LINES;
		exports.ensureCss = ensureCss;
