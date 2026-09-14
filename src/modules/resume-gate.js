
		// 与宿主路由的 RESUME_TERMINAL_KINDS（lib/index.js）及设计文档 FR-1 对齐：
		// 中止/出错/max-tokens 来自活跃回合的终态；interrupted 仅出现在崩溃修复
		// 合成的 turn/end 上（dsh-session repair.js）。客户端若少认任何一种，宿主
		// 明明可续跑的会话在 GUI 上永远拿不到 ▶——崩溃修复过的会话（interrupted）
		// 因此卡死不可操作。
		var RESUMABLE_KINDS = { aborted: true, error: true, "max-tokens": true, interrupted: true };

		/**
		 * 从聊天快照时间线派生运行态：任一 turn status 为 open 即运行中。
		 * dsh 0.1.2 会话面快照不再稳定携带 running（供给端按需补齐）；
		 * 快照缺失/畸形一律 false（不误判为运行中）。
		 */
		function deriveRunning(chat) {
			var turns = chat && chat.timeline && chat.timeline.turns;
			if (!turns || typeof turns.forEach !== "function") return false;
			var running = false;
			turns.forEach(function (turn) {
				if (turn && turn.status === "open") running = true;
			});
			return running;
		}

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
			// running 只有在时间线佐证（存在 open turn）或无时间线可查时才拦截。
			// 真运行中的会话，turn/start 先于状态推送落库，open turn 必在；反之
			// running=true 而时间线全部闭合 = 陈旧位（宿主崩溃/代理已退场），此时
			// 落到终态判定，让会话可以被 ▶ 唤醒，而不是永久卡在「运行中不可操作」。
			if (session.running === true) {
				var chatMissing = session.chat === null || session.chat === undefined;
				if (chatMissing || deriveRunning(session.chat)) {
					return { canResume: false, reason: "running" };
				}
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
		exports.deriveRunning = deriveRunning;
		exports.canResume = canResume;
