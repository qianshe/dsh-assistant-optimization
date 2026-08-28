// turn-fold.js — 已完成 turn 的过程内容自动折叠（codex 风格）
//
// 行为规格：
//   · turn 运行中：不动（官方 "Deep diving…" + 计时行即"运行中+时间"显示）
//   · turn 结束（turn-tail 节点出现 = 结论来了）：自动收起该 turn 的过程节点
//     （thinking、工具调用、中间正文、重试/上下文行），只保留：
//       - 一行折叠头「已完成 · 时长」（出错/停止的 turn 显示对应状态，可点开）
//       - 该 turn 的总结性回复（官方 turn-tail.closing 定位的最后一条含文本回复）
//       - 用户消息（user / steering / command）与结果行（turn-error 等）
//   · 点折叠头展开看全过程，再点收起；用户选择只保存在内存（刷新后默认收起）。
//
// 数据源（全部来自会话快照，不靠 DOM 猜测）：
//   session.chat.order      有序节点 key 数组
//   session.chat.nodes      Map<key, { key, kind, data, location }>
//   session.chat.locations  getTurn(n) → 该 turn 的节点 key 数组（流程顺序）
//   session.chat.timeline   turns Map<n, { status, start, end }>
//                           end.data.reason.kind = 终止原因
//   turn-tail 节点 data.closing.finalNode.seq → 总结性回复的定位
//
// DOM 层（沿用 tool-group 模式）：
//   过程 flowItem 加 data-dsao-tf-hidden（display:none!important）
//   该 turn 第一个过程节点前注入 data-dsao-tf-header 折叠头
//   MutationObserver 只响应 flowItem 增删（不追流式文本），80ms 防抖

var STORAGE_KEY = "dsao:turn-fold-enabled";

var TERMINAL_LABELS = {
  completed: "已完成",
  aborted: "已停止",
  error: "已出错",
  "max-tokens": "已截断"
};

function loadEnabled() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) return raw === "1";
  } catch (e) {}
  return true;
}

function saveEnabled(v) {
  try { localStorage.setItem(STORAGE_KEY, v ? "1" : "0"); } catch (e) {}
  try { window.dispatchEvent(new Event("dsao:turn-fold-changed")); } catch (e) {}
}

function formatDuration(ms) {
  // 与 DSH 原生 turn 计时（formatRunDuration 中文模板）一致：42秒 / 3分05秒
  var total = Math.max(0, Math.floor(ms / 1000));
  var minutes = Math.floor(total / 60);
  var seconds = total % 60;
  if (minutes > 0) return minutes + "分" + String(seconds).padStart(2, "0") + "秒";
  return total + "秒";
}

function terminalLabel(reasonKind) {
  return TERMINAL_LABELS[reasonKind] || "已完成";
}

/**
 * 纯函数：判断节点是否为"过程节点"（turn 折叠时应隐藏）。
 * closingSeq 为该 turn 总结性回复的 finalNode.seq（null = 该 turn 无文本回复）。
 */
function isProcessNode(node, closingSeq) {
  var kind = node && node.kind;
  // 用户输入 / 结果行 / 页脚：保留
  if (kind === "user" || kind === "steering" || kind === "command") return false;
  if (kind === "turn-tail" || kind === "turn-error" || kind === "turn-max-tokens") return false;
  if (kind === "unknown") return false;
  if (kind === "assistant-step") {
    var fn = node.data && node.data.finalNode;
    return !(closingSeq !== null && fn && fn.seq === closingSeq);
  }
  // tool-call / model-retry / context / compaction / manual-compaction：过程
  return true;
}

/**
 * 纯函数：从会话快照生成折叠计划。
 * 返回 { keySet: Set<key>, folds: [{ turn, hiddenKeys, anchorKey, reasonKind, label, runMs, headerText }] }
 * 只包含"有过程可折叠"的已完成 turn。
 */
