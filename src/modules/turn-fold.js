// turn-fold.js — turn 过程折叠（codex 风格）
//
// 行为规格：
//   · turn 运行中：在该 turn 内容顶部注入「运行中 · 计时」行（每秒跳动，
//     不折叠内容）。不依赖 DSH 底部 "Deep diving…" 行（它计时要 15 秒才显示）。
//   · turn 结束（turn-tail 节点出现 = 结论来了）：运行中行移除，自动收起
//     该 turn 的过程节点（thinking、工具调用、中间正文、重试/上下文行），
//     只保留：
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
 * 续跑 marker 判定（与 resume-continuity.isResumeMarker 同一数据契约）：
 * 用户节点 + source.dsaoResume 标记 + 空 content（或纯空白 text 块）。
 * 本地实现保持 turn-fold 零依赖（单文件加载环境可独立运行）。
 */
function isResumeMarkerNode(node) {
  if (!node || node.kind !== "user") return false;
  var data = node.data;
  if (!data || typeof data !== "object") return false;
  var source = data.source;
  if (!source || typeof source !== "object" || source.dsaoResume !== true) return false;
  var content = data.content;
  if (!Array.isArray(content)) return false;
  if (content.length === 0) return true;
  return content.length === 1 && content[0] && content[0].type === "text" &&
    String(content[0].text || "").trim() === "";
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
 * 纯函数：把「中断续跑」拆出的相邻 turn 归并为一个折叠组（链模型）。
 * 链判定：turn 号连续 + 后段首节点是续跑 marker（isResumeMarkerNode）相连；
 * 除末段外各段以 aborted/error 收尾；链内全部 closed。覆盖手动停止续跑、
 * 报错（含上游 400）后继续、停→续→停→续链式多段。
 * 无过程节点的纯报错段（本无 fold）同样并入链——修复「错误行+marker 裸露
 * 在折叠头之外」的截图态。
 * 归并语义：组 id = 首段 turn 号；非末段除真实用户输入外全部转为折叠隐藏
 * （半截回复、组内 marker、错误行、turn-tail 动作行）；末段保留 closing +
 * tail + 错误行，隐藏其 marker 与过程；文案取末段状态 + 各段活跃时长之和。
 * 展开态显示链内全部历史（含被收起的 marker/错误行）。
 */
function mergeResumeFolds(plan, nodes, locations, turnMeta) {
  if (!turnMeta) return;
  var turnNums = [];
  plan.turnOf.forEach(function (tn) {
    if (turnNums.indexOf(tn) < 0) turnNums.push(tn);
  });
  if (turnNums.length < 2) return;
  turnNums.sort(function (a, b) { return a - b; });

  function keysOf(t) {
    return locations && typeof locations.getTurn === "function" ? locations.getTurn(t) : null;
  }
  function isMarkerLed(t) {
    var keys = keysOf(t);
    if (!keys || keys.length === 0) return false;
    return isResumeMarkerNode(nodes.get(keys[0]));
  }

  // 切链：连续号 + marker 相连扩展；非 closed turn 切断（运行末段不并入）。
  var chains = [];
  var cur = null;
  for (var i = 0; i < turnNums.length; i++) {
    var tn = turnNums[i];
    var meta = turnMeta[tn];
    if (!meta || meta.status !== "closed") {
      if (cur !== null) { chains.push(cur); cur = null; }
      continue;
    }
    if (cur !== null) {
      var prevTn = cur[cur.length - 1];
      var prevMeta = turnMeta[prevTn];
      var prevResumable = prevMeta.reasonKind === "aborted" || prevMeta.reasonKind === "error";
      if (tn === prevTn + 1 && prevResumable && isMarkerLed(tn)) {
        cur.push(tn);
        continue;
      }
      chains.push(cur);
    }
    cur = [tn];
  }
  if (cur !== null) chains.push(cur);

  var foldByTurn = {};
  for (var f = 0; f < plan.folds.length; f++) foldByTurn[plan.folds[f].turn] = plan.folds[f];

  var merged = [];
  for (var c = 0; c < chains.length; c++) {
    var chain = chains[c];
    if (chain.length === 1) {
      if (foldByTurn[chain[0]]) merged.push(foldByTurn[chain[0]]);
      continue;
    }
    var sTurn = chain[0];
    var eTurn = chain[chain.length - 1];
    var eMeta = turnMeta[eTurn];
    var eFold = foldByTurn[eTurn];
    var hiddenKeys = [];
    var hiddenSeen = {};
    for (var g = 0; g < chain.length; g++) {
      var t = chain[g];
      var keys = keysOf(t);
      if (!keys) continue;
      var isFinalSeg = t === eTurn;
      for (var ki = 0; ki < keys.length; ki++) {
        var key = keys[ki];
        var node = nodes.get(key);
        var markerUser = !!node && node.kind === "user" && isResumeMarkerNode(node);
        var realUser = !!node && node.kind === "user" && !markerUser;
        // 非末段：只留真实输入；末段：marker 收起，closing/tail/error 保留，
        // 过程沿用 eFold.hiddenKeys（补入集合）。
        var keep = isFinalSeg ? !markerUser : realUser;
        if (!keep && !hiddenSeen[key]) {
          hiddenSeen[key] = true;
          hiddenKeys.push(key);
        }
      }
      if (isFinalSeg && eFold) {
        for (var h = 0; h < eFold.hiddenKeys.length; h++) {
          var hk = eFold.hiddenKeys[h];
          if (!hiddenSeen[hk]) { hiddenSeen[hk] = true; hiddenKeys.push(hk); }
        }
      }
    }
    if (hiddenKeys.length === 0) continue; // 无可折叠内容 → 不建组
    var totalMs = null;
    for (g = 0; g < chain.length; g++) {
      var m = turnMeta[chain[g]];
      if (m && typeof m.runMs === "number") totalMs = (totalMs === null ? 0 : totalMs) + m.runMs;
    }
    var label = terminalLabel(eMeta.reasonKind);
    merged.push({
      turn: sTurn,
      hiddenKeys: hiddenKeys,
      anchorKey: hiddenKeys[0], // push 按链内流序 → 首个即流序首个隐藏节点
      closingKey: eFold ? eFold.closingKey : null,
      reasonKind: eMeta.reasonKind,
      label: label,
      runMs: totalMs,
      headerText: label + (totalMs !== null ? " · " + formatDuration(totalMs) : "")
    });
    // 位置域归属整链改写到组 id（tg 头隐藏依赖它）
    for (g = 0; g < chain.length; g++) {
      var sk = keysOf(chain[g]);
      if (sk) {
        for (var s2 = 0; s2 < sk.length; s2++) plan.turnOf.set(sk[s2], sTurn);
      }
    }
  }
  plan.folds = merged;
}

/**
 * 纯函数：从会话快照生成折叠计划。
 * 返回 { keySet: Set<key>, turnOf: Map<key,turn>, folds: [...], runs: [...] }
 * folds: [{ turn, hiddenKeys, anchorKey, closingKey, reasonKind, label, runMs, headerText }]
 *   closingKey 为该 turn 总结性回复（closing）所在 assistant-step 的 key，
 *   折叠态下用于一并收起其内部 thinking 行。只包含"有过程可折叠"的已完成 turn。
 * runs: [{ turn, startTime, anchorKey, before }] —— 运行中 turn：
 *   anchorKey/before 为「运行中」行的插入锚点（第一个过程节点前；
 *   尚无过程节点时锚到该 turn 最后一个节点之后）。
 */
function planTurnFold(session) {
  var plan = { keySet: null, turnOf: new Map(), folds: [], runs: [] };
  var turnMeta = {};
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
    if (!turn) return;
    var keys = locations && typeof locations.getTurn === "function" ? locations.getTurn(turnNum) : null;
    if (!keys || keys.length === 0) return;
    var i;
    for (i = 0; i < keys.length; i++) plan.turnOf.set(keys[i], turnNum);

    // 链归并所需的逐 turn 元数据（open 段也记录，链遇 open 即断）
    var metaReason = turn.end && turn.end.data && turn.end.data.reason ? turn.end.data.reason.kind : "completed";
    var metaRunMs = null;
    if (turn.start && turn.end && typeof turn.start.time === "number" && typeof turn.end.time === "number") {
      metaRunMs = Math.max(0, turn.end.time - turn.start.time);
    }
    turnMeta[turnNum] = { status: turn.status, reasonKind: metaReason, runMs: metaRunMs };

    // 运行中 turn：注入「运行中 · 计时」行的锚点
    if (turn.status === "open" && turn.start && typeof turn.start.time === "number") {
      var runAnchor = null;
      var runBefore = true;
      for (i = 0; i < keys.length; i++) {
        var rn = nodes.get(keys[i]);
        if (rn && isProcessNode(rn, null)) { runAnchor = keys[i]; break; }
      }
      if (runAnchor === null) {
        runBefore = false;
        for (i = keys.length - 1; i >= 0; i--) {
          if (nodes.get(keys[i])) { runAnchor = keys[i]; break; }
        }
      }
      if (runAnchor !== null) {
        plan.runs.push({ turn: turnNum, startTime: turn.start.time, anchorKey: runAnchor, before: runBefore });
      }
      return;
    }

    if (turn.status !== "closed") return;

    // 总结性回复：turn-tail data.closing（官方定位：最后一条含文本的 assistant-step）
    var closingSeq = null;
    for (i = 0; i < keys.length; i++) {
      var n = nodes.get(keys[i]);
      if (n && n.kind === "turn-tail" && n.data && n.data.closing && n.data.closing.finalNode) {
        closingSeq = n.data.closing.finalNode.seq;
        break;
      }
    }

    var hiddenKeys = [];
    var anchorKey = null;
    var closingKey = null;
    for (i = 0; i < keys.length; i++) {
      var node = nodes.get(keys[i]);
      if (!node) continue;
      if (node.kind === "assistant-step" && closingSeq !== null &&
          node.data && node.data.finalNode && node.data.finalNode.seq === closingSeq) {
        closingKey = keys[i];
      }
      if (isProcessNode(node, closingSeq)) {
        if (anchorKey === null) anchorKey = keys[i];
        hiddenKeys.push(keys[i]);
      }
    }
    if (hiddenKeys.length === 0) return;

    var runMs = turnMeta[turnNum].runMs;
    var reasonKind = turnMeta[turnNum].reasonKind;
    var label = terminalLabel(reasonKind);
    plan.folds.push({
      turn: turnNum,
      hiddenKeys: hiddenKeys,
      anchorKey: anchorKey,
      closingKey: closingKey,
      reasonKind: reasonKind,
      label: label,
      runMs: runMs,
      headerText: label + (runMs !== null ? " · " + formatDuration(runMs) : "")
    });
  });
  mergeResumeFolds(plan, nodes, locations, turnMeta);
  return plan;
}

