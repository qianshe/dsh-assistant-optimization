// resume-button.js — 断点续发"内嵌三态"：把发送按钮本体变成播放键。
//
// 探针结论（PRD §14 P0-2 / 附录 B.3）：
//   - conversation.composer 是**替换式** chain（elected 整个顶掉 fallback 渲染），
//     没有"包官方组件再委托回去"的缝；fork 整个 InputBar 不可取。
//   - 官方 primary 按钮空稿时 disabled，子元素点击也不会触发；图标是内联
//     SVG、每次 React 渲染都会重画——任何"改官方节点内部"的方案都会被覆盖。
//
// 因此采用**覆盖面（overlay face）**方案：
//   - 门控点亮时，在 .trailing 容器里放一个绝对定位的层，精确盖住 primary
//     按钮的盒子，绘制 ▶ 面，视觉上 = 发送键变成了播放键；
//   - 层自己接管 click → POST /api/dsao/resume（官方按钮收不到任何事件，
//     空稿 disabled 的原生行为也一并绕开）；
//   - 盖面位置随轮询/resize/MutationObserver 三路刷新，幂等清理；
//   - 其余场景盖面隐藏，官方按钮完全原样（FR-2 仲裁不变）。
//
// 悬浮提示已按需求移除（v1.6.2 项3）；错误反馈仅保留按钮态闪烁。

var RESUME_ENDPOINT = '/api/dsao/resume'
var SVG_NS = 'http://www.w3.org/2000/svg'
// Play triangle sized to match official send-arrow visual weight inside 16×16 viewBox.
// Official send arrow spans ~x1.3–14.7 / y1–15; play triangle spans ~x3–14 / y2–14.
var PATH_PLAY = 'M3 2v12l11-6z'

function ensureStyles(doc) {
	if (doc.getElementById('dsao-resume-css') !== null) return
	var style = doc.createElement('style')
	style.id = 'dsao-resume-css'
	// Exactly mirrors the official .uV2eYG_primary Button skin:
	//   background: var(--dsw-alias-button-info-fill); color:#fff;
	//   border-radius:999px; display:grid; place-items:center;
	//   transition:background-color .1s; transform:translateY(-2px)
	// The overlay box is sized by primaryBox() to precisely cover the
	// official button, so we only need to match fill/hover/disabled.
	style.textContent = [
		'[data-dsao-resume-overlay]{position:absolute;z-index:30;border:none;margin:0;padding:0;display:none;align-items:center;justify-content:center;place-items:center;background:var(--dsw-alias-button-info-fill);color:#fff;border-radius:999px;cursor:pointer;transition:background-color .1s;transform:translateY(-2px);}',
		'[data-dsao-resume-overlay]:hover:not(:disabled){background:var(--dsw-alias-button-info-hover);}',
		'[data-dsao-resume-overlay]:disabled{cursor:not-allowed;opacity:.4;}',
	].join('\n')
	doc.head.appendChild(style)
}

/**
 * 把 trailing 内第一个 primary 按钮的盒子坐标算出来（相对 trailing）。
 * @returns {{left,top,width,height}} 或 null（找不到 / 盒子为零时）。
 */
function primaryBox(trailing) {
	var buttons = typeof trailing.querySelectorAll === 'function'
		? trailing.querySelectorAll('button[class*="primary"]')
		: []
	if (buttons.length === 0) return null
	var target = buttons[0]
	var tr = trailing.getBoundingClientRect()
	var br = target.getBoundingClientRect()
	if (br.width === 0 || br.height === 0) return null
	return {
		left: br.left - tr.left,
		top: br.top - tr.top,
		width: br.width,
		height: br.height,
	}
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

			ensureStyles(doc)
			// relative 定位锚：trailing 变成 overlay 的包含块（幂等：已有值不动）。
			if (!trailing.style.position) trailing.style.position = 'relative'

			var overlay = doc.createElement('button')
			overlay.type = 'button'
			overlay.setAttribute('data-dsao-resume-overlay', '')
			overlay.setAttribute('aria-label', '断点续发')

			var svg = doc.createElementNS(SVG_NS, 'svg')
			svg.setAttribute('viewBox', '0 0 16 16')
			svg.setAttribute('width', '16')
			svg.setAttribute('height', '16')
			svg.setAttribute('aria-hidden', 'true')
			svg.style.flex = 'none'
			var icon = doc.createElementNS(SVG_NS, 'path')
			icon.setAttribute('d', PATH_PLAY)
			icon.setAttribute('fill', 'currentColor')
			svg.appendChild(icon)
			overlay.appendChild(svg)

			trailing.appendChild(overlay)

			var busy = false
			var settleTimer = null
			var clearSettle = function () {
				if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null }
			}

			var place = function () {
				var box = primaryBox(trailing)
				if (box === null) return
				overlay.style.left = box.left + 'px'
				overlay.style.top = box.top + 'px'
				overlay.style.width = box.width + 'px'
				overlay.style.height = box.height + 'px'
			}

			function renderIdle() {
				clearSettle()
				busy = false
				overlay.disabled = false
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

			overlay.addEventListener('click', function () {
				if (busy) return
				var snap = sessionRef.current
				var verdict = gateMod.canResume(snap, draftRef.current)
				if (verdict.canResume !== true) return
				var sessionId = snap && typeof snap.sessionId === 'string' ? snap.sessionId : ''
				if (sessionId === '') return
				busy = true
				overlay.disabled = true
				requestResume(sessionId).then(function () {
					settleTimer = setTimeout(function () { renderIdle(); poll() }, 1200)
				}).catch(function (err) {
					settleTimer = setTimeout(function () { renderIdle(); poll() }, 2600)
				})
			})

			// 轮询门控 + 三路位置刷新（interval/resize/mutation）。
			var poll = function () {
				if (busy) { place(); return }
				var verdict = gateMod.canResume(sessionRef.current, draftRef.current)
				var visible = verdict.canResume === true
				overlay.style.display = visible ? 'grid' : 'none'
				if (visible) place()
			}
			var timer = setInterval(poll, 700)
			var onReflow = function () { if (overlay.style.display !== 'none') place() }
			window.addEventListener('resize', onReflow)
			var obs = new MutationObserver(onReflow)
			obs.observe(trailing, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled'] })
			poll()

			return function () {
				obs.disconnect()
				clearInterval(timer)
				window.removeEventListener('resize', onReflow)
				clearSettle()
				if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
			}
		})

		// 每次渲染后同步最新快照/草稿（无依赖数组 effect 即渲染后同步）。
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
exports.primaryBox = primaryBox
exports.ensureStyles = ensureStyles