function planTurnFold(session) {
  var plan = { keySet: null, folds: [] };
  if (!session || typeof session !== "object") return plan;
  var chat = session.chat;
  if (!chat) return plan;
  var order = Array.isArray(chat.order) ? chat.order : [];
  plan.keySet = new Set(order);
  var nodes = chat.nodes;
  if (!nodes || typeof nodes.get !== "function") return plan;
  var timeline = chat.timeline;
  var locations = chat.locations;
  if (!timeline || !timeline.turns || typeof timeline.turns.forEach !== "function") return plan;

  timeline.turns.forEach(function (turn, turnNum) {
    if (!turn || turn.status !== "closed") return;
    var keys = locations && typeof locations.getTurn === "function" ? locations.getTurn(turnNum) : null;
    if (!keys || keys.length === 0) return;

    // 总结性回复：turn-tail data.closing（官方定位：最后一条含文本的 assistant-step）
    var closingSeq = null;
    var i;
    for (i = 0; i < keys.length; i++) {
      var n = nodes.get(keys[i]);
      if (n && n.kind === "turn-tail" && n.data && n.data.closing && n.data.closing.finalNode) {
        closingSeq = n.data.closing.finalNode.seq;
        break;
      }
    }

    var hiddenKeys = [];
    var anchorKey = null;
    for (i = 0; i < keys.length; i++) {
      var node = nodes.get(keys[i]);
      if (!node) continue;
      if (isProcessNode(node, closingSeq)) {
        if (anchorKey === null) anchorKey = keys[i];
        hiddenKeys.push(keys[i]);
      }
    }
    if (hiddenKeys.length === 0) return;

    var runMs = null;
    if (turn.start && turn.end && typeof turn.start.time === "number" && typeof turn.end.time === "number") {
      runMs = Math.max(0, turn.end.time - turn.start.time);
    }
    var reasonKind = turn.end && turn.end.data && turn.end.data.reason ? turn.end.data.reason.kind : "completed";
    var label = terminalLabel(reasonKind);
    plan.folds.push({
      turn: turnNum,
      hiddenKeys: hiddenKeys,
      anchorKey: anchorKey,
      reasonKind: reasonKind,
      label: label,
      runMs: runMs,
      headerText: label + (runMs !== null ? " · " + formatDuration(runMs) : "")
    });
  });
  return plan;
}

// ── DOM 层 ────────────────────────────────────────────────────────────────

var CSS = [
  "[data-dsao-tf-hidden]{display:none!important}",
  ".dsao-tf-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:0;min-width:0;transition:color 120ms}",
  ".dsao-tf-headerIcon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);margin-right:6px}",
  ".dsao-tf-headerIcon[data-state=error]{color:var(--dsw-alias-state-error-primary)}",
  ".dsao-tf-headerText{font-weight:400;white-space:nowrap;min-width:0}",
  ".dsao-tf-headerSpacer{flex:auto}",
  ".dsao-tf-toggle{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:24px}",
  ".dsao-tf-chevron{display:inline-flex;transition:transform 180ms ease;color:var(--dsw-alias-label-secondary)}",
  '.dsao-tf-header[data-dsao-tf-state="expanded"] .dsao-tf-chevron{transform:rotate(90deg)}',
  ".dsao-tf-header:hover .dsao-tf-headerText{color:var(--dsw-alias-label-primary)}",
].join("");

function ensureStyles(doc) {
  if (doc.getElementById("dsao-turn-fold-css")) return;
  var style = doc.createElement("style");
  style.id = "dsao-turn-fold-css";
  style.textContent = CSS;
  doc.head.appendChild(style);
}

var ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13.5 4.5l-6.4 7-4.1-3.6 1-1.1 3 2.6 5.4-5.9z" fill="currentColor"/></svg>';
var ICON_STOP = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="2" fill="currentColor"/></svg>';
var ICON_ERROR = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" fill="currentColor"/></svg>';
var CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.47813 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/></svg>';

function iconForReason(reasonKind) {
  if (reasonKind === "error") return ICON_ERROR;
  if (reasonKind === "aborted" || reasonKind === "max-tokens") return ICON_STOP;
  return ICON_CHECK;
}

