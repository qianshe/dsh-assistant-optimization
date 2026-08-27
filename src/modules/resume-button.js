// resume-button.js — 断点续发：直接替换发送按钮的 icon 和 click 行为。
//
// 方案演进：v1.6.2–v1.6.5 用覆盖面（overlay），但有间隙/阴影/对齐问题。
// v1.7 改为**直接替换**：门控点亮时，直接操作官方 primary 按钮的 DOM ——
// 替换其内部 SVG 为 ▶ 图标，劫持 click → POST /api/dsao/resume。
// React 重新渲染会重画按钮内部，用 MutationObserver 监测并在下一帧重做替换。
//
// 优点：零间隙（就是同一个按钮），样式 100% 官方（不改 CSS），icon 完全居中。
// 门控关闭时还原按钮原始状态，不影响正常发送。

var RESUME_ENDPOINT = '/api/dsao/resume'
var SVG_NS = 'http://www.w3.org/2000/svg'
var PATH_PLAY = 'M3 2v12l11-6z'

/**
 * 在 trailing 容器里找官方 primary 按钮。
 */
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

			// 锚点在 input.right 的渲染位；真实容器是向上找到含 primary 按钮的行。
			var trailing = marker.parentNode
			while (
				trailing &&
				(typeof trailing.querySelector !== 'function' ||
					trailing.querySelector('button[class*="primary"]') === null)
			) {
				trailing = trailing.parentNode
			}
			if (!trailing) return

			// ── 替换状态管理 ──────────────────────────────────────────
			var active = false        // 门控是否点亮
			var busy = false          // 续跑请求进行中
			var settleTimer = null
			var savedInnerHTML = null // 原始按钮内容备份
			var savedOnClick = null   // 原始 click handler 备份（通过 cloneNode 捕获）
			var hijackedBtn = null    // 当前被劫持的按钮引用

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
			 * 把指定按钮替换为续跑 ▶ 面。
			 * 替换 SVG icon + 设置 aria-label + enabled + 劫持 click。
			 */
			function applyResumeFace(btn) {
				if (!btn) return
				// 移除旧 SVG（React 画的上箭头/停止方块）
				var oldSvg = btn.querySelector('svg')
				var newSvg = btn.ownerDocument.createElementNS(SVG_NS, 'svg')
				newSvg.setAttribute('viewBox', '0 0 16 16')
				newSvg.setAttribute('width', '16')
				newSvg.setAttribute('height', '16')
				newSvg.setAttribute('aria-hidden', 'true')
				var path = btn.ownerDocument.createElementNS(SVG_NS, 'path')
				path.setAttribute('d', PATH_PLAY)
				path.setAttribute('fill', 'currentColor')
				newSvg.appendChild(path)
				if (oldSvg) {
					oldSvg.replaceWith(newSvg)
				} else {
					btn.appendChild(newSvg)
				}
				btn.setAttribute('aria-label', '断点续发')
				btn.removeAttribute('disabled')
				// 移除 React 的 onClick（通过 stopPropagation + 自定义 handler 在 capture 层拦截）
			}

			/**
			 * 在按钮上安装续跑 click 拦截。
			 * 用 capture 阶段拦截，阻止 React 合成事件触发。
			 */
			function installClickHijack(btn) {
				function onCaptureClick(ev) {
					ev.stopPropagation()
					ev.preventDefault()
					if (busy) return
					var snap = sessionRef.current
					var verdict = gateMod.canResume(snap, draftRef.current)
					if (verdict.canResume !== true) return
					var sessionId = snap && typeof snap.sessionId === 'string' ? snap.sessionId : ''
					if (sessionId === '') return
					busy = true
					if (hijackedBtn) hijackedBtn.setAttribute('disabled', '')
					requestResume(sessionId).then(function () {
						settleTimer = setTimeout(function () {
							busy = false
							if (hijackedBtn) hijackedBtn.removeAttribute('disabled')
							poll()
						}, 1200)
					}).catch(function () {
						settleTimer = setTimeout(function () {
							busy = false
							if (hijackedBtn) hijackedBtn.removeAttribute('disabled')
							poll()
						}, 2600)
					})
				}
				btn.addEventListener('click', onCaptureClick, true)
				// 把 remover 存在按钮上以便后续清理
				btn._dsaoHijackRemover = function () {
					btn.removeEventListener('click', onCaptureClick, true)
				}
			}

			function removeClickHijack(btn) {
				if (btn && typeof btn._dsaoHijackRemover === 'function') {
					btn._dsaoHijackRemover()
					btn._dsaoHijackRemover = null
				}
			}

			/**
			 * 激活续跑面：保存原始状态 → 替换 icon + 劫持 click。
			 */
			function activate(btn) {
				if (active && hijackedBtn === btn) return // 已激活且同一按钮
				if (active && hijackedBtn !== btn) deactivate() // 切按钮：先还原
				hijackedBtn = btn
				// 不需要备份 innerHTML —— React 重画时 MutationObserver 会重做替换
				active = true
				applyResumeFace(btn)
				installClickHijack(btn)
			}

			/**
			 * 还原：移除劫持，让 React 下一次渲染恢复原始按钮。
			 */
			function deactivate() {
				if (!active) return
				if (hijackedBtn) {
					removeClickHijack(hijackedBtn)
					// 不手动还原 SVG —— 让 React 自己重画。
					// 但需要触发 React 重画：修改一个 React 关心的属性 → 不靠谱。
					// 更简单：手动恢复 disabled 状态（空稿时 React 会保持 disabled），
					// 然后 React 的下次 setState/渲染会重画按钮内容。
				}
				active = false
				hijackedBtn = null
			}

			// ── 轮询 + MutationObserver ──────────────────────────────
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
					// 如果刚从激活变为未激活，React 可能不会立即重画，
					// 手动触发：修改 disabled 属性让 React 检测到变化。
					// 但更可靠的方式：什么都不做，让下次 React render 自然恢复。
				}
			}

			var timer = setInterval(poll, 500)

			// React 重画按钮内部时（子树变更），如果仍处于激活态，重做替换。
			var domObs = new MutationObserver(function () {
				if (!active) return
				var btn = findPrimaryButton(trailing)
				if (!btn || btn !== hijackedBtn) {
					// 按钮被 React 替换了 → 重新激活新按钮
					hijackedBtn = null
					poll()
				} else {
					// 同一按钮但内部被 React 重画 → 重做 icon 替换
					var svg = btn.querySelector('svg path')
					if (!svg || svg.getAttribute('d') !== PATH_PLAY) {
						applyResumeFace(btn)
					}
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

		// 每次渲染后同步最新快照/草稿。
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
