// resume-gate.js — 决定"发送键是否变 ▶"的纯函数与最小 DOM 帮手。
//
// 输入全部来自会话快照（client-runtime session controller 的 snapshot），
// 五个门控量对应 PRD FR-1：
//   running        快照.running（bool）
//   queue          快照.queue 数组，只看 placement === 'queued' 的行
//   turnEnds       快照.turnEnds —— 每个 turn 的 {start,end,...} 草稿，
//                  end 是 turn/end 事件本身；取 seq 最大的一条读 reason.kind
//   draft          输入框草稿（空才允许 ▶）
//   subagent       非空 = 子代理会话，一律不给 ▶
//
// 图片附件在输入区 props 里拿不到可靠信号：v0 接受"挂图 + 空草稿 + 可继续
// 时点 ▶ 依然走续跑"，这是对 FR-1 的已知放宽（附录 B 备注）。
//
// 设计成不依赖 React：组件层用轮询调它并把结果写进按钮态。

var TERMINAL_KINDS = ['aborted', 'error', 'max-tokens', 'interrupted']

/**
 * 从 nodes（会话快照的投影行）取最后一个可判定终态（v1.6.1 修复主路径）：
 *   kind==='assistant' && interrupted:true  -> aborted
 *   kind==='turn-error'                     -> error
 *   kind==='turn-max-tokens'                -> max-tokens
 * 快照上的 turnEnds 是 Map<turn, seq> 纯序号、无 reason，旧路径仅作兜底。
 */
function lastTerminalKindFromNodes(nodes) {
  if (!Array.isArray(nodes)) return undefined
  for (var i = nodes.length - 1; i >= 0; i--) {
    var n = nodes[i]
    if (n === null || n === undefined || typeof n !== 'object') continue
    var kind = n.kind
    if (kind === 'turn-error') return 'error'
    if (kind === 'turn-max-tokens') return 'max-tokens'
    if (kind === 'assistant' && n.interrupted === true) return 'aborted'
  }
  return undefined
}

/** 从 turnEnds（数组、Map 或普通对象）里取最后一条 turn/end 的 reason.kind。 */
function lastTerminalKind(turnEnds) {
  if (turnEnds === null || turnEnds === undefined || typeof turnEnds !== 'object') return undefined
  var list
  if (typeof turnEnds.forEach === 'function' && !(turnEnds instanceof Array)) {
    // Map 或类 Map：values() 也是 forEach 遍历。
    list = []
    turnEnds.forEach(function (value) { list.push(value) })
  } else if (Array.isArray(turnEnds)) {
    list = turnEnds
  } else {
    list = Object.keys(turnEnds).map(function (k) { return turnEnds[k] })
  }
  var best = null
  var bestSeq = -1
  for (var i = 0; i < list.length; i++) {
    var entry = list[i]
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    var end = entry.end
    if (end === null || end === undefined || typeof end !== 'object') continue
    var data = end.data
    if (data === null || data === undefined || typeof data !== 'object') continue
    var reason = data.reason
    if (reason === null || reason === undefined || typeof reason !== 'object') continue
    var kindHere = typeof reason.kind === 'string' ? reason.kind : undefined
    if (kindHere === undefined) continue
    var seq = typeof end.seq === 'number' ? end.seq : i
    if (seq >= bestSeq) {
      bestSeq = seq
      best = kindHere
    }
  }
  return best === null ? undefined : best
}

/**
 * FR-1 谓词。session 是会话快照对象，draft 为当前草稿文本。
 * 返回 { canResume, reason?, terminalKind? } —— reason 用于调试/tooltip。
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
  var kind = lastTerminalKindFromNodes(session.nodes)
  if (kind === undefined) {
    kind = lastTerminalKind(session.turnEnds)
  }
  if (kind === undefined) {
    return { canResume: false, reason: 'no-terminal' }
  }
  if (TERMINAL_KINDS.indexOf(kind) === -1) {
    return { canResume: false, reason: 'terminal-' + kind, terminalKind: kind }
  }
  return { canResume: true, terminalKind: kind }
}

module.exports = {
  TERMINAL_KINDS: TERMINAL_KINDS,
  lastTerminalKind: lastTerminalKind,
  canResume: canResume,
}
