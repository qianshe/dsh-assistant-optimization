// 离线复现装置：turn-fold 会话初始化（converge sweep）× DSH 滚动账本
//
// 用户报告：打开会话后滚动条未定位到底部。
// 本装置把三件事拼在一条时间线上：
//   1. jsdom 里的迷你布局引擎（行高模型 + scrollTop 钳制 + scroll 事件
//      异步投递 + getBoundingClientRect 累积高度模型），让「塌缩→钳制→
//      事件→ResizeObserver」的真实浏览器语义可离线复现；
//   2. DSH ChatView 滚动逻辑的逐行复刻（toBottom / observed-top 账本 /
//      FOLLOW_THRESHOLD=24 归因 / open 分支 restore-saved / prepend 锚定 /
//      ResizeObserver 钉底），全部取自 deepseek-harness 的
//      packages/client/ui-conversation/src/client/chat/ChatView.tsx 原文；
//   3. 真实 src/modules/turn-fold.js（createTurnFold 全生命周期，tool-group
//      DI 置空 = 模块注释声明的测试模式）。
//
// 时间线语义（与浏览器一致）：
//   JS 任务（React commit / 插件 timer / 插件 sync）
//     → 渲染步 dshRenderStep()：布局钳制（内容塌缩浏览器自动钳 scrollTop
//       并投递 scroll 事件）+ ResizeObserver 回调（列高净变化且钉底时
//       重钉——followRef 语义）
//     → scroll 事件异步投递 settle()（浏览器把 scroll 事件作为任务投递，
//       不是 setter 同步）
//
// 运行：
//   node scripts/repro-open-scroll.cjs bug    # 断言「修复前代码复现故障」
//   node scripts/repro-open-scroll.cjs fixed  # 断言「修复后行为正确」
// bug 模式是历史复现（v1.6.20 的两个滚动 bug：底部漂移 + 切回漂移），
// 只对修复前代码全绿；修复后代码下 Phase 2/3/5 的 bug 断言会失败 = 修复生效。
// fixed 模式是回归门禁：Phase 1-3 底部语义、Phase 4 「加载更早」锚定补偿
// （约束：不得破坏）、Phase 5 切走→切回位置恢复（参考行偏移全程 ≤1px、
// 两周期无累积）。
//
// 退出码 0 = 断言全过；1 = 发散。

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'node_modules', 'jsdom'));

const EXPECT = process.argv[2] || 'bug';
const SID = 'sess-A';

const dom = new JSDOM('<!doctype html><html><body><div id="chat"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const doc = dom.window.document;
global.window = dom.window;
global.document = doc;
try { global.navigator = dom.window.navigator; } catch (e) {}
global.localStorage = dom.window.localStorage;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = clearTimeout;

// ── 1. 迷你布局引擎 ─────────────────────────────────────────────────────────
// 行高模型（只为让「锚点上方塌缩量」有可观测量级；量级贴近真实消息行）：
const H = { user: 48, 'tool-call': 36, 'assistant-step': 120, 'turn-tail': 40, steering: 48, header: 24, other: 20 };
const VIEW_H = 800;

function rowHeight(el) {
  if (el.nodeType !== 1) return 0;
  if (el.hasAttribute('data-dsao-tf-hidden')) return 0;
  if (el.hasAttribute('data-dsao-tf-header')) return H.header;
  if (el.hasAttribute('data-dsao-tf-running')) return H.header;
  if (el.hasAttribute('data-dsao-tg-header')) return H.header;
  return H[el.getAttribute('data-chat-flow-kind')] ?? H.other;
}

// DOM：body > #chat > .scrollport(overflow-y:auto) > [data-chat-flow]
const scrollport = doc.createElement('div');
scrollport.className = 'scrollport';
scrollport.style.overflowY = 'auto';
const column = doc.createElement('div');
column.setAttribute('data-chat-flow', '');
scrollport.appendChild(column);
doc.getElementById('chat').appendChild(scrollport);

let scrollTop = 0;
const pendingScrollEvents = [];
function colHeight() {
  let h = 0;
  for (const c of column.children) h += rowHeight(c);
  return h;
}
function floor() { return Math.max(0, colHeight() - VIEW_H); }
function fireScroll() { pendingScrollEvents.push(null); } // 浏览器异步投递

Object.defineProperty(scrollport, 'scrollTop', {
  get() { return scrollTop; },
  set(v) {
    const nv = Math.max(0, Math.min(Number(v) || 0, floor()));
    if (nv !== scrollTop) { scrollTop = nv; fireScroll(); }
  },
});
Object.defineProperty(scrollport, 'scrollHeight', { get: () => colHeight() });
Object.defineProperty(scrollport, 'clientHeight', { get: () => VIEW_H });

// 坐标：屏坐标 = 内容坐标 − scrollTop（scrollport 位于视口顶部）
function contentTop(el) {
  if (el.parentElement !== column) return null;
  let t = 0;
  for (const c of column.children) {
    if (c === el) return t;
    t += rowHeight(c);
  }
  return null;
}
// 原型级补丁：覆盖插件动态插入的折叠头/运行行（jsdom 默认返回全零 rect，
// 会让 restoreAnchor 的「锚点被折叠→挂头」分支误判）
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  // display:none（data-dsao-tf-hidden）：真实浏览器返回全零 rect
  if (this.hasAttribute && this.hasAttribute('data-dsao-tf-hidden')) {
    return { top: 0, bottom: 0, height: 0, left: 0, right: 0 };
  }
  if (this === scrollport) return { top: 0, bottom: VIEW_H, height: VIEW_H, left: 0, right: 100 };
  if (this === column) {
    const t = -scrollTop;
    return { top: t, bottom: t + colHeight(), height: colHeight(), left: 0, right: 100 };
  }
  const t = contentTop(this);
  if (t === null) return { top: 0, bottom: 0, height: 0, left: 0, right: 0 };
  const h = rowHeight(this);
  return { top: t - scrollTop, bottom: t - scrollTop + h, height: h, left: 0, right: 100 };
};

