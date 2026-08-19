// dsh-assistant-optimization — Client (development reference)
//
// This file shows the full plugin logic by combining all modules under
// src/modules/. For dynamic plugin development (cordis_define), paste the
// module contents inline — the dynamic plugin runner evaluates a single
// function body string with no module system.
//
// For the static plugin, lib/client.js uses window.__ModuleLoader__.load()
// multi-registration to achieve the same split at runtime.
//
// Module dependencies:
//   markers.js    — localStorage marker CRUD
//   text-split.js — splitText + transformBlocks
//   tool-diff.js  — file-edit diff line count badges
//   wrapper.js    — WrappedAssistantStep / WrappedToolCallTree + official renderer finders
//   mermaid.js    — MutationObserver + SVG rendering
//   settings.js   — TagsSetting React component
//
// See lib/client.js for the assembled static version.

// The apply function below is what gets registered as the Cordis plugin:
function apply(ctx) {
  var slots = ctx.get("slots");
  if (slots === undefined) return;

  // 1. Wrap official assistant-step renderer (priority -1 shadows priority 0)
  slots.inject("conversation.chat.node", function () {
    return slots.register(
      { name: "conversation.chat.node", key: "assistant-step", priority: -1, locale: "conversation" },
      function (rawProps) {
        var official = findOfficialRenderer(slots);
        var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
        return React.createElement(WrappedAssistantStep, wrapperProps);
      }
    );
  });

  // 1b. Wrap official tool-call renderer to add file-edit diff badges
  slots.inject("conversation.chat.node", function () {
    return slots.register(
      { name: "conversation.chat.node", key: "tool-call", priority: -1, locale: "conversation" },
      function (rawProps) {
        var official = findToolRenderer(slots);
        var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
        return React.createElement(WrappedToolCallTree, wrapperProps);
      }
    );
  });

  // 2. Settings page
  slots.inject("settings.general.item", function () {
    return slots.register(
      { name: "settings.general.item", id: "thinking-tags", order: 30 },
      function () { return React.createElement(TagsSetting); }
    );
  });

  // 3. Mermaid post-processor
  ctx.effect(function () { return startMermaidObserver(); });
}
