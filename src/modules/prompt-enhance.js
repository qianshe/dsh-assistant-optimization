// prompt-enhance.js — "Prompt 增强" button in the composer tool row.
//
// Placement: the shipped `conversation.input.right` seat renders BEFORE the
// model select and the context meter, but the button belongs immediately left
// of the send button. There is no slot there, so the seat is used only as a
// scoped anchor: the component renders a hidden marker, then inserts a plain
// DOM button into the same `.trailing` container just before the primary
// send/stop button. The button is not React-owned, so — exactly as with the
// diff badge — placement is idempotent and cleanup is independent.
//
// Requires: React, fetch

var ENDPOINT = '/api/dsao/prompt-enhance'
var BTN_ATTR = 'data-dsao-enhance-btn'

function sparkleSvg(doc) {
  var ns = 'http://www.w3.org/2000/svg'
  var svg = doc.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('aria-hidden', 'true')
  var path = doc.createElementNS(ns, 'path')
  // Four-point star plus a small companion star.
  path.setAttribute('d', 'M6.5 1.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L2.5 5.5l2.9-1.1zM12 9l.65 1.65L14.3 11.3l-1.65.65L12 13.6l-.65-1.65L9.7 11.3l1.65-.65z')
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  return svg
}

function createButton(doc, onClick) {
  var btn = doc.createElement('button')
  btn.type = 'button'
  btn.setAttribute(BTN_ATTR, '')
  btn.setAttribute('aria-label', 'Prompt 增强')
  btn.title = 'Prompt 增强 — 用当前模型改写草稿'
  btn.style.cssText = [
    'display:inline-flex', 'align-items:center', 'justify-content:center',
    'width:24px', 'height:24px', 'flex:none', 'padding:0', 'margin:0',
    'border:none', 'border-radius:6px', 'background:transparent',
    'color:var(--dsw-alias-label-secondary)', 'cursor:pointer',
    'transition:background 120ms,color 120ms',
  ].join(';')
  btn.appendChild(sparkleSvg(doc))
  btn.addEventListener('click', onClick)
  btn.addEventListener('mousedown', function (e) { e.preventDefault() })
  btn.addEventListener('mouseenter', function () {
    if (btn.disabled) return
    btn.style.background = 'var(--dsw-alias-bg-layer-2)'
    btn.style.color = 'var(--dsw-alias-label-primary)'
  })
  btn.addEventListener('mouseleave', function () {
    btn.style.background = 'transparent'
    btn.style.color = 'var(--dsw-alias-label-secondary)'
  })
  return btn
}

/** The send/stop button ends the trailing row; the button goes just before it. */
function findPrimary(trailing) {
  var buttons = trailing.querySelectorAll('button[class*="primary"]')
  return buttons.length === 0 ? null : buttons[buttons.length - 1]
}

/**
 * Idempotent placement: cleanup first (so a container swap cannot orphan the
 * button), then insert only when the seat is not already correct.
 */
function ensurePlacement(trailing, btn) {
  if (!trailing || !btn) return
  var primary = findPrimary(trailing)
  if (primary === null) {
    if (btn.parentNode) btn.parentNode.removeChild(btn)
    return
  }
  if (btn.parentNode === trailing && btn.nextElementSibling === primary) return
  trailing.insertBefore(btn, primary)
}

function setBusy(btn, busy) {
  btn.disabled = busy || btn.dataset.dsaoBlocked === '1'
  btn.style.opacity = btn.disabled ? '0.4' : '1'
  btn.style.cursor = btn.disabled ? 'default' : 'pointer'
  btn.style.animation = busy ? 'dsao-enhance-pulse 1s ease-in-out infinite' : ''
}

function setBlocked(btn, blocked) {
  btn.dataset.dsaoBlocked = blocked ? '1' : '0'
  if (btn.style.animation === '') {
    btn.disabled = blocked
    btn.style.opacity = blocked ? '0.4' : '1'
    btn.style.cursor = blocked ? 'default' : 'pointer'
  }
}

