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

// Required services, declared so Cordis holds this fiber in waiting until the
// slots service is actually provided. Row order does NOT make a service
// available: in dsh 0.1.2+ the shell boots all client plugin entries
// concurrently (Promise.all over the boot manifest), so an undeclared probe
// like ctx.get("slots") races the renderer and silently bails out. This is
// the client-side twin of the host half's `inject = ['webServer']` fix.
const inject = ['slots'];

// The apply function below is what gets registered as the Cordis plugin:
function apply(ctx) {
  var slots = ctx.slots;
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

  // 2c. Turn folding toggle
  slots.inject("settings.general.item", function () {
    return slots.register(
      { name: "settings.general.item", id: "turn-fold", order: 50 },
      function () { return React.createElement(createTurnFoldSetting(React)); }
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
  //     ResumeMarkerAwareUserNode 由工厂创建（模块拿 React 走 DI，不直接导出组件），
  //     必须经 createResumeContinuity 实例化——直接引用模块属性是 undefined，
  //     会让 React 抛 #130（element type undefined，经槽位边界让位官方渲染器后
  //     仅表现为控制台报错）。
  resumeContinuity.provideSlots(slots);
  var resumeRC = resumeContinuity.createResumeContinuity(React);
  slots.inject("conversation.chat.node", function () {
    return slots.register(
      { name: "conversation.chat.node", key: "user", priority: -1, locale: "conversation" },
      function (rawProps) {
        return React.createElement(resumeRC.ResumeMarkerAwareUserNode, rawProps);
      }
    );
  });

  // 3d. 回合过程折叠：隐藏锚点挂在输入行，同步器观察聊天列 DOM +
  //     会话快照，把已完成 turn 的过程收起为「已完成 · 时长」一行。
  //     会话切换收敛需要拆掉两个模块的注入头再重建（注入头是 React 不管理
  //     的外来节点，跨会话原地泄漏），因此把 tool-group 的复位/重建函数
  //     经 DI 传入——缺省参数下行为退化为纯 tf 同步（测试环境用）。
  slots.inject("conversation.input.right", function () {
    return slots.register(
      { name: "conversation.input.right", id: "dsao-turn-fold", order: 110, locale: "conversation" },
      createTurnFold(React, resetToolGroups, scanToolGroups).TurnFoldMount
    );
  });

  // 4. Mermaid post-processor
  ctx.effect(function () { return startMermaidObserver(); });

  // 5. Tool-call grouping: collapse consecutive tool-call rows into a group
  ctx.effect(function () { return startToolGroupObserver(); });

  // 6. 断点续发行折叠：DOM 层后备，把官方渲染的空 marker 气泡替换为
  //    「已从中断处继续」提示行（slot 遮蔽未生效时的双保险）。
  ctx.effect(function () { return resumeContinuity.startResumeHintObserver(); });
}