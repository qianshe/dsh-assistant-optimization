// resume-continuity.js — 续跑行的呈现处理（项2 空白行消除 + 项4 连续性提示）。
//
// 原理：续跑触发时 Host 会落一条 marker 用户消息（content 为空块、
// source.dsaoResume === true）。官方 UserMessageNodeView 照常渲染它 →
// 对话流里多出一个空泡。这里在 conversation.chat.node 的 keyed 槽位上，
// 以 priority -1 遮蔽 key:'user'（与 wrapper.js 遮蔽 assistant-step 同一
// 工艺）：marker 行渲染为一条内联小字「已从中断处继续」提示，其余用户
// 消息原样委托官方组件。
//
// 连续性（项4）：空泡消失后阅读动线变为
//   半截回复（带 message.stopped 标记）→ [已从中断处继续] → 续跑回复，
//   视觉上是一段被明确接续的输出而非两段孤立消息。

var HINT_TEXT = '已从中断处继续'

/** 官方 UserMessageNodeView 的发现（同 wrapper.findOfficialRenderer 的手法）。 */
var _officialUserCache = null
/** slots 查找器的注入点：主入口拿到 ctx 后把 slots 传进来（缓存一次即可）。 */
function provideSlots(slots) {
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
  try {
    var entries = slots.entries('conversation.chat.node')
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

/** 该用户节点是否是续跑 marker：空块（或纯空白文本）+ dsaoResume 标记。 */
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
  // sentinel 风格：唯一 text 块且为极短中性词（不下预算法，仅当 content 全部空白时视作 marker 视觉处理；
  // 有实义文本的 sentinel 仍正常显示，避免吞掉真实输入）。
  if (content.length === 1 && content[0] && content[0].type === 'text' && String(content[0].text || '').trim() === '') {
    return true
  }
  return false
}

function createResumeContinuity(React) {
  /**
   * key:'user'（priority -1）的遮蔽组件。props 形态同官方：
   * { node: routedNode, ...ownerProps }，官方组件经 findOfficialUserRenderer 拿到。
   */
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
    if (Official === null) {
      // 官方组件未找到（缓存建立前的极端时序）：不渲染任何东西，优于崩溃。
      return null
    }
    return React.createElement(Official, props)
  }

  return {
    ResumeMarkerAwareUserNode: ResumeMarkerAwareUserNode,
  }
}

exports.createResumeContinuity = createResumeContinuity
exports.isResumeMarker = isResumeMarker
exports.findOfficialUserRenderer = findOfficialUserRenderer
exports.provideSlots = provideSlots
exports.HINT_TEXT = HINT_TEXT
