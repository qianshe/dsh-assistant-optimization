// settings.js — Settings page UI for managing markers
// Exports: TagsSetting (React component)
// Requires: markers module

function createTagsSetting(React, markersMod) {
  var loadMarkers = markersMod.loadMarkers;
  var saveMarkers = markersMod.saveMarkers;

  function TagsSetting() {
    var m = React.useState(loadMarkers()), markers = m[0], setMarkers = m[1];
    var inp = React.useState(""), input = inp[0], setInput = inp[1];

    function syncMarkers() {
      var updated = loadMarkers();
      setMarkers(updated.slice());
      window.dispatchEvent(new Event("dsao:markers-changed"));
    }
    function add() {
      var t = input.trim(); if (!t) return;
      var current = loadMarkers();
      if (!current.includes(t)) { current.push(t); saveMarkers(current); }
      setInput(""); syncMarkers();
    }
    function remove(tag) {
      var current = loadMarkers().filter(function (m) { return m !== tag; });
      saveMarkers(current); syncMarkers();
    }

    var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
    var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
    var descStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: "13px", lineHeight: "20px" };
    var chipStyle = { display: "inline-flex", alignItems: "center", gap: "4px", padding: "2px 8px", borderRadius: "6px", background: "var(--dsw-alias-interactive-bg-hover)", fontSize: "13px" };
    var xStyle = { cursor: "pointer", color: "var(--dsw-alias-label-tertiary)", border: "none", background: "none", padding: "0 2px", fontSize: "16px", lineHeight: "1" };
    var inputStyle = { fontSize: "13px", padding: "4px 8px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", outline: "none", minWidth: "100px" };
    var addBtnStyle = { cursor: "pointer", fontSize: "13px", padding: "4px 12px", borderRadius: "6px", border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-interactive-bg-base)", color: "var(--dsw-alias-label-primary)" };

    var chipEls = [];
    for (var ci = 0; ci < markers.length; ci++) {
      chipEls.push(React.createElement("span", { key: markers[ci], style: chipStyle }, markers[ci], React.createElement("button", { style: xStyle, onClick: function (tag) { return function () { remove(tag); }; }(markers[ci]) }, "\u00D7")));
    }
    chipEls.push(React.createElement("input", { key: "_input", value: input, onChange: function (e) { setInput(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") add(); }, placeholder: "Add marker...", style: inputStyle }));
    chipEls.push(React.createElement("button", { key: "_add", onClick: add, style: addBtnStyle }, "Add"));

    var leftCol = React.createElement("div", { style: { flexDirection: "column", flex: "1 1 auto", gap: "4px", display: "flex", minWidth: "0" } }, React.createElement("div", { style: titleStyle }, "Thinking Tag Markers"), React.createElement("div", { style: descStyle }, "Split reasoning text before these markers into collapsible blocks."));
    var rightCol = React.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", justifyContent: "flex-end", maxWidth: "280px" } }, chipEls);
    return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
  }

  return TagsSetting;
}

exports.createTagsSetting = createTagsSetting;