// ── DOM 层 ────────────────────────────────────────────────────────────────

var CSS = [
  "[data-dsao-tf-hidden]{display:none!important}",
  "[data-dsao-tf-closing-folded] [data-variant=\"think\"]{display:none!important}",
  "[data-dsao-tf-process-end]{border-bottom:1px solid var(--dsw-alias-border-l2)}",
  "@keyframes dsao-tf-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
  ".dsao-tf-running{display:flex;align-items:center;gap:0;padding:0;cursor:default;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;min-width:0;border-bottom:1px solid var(--dsw-alias-border-l2)}",
  ".dsao-tf-runningIcon{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);margin-right:6px}",
  ".dsao-tf-runningDot{width:8px;height:8px;border-radius:50%;background:currentColor;animation:dsao-tf-pulse 1.2s ease-in-out infinite}",
  ".dsao-tf-runningText{font-weight:400;white-space:nowrap;min-width:0}",
  ".dsao-tf-header{display:flex;align-items:center;gap:0;padding:0;cursor:pointer;user-select:none;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-bottom:1px solid var(--dsw-alias-border-l2);border-radius:0;min-width:0;transition:color 120ms}",
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
  var existing = doc.getElementById("dsao-turn-fold-css");
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS;
    return;
  }
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
  header.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))";

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
  var chevron = doc.createElement("span");
  chevron.className = "dsao-tf-chevron";
  chevron.innerHTML = CHEVRON_SVG;
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
}

