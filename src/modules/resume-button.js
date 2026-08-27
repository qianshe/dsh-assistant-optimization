// resume-button.js — 断点续发：直接替换发送按钮的 icon 和 click 行为。
//
// v1.6.6 改为直接替换 SVG，但 React reconciliation 不感知 DOM 修改，
// deactivate() 后原始 icon 无法可靠还原（输入内容 / 完成续跑后按钮卡在 ▶）。
//
// v1.6.8 改为 **CSS 叠加**策略：
//   - 激活时：给按钮加 data-dsao-resume 属性 + 追加一个 data-dsao-play SVG。
//     CSS 规则 [data-dsao-resume] > svg:not([data-dsao-play]) { display:none }
//     隐藏官方 icon，播放 icon 可见。
//   - 关闭时：移除 data-dsao-resume 属性 + 移除播放 SVG。
//     官方 icon 立即恢复（CSS 不再隐藏），React 无需重新渲染。
//   - 不修改官方 SVG 的任何属性 → React reconciliation 完全不受干扰。

var RESUME_ENDPOINT = '/api/dsao/resume'
var SVG_NS = 'http://www.w3.org/2000/svg'
var PATH_PLAY = 'M3 2v12l11-6z'

function ensureStyles(doc) {
	if (doc.getElementById('dsao-resume-btn-css') !== null) return
	var style = doc.createElement('style')
	style.id = 'dsao-resume-btn-css'
	// 隐藏官方 icon + 悬浮提示（与 DSH Tooltip 统一：var(--dsw-alias-tooltip-bg)）。
	style.textContent = [
		'[data-dsao-resume] > svg:not([data-dsao-play]){display:none}',
		'[data-dsao-resume]{position:relative}',
		'[data-dsao-resume]::after{',
			'content:attr(data-dsao-tip);',
			'position:absolute;',
			'bottom:calc(100% + 6px);',
			'left:50%;',
			'transform:translateX(-50%);',
			'background:var(--dsw-alias-tooltip-bg,#2c2c2e);',
			'color:#fff;',
			'font-size:12px;',
			'line-height:1;',
			'padding:6px 10px;',
			'border-radius:6px;',
			'white-space:nowrap;',
			'pointer-events:none;',
			'opacity:0;',
			'transition:opacity .15s ease .3s;',
			'z-index:100;',
		'}',
		'[data-dsao-resume]:hover::after{opacity:1}',
	].join('')
	doc.head.appendChild(style)
}

function findPrimaryButton(trailing) {
	if (!trailing || typeof trailing.querySelector !== 'function') return null
	var btn = trailing.querySelector('button[class*="primary"]')
	return btn || null
}