function createHeader(fold, doc) {
  var header = doc.createElement("div");
  header.className = "dsao-tf-header";
  header.setAttribute("data-dsao-tf-header", String(fold.turn));
  header.setAttribute("data-dsao-tf-state", "collapsed");
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");
  header.setAttribute("aria-label", fold.headerText);

  var icon = doc.createElement("span");
  icon.className = "dsao-tf-headerIcon";
  icon.setAttribute("data-state", fold.reasonKind === "error" ? "error" : "ok");
  icon.innerHTML = iconForReason(fold.reasonKind);

  var text = doc.createElement("span");
  text.className = "dsao-tf-headerText";
  text.textContent = fold.headerText;

  var spacer = doc.createElement("span");
  spacer.className = "dsao-tf-headerSpacer";

  var toggle = doc.createElement("span");
  toggle.className = "dsao-tf-toggle";
  var toggleLabel = doc.createElement("span");
  toggleLabel.textContent = "展开";
  var chevron = doc.createElement("span");
  chevron.className = "dsao-tf-chevron";
  chevron.innerHTML = CHEVRON_SVG;
  toggle.appendChild(toggleLabel);
  toggle.appendChild(chevron);

  header.appendChild(icon);
  header.appendChild(text);
  header.appendChild(spacer);
  header.appendChild(toggle);
  return header;
}

function updateHeader(header, fold, expanded) {
  header.setAttribute("data-dsao-tf-state", expanded ? "expanded" : "collapsed");
  header.setAttribute("aria-expanded", expanded ? "true" : "false");
  var text = header.querySelector(".dsao-tf-headerText");
  if (text && text.textContent !== fold.headerText) text.textContent = fold.headerText;
  var toggleLabel = header.querySelector(".dsao-tf-toggle > span:first-child");
  if (toggleLabel) toggleLabel.textContent = expanded ? "收起" : "展开";
}

function findHeaderBefore(anchorEl) {
  var prev = anchorEl && anchorEl.previousElementSibling;
  if (prev && prev.getAttribute && prev.getAttribute("data-dsao-tf-header") !== null) return prev;
  return null;
}

function isFlowItemEl(el) {
  return !!(el && el.getAttribute && el.getAttribute("data-chat-flow-key") !== null);
}

function stripColumn(column) {
  var hidden = column.querySelectorAll("[data-dsao-tf-hidden]");
  for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute("data-dsao-tf-hidden");
  var headers = column.querySelectorAll("[data-dsao-tf-header]");
  for (var j = 0; j < headers.length; j++) {
    if (headers[j].parentNode) headers[j].parentNode.removeChild(headers[j]);
  }
  var tg = column.querySelectorAll("[data-dsao-tg-header][data-dsao-tf-hidden]");
  for (var k = 0; k < tg.length; k++) tg[k].removeAttribute("data-dsao-tf-hidden");
}

/**
 * 把折叠计划应用到一列（幂等收敛：按 key 对 diff 隐藏属性，按 turn 对 diff 折叠头）。
 */