function flash(btn, color) {
  btn.style.color = color
  setTimeout(function () { btn.style.color = 'var(--dsw-alias-label-secondary)' }, 1200)
}

function ensureKeyframes(doc) {
  if (doc.getElementById('dsao-enhance-css') !== null) return
  var style = doc.createElement('style')
  style.id = 'dsao-enhance-css'
  style.textContent = '@keyframes dsao-enhance-pulse{0%,100%{opacity:.45}50%{opacity:1}}'
  doc.head.appendChild(style)
}

/** POST the draft to the Host half, which runs one non-session model call. */
function requestEnhance(text, signal) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text }),
    signal: signal,
  }).then(function (res) {
    return res.json().then(function (body) {
      if (!res.ok || body === null || typeof body !== 'object' || typeof body.text !== 'string') {
        var reason = body && typeof body.error === 'string' ? body.error : 'HTTP ' + res.status
        throw new Error(reason)
      }
      return body.text
    })
  })
}

function createPromptEnhance(React) {
  /**
   * Registered in `conversation.input.right`; renders only a hidden marker and
   * owns a plain DOM button placed beside the send button.
   */
  function PromptEnhanceMount(props) {
    var markerRef = React.useRef(null)
    var btnRef = React.useRef(null)
    var draftRef = React.useRef('')
    var busyRef = React.useRef(false)
    var actionsRef = React.useRef(null)

    var input = props.input || {}
    draftRef.current = typeof input.draft === 'string' ? input.draft : ''
    actionsRef.current = props.inputActions || null
    var phase = input.phase
    var blocked = draftRef.current.trim() === '' || (phase !== undefined && phase !== 'plain')

    React.useEffect(function () {
      var marker = markerRef.current
      if (!marker || !marker.parentNode) return
      var doc = marker.ownerDocument
      // rightItems renders inside the trailing row, so the marker's parent
      // chain reaches the same container that holds the send button.
      var trailing = marker.parentNode
      while (trailing && findPrimary(trailing) === null) trailing = trailing.parentNode
      if (!trailing) return

      ensureKeyframes(doc)

      var controller = null
      var btn = createButton(doc, function () {
        if (busyRef.current) return
        var text = draftRef.current
        var actions = actionsRef.current
        if (text.trim() === '' || actions === null) return
        busyRef.current = true
        setBusy(btn, true)
        controller = new AbortController()
        requestEnhance(text, controller.signal).then(function (next) {
          if (next.trim() !== '') actions.setDraft(next)
          flash(btn, 'var(--dsw-alias-state-success-primary)')
        }).catch(function (err) {
          btn.title = 'Prompt 增强失败：' + (err && err.message ? err.message : String(err))
          flash(btn, 'var(--dsw-alias-state-error-primary)')
        }).then(function () {
          busyRef.current = false
          setBusy(btn, false)
          controller = null
        })
      })
      btnRef.current = btn
      setBlocked(btn, blocked)
      ensurePlacement(trailing, btn)

      var obs = new MutationObserver(function () { ensurePlacement(trailing, btn) })
      obs.observe(trailing, { childList: true })

      return function () {
        obs.disconnect()
        if (controller !== null) controller.abort()
        if (btn.parentNode) btn.parentNode.removeChild(btn)
        btnRef.current = null
      }
    }, [])

    React.useEffect(function () {
      if (btnRef.current !== null) setBlocked(btnRef.current, blocked)
    }, [blocked])

    return React.createElement('span', {
      ref: markerRef,
      'data-dsao-enhance-anchor': '',
      style: { display: 'none' },
    })
  }

  return { PromptEnhanceMount: PromptEnhanceMount }
}

exports.createPromptEnhance = createPromptEnhance
exports.ENDPOINT = ENDPOINT