function createResumeButton(React, gateMod) {
	function ResumeMount(props) {
		var markerRef = React.useRef(null)
		var sessionRef = React.useRef(props.session)
		var draftRef = React.useRef(typeof (props.input && props.input.draft) === 'string' ? props.input.draft : '')

		React.useEffect(function () {
			var marker = markerRef.current
			if (!marker || !marker.parentNode) return
			var doc = marker.ownerDocument

			var trailing = marker.parentNode
			while (
				trailing &&
				(typeof trailing.querySelector !== 'function' ||
					trailing.querySelector('button[class*="primary"]') === null)
			) {
				trailing = trailing.parentNode
			}
			if (!trailing) return

			ensureStyles(doc)

			var active = false
			var busy = false
			var settleTimer = null
			var hijackedBtn = null

			function clearSettle() {
				if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
			}

			function requestResume(sessionId) {
				return fetch(RESUME_ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: sessionId }),
				}).then(function (res) {
					return res.text().then(function (raw) {
						var bag
						try { bag = JSON.parse(raw) } catch (e) { bag = {} }
						if (!res.ok || bag.accepted !== true) {
							throw new Error(typeof bag.error === 'string' ? bag.error : 'HTTP ' + res.status)
						}
						return bag
					})
				})
			}

			/**
			 * 激活：标记按钮 + 追加播放 SVG + 安装 click 拦截。
			 * 幂等：已有 play SVG 不重复添加。
			 */
			function activate(btn) {
				if (!btn) return
				if (active && hijackedBtn === btn) return
				if (active && hijackedBtn !== btn) deactivate()
				hijackedBtn = btn
				active = true
				btn.setAttribute('data-dsao-resume', '')
				btn.setAttribute('data-dsao-tip', '断点续发')
				btn.setAttribute('aria-label', '断点续发')
				btn.removeAttribute('disabled')
				// 追加播放 SVG（幂等）。
				if (!btn.querySelector('svg[data-dsao-play]')) {
					var playSvg = doc.createElementNS(SVG_NS, 'svg')
					playSvg.setAttribute('viewBox', '0 0 16 16')
					playSvg.setAttribute('width', '16')
					playSvg.setAttribute('height', '16')
					playSvg.setAttribute('aria-hidden', 'true')
					playSvg.setAttribute('data-dsao-play', '')
					var path = doc.createElementNS(SVG_NS, 'path')
					path.setAttribute('d', PATH_PLAY)
					path.setAttribute('fill', 'currentColor')
					playSvg.appendChild(path)
					btn.appendChild(playSvg)
				}
				installClickHijack(btn)
			}

			/**
			 * 关闭：移除标记 + 移除播放 SVG + 移除 click 拦截。
			 * 官方 icon 因 CSS 规则不再适用而立即恢复可见——无需 React 重新渲染。
			 */
			function deactivate() {
				if (!active) return
				if (hijackedBtn) {
					removeClickHijack(hijackedBtn)
					hijackedBtn.removeAttribute('data-dsao-resume')
					hijackedBtn.removeAttribute('data-dsao-tip')
					hijackedBtn.removeAttribute('aria-label')
					var playSvg = hijackedBtn.querySelector('svg[data-dsao-play]')
					if (playSvg) playSvg.remove()
				}
				active = false
				hijackedBtn = null
			}

			function installClickHijack(btn) {
				if (btn._dsaoHijackRemover) return // 已安装
				function onCaptureClick(ev) {
					ev.stopPropagation()
					ev.preventDefault()
					if (busy) return
					var snap = sessionRef.current
					var verdict = gateMod.canResume(snap, draftRef.current)
					if (verdict.canResume !== true) return
					var sessionId = snap && typeof snap.sessionId === 'string' ? snap.sessionId : ''
					if (sessionId === '') return
					deactivate()
					busy = true
					requestResume(sessionId).then(function () {
						settleTimer = setTimeout(function () { busy = false; poll() }, 1200)
					}).catch(function () {
						settleTimer = setTimeout(function () { busy = false; poll() }, 2600)
					})
				}
				btn.addEventListener('click', onCaptureClick, true)
				btn._dsaoHijackRemover = function () {
					btn.removeEventListener('click', onCaptureClick, true)
					btn._dsaoHijackRemover = null
				}
			}

			function removeClickHijack(btn) {
				if (btn && typeof btn._dsaoHijackRemover === 'function') {
					btn._dsaoHijackRemover()
				}
			}

			function poll() {
				if (busy) return
				var verdict = gateMod.canResume(sessionRef.current, draftRef.current)
				var shouldActivate = verdict.canResume === true
				var btn = findPrimaryButton(trailing)
				if (!btn) return
				if (shouldActivate) {
					activate(btn)
				} else {
					deactivate()
				}
			}

			var timer = setInterval(poll, 400)

			// React 重画按钮时，如果仍处于激活态，确保标记和播放图标在位。
			var domObs = new MutationObserver(function () {
				if (!active) return
				var btn = findPrimaryButton(trailing)
				if (!btn || btn !== hijackedBtn) {
					hijackedBtn = null
					poll()
				} else {
					// 同一按钮但 React 重画了子树 → 确保标记、提示和播放 SVG 在位。
					if (!btn.hasAttribute('data-dsao-resume')) {
						btn.setAttribute('data-dsao-resume', '')
						btn.setAttribute('data-dsao-tip', '断点续发')
						btn.setAttribute('aria-label', '断点续发')
					}
					if (!btn.querySelector('svg[data-dsao-play]')) {
						var playSvg = doc.createElementNS(SVG_NS, 'svg')
						playSvg.setAttribute('viewBox', '0 0 16 16')
						playSvg.setAttribute('width', '16')
						playSvg.setAttribute('height', '16')
						playSvg.setAttribute('aria-hidden', 'true')
						playSvg.setAttribute('data-dsao-play', '')
						var path = doc.createElementNS(SVG_NS, 'path')
						path.setAttribute('d', PATH_PLAY)
						path.setAttribute('fill', 'currentColor')
						playSvg.appendChild(path)
						btn.appendChild(playSvg)
					}
					if (!btn._dsaoHijackRemover) installClickHijack(btn)
				}
			})
			domObs.observe(trailing, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] })

			poll()

			return function () {
				domObs.disconnect()
				clearInterval(timer)
				clearSettle()
				deactivate()
			}
		})

		React.useEffect(function () {
			sessionRef.current = props.session
			draftRef.current = typeof (props.input && props.input.draft) === 'string' ? props.input.draft : ''
		})

		return React.createElement('span', {
			ref: markerRef,
			'data-dsao-resume-anchor': '',
			style: { display: 'none' },
		})
	}

	return { ResumeMount: ResumeMount }
}

exports.createResumeButton = createResumeButton
exports.RESUME_ENDPOINT = RESUME_ENDPOINT
exports.findPrimaryButton = findPrimaryButton
exports.ensureStyles = ensureStyles