function applyPlanToColumn(column, plan, expandedSet) {
  var items = column.querySelectorAll("[data-chat-flow-key]");
  if (items.length === 0) return;
  // 列归属校验：任一 key 不在本会话 order 中 → 不是本会话的列，清掉自己的标记。
  for (var i = 0; i < items.length; i++) {
    if (!plan.keySet.has(items[i].getAttribute("data-chat-flow-key"))) {
      stripColumn(column);
      return;
    }
  }

  var byKey = {};
  for (var b = 0; b < items.length; b++) byKey[items[b].getAttribute("data-chat-flow-key")] = items[b];

  // 本轮应隐藏的 key 集合
  var toHide = {};
  var f;
  for (f = 0; f < plan.folds.length; f++) {
    var fold = plan.folds[f];
    if (expandedSet[fold.turn]) continue;
    var hk;
    for (hk = 0; hk < fold.hiddenKeys.length; hk++) toHide[fold.hiddenKeys[hk]] = true;
  }

  // 隐藏/恢复 flowItem
  var k2;
  for (k2 in byKey) {
    var el = byKey[k2];
    if (toHide[k2]) {
      if (!el.hasAttribute("data-dsao-tf-hidden")) el.setAttribute("data-dsao-tf-hidden", "");
    } else if (el.hasAttribute("data-dsao-tf-hidden")) {
      el.removeAttribute("data-dsao-tf-hidden");
    }
  }

  // tool-group 折叠头：紧跟在某个被隐藏过程节点前 → 一并隐藏
  var tgHeaders = column.querySelectorAll("[data-dsao-tg-header]");
  for (var t = 0; t < tgHeaders.length; t++) {
    var th = tgHeaders[t];
    var next = th.nextElementSibling;
    while (next && !isFlowItemEl(next)) next = next.nextElementSibling;
    var shouldHideTg = !!(next && next.hasAttribute("data-dsao-tf-hidden"));
    if (shouldHideTg) {
      if (!th.hasAttribute("data-dsao-tf-hidden")) th.setAttribute("data-dsao-tf-hidden", "");
    } else if (th.hasAttribute("data-dsao-tf-hidden")) {
      th.removeAttribute("data-dsao-tf-hidden");
    }
  }

  // 折叠头：创建/更新/清理
  var seenTurns = {};
  for (f = 0; f < plan.folds.length; f++) {
    var fold2 = plan.folds[f];
    seenTurns[fold2.turn] = true;
    var anchor = byKey[fold2.anchorKey];
    if (!anchor) continue;
    var existing = findHeaderBefore(anchor);
    var expanded = !!expandedSet[fold2.turn];
    if (!existing) {
      existing = createHeader(fold2, column.ownerDocument);
      column.insertBefore(existing, anchor);
    } else if (existing.getAttribute("data-dsao-tf-header") !== String(fold2.turn)) {
      // 位置被占用（理论上不会）：移除重建
      if (existing.parentNode) existing.parentNode.removeChild(existing);
      existing = createHeader(fold2, column.ownerDocument);
      column.insertBefore(existing, anchor);
    }
    updateHeader(existing, fold2, expanded);
  }
  var stale = column.querySelectorAll("[data-dsao-tf-header]");
  for (var s2 = 0; s2 < stale.length; s2++) {
    var turnNum = parseInt(stale[s2].getAttribute("data-dsao-tf-header"), 10);
    if (!seenTurns[turnNum] && stale[s2].parentNode) stale[s2].parentNode.removeChild(stale[s2]);
  }
}

// ── React 挂载 ────────────────────────────────────────────────────────────

function createTurnFold(React) {
  /**
   * 挂在 conversation.input.right：渲染一个不可见锚点，
   * 订阅当前会话快照 + 观察聊天列 DOM 变化，驱动折叠同步。
   */
  function TurnFoldMount(props) {
    var markerRef = React.useRef(null);
    var sessionRef = React.useRef(props.session);
    sessionRef.current = props.session;
    var sessionIdRef = React.useRef(props.sessionId);
    sessionIdRef.current = props.sessionId;
    var syncRef = React.useRef(null);

    React.useEffect(function () {
      var marker = markerRef.current;
      var doc = marker && marker.ownerDocument ? marker.ownerDocument : document;
      if (!doc || !doc.body) return;
      ensureStyles(doc);

      // 用户展开偏好：sessionId -> { turnNum: true }
      var userExpanded = {};
      var enabled = loadEnabled();
      var timer = null;

      function columnList() {
        return doc.querySelectorAll("[data-chat-flow]");
      }

      function sync() {
        var session = sessionRef.current;
        var sessionId = sessionIdRef.current;
        if (!enabled) {
          var c0;
          var cols0 = columnList();
          for (c0 = 0; c0 < cols0.length; c0++) stripColumn(cols0[c0]);
          return;
        }
        if (!session || !session.chat) return;
        var plan = planTurnFold(session);
        if (!plan.keySet) return;
        var expandedSet = (sessionId && userExpanded[sessionId]) || {};
        var cols = columnList();
        for (var c = 0; c < cols.length; c++) applyPlanToColumn(cols[c], plan, expandedSet);
      }

      function scheduleSync() {
        if (timer !== null) return;
        timer = setTimeout(function () {
          timer = null;
          sync();
        }, 80);
      }
      syncRef.current = scheduleSync;

      // DOM 变化：只对 flowItem 增删响应（turn 结束 = turn-tail flowItem 新增）。
      function hasFlowDelta(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.type !== "childList") continue;
          var list = m.addedNodes.length > 0 ? m.addedNodes : m.removedNodes;
          for (var j = 0; j < list.length; j++) {
            var node = list[j];
            if (!node || node.nodeType !== 1) continue;
            if (node.getAttribute && (node.getAttribute("data-chat-flow-key") !== null ||
                node.getAttribute("data-dsao-tf-header") !== null)) return true;
            if (node.querySelectorAll && (node.querySelector("[data-chat-flow-key]") ||
                node.querySelector("[data-dsao-tf-header]"))) return true;
          }
        }
        return false;
      }
      var obs = new MutationObserver(function (muts) {
        if (hasFlowDelta(muts)) scheduleSync();
      });
      obs.observe(doc.body, { childList: true, subtree: true });

      // 折叠头点击（事件委托，避免重复绑定）
      function onClick(e) {
        var target = e.target;
        if (!target || !target.closest) return;
        var header = target.closest("[data-dsao-tf-header]");
        if (!header) return;
        e.preventDefault();
        e.stopPropagation();
        var sessionId = sessionIdRef.current;
        if (!sessionId) return;
        var turn = parseInt(header.getAttribute("data-dsao-tf-header"), 10);
        if (isNaN(turn)) return;
        if (!userExpanded[sessionId]) userExpanded[sessionId] = {};
        var map = userExpanded[sessionId];
        if (map[turn]) delete map[turn];
        else map[turn] = true;
        sync();
      }
      function onKeydown(e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        var target = e.target;
        if (!target || !target.closest) return;
        if (!target.closest("[data-dsao-tf-header]")) return;
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      }
      function onSettingChange() {
        enabled = loadEnabled();
        sync();
      }
      doc.addEventListener("click", onClick);
      doc.addEventListener("keydown", onKeydown);
      window.addEventListener("dsao:turn-fold-changed", onSettingChange);

      sync(); // 初次进入：对已加载的会话整体收敛一次

      return function () {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        obs.disconnect();
        doc.removeEventListener("click", onClick);
        doc.removeEventListener("keydown", onKeydown);
        window.removeEventListener("dsao:turn-fold-changed", onSettingChange);
        syncRef.current = null;
      };
    }, []);

    // 会话快照变化（含切换会话）→ 防抖再收敛一次
    React.useEffect(function () {
      if (syncRef.current) syncRef.current();
    }, [props.session, props.sessionId]);

    return React.createElement("span", { ref: markerRef, style: { display: "none" } });
  }

  return { TurnFoldMount: TurnFoldMount };
}

