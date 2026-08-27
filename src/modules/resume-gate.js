// resume-gate.js — 决定"发送键是否变 ▶"的纯函数。
//
// v1.7.0 完全重写，修正数据路径：
//   snapshot.chat.nodes    → Map<key, {key, kind, data, anchorSeq, ...}>
//   snapshot.chat.order    → 有序 key 数组
//   snapshot.chat.legacy.nodes → 已完成节点 data 对象的扁平数组（按 seq 排序）
//   snapshot.chat.legacy.turnEnds → Map<turn, endSeq>（仅序号，无 reason）
//
// 判定策略（按可靠性从高到低）：
//   1. 遍历 chat.nodes（Map）按 chat.order 取最后一个可见节点，
//      检查 node.kind 是否为中断/错误/max-tokens 类型。
//   2. 回退到 chat.legacy.nodes（数组），看最后一个 data.kind + data.interrupted。
//   3. 都拿不到 → no-terminal → 不显示 ▶。

var TERMINAL_KINDS = ['aborted', 'error', 'max-tokens', 'interrupted']

/**
 * 从 chat nodes（Map）+ order（key 数组）取最后一个节点的终态。
 * 返回 'aborted' | 'error' | 'max-tokens' | undefined。
 */
function lastTerminalFromChatNodes(chatNodes, order) {
  if (!chatNodes || typeof chatNodes.get !== 'function') return undefined
  if (!Array.isArray(order) || order.length === 0) return undefined

  // 从 order 末尾向前找最后一个 visible 节点。
  for (var i = order.length - 1; i >= 0; i--) {
    var node = chatNodes.get(order[i])
    if (!node) continue
    // 跳过隐藏节点。
    if (node.visibility && node.visibility !== 'visible') continue

    var kind = node.kind
    if (kind === 'turn-error') return 'error'
    if (kind === 'turn-max-tokens') return 'max-tokens'
    // assistant-step 节点的中断标志在 node.data.interrupted。
    if (kind === 'assistant-step') {
      var data = node.data
      if (data && data.interrupted === true) return 'aborted'
      // 正常完成的 assistant-step（非中断）→ 会话已完成，不回溯更早节点。
      return undefined
    }
    // user / steering / command / tool-call 等 → 不是终态节点，跳过。
  }
  return undefined
}

/**
 * 从 legacy.nodes（扁平 data 数组）取最后一个终态。
 */
function lastTerminalFromLegacyNodes(legacyNodes) {
  if (!Array.isArray(legacyNodes) || legacyNodes.length === 0) return undefined
  var last = legacyNodes[legacyNodes.length - 1]
  if (!last || typeof last !== 'object') return undefined
  if (last.kind === 'turn-error') return 'error'
  if (last.kind === 'turn-max-tokens') return 'max-tokens'
  if (last.kind === 'assistant' && last.interrupted === true) return 'aborted'
  return undefined
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

  // 主路径：chat.nodes (Map) + chat.order。
  var chat = session.chat
  var kind
  if (chat && chat.nodes && chat.order) {
    kind = lastTerminalFromChatNodes(chat.nodes, chat.order)
  }
  // 回退：chat.legacy.nodes。
  if (kind === undefined && chat && chat.legacy && Array.isArray(chat.legacy.nodes)) {
    kind = lastTerminalFromLegacyNodes(chat.legacy.nodes)
  }
  // 极旧回退：session.nodes（已废弃路径）。
  if (kind === undefined && Array.isArray(session.nodes)) {
    kind = lastTerminalFromLegacyNodes(session.nodes)
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
  canResume: canResume,
  lastTerminalFromChatNodes: lastTerminalFromChatNodes,
  lastTerminalFromLegacyNodes: lastTerminalFromLegacyNodes,
}