// ── 2. DSH ChatView 滚动逻辑复刻（原文语义）────────────────────────────────
// 多会话：positions 为模块级 Map（跨会话切换存活）；activeSid = 当前挂载的
// ChatView 实例所属会话（切换会话 = 旧实例卸载 + 新实例挂载 = dshReset）。
const FOLLOW_THRESHOLD = 24;
const positions = new Map(); // chatScrollPositions（模块级 Map，跨会话切换存活）
let activeSid = SID;
let atBottomRef = true, observedTopRef = 0, anchorRef = null, openedRef = false;
let firstSeqRef = null, lastKeyRef = null, followSigRef = null;
let lastObservedH = null;

function dshSave(sid, p) { if (p === null) positions.delete(sid); else positions.set(sid, p); }
function dshRead(sid) { return positions.get(sid) ?? null; }

function dshReset() {
  atBottomRef = true; observedTopRef = 0; anchorRef = null; openedRef = false;
  firstSeqRef = null; lastKeyRef = null; followSigRef = null;
  lastObservedH = null; // ResizeObserver 每 ChatView 挂载重建
}
function toBottom(sid) {
  anchorRef = null;
  scrollport.scrollTop = scrollport.scrollHeight;
  observedTopRef = scrollTop;
  atBottomRef = true;
  dshSave(sid, null);
}
function flowTop(row) { return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top; }
function anchorRowOf(key) {
  for (const row of column.querySelectorAll('[data-chat-anchor-key]')) {
    if (row.getAttribute('data-chat-anchor-key') === key) return row;
  }
  return null;
}
function scrollPositionOf() {
  const rows = [...column.querySelectorAll('[data-chat-anchor-key]')];
  const visible = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < VIEW_H; });
  const row = visible[0] ?? rows[0] ?? null;
  if (!row) return null;
  return { anchorKey: row.getAttribute('data-chat-anchor-key'), anchorTop: flowTop(row), scrollTop };
}

