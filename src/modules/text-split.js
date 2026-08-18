// text-split.js — split text blocks at markers into reasoning + text
// Exports: splitText, transformBlocks

function splitText(text, markers) {
  var valid = (markers || []).filter(function (m) { return typeof m === "string" && m.length > 0; });
  if (valid.length === 0) return [{ kind: "body", text: text }];
  var segs = [];
  var pos = 0;
  while (pos < text.length) {
    var cut = -1;
    for (var i = 0; i < valid.length; i++) {
      var at = text.indexOf(valid[i], pos);
      if (at !== -1 && (cut === -1 || at < cut)) cut = at;
    }
    if (cut === -1) { segs.push({ kind: "body", text: text.slice(pos) }); break; }
    var reason = text.slice(pos, cut);
    if (reason.trim() !== "") segs.push({ kind: "reason", text: reason });
    pos = cut;
    for (var j = 0; j < valid.length; j++) { if (text.startsWith(valid[j], pos)) { pos += valid[j].length; break; } }
  }
  return segs;
}

function transformBlocks(blocks, markers) {
  if (!markers || markers.length === 0) return blocks;
  var out = [];
  for (var bi = 0; bi < blocks.length; bi++) {
    var b = blocks[bi];
    if (b.kind !== "text") { out.push(b); continue; }
    var segs = splitText(b.text || "", markers);
    for (var si = 0; si < segs.length; si++) {
      var seg = segs[si];
      if (seg.kind === "reason") out.push({ kind: "reasoning", text: seg.text });
      else if (seg.text.trim() !== "") out.push({ kind: "text", text: seg.text });
    }
  }
  return out;
}

exports.splitText = splitText;
exports.transformBlocks = transformBlocks;
