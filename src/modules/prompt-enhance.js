// prompt-enhance.js — "Prompt 增强" button in the composer tool row.
//
// Placement: the shipped `conversation.input.right` seat renders BEFORE the
// model select and the context meter, but the button belongs immediately left
// of the send button. There is no slot there, so the seat is used only as a
// scoped anchor: the component renders a hidden marker, then inserts a plain
// DOM button into the same `.trailing` container just before the first
// primary button in the group (send alone when idle, stop+send while an
// interrupt is available, so the button never separates stop from send). The
// button is not React-owned, so — exactly as with the diff badge — placement
// is idempotent and cleanup is independent.
//
// Subagent sessions render no button at all: `props.session.subagent` is
// non-null there, the composer belongs to the delegated agent's own draft
// flow, and while it runs the button would only jostle the interrupt
// controls. The mount returns null and the effect bails before touching the
// DOM or the network.
//
// Feedback has three states: idle (sparkle), busy (spinning arc, brand color,
// a sliding "增强中" label, aria-busy), and settled (green check for 1.4s or a
// red sparkle for 2.6s with the reason in the tooltip).
//
// Requires: React, fetch, and the context module for private-reference extraction.

var ENDPOINT = '/api/dsao/prompt-enhance'
var SVG_NS = 'http://www.w3.org/2000/svg'
var IDLE_COLOR = 'var(--dsw-alias-label-secondary)'
var IDLE_TITLE = 'Prompt 增强 — 用当前模型改写草稿'
var BUSY_TITLE = '正在增强…'
var BUSY_LABEL = '增强中'
var PATH_SPARKLE = 'M6.5 1.5l1.1 2.9 2.9 1.1-2.9 1.1-1.1 2.9-1.1-2.9L2.5 5.5l2.9-1.1zM12 9l.65 1.65L14.3 11.3l-1.65.65L12 13.6l-.65-1.65L9.7 11.3l1.65-.65z'
var PATH_CHECK = 'M13.5 4.5l-6.4 7-4.1-3.6 1-1.1 3 2.6 5.4-5.9z'

var CSS = [
  '@keyframes dsao-enh-spin{to{transform:rotate(360deg)}}',
  '@keyframes dsao-enh-breathe{0%,100%{opacity:.55}50%{opacity:1}}',
  '[data-dsao-enhance-btn][data-state="busy"]{animation:dsao-enh-breathe 1.4s ease-in-out infinite}',
  '[data-dsao-enhance-btn] .dsao-enh-spinner{transform-origin:8px 8px;animation:dsao-enh-spin .7s linear infinite}',
  '[data-dsao-enhance-btn] .dsao-enh-label{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;transition:max-width 180ms ease,opacity 180ms ease,margin-left 180ms ease;margin-left:0}',
  '[data-dsao-enhance-btn][data-state="busy"] .dsao-enh-label{max-width:52px;opacity:1;margin-left:4px}',
].join('\n')

function ensureStyles(doc) {
  if (doc.getElementById('dsao-enhance-css') !== null) return
  var style = doc.createElement('style')
  style.id = 'dsao-enhance-css'
  style.textContent = CSS
  doc.head.appendChild(style)
}

/** The primary button group (stop + send when an interrupt is available) ends
 * the trailing row; the button goes just before the FIRST of them, so the
 * group stays put and the button never wedges between stop and send. */
function findPrimary(trailing) {
  var buttons = trailing.querySelectorAll('button[class*="primary"]')
  return buttons.length === 0 ? null : buttons[0]
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

/** Condense the Host's refBytes diagnostic into one tooltip line. */
function refSummary(refBytes, searches) {
  if (refBytes === null || typeof refBytes !== 'object') return ''
  var num = function (v) { return typeof v === 'number' ? v : 0 }
  var src = typeof refBytes.instructionSource === 'string' ? refBytes.instructionSource : '?'
  return '上次上下文：project ' + num(refBytes.project) +
    ' / instructions ' + num(refBytes.instructions) + ' (' + src + ')' +
    ' / summary ' + num(refBytes.summary) +
    ' / asks ' + num(refBytes.history) +
    ' / results ' + num(refBytes.replies) +
    (num(searches) > 0 ? ' / searches ' + num(searches) : '')
}

/**
 * Read a response body without letting a parse error hide the real cause.
 *
 * The webserver's fallback answers 404 with the plain text "not found", so a
 * bare res.json() throws "Unexpected token 'o'" and buries the actual fact:
 * the route was never registered.
 */
function readBody(res) {
  return res.text().then(function (raw) {
    try {
      var parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch (e) {
      var snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 80)
      return { error: 'HTTP ' + res.status + (snippet === '' ? '' : ': ' + snippet) }
    }
  })
}

/** POST the draft plus its private reference; the Host runs one non-session call. */
function requestEnhance(payload, signal) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: signal,
  }).then(function (res) {
    return readBody(res).then(function (bag) {
      if (!res.ok || typeof bag.text !== 'string') {
        var reason = typeof bag.error === 'string' ? bag.error : 'HTTP ' + res.status
        var err = new Error(reason)
        err.refBytes = bag.refBytes
        throw err
      }
      return { text: bag.text, refBytes: bag.refBytes }
    })
  })
}

