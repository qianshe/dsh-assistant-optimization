
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
