		var HINT_TEXT = '已从中断处继续'

		// ── React-layer shadow (mechanism A) ──────────────────────────────

		var _officialUserCache = null
		var _slotsRef = null
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
			if (content.length === 1 && content[0] && content[0].type === 'text' && String(content[0].text || '').trim() === '') {
				return true
			}
			return false
		}

		// ── DOM-layer fallback (mechanism B) ──────────────────────────────

		function startResumeHintObserver() {
			if (typeof document === 'undefined') return function () {}
			var ROW_SEL = '[class*="userRow"]'
			var BUBBLE_SEL = '[class*="bubble"]'
			var STACK_SEL = '[class*="userStack"]'

			function processRow(row) {
				if (!row || row.hasAttribute('data-dsao-resume-collapsed')) return
				var bubble = row.querySelector(BUBBLE_SEL)
				if (bubble) return
				var stack = row.querySelector(STACK_SEL)
				if (!stack) return
				var stackText = String(stack.textContent || '').trim()
				if (stackText !== '') return
				if (stack.querySelector('img')) return
				row.setAttribute('data-dsao-resume-collapsed', '')
				var hint = document.createElement('div')
				hint.setAttribute('data-dsao-resume-hint', '')
				hint.style.cssText = 'display:flex;align-items:center;gap:6px;margin:2px 0;padding:0 2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:1.4;user-select:none'
				var line = document.createElement('span')
				line.style.cssText = 'width:14px;height:1px;flex:none;background:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:0.6'
				hint.appendChild(line)
				hint.appendChild(document.createTextNode(HINT_TEXT))
				while (row.firstChild) row.removeChild(row.firstChild)
				row.appendChild(hint)
				row.style.alignItems = 'flex-start'
			}

			function scan(root) {
				try {
					var rows = root.querySelectorAll(ROW_SEL + ':not([data-dsao-resume-collapsed])')
					for (var i = 0; i < rows.length; i++) processRow(rows[i])
				} catch (err) {}
			}

			scan(document)
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
				scan(document)
			})
			obs.observe(document.body, { childList: true, subtree: true })
			return function () { obs.disconnect() }
		}

		function createResumeContinuity(React) {
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
				if (Official === null) return null
				return React.createElement(Official, props)
			}
			return { ResumeMarkerAwareUserNode: ResumeMarkerAwareUserNode }
		}

		exports.provideSlots = provideSlots
		exports.createResumeContinuity = createResumeContinuity
		exports.isResumeMarker = isResumeMarker
		exports.findOfficialUserRenderer = findOfficialUserRenderer
		exports.startResumeHintObserver = startResumeHintObserver
		exports.HINT_TEXT = HINT_TEXT