function createPromptEnhance(React, contextMod) {
  /**
   * Registered in `conversation.input.right`; renders only a hidden marker and
   * owns a plain DOM button placed beside the send button.
   */
  function PromptEnhanceMount(props) {
    // A subagent composer belongs to the delegated agent, not the user's draft
    // flow: the enhance button would only occupy the tool row (and, while the
    // subagent runs, jostle the interrupt controls). Hide the button and skip
    // all placement/network logic -- no anchor, no button, no controller.
    var isSubagent = props.session !== null && typeof props.session === 'object' &&
      props.session.subagent !== null && props.session.subagent !== undefined

    var markerRef = React.useRef(null)
    var apiRef = React.useRef(null)
    var stateRef = React.useRef({ blocked: true, busy: false })
    var draftRef = React.useRef('')
    var actionsRef = React.useRef(null)
    var lastRefRef = React.useRef('')
    var contextRef = React.useRef({ project: '', cwd: '', instructions: '', summary: '', history: '', replies: '' })

    var input = props.input || {}
    var draft = typeof input.draft === 'string' ? input.draft : ''
    var phase = input.phase
    var blocked = draft.trim() === '' || (phase !== undefined && phase !== 'plain')
    draftRef.current = draft
    actionsRef.current = props.inputActions || null

    // Standard props supply the session and workspace list hooks; the owner
    // share supplies the live conversation snapshot.
    var identity = function (s) { return s }
    var sessions = typeof props.useSessions === 'function' ? props.useSessions(identity) : null
    var workspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces(identity) : null
    contextRef.current = contextMod.readContext(props.session, sessions, workspaces)

    React.useEffect(function () {
      if (isSubagent) return
      var marker = markerRef.current
      if (!marker || !marker.parentNode) return
      var doc = marker.ownerDocument
      var trailing = marker.parentNode
      while (trailing && findPrimary(trailing) === null) trailing = trailing.parentNode
      if (!trailing) return

      ensureStyles(doc)

      var btn = doc.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-dsao-enhance-btn', '')
      btn.setAttribute('data-state', 'idle')
      btn.setAttribute('aria-label', 'Prompt 增强')
      btn.title = IDLE_TITLE
      btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;height:24px;flex:none;padding:0 4px;margin:0;border:none;border-radius:6px;background:transparent;color:' + IDLE_COLOR + ';cursor:pointer;font:inherit;font-size:12px;line-height:1;transition:background 120ms,color 120ms;'

      var svg = doc.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('width', '14')
      svg.setAttribute('height', '14')
      svg.setAttribute('aria-hidden', 'true')
      svg.style.flex = 'none'

      var icon = doc.createElementNS(SVG_NS, 'path')
      icon.setAttribute('d', PATH_SPARKLE)
      icon.setAttribute('fill', 'currentColor')
      svg.appendChild(icon)

      // Spinner arc, shown only while busy.
      var spinner = doc.createElementNS(SVG_NS, 'circle')
      spinner.setAttribute('class', 'dsao-enh-spinner')
      spinner.setAttribute('cx', '8')
      spinner.setAttribute('cy', '8')
      spinner.setAttribute('r', '6')
      spinner.setAttribute('fill', 'none')
      spinner.setAttribute('stroke', 'currentColor')
      spinner.setAttribute('stroke-width', '2')
      spinner.setAttribute('stroke-linecap', 'round')
      spinner.setAttribute('stroke-dasharray', '28')
      spinner.setAttribute('stroke-dashoffset', '20')
      spinner.style.display = 'none'
      svg.appendChild(spinner)

      var label = doc.createElement('span')
      label.setAttribute('class', 'dsao-enh-label')
      label.textContent = BUSY_LABEL

      btn.appendChild(svg)
      btn.appendChild(label)

      var controller = null
      var settleTimer = null
      var clearSettle = function () {
        if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
      }

      var render = function () {
        var s = stateRef.current
        var off = s.blocked || s.busy
        btn.disabled = off
        btn.style.cursor = off ? 'default' : 'pointer'
        btn.setAttribute('aria-busy', s.busy ? 'true' : 'false')
        if (s.busy) {
          btn.setAttribute('data-state', 'busy')
          btn.title = BUSY_TITLE
          btn.style.opacity = '1'
          btn.style.color = 'var(--dsw-alias-brand-primary)'
          btn.style.background = 'var(--dsw-alias-bg-layer-2)'
          icon.style.display = 'none'
          spinner.style.display = ''
          return
        }
        btn.setAttribute('data-state', 'idle')
        btn.style.opacity = s.blocked ? '0.4' : '1'
        btn.style.background = 'transparent'
        spinner.style.display = 'none'
        icon.style.display = ''
      }

      /** Idle tooltip carries the last context sizes, for diagnosis. */
      var idleTitle = function () {
        var diag = lastRefRef.current
        return diag === '' ? IDLE_TITLE : IDLE_TITLE + '\n' + diag
      }

      var settle = function (ok, why) {
        clearSettle()
        icon.setAttribute('d', ok ? PATH_CHECK : PATH_SPARKLE)
        btn.style.color = ok
          ? 'var(--dsw-alias-state-success-primary)'
          : 'var(--dsw-alias-state-error-primary)'
        var diag = lastRefRef.current
        btn.title = ok
          ? idleTitle()
          : 'Prompt 增强失败：' + why + (diag === '' ? '' : '\n' + diag)
        settleTimer = setTimeout(function () {
          icon.setAttribute('d', PATH_SPARKLE)
          btn.style.color = IDLE_COLOR
          btn.title = idleTitle()
          settleTimer = null
        }, ok ? 1400 : 2600)
      }

      btn.addEventListener('mousedown', function (e) { e.preventDefault() })
      btn.addEventListener('mouseenter', function () {
        if (btn.disabled) return
        btn.style.background = 'var(--dsw-alias-bg-layer-2)'
        btn.style.color = 'var(--dsw-alias-label-primary)'
      })
      btn.addEventListener('mouseleave', function () {
        if (stateRef.current.busy) return
        btn.style.background = 'transparent'
        if (settleTimer === null) btn.style.color = IDLE_COLOR
      })
      btn.addEventListener('click', function () {
        if (stateRef.current.busy) return
        var text = draftRef.current
        var actions = actionsRef.current
        if (text.trim() === '' || actions === null) return
        clearSettle()
        icon.setAttribute('d', PATH_SPARKLE)
        stateRef.current.busy = true
        render()
        controller = new AbortController()
        var ref = contextRef.current
        requestEnhance({
          text: text,
          project: ref.project,
          cwd: ref.cwd,
          instructions: ref.instructions,
          summary: ref.summary,
          history: ref.history,
          replies: ref.replies,
        }, controller.signal).then(function (reply) {
          if (reply.text.trim() !== '') actions.setDraft(reply.text)
          lastRefRef.current = refSummary(reply.refBytes, reply.searches)
          settle(true, '')
        }).catch(function (err) {
          lastRefRef.current = refSummary(err && err.refBytes, err && err.searches)
          settle(false, err && err.message ? err.message : String(err))
        }).then(function () {
          stateRef.current.busy = false
          controller = null
          render()
        })
      })

      apiRef.current = { render: render }
      render()
      ensurePlacement(trailing, btn)

      var obs = new MutationObserver(function () { ensurePlacement(trailing, btn) })
      obs.observe(trailing, { childList: true })

      return function () {
        obs.disconnect()
        clearSettle()
        if (controller !== null) controller.abort()
        if (btn.parentNode) btn.parentNode.removeChild(btn)
        apiRef.current = null
      }
    }, [])

    React.useEffect(function () {
      stateRef.current.blocked = blocked
      if (apiRef.current !== null) apiRef.current.render()
    }, [blocked])

    return isSubagent ? null : React.createElement('span', {
      ref: markerRef,
      'data-dsao-enhance-anchor': '',
      style: { display: 'none' },
    })
  }

  return { PromptEnhanceMount: PromptEnhanceMount }
}

exports.createPromptEnhance = createPromptEnhance
exports.ensurePlacement = ensurePlacement
exports.findPrimary = findPrimary
exports.refSummary = refSummary
exports.ENDPOINT = ENDPOINT
