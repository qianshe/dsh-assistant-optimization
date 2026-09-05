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
		var session = typeof props.useSession === 'function' ? props.useSession(function (s) { return s; }) : null
		var chatSnapshot = typeof props.useChat === 'function' ? props.useChat(function (s) { return s; }) : null
		var inputState = typeof props.useInput === 'function' ? props.useInput(function (s) { return s; }) : null
		var sessionRef = React.useRef(session)
		sessionRef.current = session
		var chatRef = React.useRef(chatSnapshot)
		chatRef.current = chatSnapshot
		var gateSyncRefRef = React.useRef(null)
		var draft = typeof (inputState && inputState.draft) === 'string' ? inputState.draft : ''
		var draftRef = React.useRef(draft)
		draftRef.current = draft

		// dsh 0.1.2：门控快照 = 会话生命周期 + 聊天时间线合成旧 session.chat 形状
		// （resume-gate 纯函数契约不变）。running 缺失时从聊天时间线派生——
		// 任一 turn open 即运行中；该字段缺失会导致 ▶ 在运行中永不熄灭。
		function gateSnapshot() {
			var s = sessionRef.current
			var c = chatRef.current
			if (!s) return null
			if (!c) return s
			var running = s.running !== undefined ? !!s.running : gateMod.deriveRunning(c)
			return Object.assign({}, s, { chat: c, running: running })
		}

		// v1.8.1 去轮询：session/chat/input 快照都是响应式 Hook——快照变化即
		// 重渲染，渲染期用纯函数重评门控，下方 effect 按结论同步按钮态。
		// 原 400ms 轮询与失败后的补偿重扫一并移除。
		var verdict = gateMod.canResume(gateSnapshot(), draftRef.current)

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
			var hijackedBtn = null

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
					var snap = gateSnapshot()
					var verdict = gateMod.canResume(snap, draftRef.current)
					if (verdict.canResume !== true) return
					var sessionId = snap && typeof snap.sessionId === 'string' ? snap.sessionId : ''
					if (sessionId === '') return
					// 不提前 deactivate：请求失败时 ▶ 留存可重试；成功后快照变化
					//（新 turn 开启）经响应式门控自动熄灭并还原原生按钮。
					busy = true
					requestResume(sessionId).then(function () { busy = false }).catch(function () { busy = false })
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

			// 门控 → 按钮态同步（activate/deactivate 均幂等）。由 verdict effect
			// 在快照变化时驱动；挂载时先对齐一次。
			function syncGate() {
				var v = gateMod.canResume(gateSnapshot(), draftRef.current)
				var btn = findPrimaryButton(trailing)
				if (!btn) return
				if (v.canResume === true) activate(btn)
				else deactivate()
			}
			gateSyncRefRef.current = syncGate

			syncGate()

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
				deactivate()
				gateSyncRefRef.current = null
			}
		})

		// 门控结论变化 → 同步按钮态（原 400ms 轮询的响应式替代）
		React.useEffect(function () {
			if (gateSyncRefRef.current) gateSyncRefRef.current()
		}, [verdict.canResume, verdict.reason, verdict.terminalKind])

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