// ChatView useLayoutEffect 决策（open 分支 / prepend 分支 / follow 分支）
function dshRender(sid, { openState, firstSeq, lastKey, lastNodeKind, followSig }) {
  if (openState === 'open' && !openedRef) {
    openedRef = true;
    const saved = dshRead(sid);
    if (saved === null) {
      toBottom(sid);
    } else {
      scrollport.scrollTop = saved.scrollTop;
      const row = anchorRowOf(saved.anchorKey);
      if (row !== null) scrollport.scrollTop += flowTop(row) - saved.anchorTop;
      observedTopRef = scrollTop;
      const isAtBottom = scrollport.scrollHeight - scrollTop - scrollport.clientHeight <= FOLLOW_THRESHOLD + 1;
      atBottomRef = isAtBottom;
      const normalized = isAtBottom ? null : scrollPositionOf();
      if (isAtBottom) dshSave(sid, null);
      else if (normalized !== null) dshSave(sid, normalized);
    }
    firstSeqRef = firstSeq; lastKeyRef = lastKey; followSigRef = followSig;
    return;
  }
  if (anchorRef !== null && firstSeq !== null && firstSeqRef !== null && firstSeq < firstSeqRef) {
    const anchor = anchorRef;
    anchorRef = null;
    const row = anchorRowOf(anchor.key);
    if (process.env.DBG) {
      console.log(`  [DBG prepend] anchor=${anchor.key} anchor.top=${anchor.top} rowTop=${row ? row.getBoundingClientRect().top.toFixed(0) : 'null'} S=${scrollTop}`);
    }
    if (row !== null) scrollport.scrollTop += flowTop(row) - anchor.top;
    observedTopRef = scrollTop;
    firstSeqRef = firstSeq; lastKeyRef = lastKey; followSigRef = followSig;
    return;
  }
  firstSeqRef = firstSeq;
  const appendedUser = lastKey !== lastKeyRef && lastNodeKind === 'user';
  const tipMoved = followSigRef !== followSig;
  lastKeyRef = lastKey; followSigRef = followSig;
  if (appendedUser || (tipMoved && atBottomRef)) toBottom(sid);
}

// ChatView onScroll（observed-top 账本归因）——作为 scroll 事件监听器
scrollport.addEventListener('scroll', () => {
  const sid = activeSid;
  const fl = floor();
  const movedByReader = Math.abs(scrollTop - Math.min(observedTopRef, fl)) > 0.5;
  const isAtBottom = movedByReader ? fl - scrollTop <= FOLLOW_THRESHOLD + 1 : atBottomRef;
  if (!movedByReader && isAtBottom) { toBottom(sid); return; }
  atBottomRef = isAtBottom;
  const position = isAtBottom ? null : scrollPositionOf();
  if (isAtBottom) dshSave(sid, null);
  else if (position !== null) dshSave(sid, position);
  observedTopRef = scrollTop;
});

// 浏览器渲染步：布局钳制（内容塌缩时自动钳 scrollTop 并投递事件）
// + ResizeObserver 复刻（列高净变化且 atBottomRef 时钉底——followRef.current）
function dshRenderStep() {
  const f = floor();
  if (scrollTop > f) { scrollTop = f; fireScroll(); }
  const h = colHeight();
  if (lastObservedH !== null && h !== lastObservedH) {
    if (atBottomRef) {
      scrollport.scrollTop = scrollport.scrollHeight;
      observedTopRef = scrollTop;
      dshSave(activeSid, null);
    }
  }
  lastObservedH = h;
}

// scroll 事件异步投递（drain 到空）
function settle() {
  return new Promise((resolve) => {
    let guard = 0;
    const step = () => {
      if (pendingScrollEvents.length === 0 && guard++ < 3) return resolve();
      guard = 0;
      pendingScrollEvents.splice(0, 1);
      scrollport.dispatchEvent(new dom.window.Event('scroll'));
      setTimeout(step, 0);
    };
    step();
  });
}

// loadOlderAnchored 点击（锚定当前首可见行）
function dshClickLoadOlder() {
  const rows = [...column.querySelectorAll('[data-chat-anchor-key]')];
  const visible = rows.filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > 0 && b.top < VIEW_H; });
  const row = visible[0];
  if (process.env.DBG) {
    console.log(`  [DBG click] S=${scrollTop} visible[:5]=${visible.slice(0, 5).map((r) => r.getAttribute('data-chat-anchor-key') + '@' + r.getBoundingClientRect().top.toFixed(0)).join(' ')}`);
  }
  if (row) anchorRef = { key: row.getAttribute('data-chat-anchor-key'), top: flowTop(row) };
}

// ── 3. 真实 turn-fold 模块 + React hook 驱动 ─────────────────────────────────
function loadModule(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const module = { exports: {} };
  const fn = new Function(
    'exports', 'module', 'document', 'window', 'MutationObserver', 'localStorage', 'navigator',
    src + '\n;return module.exports;'
  );
  return fn(module.exports, module, doc, dom.window, dom.window.MutationObserver, dom.window.localStorage, dom.window.navigator);
}
const tf = loadModule('src/modules/turn-fold.js');

