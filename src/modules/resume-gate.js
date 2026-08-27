// resume-gate.js — 决定"发送键是否变 ▶"的纯函数。
//
// v1.6.11 彻底简化：直接从 timeline 的最后一轮 turn/end 事件读 reason.kind。
//
// 数据路径：
//   session.chat.timeline.turns → Map<turnNum, {
//     turn, start, end, status, steps, data
//   }>
//
// turn.end 是 turn/end 原始事件，其 data.reason.kind 就是终止原因：
//   "aborted"      → 用户手动停止
//   "error"        → 会话出错
//   "max-tokens"   → 达到 token 上限
//   "completed"    → 正常完成（不可续跑）
//   "blocked"      → 被拒绝（不可续跑）
//
// 只要看最后一轮的 reason.kind 是否属于可续跑集合即可。
// 不再依赖 chat.nodes Map、legacy.nodes、interrupted 标志等间接信号。

var RESUMABLE_KINDS = { aborted: true, error: true }

/**
 * 从 timeline 取最后一轮已关闭 turn 的终止原因 kind。
 * @returns {string|undefined} reason.kind 或 undefined。
 */
function lastTurnReasonKind(timeline) {
  if (!timeline || !timeline.turns || typeof timeline.turns.forEach !== 'function') return undefined
  var lastTurn = null
  var lastTurnNum = -1
  timeline.turns.forEach(function (turn) {
    if (turn && turn.status === 'closed' && typeof turn.turn === 'number' && turn.turn > lastTurnNum) {
      lastTurnNum = turn.turn
      lastTurn = turn
    }
  })
  if (!lastTurn || !lastTurn.end) return undefined
  var reason = lastTurn.end.data && lastTurn.end.data.reason
  if (!reason || typeof reason.kind !== 'string') return undefined
  return reason.kind
}

/**
 * FR-1 谓词。session 是会话快照，draft 为当前草稿文本。
 */
function canResume(session, draft) {
  if (session === null || session === undefined || typeof session !== 'object') {
    return { canResume: false, reason: 'no-session' }
  }
  if (session.subagent !== null && session.subagent !== undefined) {
    return { canResume: false, reason: 'subagent' }
  }
  if (session.running === true) {
    return { canResume: false, reason: 'running' }
  }
  if (typeof draft === 'string' && draft.trim() !== '') {
    return { canResume: false, reason: 'draft-not-empty' }
  }
  var queue = Array.isArray(session.queue) ? session.queue : []
  for (var i = 0; i < queue.length; i++) {
    var item = queue[i]
    if (item !== null && item !== undefined && item.placement === 'queued') {
      return { canResume: false, reason: 'queue-pending' }
    }
  }

  var kind = lastTurnReasonKind(session.chat && session.chat.timeline)

  if (kind === undefined) {
    return { canResume: false, reason: 'no-terminal' }
  }
  if (!RESUMABLE_KINDS[kind]) {
    return { canResume: false, reason: 'terminal-' + kind, terminalKind: kind }
  }
  return { canResume: true, terminalKind: kind }
}

module.exports = {
  RESUMABLE_KINDS: RESUMABLE_KINDS,
  canResume: canResume,
  lastTurnReasonKind: lastTurnReasonKind,
}
