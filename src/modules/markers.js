// markers.js — localStorage-based marker management
// Exports: loadMarkers, saveMarkers

var STORAGE_KEY = "dsao:thinking-markers";
var DEFAULT_MARKERS = ["\x3C/think\x3E"];

function loadMarkers() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { var p = JSON.parse(raw); if (Array.isArray(p)) return p; }
  } catch (e) {}
  return DEFAULT_MARKERS.slice();
}

function saveMarkers(m) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(m)); } catch (e) {}
}

exports.loadMarkers = loadMarkers;
exports.saveMarkers = saveMarkers;
exports.DEFAULT_MARKERS = DEFAULT_MARKERS;