function findHeaderBefore(anchorEl) {
  // Walk backward past non-flow-item siblings (e.g. tool-group headers)
  // to find an existing turn-fold header that may have been separated
  // from its anchor by an injected element.
  var prev = anchorEl && anchorEl.previousElementSibling;
  while (prev) {
    if (prev.getAttribute && prev.getAttribute("data-dsao-tf-header") !== null) return prev;
    if (isFlowItemEl(prev)) break; // hit another flow item → no header between us
    prev = prev.previousElementSibling;
  }
  return null;
}

function isFlowItemEl(el) {
  return !!(el && el.getAttribute && el.getAttribute("data-chat-flow-key") !== null);
}

/** 创建「运行中 · 计时」行（纯状态展示，不可点）。计时文本由 tick 每秒刷新。 */
function createRunningRow(run, doc) {
  var row = doc.createElement("div");
  row.className = "dsao-tf-running";
  row.setAttribute("data-dsao-tf-running", String(run.turn));
  row.setAttribute("data-dsao-tf-start", String(run.startTime));
  row.setAttribute("role", "status");
  row.setAttribute("aria-live", "polite");
  row.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1))";

  var icon = doc.createElement("span");
  icon.className = "dsao-tf-runningIcon";
  var dot = doc.createElement("span");
  dot.className = "dsao-tf-runningDot";
  icon.appendChild(dot);

  var text = doc.createElement("span");
  text.className = "dsao-tf-runningText";
  text.textContent = runningText(run.startTime);

  row.appendChild(icon);
  row.appendChild(text);
  return row;
}

