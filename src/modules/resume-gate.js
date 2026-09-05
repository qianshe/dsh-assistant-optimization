
		var RESUMABLE_KINDS = { aborted: true, error: true };

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
		exports.deriveRunning = deriveRunning;
		exports.canResume = canResume;