// ── 设置项 ────────────────────────────────────────────────────────────────

function createTurnFoldSetting(React) {
  function TurnFoldSetting() {
    var s = React.useState(loadEnabled()), enabled = s[0], setEnabled = s[1];

    React.useEffect(function () {
      function handler() { setEnabled(loadEnabled()); }
      window.addEventListener("dsao:turn-fold-changed", handler);
      return function () { window.removeEventListener("dsao:turn-fold-changed", handler); };
    }, []);

    function toggle() {
      var next = !enabled;
      setEnabled(next);
      saveEnabled(next);
    }

    var rowStyle = { borderBottom: "1px solid var(--dsw-alias-border-l2)", alignItems: "center", gap: "8px", padding: "16px 0", display: "flex" };
    var titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "14px", fontWeight: 400, lineHeight: "22px" };
    var descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: "18px" };
    var checkStyle = { width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)" };

    var leftCol = React.createElement("div", { style: { flex: "1 1 auto", minWidth: "0" } },
      React.createElement("div", { style: titleStyle }, "Turn Folding"),
      React.createElement("div", { style: descStyle }, "已完成回合自动收起过程（思考、工具调用），只留一行「已完成 · 时长」和总结回复；运行中不折叠"));
    var rightCol = React.createElement("input", {
      type: "checkbox",
      checked: enabled,
      onChange: toggle,
      style: checkStyle,
      "aria-label": "回合过程折叠"
    });
    return React.createElement("div", { style: rowStyle }, leftCol, rightCol);
  }
  return TurnFoldSetting;
}

exports.STORAGE_KEY = STORAGE_KEY;
exports.TERMINAL_LABELS = TERMINAL_LABELS;
exports.loadEnabled = loadEnabled;
exports.saveEnabled = saveEnabled;
exports.formatDuration = formatDuration;
exports.terminalLabel = terminalLabel;
exports.isProcessNode = isProcessNode;
exports.planTurnFold = planTurnFold;
exports.ensureStyles = ensureStyles;
exports.applyPlanToColumn = applyPlanToColumn;
exports.createTurnFold = createTurnFold;
exports.createTurnFoldSetting = createTurnFoldSetting;
