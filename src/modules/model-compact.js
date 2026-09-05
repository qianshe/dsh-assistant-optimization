
// model-compact.js — 模型选择器收窄适配 + 弹窗边缘避让
//
// 功能一（icon 占位）：官方模型选择按钮在窄宽度下与权限按钮行为不一致——
// 权限按钮有 @container (width<=460px) 规则自动隐藏文字只留 icon，模型选择器
// 没有，收窄后文字挤压发送区。本模块标记模型选择按钮（aria-haspopup="menu" +
// title 含 "·"），CSS 容器查询隐藏文字 span 并以实心方块 icon 占位。
//
// 功能二（弹窗避让）：模型菜单与用量面板都用 `position:absolute;
// bottom:calc(100%+8px); right:0` 以右下角为基准向左上展开。窄窗口下触发器
// 偏左，弹窗向左展开会冲出视口左边缘被裁。本模块在弹窗打开后按视口边缘计算
// 溢出量，用 translateX 平移回窗口内（保留右下锚定观感，仅在真溢出时微调；
// 空间恢复后自动复位）。

var CSS = [
  '@container (width<=460px){',
  '  [data-dsao-model-trigger]>span{display:none!important}',
  '  [data-dsao-model-trigger]::before{content:"";display:inline-flex;width:14px;height:14px;flex:none;background:currentColor;border-radius:3px}',
  '}',
].join('\n')

var MARGIN = 8

function ensureStyles(doc) {
  if (doc.getElementById('dsao-model-compact-css') !== null) return
  var style = doc.createElement('style')
  style.id = 'dsao-model-compact-css'
  style.textContent = CSS
  doc.head.appendChild(style)
}

function tagModelButton(root) {
  try {
    var scope = root && root.querySelectorAll ? root : document
    var buttons = scope.querySelectorAll('button[aria-haspopup="menu"]')
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i]
      // 模型选择器特征：title 含 "·"（如 "glm-5.3 · Max"）
      if (btn.title && btn.title.indexOf('\u00b7') >= 0) {
        btn.setAttribute('data-dsao-model-trigger', '')
      }
    }
  } catch (e) {}
}

// ── 弹窗避让 ──────────────────────────────────────────────────────────────
// 扫描 composer 卡片内向上展开的绝对定位弹窗，按视口左右边缘钳位。
// 用内联 translateX 实现，不依赖具体（会被构建改写的）CSS module 类名。

function clampPopups() {
  try {
    var card = document.querySelector('[data-composer-card]')
    if (!card) return
    var vw = document.documentElement.clientWidth || window.innerWidth
    var nodes = card.querySelectorAll('*')
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      var cs
      try { cs = window.getComputedStyle(el) } catch (e) { continue }
      if (cs.position !== 'absolute') continue
      if (cs.bottom === 'auto') continue // 只处理向上展开的弹窗
      var rect = el.getBoundingClientRect()
      if (rect.width < 120 || rect.height < 24) continue // 忽略小元素/图标

      var dx = 0
      if (rect.left < MARGIN) dx = MARGIN - rect.left
      else if (rect.right > vw - MARGIN) dx = (vw - MARGIN) - rect.right

      // 平移量基于「不含本次 transform」的真实矩形：先清掉再量。
      if (dx === 0) {
        if (el.style.transform && el.style.transform.indexOf('translateX') === 0) {
          el.style.transform = ''
        }
        continue
      }
      el.style.transform = 'translateX(' + Math.round(dx) + 'px)'
    }
  } catch (e) {}
}

var _rafA = 0
var _rafB = 0
function scheduleClamp() {
  if (_rafA) return
  // 双 rAF：等弹窗完成布局后再量，避免首帧宽度为 0。
  _rafA = requestAnimationFrame(function () {
    _rafA = 0
    _rafB = requestAnimationFrame(function () {
      _rafB = 0
      clampPopups()
    })
  })
}

function startModelSelectorCompact() {
  if (typeof document === 'undefined') return function () {}

  ensureStyles(document)
  tagModelButton(document)

  var obs = new MutationObserver(function (mutations) {
    var touched = false
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i]
      for (var j = 0; j < m.addedNodes.length; j++) {
        var node = m.addedNodes[j]
        if (node.nodeType !== 1) continue
        touched = true
        if (node.tagName === 'BUTTON') tagModelButton(node)
        else if (node.querySelector) tagModelButton(node)
      }
    }
    if (touched) scheduleClamp()
  })
  obs.observe(document.body, { childList: true, subtree: true })

  // 弹窗开合也可能只改属性/文本而不增删节点；点击后主动重算一次。
  var onClick = function () { scheduleClamp() }
  document.addEventListener('click', onClick, true)
  window.addEventListener('resize', scheduleClamp)

  return function () {
    obs.disconnect()
    document.removeEventListener('click', onClick, true)
    window.removeEventListener('resize', scheduleClamp)
    if (_rafA) cancelAnimationFrame(_rafA)
    if (_rafB) cancelAnimationFrame(_rafB)
  }
}

exports.startModelSelectorCompact = startModelSelectorCompact
