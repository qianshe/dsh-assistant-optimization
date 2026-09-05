
		var React = require("react");
		var markersMod = require("dsao/markers");

		function TagsSetting() {
			var m = React.useState(markersMod.loadMarkers()), markers = m[0], setMarkers = m[1];
			var inp = React.useState(""), input = inp[0], setInput = inp[1];

			function syncMarkers() {
				setMarkers(markersMod.loadMarkers().slice());
				window.dispatchEvent(new Event("dsao:markers-changed"));
			}
			function add() {
				var t = input.trim(); if (!t) return;
				var current = markersMod.loadMarkers();
				if (!current.includes(t)) { current.push(t); markersMod.saveMarkers(current); }
				setInput(""); syncMarkers();
			}
			function remove(tag) {
				var current = markersMod.loadMarkers().filter(function (m) { return m !== tag; });
				markersMod.saveMarkers(current); syncMarkers();
			}

			var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
			var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
			var chipStyle = { display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "6px", background: "var(--dsw-alias-interactive-bg-hover)", fontSize: "13px" };
			var xStyle = { cursor: "pointer", color: "var(--dsw-alias-label-tertiary)", border: "none", background: "none", padding: "0 2px", fontSize: "16px", lineHeight: "1" };
			var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "100px" };
			var addBtnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };

			var chipEls = [];
			for (var ci = 0; ci < markers.length; ci++) {
				chipEls.push(React.createElement("span", { key: markers[ci], style: chipStyle }, markers[ci], React.createElement("button", { style: xStyle, onClick: function (tag) { return function () { remove(tag); }; }(markers[ci]) }, "\u00D7")));
			}
			var inputGroup = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flex: "0 0 auto" } }, React.createElement("input", { value: input, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") add(); }, placeholder: "Add marker...", style: inputStyle }), React.createElement("button", { onClick: add, style: addBtnStyle }, "Add"));

			var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Thinking Tag Markers");
			var rightCol = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", flex: "1 1 auto", minWidth: "0", maxWidth: "560px" } }, React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", justifyContent: "flex-end", flex: "1 1 auto", minWidth: "0" } }, chipEls), inputGroup);
			return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
		}

		exports.TagsSetting = TagsSetting;

		// ── Windsurf API Key setting ─────────────────────────────────────
		// Manual entry for the fast-context tool's key. The host resolves keys
		// as: WINDSURF_API_KEY env → this manual file → local auto-read. With
		// no key the tool is not registered, so the status line doubles as the
		// "why is the tool missing" answer. Changes apply on next restart; the
		// value is never echoed back beyond a 4+4 preview.
		var KEY_ENDPOINT = "/api/dsao/windsurf-key";
		var SOURCE_LABELS = {
			env: "环境变量",
			file: "手动填写",
			auto: "自动读取",
			none: "未配置"
		};
		function WindsurfKeySetting() {
			var s = React.useState(null), status = s[0], setStatus = s[1];
			var inp = React.useState(""), input = inp[0], setInput = inp[1];
			var busy = React.useState(false), isBusy = busy[0], setBusy = busy[1];
			var note = React.useState(""), noteMsg = note[0], setNote = note[1];

			React.useEffect(function () {
				var cancelled = false;
				fetch(KEY_ENDPOINT, { method: "GET" })
					.then(function (r) { return r.json(); })
					.then(function (data) { if (!cancelled) setStatus(data); })
					.catch(function () { if (!cancelled) setStatus({ present: false, source: "none" }); });
				return function () { cancelled = true; };
			}, []);

			function refresh() {
				fetch(KEY_ENDPOINT, { method: "GET" })
					.then(function (r) { return r.json(); })
					.then(function (data) { setStatus(data); })
					.catch(function () {});
			}
			function save() {
				var k = input.trim();
				if (k === "" || isBusy) return;
				setBusy(true); setNote("");
				fetch(KEY_ENDPOINT, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k }) })
					.then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
					.then(function (res) {
						setInput("");
						if (res.ok) { setNote("已保存，重启后生效"); setStatus({ present: true, source: "file", preview: k.slice(0, 4) + "…" + k.slice(-4) }); }
						else setNote("保存失败：" + (res.data && res.data.error ? res.data.error : "未知错误"));
					})
					.catch(function (e) { setNote("保存失败：" + e.message); })
					.then(function () { setBusy(false); });
			}
			function clear() {
				if (isBusy) return;
				setBusy(true); setNote("");
				fetch(KEY_ENDPOINT, { method: "DELETE" })
					.then(function (r) { return r.json(); })
					.then(function () { setNote("已清除，重启后生效"); refresh(); })
					.catch(function (e) { setNote("清除失败：" + e.message); })
					.then(function () { setBusy(false); });
			}

			var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
			var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
			var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "160px" };
			var btnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };
			var statusStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px", whiteSpace: "nowrap" };
			var noteStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", lineHeight: "18px" };

			var statusText = status === null ? "读取中…" : (status.present ? (status.preview || "") + " · " + (SOURCE_LABELS[status.source] || status.source) : (SOURCE_LABELS[status.source] || "未配置"));

			var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Devin Key");
			var rightCol = React.createElement("div", { style: { display: "flex", gap: "6px", alignItems: "center", maxWidth: "560px" } },
				React.createElement("div", { style: statusStyle }, statusText),
				React.createElement("input", { type: "password", value: input, disabled: isBusy, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") save(); }, placeholder: "粘贴 key 后保存…", style: inputStyle }),
				React.createElement("button", { style: btnStyle, disabled: isBusy || input.trim() === "", onClick: save }, "保存"),
				React.createElement("button", { style: btnStyle, disabled: isBusy || status === null || !status.present, onClick: clear }, "清除"),
				noteMsg !== "" ? React.createElement("div", { style: noteStyle }, noteMsg) : null);
			return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
		}
		exports.WindsurfKeySetting = WindsurfKeySetting;
