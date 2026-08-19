// wrapper.js — wrap official assistant-step and tool-call renderers
// Exports: createWrapper (returns WrappedAssistantStep + WrappedToolCallTree)
// Requires: React, text-split module, markers module, tool-diff module

var _officialRendererCache = null;
var _toolRendererCache = null;

function findOfficialRenderer(slots) {
  if (_officialRendererCache) return _officialRendererCache;
  try {
    var entries = slots.entries("conversation.chat.node");
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.options.key === "assistant-step" && (e.options.priority ?? 0) === 0) {
        _officialRendererCache = e.component;
        return _officialRendererCache;
      }
    }
  } catch (err) {}
  return null;
}

function findToolRenderer(slots) {
  if (_toolRendererCache) return _toolRendererCache;
  try {
    var entries = slots.entries("conversation.chat.node");
    if (!entries) return null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.options.key === "tool-call" && (e.options.priority ?? 0) === 0) {
        _toolRendererCache = e.component;
        return _toolRendererCache;
      }
    }
  } catch (err) {}
  return null;
}

function createWrapper(React, textSplitMod, markersMod, toolDiffMod) {
  var transformBlocks = textSplitMod.transformBlocks;
  var loadMarkers = markersMod.loadMarkers;
  var annotateToolDiffs = toolDiffMod ? toolDiffMod.annotateToolDiffs : null;

  function WrappedAssistantStep(props) {
    var officialRenderer = props._officialRenderer;
    var ms = React.useState(loadMarkers());
    var markers = ms[0];

    React.useEffect(function () {
      function handler() { ms[1](loadMarkers()); }
      window.addEventListener("dsao:markers-changed", handler);
      return function () { window.removeEventListener("dsao:markers-changed", handler); };
    }, []);

    if (!officialRenderer) return null;
    var fp = Object.assign({}, props._rawProps || {});
    if (!markers || markers.length === 0) return React.createElement(officialRenderer, fp);
    var node = props.node;
    var data = node && node.data;
    if (!data || !data.blocks) return React.createElement(officialRenderer, fp);
    var hasText = false;
    for (var i = 0; i < data.blocks.length; i++) { if (data.blocks[i].kind === "text") { hasText = true; break; } }
    if (!hasText) return React.createElement(officialRenderer, fp);
    var newBlocks = transformBlocks(data.blocks, markers);
    var newData = Object.assign({}, data, { blocks: newBlocks });
    var newNode = Object.assign({}, node, { data: newData });
    var newProps = Object.assign({}, props._rawProps || {}, { node: newNode });
    return React.createElement(officialRenderer, newProps);
  }

  function WrappedToolCallTree(props) {
    var officialRenderer = props._officialRenderer;
    var ref = React.useRef(null);
    var node = props.node;
    var root = node && node.data && node.data.root;
    React.useEffect(function () {
      if (ref.current && root && annotateToolDiffs) annotateToolDiffs(ref.current, root);
    }, [root, officialRenderer, annotateToolDiffs]);
    if (!officialRenderer) return null;
    return React.createElement(
      'div',
      { ref: ref, className: 'dsao-tool-call-wrapper', style: { display: 'contents' } },
      React.createElement(officialRenderer, props._rawProps || {})
    );
  }

  return {
    WrappedAssistantStep: WrappedAssistantStep,
    WrappedToolCallTree: WrappedToolCallTree,
    findOfficialRenderer: findOfficialRenderer,
    findToolRenderer: findToolRenderer,
  };
}

exports.createWrapper = createWrapper;
exports.findOfficialRenderer = findOfficialRenderer;
exports.findToolRenderer = findToolRenderer;
