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
// settingsScope：接管官方 transcriptView（dsh 0.1.2+ 默认 compact 折叠）
// sessions/uiConversation/conversation：会话数据注入的快照源（供给端，见下）
const inject = ['slots', 'settingsScope', 'sessions', 'uiConversation', 'conversation'];

// ── 会话数据注入（dsh 0.1.2+ 供给端）────────────────────────────────────
// 槽位 props 不再携带会话（conversation 包全部 renderSlot 均为空 props），
// 消费端（prompt-enhance / resume / turn-fold 三个挂载）已改为 Hook 型 props：
// useSession/useInput/useChat/useSessions/useWorkspaces。
// 供给走 renderer 的 entry inject：session-scoped 槽位的 inject(sessionId)
// 收到会话 id，返回 face 里 hooks.{name} 源会被包装成 use{Name} 选择器 Hook
// （useSyncExternalStoreWithSelector），源契约 = { getSnapshot, subscribe }。
function createSessionInject(ctx) {
  return function sessionInject(sessionId) {
    var face = { sessionId: sessionId };
    var hooks = {};
    try {
      // 聊天快照（形状兼容旧 session.chat：order/nodes/locations/timeline）
      var chatTarget = ctx.uiConversation.binding(sessionId).target("chat");
      hooks.chat = {
        getSnapshot: function () { return chatTarget.getSnapshot(); },
        subscribe: function (fn) { return chatTarget.subscribe(fn); }
      };
    } catch (e) { /* 会话未就绪：useChat 缺席，挂载端按 null 快照降级 */ }
    try {
      // 会话列表（byId 含 running/cwd/origin/current）——运行检测与上下文的数据源
      hooks.sessions = {
        getSnapshot: function () { return ctx.sessions.list.getSnapshot(); },
        subscribe: function (fn) { return ctx.sessions.list.subscribe(fn); }
      };
    } catch (e) {}
    try {
      // 会话面：优先挂 binding.session 门面（快照带 queue，placement:'queued'
      // 契约与旧版一致）；sessionId/running/subagent 按需补齐——running 来自
      // list 行（canResume 的运行检测依赖它），subagent 来自行的 origin。
      // 双订阅：门面与 list 任一变化都通知；组合快照按双身份缓存，保持
      // getSnapshot 引用稳定（useSyncExternalStore 要求缓存）。
      var binding = ctx.sessions.binding(sessionId);
      var facade = binding && binding.session;
      var listRef = hooks.sessions;
      function subagentOf(row) {
        return row && row.origin === "subagent"
          ? (row.parentSessionId !== undefined ? row.parentSessionId : true)
          : null;
      }
      if (facade && typeof facade.getSnapshot === "function") {
        var lastRaw = null, lastList = null, lastComposed = null;
        hooks.session = {
          getSnapshot: function () {
            var raw = facade.getSnapshot();
            var list = ctx.sessions.list.getSnapshot();
            if (raw !== lastRaw || list !== lastList) {
              lastRaw = raw;
              lastList = list;
              var row = list && list.byId ? list.byId[sessionId] : null;
              lastComposed = Object.assign({}, raw || {}, {
                sessionId: raw && raw.sessionId !== undefined ? raw.sessionId : sessionId,
                running: raw && raw.running !== undefined ? !!raw.running : !!(row && row.running),
                subagent: raw && raw.subagent !== undefined ? raw.subagent : subagentOf(row)
              });
            }
            return lastComposed;
          },
          subscribe: function (fn) {
            var unsubs = [];
            if (typeof facade.subscribe === "function") {
              try { unsubs.push(facade.subscribe(fn)); } catch (e3) {}
            }
            try { unsubs.push(listRef.subscribe(fn)); } catch (e4) {}
            return function () { for (var i = 0; i < unsubs.length; i++) { try { unsubs[i](); } catch (e5) {} } };
          }
        };
      } else {
        // 无门面：退化为 list 行合成
        hooks.session = {
          getSnapshot: function () {
            var list = ctx.sessions.list.getSnapshot();
            var row = list && list.byId ? list.byId[sessionId] : null;
            return {
              sessionId: sessionId,
              running: !!(row && row.running),
              subagent: subagentOf(row)
            };
          },
          subscribe: function (fn) { return listRef.subscribe(fn); }
        };
      }
    } catch (e) {}
    try {
      // 输入面（draft/phase）——composer 编辑投影
      var inputState = ctx.conversation.input.for(ctx.sessions.scope(sessionId)).state;
      hooks.input = {
        getSnapshot: function () { return inputState.getSnapshot(); },
        subscribe: function (fn) { return inputState.subscribe(fn); }
      };
    } catch (e) { /* 输入面未就绪：draft 视为空 */ }
    // workspaces：服务侧无稳定快照源，不给 useWorkspaces——readContext 对
    // null 容忍，仅项目名降级，增强请求其余上下文不受影响。
    if (Object.keys(hooks).length > 0) face.hooks = hooks;
    return face;
  };
}

// The apply function below is what gets registered as the Cordis plugin:
function apply(ctx) {
  var slots = ctx.slots;
  if (slots === undefined) return;
  var sessionInject = createSessionInject(ctx);

  // ── 屏蔽官方 turn 折叠（dsh 0.1.2+）───────────────────────────
  // 官方在 transcriptView==="compact" 时折叠过程成员（hidden="until-found"），
  // 与我们的 turn-fold 双重折叠。我们启用时把官方强制为 normal。
  function syncOfficialTranscriptView() {
    try {
      var enabled = turnFold.loadEnabled();
      var scope = ctx.settingsScope && ctx.settingsScope.bind ? ctx.settingsScope.bind({ namespace: "ui-chat" }) : null;
      if (!scope) return;
      scope.set("transcriptView", enabled ? "normal" : "compact");
    } catch (e) { /* host 设置不可写时静默退回纯 DOM 折叠 */ }
  }
  syncOfficialTranscriptView();
  window.addEventListener("dsao:turn-fold-changed", syncOfficialTranscriptView);

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
  var diffKeys = []; // v1.8.0: official ToolRow renders native write/edit diff stats
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
      { name: "conversation.input.right", id: "dsao-prompt-enhance", order: 100, locale: "conversation", inject: sessionInject },
      PromptEnhanceMount
    );
  });

  // 3b. 断点续发播放键：发送键内嵌覆盖面（门控点亮时发送键本体变 ▶），
  //     点击调用 /api/dsao/resume 免输入唤醒（PRD §14 Phase 2）。
  slots.inject("conversation.input.right", function () {
    return slots.register(
      { name: "conversation.input.right", id: "dsao-resume", order: 101, locale: "conversation", inject: sessionInject },
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
      { name: "conversation.input.right", id: "dsao-turn-fold", order: 110, locale: "conversation", inject: sessionInject },
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

  // 7. 模型选择器收窄适配：标记模型选择按钮（aria-haspopup + title 含 "·"），
  //    CSS 容器查询在窄宽度下隐藏文字（同权限按钮行为）。
  ctx.effect(function () { return startModelSelectorCompact(); });

  // 卸载时移除官方折叠同步监听
  ctx.effect(function () {
    return function () {
      window.removeEventListener("dsao:turn-fold-changed", syncOfficialTranscriptView);
    };
  });
}