function runningText(startTime) {
  return "运行中 · " + formatDuration(Math.max(0, Date.now() - startTime));
}

/**
 * 幂等收敛运行中行：不存在则创建到锚点位置；位置漂移则移动；
 * 起点变化则更新 data-dsao-tf-start。before=true 插在 anchor 前，
 * 否则插在 anchor 后（anchor 是该 turn 最后一个节点）。
 */
function ensureRunningRow(column, run, anchorEl) {
  var existing = column.querySelector('[data-dsao-tf-running="' + run.turn + '"]');
  if (run.before) {
    if (!existing) {
      column.insertBefore(createRunningRow(run, column.ownerDocument), anchorEl);
    } else if (anchorEl.previousElementSibling !== existing) {
      column.insertBefore(existing, anchorEl);
    }
  } else {
    if (!existing) {
      column.insertBefore(createRunningRow(run, column.ownerDocument), anchorEl.nextElementSibling);
    } else if (anchorEl.nextElementSibling !== existing) {
      column.insertBefore(existing, anchorEl.nextElementSibling);
    }
  }
  var live = column.querySelector('[data-dsao-tf-running="' + run.turn + '"]');
  if (live && live.getAttribute("data-dsao-tf-start") !== String(run.startTime)) {
    live.setAttribute("data-dsao-tf-start", String(run.startTime));
  }
}

