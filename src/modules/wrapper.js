// wrapper.js — wrap official assistant-step and tool-call renderers
// Exports: createWrapper (returns WrappedAssistantStep + WrappedToolCallRow),
//          findOfficialRenderer, findToolRenderer, findOfficialView
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

/** 从 slots 查找 tool.call.toolview 官方 priority 0 组件 */
function findOfficialView(slots, toolName) {
  try {
    var entries = slots.entries('tool.call.toolview')
    if (!entries) return null
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i]
      if (e.options.key === toolName && (e.options.priority || 0) === 0) return e.component
    }
  } catch (err) {}
  return null
}

function createWrapper(React, textSplitMod, markersMod, toolDiffMod) {
  var transformBlocks = textSplitMod.transformBlocks;
  var loadMarkers = markersMod.loadMarkers;
  var ensureBadge = toolDiffMod ? toolDiffMod.ensureBadge : null;
  var findOfficialView = toolDiffMod ? toolDiffMod.findOfficialView : null;

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

  // 叶子层 wrapper：包裹官方 FileMutationRow（write/edit），幂等注入 diff 徽章。
  // 关键：不声明 children→不需要 renderSlot；ensureBadge 幂等收敛，避免 MutationObserver 自触发卡死。
  function WrappedToolCallRow(props) {
    var official = props._officialRenderer;
    var ref = React.useRef(null);
    var block = props.block;

    React.useEffect(function () {
      if (!ref.current) return;
      if (ensureBadge) ensureBadge(ref.current, block);
      var obs = new MutationObserver(function () {
        if (ref.current && ensureBadge) ensureBadge(ref.current, block);
      });
      // 只观察 childList，不观察 characterData（避免文本流式更新误触发）
      obs.observe(ref.current, { childList: true, subtree: true });
      return function () { obs.disconnect(); };
    }, [block, official]);

    if (!official) return null;
    return React.createElement(
      'div',
      { ref: ref, className: 'dsao-tool-view-row', style: { display: 'contents' } },
      React.createElement(official, props._rawProps || {})
    );
  }

  return {
    WrappedAssistantStep: WrappedAssistantStep,
    WrappedToolCallRow: WrappedToolCallRow,
    findOfficialRenderer: findOfficialRenderer,
    findToolRenderer: findToolRenderer,
    findOfficialView: findOfficialView,
  };
}

exports.createWrapper = createWrapper;
exports.findOfficialRenderer = findOfficialRenderer;
exports.findToolRenderer = findToolRenderer;
exports.findOfficialView = findOfficialView;