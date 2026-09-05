
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
			"[data-dsao-enhance-btn]{position:relative;min-width:0;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;transition:background 120ms,color 120ms}",
			"[data-dsao-enhance-btn]:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}",
			"[data-dsao-enhance-btn]:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
			"[data-dsao-enhance-btn]:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}",
			"[data-dsao-enhance-btn] svg{flex:none}",
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
			var session = typeof props.useSession === "function" ? props.useSession(function (s) { return s; }) : null;
			var inputState = typeof props.useInput === "function" ? props.useInput(function (s) { return s; }) : null;
			var chatSnapshot = typeof props.useChat === "function" ? props.useChat(function (s) { return s; }) : null;
			var isSubagent = session !== null && typeof session === "object" &&
				session.subagent !== null && session.subagent !== undefined;

			var markerRef = React.useRef(null);
			var apiRef = React.useRef(null);
			var stateRef = React.useRef({ blocked: true, busy: false });
			var draftRef = React.useRef("");
			var actionsRef = React.useRef(null);
			var lastRefRef = React.useRef("");
			var contextRef = React.useRef({ project: "", cwd: "", instructions: "", summary: "", history: "" });

			var input = inputState || {};
			var draft = typeof input.draft === "string" ? input.draft : "";
			var phase = input.phase;
			var blocked = draft.trim() === "" || (phase !== undefined && phase !== "plain");
			draftRef.current = draft;
			actionsRef.current = props.inputActions || null;

			var identity = function (s) { return s; };
			var sessions = typeof props.useSessions === "function" ? props.useSessions(identity) : null;
			var workspaces = typeof props.useWorkspaces === "function" ? props.useWorkspaces(identity) : null;
			var legacyNodes = chatSnapshot && chatSnapshot.legacy && Array.isArray(chatSnapshot.legacy.nodes)
				? chatSnapshot.legacy.nodes
				: [];
			contextRef.current = contextMod.readContext(
				session ? { sessionId: session.sessionId, nodes: legacyNodes } : null,
				sessions,
				workspaces
			);

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

				btn.appendChild(svg);

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
