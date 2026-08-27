// resume-continuity.js — 续跑行的呈现处理（项2 空白行消除 + 项4 连续性提示）。
//
// 双保险机制：
//   A) React 层：conversation.chat.node key:'user' priority:-1 遮蔽，
//      marker → 「已从中断处继续」提示行，其余用户消息原样委托官方组件。
//   B) DOM 层：MutationObserver 扫描对话流，把官方渲染出的空 marker 气泡
//      （source.dsaoResume 无法在 DOM 标记时的后备路径）替换为提示行。
//      判定依据：用户消息行内气泡为空（或仅含空白文本节点）→ 视为 marker。
//
// 连续性（项4）：空泡消失后阅读动线变为
//   半截回复（带 message.stopped 标记）→ [已从中断处继续] → 续跑回复，
//   视觉上是一段被明确接续的输出而非两段孤立消息。

var HINT_TEXT = '已从中断处继续'

// ── React-layer shadow (mechanism A) ──────────────────────────────────────

/** 官方 UserMessageNodeView 的发现（同 wrapper.findOfficialRenderer 的手法）。 */
var _officialUserCache = null
var _slotsRef = null
/** slots 查找器的注入点：主入口拿到 ctx 后把 slots 传进来（缓存一次即可）。 */
function provideSlots(slots) {
  _slotsRef = slots
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
  var s = slots || _slotsRef
  if (!s) return null
  try {
    var entries = s.entries('conversation.chat.node')
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

// ── DOM-layer fallback (mechanism B) ──────────────────────────────────────

/**
 * MutationObserver 扫描对话流，把空的用户消息气泡替换为「已从中断处继续」提示行。
 *
 * 判定逻辑：用户消息行（.gdEzaW_userRow）内的气泡（.gdEzaW_bubble）为空
 * （无文本、无子元素，或仅含空白文本节点）→ 视为续跑 marker 行。
 * 已处理过的行带 data-dsao-resume-collapsed 属性，跳过。
 *
 * @returns 清理函数（断开 observer）。
 */
function startResumeHintObserver() {
  if (typeof document === 'undefined') return function () {}

  var BUBBLE_SEL = '.gdEzaW_bubble'
  var ROW_SEL = '.gdEzaW_userRow'

  function processRow(row) {
    if (!row || row.hasAttribute('data-dsao-resume-collapsed')) return
    var bubble = row.querySelector(BUBBLE_SEL)
    if (!bubble) return

    // 气泡是否"空"：无子元素且文本空白。
    var isEmpty = bubble.children.length === 0 && String(bubble.textContent || '').trim() === ''
    if (!isEmpty) return

    // 标记已处理。
    row.setAttribute('data-dsao-resume-collapsed', '')

    // 用提示行替换整个用户行的内容。
    var hint = document.createElement('div')
    hint.setAttribute('data-dsao-resume-hint', '')
    hint.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:6px',
      'margin:2px 0',
      'padding:0 2px',
      'color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))',
      'font-size:11px',
      'line-height:1.4',
      'user-select:none',
    ].join(';')

    var line = document.createElement('span')
    line.style.cssText = [
      'width:14px',
      'height:1px',
      'flex:none',
      'background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))',
      'opacity:0.6',
    ].join(';')
    hint.appendChild(line)
    hint.appendChild(document.createTextNode(HINT_TEXT))

    // 清空原行内容，插入提示。
    while (row.firstChild) row.removeChild(row.firstChild)
    row.appendChild(hint)
    // 行容器不再右对齐（否则提示浮在右侧很怪），改为左侧自然流。
    row.style.alignItems = 'flex-start'
  }

  function scan(root) {
    try {
      var rows = root.querySelectorAll(ROW_SEL + ':not([data-dsao-resume-collapsed])')
      for (var i = 0; i < rows.length; i++) processRow(rows[i])
    } catch (err) {}
  }

  // 初始扫描。
  scan(document)

  // 监听后续变化。
  var obs = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i]
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j]
        if (node.nodeType !== 1) continue
        if (node.matches && node.matches(ROW_SEL)) processRow(node)
        else if (node.querySelector) scan(node)
      }
    }
    // 也处理子树变更（气泡内容异步填充后变空的情况罕见，但覆盖之）。
    scan(document)
  })
  obs.observe(document.body, { childList: true, subtree: true })

  return function () {
    obs.disconnect()
  }
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
exports.startResumeHintObserver = startResumeHintObserver
exports.HINT_TEXT = HINT_TEXT