let effectQueue = [];
let prevRefs = [], curRefs = [];
const hookReact = {
  useRef(init) {
    const r = curRefs.length < prevRefs.length ? prevRefs[curRefs.length] : { current: init };
    curRefs.push(r);
    return r;
  },
  createElement(type, props) { return { type, props }; },
  useEffect(fn, deps) { effectQueue.push({ fn, deps }); },
};
let cleanups = [];
let firstMount = true;
function mountOrUpdate(props) {
  effectQueue = [];
  prevRefs = curRefs;
  curRefs = [];
  tf.createTurnFold(hookReact, null, null).TurnFoldMount(props);
  const toRun = firstMount ? effectQueue : effectQueue.slice(-1);
  if (!firstMount && cleanups.length) {
    const lastCleanup = cleanups[cleanups.length - 1];
    if (lastCleanup) lastCleanup();
  }
  const newCleanups = toRun.map((e) => e.fn());
  cleanups = firstMount ? newCleanups : [...cleanups.slice(0, -1), ...newCleanups];
  firstMount = false;
}

// ── 会话数据 ────────────────────────────────────────────────────────────────
// 每 turn：user + N×tool-call + assistant(closing) + turn-tail；closed。
function buildTurns(specs, startSeq, turnBase) {
  const order = []; const nodes = new Map(); const turns = new Map(); const turnKeys = [];
  let seq = startSeq;
  specs.forEach((spec, idx) => {
    const keys = [];
    const K = (p) => p + '-' + (++seq);
    const uk = K('u'); order.push(uk); nodes.set(uk, { kind: 'user', data: {} }); keys.push(uk);
    for (let i = 0; i < spec.tools; i++) {
      const k = K('t'); order.push(k); nodes.set(k, { kind: 'tool-call', data: {} }); keys.push(k);
    }
    const closingSeq = ++seq * 1000;
    const ak = K('a'); order.push(ak);
    nodes.set(ak, { kind: 'assistant-step', data: { finalNode: { seq: closingSeq } } }); keys.push(ak);
    const tk = K('tt'); order.push(tk);
    nodes.set(tk, { kind: 'turn-tail', data: { closing: { finalNode: { seq: closingSeq } } } }); keys.push(tk);
    turns.set(turnBase + idx, {
      status: 'closed',
      start: { time: 1 },
      end: { time: 60000, data: { reason: { kind: 'completed' } } },
    });
    turnKeys.push(keys);
  });
  return { order, nodes, turns, turnKeys, lastSeq: seq };
}
function makeSession(specs, startSeq) {
  const b = buildTurns(specs, startSeq, 0);
  return {
    sessionId: SID,
    chat: {
      order: b.order, nodes: b.nodes,
      timeline: { turns: b.turns },
      locations: { getTurn: (n) => b.turnKeys[n] || null },
    },
  };
}
function renderItems(session) {
  column.querySelectorAll('[data-chat-flow-key]').forEach((el) => el.remove());
  session.chat.order.forEach((k) => {
    const n = session.chat.nodes.get(k);
    const el = doc.createElement('div');
    el.setAttribute('data-chat-flow-key', k);
    el.setAttribute('data-chat-anchor-key', k);
    el.setAttribute('data-chat-flow-kind', n.kind);
    el.textContent = n.kind + ':' + k;
    column.appendChild(el);
  });
}
// loadOlder 语义：仅新页行插入列首；既有行原位不动（保留折叠态与泄漏的外来头，
// 与真实 React keyed diff 一致）
function prependItems(session, olderCount) {
  session.chat.order.slice(0, olderCount).forEach((k) => {
    const n = session.chat.nodes.get(k);
    const el = doc.createElement('div');
    el.setAttribute('data-chat-flow-key', k);
    el.setAttribute('data-chat-anchor-key', k);
    el.setAttribute('data-chat-flow-kind', n.kind);
    el.textContent = n.kind + ':' + k;
    column.insertBefore(el, column.firstChild);
  });
}
function sigOf(session) {
  return `open:1:${session.chat.order.at(-1)}:${session.chat.order.length}:0:`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.log(`  ✗ ${label}  ${detail || ''}`); }
}
function state() {
  const saved = positions.get(activeSid);
  return {
    S: scrollTop, floor: floor(), H: colHeight(),
    atBottom: atBottomRef,
    dist: floor() - scrollTop,
    saved: saved ? `anchor=${saved.anchorKey}@${Math.round(saved.anchorTop)} S=${Math.round(saved.scrollTop)}` : null,
  };
}
function printState(label) {
  const s = state();
  console.log(`  [${label}] S=${s.S} floor=${s.floor} H=${s.H} distFromBottom=${s.dist} atBottomRef=${s.atBottom} saved=${s.saved}`);
  return s;
}

