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
//   markers.js        — localStorage marker CRUD
//   text-split.js     — splitText + transformBlocks
//   tool-diff.js      — file-edit diff line count badges (ensureBadge 幂等注入)
//   tool-group.js     — collapse consecutive tool-call rows into a group
//   wrapper.js        — WrappedAssistantStep / WrappedToolCallRow + official renderer finders
//   context.js        — private-reference extraction (project / instructions / summary / history)
//   prompt-enhance.js — composer button + placement
//   resume-gate.js    — ▶ 门控纯函数（FR-1 谓词）
//   resume-button.js  — 断点续发播放键（发送键旁挂，轮询门控）
//   mermaid.js        — MutationObserver + SVG rendering
//   settings.js       — TagsSetting React component
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

  // 1b. Wrap official tool-call *view* (write/edit) at the leaf-level
  //     tool.call.toolview slot to add file-edit diff badges. Leaf-tier
  //     shadow: does NOT declare children so it never 需要 renderSlot.
  var diffKeys = ['write', 'edit'];
  for (var di = 0; di < diffKeys.length; di++) {
    (function (key) {
      slots.inject("tool.call.toolview", function () {
        return slots.register(
          { name: "tool.call.toolview", key: key, priority: -1, locale: "conversation" },
          function (rawProps) {
            var official = findOfficialView(slots, key);
            var wrapperProps = Object.assign({}, rawProps, { _officialRenderer: official, _rawProps: rawProps });
            return React.createElement(WrappedToolCallRow, wrapperProps);
          }
        );
      });
    })(diffKeys[di]);
  }

  // 2. Settings page
  slots.inject("settings.general.item", function () {
    return slots.register(
      { name: "settings.general.item", id: "thinking-tags", order: 30 },
      function () { return React.createElement(TagsSetting); }
    );
  });
  slots.inject("settings.general.item", function () {
    return slots.register(
      { name: "settings.general.item", id: "windsurf-key", order: 40 },
      function () { return React.createElement(WindsurfKeySetting); }
    );
  });

  // 3. Prompt enhance button. Registered in conversation.input.right, which
  //    renders BEFORE the model select and context meter — the component only
  //    drops a hidden anchor there and inserts its own DOM button just left of
  //    the send button, since no slot exists at that exact position.
  slots.inject("conversation.input.right", function () {
    return slots.register(
      { name: "conversation.input.right", id: "dsao-prompt-enhance", order: 100, locale: "conversation" },
      PromptEnhanceMount
    );
  });

  // 3b. 断点续发播放键：发送键内嵌覆盖面（门控点亮时发送键本体变 ▶），
  //     点击调用 /api/dsao/resume 免输入唤醒（PRD §14 Phase 2）。
  slots.inject("conversation.input.right", function () {
    return slots.register(
      { name: "conversation.input.right", id: "dsao-resume", order: 101, locale: "conversation" },
      ResumeMount
    );
  });

  // 3c. 续跑行呈现：遮蔽 key:'user' 的官方渲染器，把续跑 marker 的空块
  //     用户消息渲染为「已从中断处继续」内联提示（项2 空白行 + 项4 连续性）。
  resumeContinuity.provideSlots(slots);
  slots.inject("conversation.chat.node", function () {
    return slots.register(
      { name: "conversation.chat.node", key: "user", priority: -1, locale: "conversation" },
      function (rawProps) {
        return React.createElement(resumeContinuity.ResumeMarkerAwareUserNode, rawProps);
      }
    );
  });

  // 4. Mermaid post-processor
  ctx.effect(function () { return startMermaidObserver(); });

  // 5. Tool-call grouping: collapse consecutive tool-call rows into a group
  ctx.effect(function () { return startToolGroupObserver(); });
}