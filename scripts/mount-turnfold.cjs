// 挂载级复现装置：真实 lib 模块 + jsdom + React hook 桩，驱动 TurnFoldMount
// 的完整 effect 生命周期（mount → 切会话 → 切回），观察折叠头/隐藏/工具组头。
// 背景：headless 断言（repro-switch-back）全绿但真实浏览器折叠消失——两者差异
// 只能在「挂载生命周期 + 两模块观察器交互」里，本装置补上这一层。
//
// 运行：node scripts/mount-turnfold.cjs
// 退出码 0 = 生命周期收敛；1 = 复现发散。

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'node_modules', 'jsdom'));

const dom = new JSDOM('<!doctype html><html><body><div id="chat"><div data-chat-flow></div></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const doc = dom.window.document;

// ── 加载真实 lib bundle（与安装副本同内容）─────────────────────────────────
const registry = new Map();
global.window = dom.window;
global.document = doc;
try { global.navigator = dom.window.navigator; } catch (e) {}
global.localStorage = dom.window.localStorage;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = clearTimeout;
window.__ModuleLoader__ = {
  load(spec) {
    const req = (id) => {
      if (id === 'react') return fakeReact.React;
      if (!registry.has(id)) throw new Error('module not found: ' + id);
      return registry.get(id);
    };
    registry.set(spec.id, spec.factory(req));
  },
};

// ── React hook 桩：只实现组件用到的 useRef/useEffect/useEffectDep 语义 ──────
// TurnFoldMount 不渲染可见 UI（隐藏 span），全部行为在 effects 里操作 DOM，
// 因此桩只需：useRef 返回稳定 ref；useEffect 按声明顺序排队、由驱动器按
// deps 变化执行/清理；createElement 返回哑元素。
const fakeReact = { React: null };
fakeReact.React = {
  useRef(init) { return { current: init }; },
  createElement(type, props) { return { type, props }; },
  useState(init) { return [typeof init === 'function' ? init() : init, function () {}]; },
};
// effect 队列（每次 render 重置；驱动器决定哪些要（重）跑）
let effectQueue = [];
// useRef 语义：ref 对象必须跨渲染稳定（按调用序对位复用），否则存活闭包
// 永远读到旧 ref —— harness 初版在这里复现不出会话切换。
let prevRefs = [];
let curRefs = [];
const hookReact = {
  useRef(init) {
    const r = curRefs.length < prevRefs.length ? prevRefs[curRefs.length] : { current: init };
    curRefs.push(r);
    return r;
  },
  createElement(type, props) { return { type, props }; },
  useEffect(fn, deps) { effectQueue.push({ fn, deps }); },
};
// TurnFoldMount 内部用的是传入的 React 参数（DI），挂载时传 hookReact。
// 但 lib 模块工厂 require("react") 拿到的是 fakeReact.React——需要同一对象。
fakeReact.React = hookReact;

const bundle = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
new Function(
  'window', 'document', 'localStorage', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  bundle
)(window, document, localStorage, MutationObserver, requestAnimationFrame, cancelAnimationFrame);

const tf = registry.get('dsao/turn-fold');
const tg = registry.get('dsao/tool-group');
if (!tf || !tg) { console.log('✗ 模块加载失败'); process.exit(1); }

// ── 会话快照伪造（与 repro 同 shape）───────────────────────────────────────
function makeSession(turnSpecs, sid) {
  const order = [];
  const nodes = new Map();
  const turns = new Map();
  const turnKeys = [];
  let seq = 0;
  const K = (p) => p + '-' + (++seq);
  turnSpecs.forEach((spec, turnNum) => {
    const keys = [];
    const uk = K(spec.keyPrefix + 'u');
    order.push(uk); nodes.set(uk, { kind: 'user', data: {} }); keys.push(uk);
    for (let i = 0; i < spec.tools; i++) {
      const k = K(spec.keyPrefix + 't');
      order.push(k); nodes.set(k, { kind: 'tool-call', data: {} }); keys.push(k);
    }
    const closingSeq = ++seq * 1000;
    const ak = K(spec.keyPrefix + 'a');
    order.push(ak); nodes.set(ak, { kind: 'assistant-step', data: { finalNode: { seq: closingSeq } } }); keys.push(ak);
    const tk = K(spec.keyPrefix + 'tt');
    order.push(tk); nodes.set(tk, { kind: 'turn-tail', data: { closing: { finalNode: { seq: closingSeq } } } }); keys.push(tk);
    turns.set(turnNum, {
      status: 'closed',
      start: { time: spec.start },
      end: { time: spec.end, data: { reason: { kind: spec.reason || 'completed' } } },
    });
    turnKeys.push(keys);
  });
  return {
    sessionId: sid,
    chat: { order, nodes, timeline: { turns }, locations: { getTurn: (n) => turnKeys[n] || null } },
  };
}

function renderItems(column, session) {
  column.querySelectorAll('[data-chat-flow-key]').forEach((el) => el.remove());
  session.chat.order.forEach((k) => {
    const n = session.chat.nodes.get(k);
    const el = doc.createElement('div');
    el.setAttribute('data-chat-flow-key', k);
    el.setAttribute('data-chat-flow-kind', n.kind);
    if (n.kind === 'tool-call') {
      const row = doc.createElement('div');
      row.setAttribute('data-tool', 'read');
      el.appendChild(row);
    } else {
      el.textContent = n.kind + ':' + k;
    }
    column.appendChild(el);
  });
}

// ── 组件挂载驱动器：模拟 React 的 mount/update effect 语义 ─────────────────
const column = doc.querySelector('[data-chat-flow]');
let cleanups = [];
let firstMount = true;

function mountOrUpdate(props) {
  effectQueue = [];
  prevRefs = curRefs;
  curRefs = [];
  tf.createTurnFold(hookReact, tg.resetToolGroups, tg.scanToolGroups).TurnFoldMount(props);
  // 首次挂载：两个 effect 都跑（依赖 [] 的跑一次；依赖 session 的跑一次）
  // 更新：只跑最后一个（session 依赖的），先执行其上一次 cleanup
  const toRun = firstMount ? effectQueue : effectQueue.slice(-1);
  if (!firstMount && cleanups.length) {
    const lastCleanup = cleanups[cleanups.length - 1];
    if (lastCleanup) lastCleanup();
  }
  const newCleanups = toRun.map((e) => e.fn());
  cleanups = firstMount ? newCleanups : [...cleanups.slice(0, -1), ...newCleanups];
  firstMount = false;
}

function snapshotState(label) {
  const tfHeaders = [...column.querySelectorAll('[data-dsao-tf-header]')].map((h) => h.getAttribute('data-dsao-tf-header'));
  const toolCalls = [...column.querySelectorAll('[data-chat-flow-kind="tool-call"]')];
  const hidden = toolCalls.filter((el) => el.hasAttribute('data-dsao-tf-hidden')).length;
  const tgHeaders = column.querySelectorAll('[data-dsao-tg-header]').length;
  console.log(`  [${label}] tf头=[${tfHeaders}] tool-call=${toolCalls.length}(隐藏${hidden}) tg头=${tgHeaders}`);
  return { tfHeaders, toolCalls: toolCalls.length, hidden, tgHeaders };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let failures = 0;
  tg.startToolGroupObserver();

  const sessionA = makeSession([
    { tools: 3, start: 1, end: 600000, keyPrefix: 'A1' },
    { tools: 2, start: 610000, end: 700000, keyPrefix: 'A2' },
  ], 'sess-A');
  const sessionB = makeSession([{ tools: 2, start: 1, end: 5000, keyPrefix: 'B1' }], 'sess-B');

// v1.8.0 供给端契约：挂载读 props.useChat(selector)（renderer 把 inject face 的
// hooks.chat 源包装成选择器 Hook）+ props.sessionId。harness 用普通函数模拟
// 选择器 Hook（无响应性，由驱动器手动换快照重渲）。
const useChatOf = (session) => (sel) => sel(session.chat);

  // 1. 挂载 + 会话 A
  renderItems(column, sessionA);
  mountOrUpdate({ sessionId: 'sess-A', useChat: useChatOf(sessionA) });
  await sleep(2300); // 等 0/300/900/2000 sweep 全部落地
  const s1 = snapshotState('mount A');
  if (s1.tfHeaders.length !== 2 || s1.hidden !== s1.toolCalls) {
    failures++; console.log('✗ 挂载后未折叠（tf头应为2，tool-call应全隐藏）');
  } else console.log('✓ 挂载后折叠正常');

  // 2. 切到会话 B（React 换 keyed 子元素，注入头泄漏留存）
  renderItems(column, sessionB);
  mountOrUpdate({ sessionId: 'sess-B', useChat: useChatOf(sessionB) });
  await sleep(2300);
  const s2 = snapshotState('switch B');
  if (s2.tfHeaders.length !== 1) { failures++; console.log('✗ 切 B 后 tf 头数量异常'); } else console.log('✓ 切 B 后收敛');

  // 3. 切回 A
  renderItems(column, sessionA);
  mountOrUpdate({ sessionId: 'sess-A', useChat: useChatOf(sessionA) });
  await sleep(2300);
  const s3 = snapshotState('back A');
  if (s3.tfHeaders.length !== 2 || s3.hidden !== s3.toolCalls) {
    failures++; console.log('✗ 切回 A 后未折叠');
  } else console.log('✓ 切回 A 后折叠正常');

  // 4. 滚动锚定补偿：折叠使锚点上方塌缩 120px → scrollTop 反向补偿 120
  console.log('· 4: 滚动锚定补偿');
  await sleep(2300); // 等场景 3 的 sweep 全部落地，避免计数干扰
  const wrap = doc.createElement('div');
  wrap.style.overflowY = 'auto';
  column.parentNode.insertBefore(wrap, column);
  wrap.appendChild(column);
  wrap.scrollTop = 500;
  wrap.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800, width: 100 });
  const anchorEl = column.querySelector('[data-chat-flow-key]');
  let gCalls = 0;
  anchorEl.getBoundingClientRect = () => {
    gCalls++;
    // 第一次 = 补偿前测量（top 300）；之后 = 折叠后测量（上方塌缩 120 → top 180）
    return gCalls === 1
      ? { top: 300, bottom: 320, height: 20, width: 100 }
      : { top: 180, bottom: 200, height: 20, width: 100 };
  };
  mountOrUpdate({ sessionId: 'sess-A', useChat: useChatOf(sessionA) }); // 同会话 → 轻量 sync
  await sleep(300); // 防抖 80ms + 余量
  const okScroll = wrap.scrollTop === 500 - 120;
  console.log(`  scrollTop=${wrap.scrollTop}（期望 380），锚点测量 ${gCalls} 次`);
  if (!okScroll) {
    failures++; console.log('✗ [滚动补偿] 未钉住锚点');
  } else {
    console.log('✓ [滚动补偿] 锚点钉住（-120 精确写回）');
  }

  console.log(failures === 0 ? '\n挂载生命周期全部收敛' : `\n${failures} 项发散`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