// ── 场景 ───────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n═══ 模式：${EXPECT}（bug=期望复现故障 / fixed=期望修复后行为）═══`);

  // Phase 0：应用启动（无活动会话）
  mountOrUpdate({ session: null, sessionId: null });
  await settle();

  // Phase 1：打开会话 A（已缓存 → 单次渲染即 open）
  const sessionA = makeSession(Array.from({ length: 12 }, () => ({ tools: 4 })), 0);
  console.log('\nPhase 1：打开会话 A（12 turn；未折叠 H=4224，viewport 800）');
  renderItems(sessionA);
  dshRender(SID, { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  const s0 = printState('DSH open→toBottom(未折叠)');
  check('open 后 DSH 钉底（未折叠）', s0.S === s0.floor, `S=${s0.S} floor=${s0.floor}`);

  // 插件被动 effect（同 commit 的 paint 之后）：会话 effect → converge t0
  mountOrUpdate({ session: sessionA, sessionId: SID });
  dshRenderStep();
  await settle();
  const s1 = printState('t0 converge（首次折叠）');
  check('t0 折叠后仍在底部', s1.S === s1.floor, `S=${s1.S} floor=${s1.floor}（差 ${s1.dist}）`);
  check('t0 后 DSH follow 未脱钩', s1.atBottom === true, `atBottomRef=${s1.atBottom}`);
  check('t0 后未落脏位置', s1.saved === null, `saved=${s1.saved}`);

  // Phase 2：sweep 轮（300/900/2000ms）——已收敛列上的 strip+refold
  await sleep(330); dshRenderStep(); await settle();
  const s2 = printState('t300 converge');
  await sleep(600); dshRenderStep(); await settle();
  const s3 = printState('t900 converge');
  await sleep(1150); dshRenderStep(); await settle();
  const s4 = printState('t2000 converge');

  if (EXPECT === 'bug') {
    console.log('\nPhase 2 断言（期望复现故障）：');
    check('t300 后视口被甩离底部（>24px）', s2.dist > FOLLOW_THRESHOLD, `dist=${s2.dist}`);
    check('t300 后 DSH follow 脱钩（误归因为读端滚动）', s2.atBottom === false, `atBottomRef=${s2.atBottom}`);
    check('t300 后脏位置已持久化到 chatScrollPositions', s2.saved !== null, `saved=${s2.saved}`);
    check('t2000 后漂移进一步扩大（每轮 strip+refold 再甩一次）', s4.dist > s2.dist + 500, `dist t300=${s2.dist} → t2000=${s4.dist}`);
  } else {
    console.log('\nPhase 2 断言（期望修复后行为）：');
    check('t300 后仍在底部', s2.S === s2.floor, `S=${s2.S} floor=${s2.floor}`);
    check('t900 后仍在底部', s3.S === s3.floor, `S=${s3.S} floor=${s3.floor}`);
    check('t2000 后仍在底部', s4.S === s4.floor, `S=${s4.S} floor=${s4.floor}`);
    check('全程 DSH follow 未脱钩', s4.atBottom === true, `atBottomRef=${s4.atBottom}`);
    check('全程未落脏位置', s4.saved === null, `saved=${s4.saved}`);
  }

  // Phase 3：重开会话 A（ChatView 重挂：ref 重置，chatScrollPositions 存活）
  console.log('\nPhase 3：重开会话 A（切走再切回）');
  dshReset();
  dshRender(SID, { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  const s5 = printState('重开');
  if (EXPECT === 'bug') {
    check('重开未落底（脏位置 restore 取代 toBottom）', s5.dist > FOLLOW_THRESHOLD, `dist=${s5.dist}`);
    check('重开后 follow 已脱钩', s5.atBottom === false, `atBottomRef=${s5.atBottom}`);
  } else {
    check('重开落底（saved 为 null → toBottom）', s5.S === s5.floor, `S=${s5.S} floor=${s5.floor} dist=${s5.dist}`);
    check('重开后 follow 保持', s5.atBottom === true, `atBottomRef=${s5.atBottom}`);
  }

  // Phase 4：「加载更早」中部阅读锚定（约束：不得破坏的已有优化）
  console.log('\nPhase 4：加载更早（中部阅读 + prepend + 折叠，锚定补偿必须保留）');
  dshReset();
  positions.delete(SID);
  lastObservedH = null;
  // 干净重开 → 钉底
  dshRender(SID, { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  // 读端手动上滚到中部（真实读端输入）
  scrollTop = Math.floor(floor() / 2);
  fireScroll();
  dshRenderStep();
  await settle();
  const sMid = state();
  check('读端上滚后 follow 脱钩（DSH 预期行为）', sMid.atBottom === false, `atBottomRef=${sMid.atBottom}`);

  // 点「加载更早」：DSH 锚定首可见行
  dshClickLoadOlder();
  const anchorKey = anchorRef.key;
  const anchorScreenTopBefore = anchorRowOf(anchorKey).getBoundingClientRect().top;
  // 更旧一页（4 turn，seq 更小）prepend；原 12 turn 的 key 保持不变
  const older = buildTurns(Array.from({ length: 4 }, () => ({ tools: 4 })), -32, 0);
  const orig = buildTurns(Array.from({ length: 12 }, () => ({ tools: 4 })), 0, 4);
  const combined = {
    sessionId: SID,
    chat: {
      order: [...older.order, ...orig.order],
      nodes: new Map([...older.nodes, ...orig.nodes]),
      timeline: { turns: new Map([...older.turns, ...orig.turns]) },
      locations: { getTurn: (n) => (n < 4 ? older.turnKeys[n] : orig.turnKeys[n - 4]) || null },
    },
  };
  prependItems(combined, 32); // 仅 32 行新页入列首
  dshRender(SID, {
    openState: 'open',
    firstSeq: -31,            // 新页首 seq < firstSeqRef → prepend 分支
    lastKey: combined.chat.order.at(-1),
    lastNodeKind: 'turn-tail',
    followSig: sigOf(combined),
  });
  dshRenderStep();
  await settle();
  const afterPrepend = printState('DSH prepend 锚定补偿后');
  if (process.env.DBG) {
    const near = [...column.querySelectorAll('[data-chat-flow-key]')].map((r) => ({ k: r.getAttribute('data-chat-anchor-key'), t: r.getBoundingClientRect().top })).filter((o) => o.t > -300 && o.t < 500).slice(0, 10);
    console.log(`  [DBG nearTop] ${near.map((o) => o.k + '@' + o.t.toFixed(0)).join(' ')}`);
  }
  check('DSH 补偿后锚点行仍在视口内（用户处中部）', afterPrepend.dist > FOLLOW_THRESHOLD, `dist=${afterPrepend.dist}`);
  // 插件：快照更新（同会话）→ 80ms 防抖 sync → 折叠新出现的更旧 turn
  mountOrUpdate({ session: combined, sessionId: SID });
  await sleep(150);
  dshRenderStep();
  await settle();
  const anchorScreenTopAfter = anchorRowOf(anchorKey).getBoundingClientRect().top;
  const pinDelta = Math.abs(anchorScreenTopAfter - anchorScreenTopBefore);
  const sP = printState('插件折叠更旧 turn 后');
  console.log(`  锚点行屏坐标：加载前 ${anchorScreenTopBefore} → 折叠后 ${anchorScreenTopAfter}（Δ=${pinDelta.toFixed(1)}px）`);
  check('锚点行钉住（±1px，「加载更早」补偿生效）', pinDelta <= 1, `Δ=${pinDelta.toFixed(1)}px`);
  check('用户仍处中部（未被甩到底部）', sP.dist > FOLLOW_THRESHOLD, `dist=${sP.dist}`);
  check('中部阅读态 follow 保持脱钩（DSH 状态一致）', sP.atBottom === false, `atBottomRef=${sP.atBottom}`);

  // ── Phase 5：切走 → 切回（中部读者）────────────────────────────────────────
  // 第二个 bug（底部意图修复之后仍在）：DSH 切回时 restore 切走前位置（中部），
  // 随后 4 轮 converge sweep 每轮 strip（重展开）→ 重折叠，而 sync 在重展开
  // 后的几何里重选锚点（视口顶行变成更高的行），重折叠钉住把更高位置写回——
  // 视图每轮上漂一个过程块高度；DSH 账本把漂后位置按「读端滚动」保存，逐次
  // 切换累积。需求：首次打开到底部；切回恢复切走前位置（参考行偏移不变）。
  console.log('\nPhase 5：切走 → 切回（中部读者，两周期完整 sweep）');
  const sessionB5 = makeSession(Array.from({ length: 6 }, () => ({ tools: 3 })), 1000);
  sessionB5.sessionId = 'B5';
  // 顶行（DSH pagingAnchor 判据：bottom > 视口顶 且 top < 视口底）
  const topRowOf = () => {
    const rows = [...column.querySelectorAll('[data-chat-flow-key]')];
    return rows.find((r) => {
      if (r.hasAttribute('data-dsao-tf-hidden')) return false;
      const b = r.getBoundingClientRect();
      return b.bottom > 0 && b.top < VIEW_H;
    }) ?? null;
  };
  // 避免行边界恰好落在视口顶（边界歧义会让 DSH/插件锚点差一行）
  const boundaryAt = (s) => {
    let t = 0;
    for (const c of column.children) { if (t === s) return true; t += rowHeight(c); }
    return t === s;
  };
  const posOf = (p) => p ? `${p.anchorKey}@${Math.round(p.anchorTop)}` : '∅';

  // 5a. A 首次打开（全新：无泄漏头、无 saved）→ 应到底部
  dshReset();
  positions.delete('A'); positions.delete('B5');
  column.querySelectorAll('[data-dsao-tf-header],[data-dsao-tf-running]').forEach((el) => el.remove());
  renderItems(sessionA);
  activeSid = 'A';
  dshRender('A', { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  mountOrUpdate({ session: sessionA, sessionId: 'A' });
  await sleep(2400); dshRenderStep(); await settle();
  const sA1 = printState('5a A 首次打开（sweep 完成）');
  check('5a 首次打开落底部', sA1.S === sA1.floor, `S=${sA1.S} floor=${sA1.floor}`);

  // 5b. 读端上滚到中部（真实读端输入）→ 记录切走前位置
  let S5b = Math.floor(floor() / 2);
  while (boundaryAt(S5b)) S5b++;
  scrollTop = S5b;
  fireScroll();
  dshRenderStep();
  await settle();
  const savedBefore = positions.get('A');
  const refRowEl = topRowOf();
  const refKey = refRowEl && refRowEl.getAttribute('data-chat-anchor-key');
  const refTop = refRowEl ? refRowEl.getBoundingClientRect().top : 0;
  check('5b 参考行（顶行）与 saved 位置存在', !!refRowEl && savedBefore !== undefined && savedBefore !== null, `ref=${refKey}@${refTop}`);
  console.log(`  参考行: ${refKey}@${refTop.toFixed(1)} S=${S5b}（切走前位置）`);

  // 5c. 切到 B（A 的泄漏头留在列里；A 的 saved 位置应保留）
  renderItems(sessionB5);
  dshReset();
  activeSid = 'B5';
  dshRender('B5', { openState: 'open', firstSeq: 1001, lastKey: sessionB5.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionB5) });
  dshRenderStep();
  await settle();
  mountOrUpdate({ session: sessionB5, sessionId: 'B5' });
  dshRenderStep();
  await settle();
  const sB5 = printState('5c 在 B（A 头泄漏）');
  check('5c B 落底', sB5.S === sB5.floor, `S=${sB5.S} floor=${sB5.floor}`);
  check('5c A 的 saved 位置未丢', positions.get('A') !== null, '');

  // 5d. 切回 A：DSH restore saved 位置 → 插件 converge（t0 + 300/900/2000）
  renderItems(sessionA);
  dshReset();
  activeSid = 'A';
  dshRender('A', { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  const refTopAfterRestore = anchorRowOf(refKey).getBoundingClientRect().top;
  mountOrUpdate({ session: sessionA, sessionId: 'A' });
  dshRenderStep();
  await settle();
  const refTopAfterT0 = anchorRowOf(refKey).getBoundingClientRect().top;
  printState('5d A 切回（t0 converge 后）');
  check('5d DSH restore：参考行在切走前偏移', Math.abs(refTopAfterRestore - refTop) <= 1, `切走前=${refTop} restore后=${refTopAfterRestore}`);
  check('5d t0 converge：参考行不漂移', Math.abs(refTopAfterT0 - refTop) <= 1, `切走前=${refTop} t0后=${refTopAfterT0}`);

  // 5e. 等 300/900/2000 sweep（漂移主战场：净零 strip→refold 轮）
  await sleep(330); dshRenderStep(); await settle();
  const refTopR1 = anchorRowOf(refKey).getBoundingClientRect().top;
  await sleep(600); dshRenderStep(); await settle();
  const refTopR2 = anchorRowOf(refKey).getBoundingClientRect().top;
  await sleep(1150); dshRenderStep(); await settle();
  const refTopR3 = anchorRowOf(refKey).getBoundingClientRect().top;
  const sA4 = printState('5e A 切回（sweep 全部完成）');
  const savedAfter = positions.get('A');
  if (EXPECT === 'bug') {
    check('5e [bug] sweep 轮把视图甩离切走前位置（参考行偏移 >30px）', Math.abs(refTopR3 - refTop) > 30, `切走前=${refTop} → r1=${refTopR1.toFixed(0)} r2=${refTopR2.toFixed(0)} r3=${refTopR3.toFixed(0)}`);
    check('5e [bug] saved 位置被漂移改写（账本累积）', posOf(savedAfter) !== posOf(savedBefore), `before=${posOf(savedBefore)} after=${posOf(savedAfter)}`);
  } else {
    check('5e 参考行全程 sweep 不变（Δ≤1px）', Math.abs(refTopR1 - refTop) <= 1 && Math.abs(refTopR2 - refTop) <= 1 && Math.abs(refTopR3 - refTop) <= 1, `切走前=${refTop} → r1=${refTopR1.toFixed(0)} r2=${refTopR2.toFixed(0)} r3=${refTopR3.toFixed(0)}`);
    check('5e saved 位置锚点不变（无漂移、无累积）', savedAfter && savedBefore && savedAfter.anchorKey === savedBefore.anchorKey && Math.abs(savedAfter.anchorTop - savedBefore.anchorTop) <= 1, `before=${posOf(savedBefore)} after=${posOf(savedAfter)}`);
    check('5e 视图在切走前位置（中部，非底部）', sA4.dist > FOLLOW_THRESHOLD && Math.abs(refTopR3 - refTop) <= 1, `dist=${sA4.dist} refTop=${refTopR3.toFixed(0)}`);
  }

  // 5f. 第二周期：切 B → 切回 A（验证无累积）
  renderItems(sessionB5);
  dshReset();
  activeSid = 'B5';
  dshRender('B5', { openState: 'open', firstSeq: 1001, lastKey: sessionB5.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionB5) });
  dshRenderStep();
  await settle();
  mountOrUpdate({ session: sessionB5, sessionId: 'B5' });
  await sleep(120);
  renderItems(sessionA);
  dshReset();
  activeSid = 'A';
  dshRender('A', { openState: 'open', firstSeq: 1, lastKey: sessionA.chat.order.at(-1), lastNodeKind: 'turn-tail', followSig: sigOf(sessionA) });
  dshRenderStep();
  await settle();
  mountOrUpdate({ session: sessionA, sessionId: 'A' });
  await sleep(2400); dshRenderStep(); await settle();
  const refTopCycle2 = anchorRowOf(refKey).getBoundingClientRect().top;
  const sA5 = printState('5f A 二次切回（sweep 完成）');
  if (EXPECT === 'bug') {
    check('5f [bug] 第二周期继续漂移（累积）', Math.abs(refTopCycle2 - refTopR3) > 30, `r3=${refTopR3.toFixed(0)} → cycle2=${refTopCycle2.toFixed(0)}`);
  } else {
    check('5f 第二周期：参考行仍在切走前偏移（无累积）', Math.abs(refTopCycle2 - refTop) <= 1, `切走前=${refTop} → cycle2=${refTopCycle2.toFixed(0)}`);
    check('5f 第二周期：仍在切走前位置（中部）', sA5.dist > FOLLOW_THRESHOLD, `dist=${sA5.dist}`);
  }

  console.log(failures === 0 ? `\n全部断言通过（模式 ${EXPECT}）` : `\n${failures} 项发散（模式 ${EXPECT}）`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