function stripColumn(column) {
  var hidden = column.querySelectorAll("[data-dsao-tf-hidden]");
  for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute("data-dsao-tf-hidden");
  var closing = column.querySelectorAll("[data-dsao-tf-closing-folded]");
  for (var n = 0; n < closing.length; n++) closing[n].removeAttribute("data-dsao-tf-closing-folded");
  var endMarks0 = column.querySelectorAll("[data-dsao-tf-process-end]");
  for (var e0 = 0; e0 < endMarks0.length; e0++) {
    endMarks0[e0].removeAttribute("data-dsao-tf-process-end");
    endMarks0[e0].style.borderBottom = "";
  }
  var headers = column.querySelectorAll("[data-dsao-tf-header]");
  for (var j = 0; j < headers.length; j++) {
    if (headers[j].parentNode) headers[j].parentNode.removeChild(headers[j]);
  }
  var running = column.querySelectorAll("[data-dsao-tf-running]");
  for (var r = 0; r < running.length; r++) {
    if (running[r].parentNode) running[r].parentNode.removeChild(running[r]);
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
  // 列归属校验：全部 key 都不在本会话 order 中 → 不是本会话的列，清掉自己的标记。
  // 部分不匹配（历史分页 prepend 时 session ref 暂时落后）只跳过未知项，不拆列。
  var unknown = 0;
  for (var i = 0; i < items.length; i++) {
    if (!plan.keySet.has(items[i].getAttribute("data-chat-flow-key"))) unknown++;
  }
  // 临时诊断：会话切换键匹配率单行日志（定位「切回会话组头裸露」用，定位后移除）
  try {
    console.debug("[DSAO-TF]", "items=" + items.length, "unknown=" + unknown,
      "folds=" + plan.folds.length, unknown > 0 && unknown === items.length ? "strip" : "apply");
  } catch (e) {}
  if (unknown > 0 && unknown === items.length) {
    stripColumn(column);
    return;
  }

  var byKey = {};
  for (var b = 0; b < items.length; b++) byKey[items[b].getAttribute("data-chat-flow-key")] = items[b];

  // 本轮应隐藏的 key 集合
  var toHide = {};
  var toCloseFold = {};
  var f;
  for (f = 0; f < plan.folds.length; f++) {
    var fold = plan.folds[f];
    if (expandedSet[fold.turn]) continue;
    var hk;
    for (hk = 0; hk < fold.hiddenKeys.length; hk++) toHide[fold.hiddenKeys[hk]] = true;
    // 折叠态下 closing 回复内的 thinking 行一并收起，只留总结性回复正文
    if (fold.closingKey) toCloseFold[fold.closingKey] = true;
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
    if (toCloseFold[k2]) {
      if (!el.hasAttribute("data-dsao-tf-closing-folded")) el.setAttribute("data-dsao-tf-closing-folded", "");
    } else if (el.hasAttribute("data-dsao-tf-closing-folded")) {
      el.removeAttribute("data-dsao-tf-closing-folded");
    }
  }

  // tool-group 折叠头隐藏：位置域归属判定。
  // 组头所属 turn = 其后第一个 key 已知 flowItem 的 turn（向前跨越非 flow 节点与
  // key 未知项，如窗口重投影导致的失配成员）；该 turn 已折叠且未被用户展开 → 隐藏。
  // 与成员的 tf-hidden 状态、组头邻接性完全解耦：成员 key 部分失配或组头泄漏
  // 堆叠在折叠区间内时，同样按位置域收起（切回会话冻结态的根因修复）。
  var foldTurns = {};
  for (f = 0; f < plan.folds.length; f++) foldTurns[plan.folds[f].turn] = true;
  var tgHeaders = column.querySelectorAll("[data-dsao-tg-header]");
  for (var t = 0; t < tgHeaders.length; t++) {
    var th = tgHeaders[t];
    var ownerTurn;
    var nx = th.nextElementSibling;
    while (nx) {
      if (nx.getAttribute && nx.getAttribute("data-chat-flow-key") !== null) {
        ownerTurn = plan.turnOf.get(nx.getAttribute("data-chat-flow-key"));
        if (ownerTurn !== undefined) break;
      }
      nx = nx.nextElementSibling;
    }
    // 向后回退：向前走不到已知 key（右侧全为失配成员或已到列尾）时，按左侧
    // 最近已知 flowItem 的 turn 归属。组头只注入在组首成员前，天然落在所属
    // turn 区间内；泄漏头也堆在区间边界上，左侧归属与真实归属一致。两个折叠
    // 区之间无歧义：左侧 turn 已折叠且未展开 → 同样隐藏（失配窗口冻结态兜底）。
    if (ownerTurn === undefined) {
      var pv = th.previousElementSibling;
      while (pv) {
        if (pv.getAttribute && pv.getAttribute("data-chat-flow-key") !== null) {
          ownerTurn = plan.turnOf.get(pv.getAttribute("data-chat-flow-key"));
          if (ownerTurn !== undefined) break;
        }
        pv = pv.previousElementSibling;
      }
    }
    var shouldHideTg = ownerTurn !== undefined && !!foldTurns[ownerTurn] && !expandedSet[ownerTurn];
    if (shouldHideTg) {
      if (!th.hasAttribute("data-dsao-tf-hidden")) th.setAttribute("data-dsao-tf-hidden", "");
    } else if (th.hasAttribute("data-dsao-tf-hidden")) {
      th.removeAttribute("data-dsao-tf-hidden");
    }
  }

  // 折叠头：创建/更新/清理
  var seenTurns = {};
  var validHeaders = {};
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
    validHeaders[fold2.turn] = existing;
  }
  var stale = column.querySelectorAll("[data-dsao-tf-header]");
  var keptTurns = {};
  for (var s2 = 0; s2 < stale.length; s2++) {
    var el = stale[s2];
    var turnNum = parseInt(el.getAttribute("data-dsao-tf-header"), 10);
    if (!seenTurns[turnNum]) {
      // Turn not in plan → remove
      if (el.parentNode) el.parentNode.removeChild(el);
    } else if (validHeaders[turnNum]) {
      // 保锚点邻接头：泄漏头（React 不管理注入节点，切会话原地留存）可能与正头
      // 同 turn 号且堆在列首——按 DOM 顺序保第一个会把对的删掉，必须按锚点归属保。
      if (el !== validHeaders[turnNum] && el.parentNode) el.parentNode.removeChild(el);
    } else if (keptTurns[turnNum]) {
      // 锚点失配（该 turn 无 valid 头）：退回保第一个
      if (el.parentNode) el.parentNode.removeChild(el);
    } else {
      keptTurns[turnNum] = true;
    }
  }

  // 展开态收尾分割线：过程块与总结回复之间的下划线。折叠态由折叠头的
  // border 承担；展开态落在 closing 前最后一个 flow item 上。复用折叠计划
  // 里的 closingKey 定位，零额外计算；收起时清除（属性 + 内联样式）。
  var processEndSeen = {};
  for (f = 0; f < plan.folds.length; f++) {
    var fold3 = plan.folds[f];
    if (!expandedSet[fold3.turn] || !fold3.closingKey) continue;
    var closingEl = byKey[fold3.closingKey];
    if (!closingEl) continue;
    var prevEl = closingEl.previousElementSibling;
    while (prevEl && !(prevEl.getAttribute && prevEl.getAttribute("data-chat-flow-key") !== null)) {
      prevEl = prevEl.previousElementSibling;
    }
    if (!prevEl) continue;
    if (!prevEl.hasAttribute("data-dsao-tf-process-end")) prevEl.setAttribute("data-dsao-tf-process-end", "");
    prevEl.style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))";
    processEndSeen[prevEl.getAttribute("data-chat-flow-key")] = true;
  }
  var endMarks = column.querySelectorAll("[data-dsao-tf-process-end]");
  for (var em = 0; em < endMarks.length; em++) {
    if (!processEndSeen[endMarks[em].getAttribute("data-chat-flow-key")]) {
      endMarks[em].removeAttribute("data-dsao-tf-process-end");
      endMarks[em].style.borderBottom = "";
    }
  }

  // 运行中行：创建/移动/清理（turn 结束 → 该行移除，由折叠头接替）
  var seenRuns = {};
  var r;
  for (r = 0; r < plan.runs.length; r++) {
    var run = plan.runs[r];
    seenRuns[run.turn] = true;
    var runAnchor = byKey[run.anchorKey];
    if (!runAnchor) continue;
    ensureRunningRow(column, run, runAnchor);
  }
  var staleRuns = column.querySelectorAll("[data-dsao-tf-running]");
  for (var sr = 0; sr < staleRuns.length; sr++) {
    var rturn = parseInt(staleRuns[sr].getAttribute("data-dsao-tf-running"), 10);
    if (!seenRuns[rturn] && staleRuns[sr].parentNode) staleRuns[sr].parentNode.removeChild(staleRuns[sr]);
  }

  // 分割线兜底：每次同步对列内所有折叠头/运行行内联补写下边框，
  // 不依赖创建路径与 CSS 注入时序（样式表缓存时仍保证可见）。
  var seps = column.querySelectorAll("[data-dsao-tf-header],[data-dsao-tf-running]");
  for (var sp = 0; sp < seps.length; sp++) {
    seps[sp].style.borderBottom = "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))";
  }
}

// ── React 挂载 ────────────────────────────────────────────────────────────

function createTurnFold(React, resetGroups, rescanGroups) {
  /**
   * 挂在 conversation.input.right：渲染一个不可见锚点，
   * 订阅当前会话快照 + 观察聊天列 DOM 变化，驱动折叠同步。
   * resetGroups/rescanGroups（可选，DI 自 tool-group）：会话切换收敛时复位
   * 并重建工具组注入——两个模块的注入头都是 React 不管理的外来节点，必须
   * 在同一时机一起拆、一起重建，否则泄漏头跨会话堆积（turn 号跨会话碰撞）。
   */
  function TurnFoldMount(props) {
    var markerRef = React.useRef(null);
    var sessionRef = React.useRef(props.session);
    sessionRef.current = props.session;
    var sessionIdRef = React.useRef(props.sessionId);
    sessionIdRef.current = props.sessionId;
    var syncRef = React.useRef(null);
    var convergeRef = React.useRef(null);
    var prevSessionIdRef = React.useRef(null);

    // 会话 id 解析：槽位 prop 缺失时回退到快照上的 sessionId。
    // userExpanded 以此为键——解析不出非空 id 时不读键、不落键，
    // 避免以 undefined/"" 为键造成跨会话展开态污染。
    function resolveSessionId() {
      var id = sessionIdRef.current;
      if (typeof id !== "string" || id === "") {
        var s = sessionRef.current;
        if (s && typeof s.sessionId === "string" && s.sessionId !== "") id = s.sessionId;
      }
      return typeof id === "string" ? id : "";
    }

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

      // ── 滚动锚定补偿 ─────────────────────────────────────────────
      // 「加载更早」场景：DSH 在 prepend 的布局 effect 里同步补偿滚动锚点，
      // 而本插件的折叠在其后异步落地——锚点上方内容塌缩使补偿失准（视口
      // 跳到很下面）。处理：把本次 sync 的 DOM 变更用「首视口元素锚点」
      // 括起来，变更前后各测一次 rect，差值写回 scrollTop，钉住正在看的
      // 内容。|delta|≤0.5px 不写，避免干扰 DSH 的 follow-scroll / toBottom。
      function scrollContainerOf(column) {
        var el = column.parentElement;
        while (el && el.nodeType === 1) {
          var mode = null;
          try { mode = doc.defaultView.getComputedStyle(el).overflowY; } catch (e) {}
          if (mode !== "auto" && mode !== "scroll" && el.style &&
              (el.style.overflowY === "auto" || el.style.overflowY === "scroll")) {
            mode = el.style.overflowY;
          }
          if (mode === "auto" || mode === "scroll") return el;
          el = el.parentElement;
        }
        return doc.scrollingElement || doc.documentElement;
      }

      function viewportAnchor(column) {
        var container = scrollContainerOf(column);
        var cRect = container.getBoundingClientRect();
        var items = column.querySelectorAll("[data-chat-flow-key]");
        for (var i = 0; i < items.length; i++) {
          var el = items[i];
          if (el.hasAttribute("data-dsao-tf-hidden")) continue;
          var r = el.getBoundingClientRect();
          if (r.bottom >= cRect.top && r.top <= cRect.bottom) {
            return { el: el, top: r.top, container: container };
          }
        }
        return null;
      }

      function restoreAnchor(anchor) {
        var el = anchor.el;
        var r = el.getBoundingClientRect();
        if (r.height === 0 && r.top === 0) {
          // 锚点行本次被折叠：挂到所在组的折叠头上（块首代表元素）
          var header = null;
          var prev = el.previousElementSibling;
          while (prev) {
            if (prev.getAttribute && prev.getAttribute("data-dsao-tf-header") !== null) { header = prev; break; }
            if (prev.getAttribute && prev.getAttribute("data-chat-flow-key") !== null &&
                !prev.hasAttribute("data-dsao-tf-hidden")) break;
            prev = prev.previousElementSibling;
          }
          if (header === null) return; // 定位不到代表元素 → 放弃补偿（不写滚动）
          el = header;
          r = el.getBoundingClientRect();
        }
        var delta = r.top - anchor.top;
        if (delta > 0.5 || delta < -0.5) anchor.container.scrollTop += delta;
      }

      function sync() {
        var session = sessionRef.current;
        var sessionId = resolveSessionId();
        if (!enabled) {
          var c0;
          var cols0 = columnList();
          for (c0 = 0; c0 < cols0.length; c0++) {
            var anchor0 = viewportAnchor(cols0[c0]);
            stripColumn(cols0[c0]);
            if (anchor0) restoreAnchor(anchor0);
          }
          return;
        }
        if (!session || !session.chat) return;
        var plan = planTurnFold(session);
        if (!plan.keySet) return;
        var expandedSet = sessionId !== "" ? (userExpanded[sessionId] || {}) : {};
        var cols = columnList();
        for (var c = 0; c < cols.length; c++) {
          var anchor = viewportAnchor(cols[c]);
          applyPlanToColumn(cols[c], plan, expandedSet);
          if (anchor) restoreAnchor(anchor);
        }
      }

      function scheduleSync() {
        if (timer !== null) return;
        timer = setTimeout(function () {
          timer = null;
          sync();
        }, 80);
      }
      syncRef.current = scheduleSync;

      // 会话切换收敛：全量拆除两个模块的注入痕迹，再按当前 DOM 重建。
      // 注入头是 React 不管理的外来节点，切换会话时 React 只换 keyed 子元素，
      // 注入头原地留存并堆进新会话的列（「多个 turn / 工具组在外面」的根源）。
      // 顺序：拆（tf 全列 strip + tg 复位）→ tg 全量重建 → tf 立即同步。
      // 直接同步不走防抖：拆与建同帧完成，运行中行不闪烁。
      // 工具组侧故障不允许拖垮折叠同步（lib 与 src 的 tool-group 状态变量
      // 已分叉过一次）：DI 调用整体 try/catch 隔离，rescanGroups 必须显式传根节点。
      function converge() {
        var cols = columnList();
        for (var i = 0; i < cols.length; i++) stripColumn(cols[i]);
        try {
          if (resetGroups) resetGroups();
          if (rescanGroups) rescanGroups(doc.body);
        } catch (e) {}
        sync();
      }
      convergeRef.current = converge;

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
                node.getAttribute("data-dsao-tf-header") !== null ||
                node.getAttribute("data-dsao-tg-header") !== null)) return true;
            if (node.querySelectorAll && (node.querySelector("[data-chat-flow-key]") ||
                node.querySelector("[data-dsao-tf-header]") ||
                node.querySelector("[data-dsao-tg-header]"))) return true;
          }
        }
        return false;
      }
      var obs = new MutationObserver(function (muts) {
        if (hasFlowDelta(muts)) scheduleSync();
      });
      obs.observe(doc.body, { childList: true, subtree: true });

      // 运行中行的计时每秒跳动（读取 data-dsao-tf-start，无运行中行时零开销）
      var tickTimer = setInterval(function () {
        var rows = doc.querySelectorAll("[data-dsao-tf-running]");
        for (var i = 0; i < rows.length; i++) {
          var start = parseInt(rows[i].getAttribute("data-dsao-tf-start"), 10);
          if (isNaN(start)) continue;
          var textEl = rows[i].querySelector(".dsao-tf-runningText");
          if (textEl) textEl.textContent = runningText(start);
        }
      }, 1000);

      // 折叠头点击（事件委托，避免重复绑定）
      function onClick(e) {
        var target = e.target;
        if (!target || !target.closest) return;
        var header = target.closest("[data-dsao-tf-header]");
        if (!header) return;
        e.preventDefault();
        e.stopPropagation();
        var sessionId = resolveSessionId();
        if (sessionId === "") return;
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
        clearInterval(tickTimer);
        obs.disconnect();
        doc.removeEventListener("click", onClick);
        doc.removeEventListener("keydown", onKeydown);
        window.removeEventListener("dsao:turn-fold-changed", onSettingChange);
        syncRef.current = null;
      };
    }, []);

    // 会话快照变化（含切换会话）→ 收敛 sweep：
    // · 会话 id 变化（含首次挂载）：走全量收敛（拆注入→tg 重建→tf 同步），把
    //   上一会话的注入泄漏在这一步根除；快照可能落后于 DOM（异步分页/部分加载
    //   窗口），主动多轮重跑（0/300/900/2000ms），快照补全后的轮次把状态拉回
    //   正确形态——否则 DOM 静止后没有新 mutation 能再触发同步（冻结态）。
    // · 同会话快照更新（流式 chunk）：只做轻量同步，不拆注入（保住用户手动
    //   展开的工具组与折叠头位置）。
    React.useEffect(function () {
      if (!convergeRef.current) return;
      var sid = resolveSessionId();
      var switched = prevSessionIdRef.current !== sid;
      prevSessionIdRef.current = sid;
      function run() {
        if (switched && convergeRef.current) convergeRef.current();
        else if (syncRef.current) syncRef.current();
      }
      run();
      var t2 = setTimeout(run, 300);
      var t3 = setTimeout(run, 900);
      var t4 = setTimeout(run, 2000);
      return function () { clearTimeout(t2); clearTimeout(t3); clearTimeout(t4); };
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
    var checkStyle = { width: "16px", height: "16px", cursor: "pointer", accentColor: "var(--dsw-alias-brand-primary)" };

    var leftCol = React.createElement("div", { style: Object.assign({ flex: "1 1 auto", minWidth: "0" }, titleStyle) }, "Turn Folding");
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
exports.isResumeMarkerNode = isResumeMarkerNode;
exports.mergeResumeFolds = mergeResumeFolds;
exports.planTurnFold = planTurnFold;
exports.ensureStyles = ensureStyles;
exports.stripColumn = stripColumn;
exports.applyPlanToColumn = applyPlanToColumn;
exports.createRunningRow = createRunningRow;
exports.ensureRunningRow = ensureRunningRow;
exports.runningText = runningText;
exports.createTurnFold = createTurnFold;
exports.createTurnFoldSetting = createTurnFoldSetting;
