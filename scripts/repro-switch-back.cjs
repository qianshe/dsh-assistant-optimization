// 离线复现装置：turn-fold × tool-group 会话切换时序
// 复现路径（用户报告）：会话 A 实时跑完（正常）→ 切到会话 B → 切回 A（工具组头跑到 turn 外）。
// 方法：jsdom 驱动两个模块的真实导出函数，按多种时序执行流水线，断言最终收敛状态。
//
// 运行：node scripts/repro-switch-back.cjs
// 退出码 0 = 全部场景收敛；1 = 找到发散场景（打印现场）。

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'node_modules', 'jsdom'));

const dom = new JSDOM('<!doctype html><html><body><div id="chat"><div data-chat-flow></div></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
const doc = dom.window.document;

// ── 模块加载：src 为 CJS 风格，包一层 Function 隔离全局 ──────────────────────
function loadModule(rel) {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const module = { exports: {} };
  const fn = new Function(
    'exports', 'module', 'document', 'window', 'MutationObserver', 'localStorage', 'navigator',
    src + '\n;return module.exports;'
  );
  return fn(
    module.exports, module, doc, dom.window,
    dom.window.MutationObserver, dom.window.localStorage, dom.window.navigator
  );
}

const tf = loadModule('src/modules/turn-fold.js');
const tg = loadModule('src/modules/tool-group.js');

// ── 伪造会话快照（shape 依 planTurnFold 的数据契约）──────────────────────────
// turnSpecs: [{ tools, status, start, end, keyPrefix }]
function makeSession(turnSpecs) {
  const order = [];
  const nodes = new Map();
  const turns = new Map();
  const turnKeys = [];
  let seq = 0;
  const K = (p) => p + '-' + (++seq);
  turnSpecs.forEach((spec, turnNum) => {
    const keys = [];
    const uk = K(spec.keyPrefix + 'u');
    order.push(uk);
    nodes.set(uk, {
      kind: 'user',
      data: spec.marker ? { source: { dsaoResume: true }, content: [] } : {},
    });
    keys.push(uk);
    for (let i = 0; i < spec.tools; i++) {
      const k = K(spec.keyPrefix + 't');
      order.push(k); nodes.set(k, { kind: 'tool-call', data: {} }); keys.push(k);
    }
    if (spec.steering) {
      const sk = K(spec.keyPrefix + 's');
      order.push(sk); nodes.set(sk, { kind: 'steering', data: {} }); keys.push(sk);
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
    chat: {
      order, nodes,
      timeline: { turns },
      locations: { getTurn: (n) => turnKeys[n] || null },
    },
  };
}

// ── DOM 渲染：模拟 React 换会话（keyed 子元素重挂，注入头泄漏留存）────────────
function renderItems(column, session) {
  column.querySelectorAll('[data-chat-flow-key]').forEach((el) => el.remove());
  // 注意：注入头（tg/tf）不删 —— React 不管理它们，真实切换时会泄漏在列里
  session.chat.order.forEach((k) => {
    const n = session.chat.nodes.get(k);
    const el = doc.createElement('div');
    el.setAttribute('data-chat-flow-key', k);
    el.setAttribute('data-chat-flow-kind', n.kind);
    if (n.kind === 'tool-call') {
      // tool-group 依赖 [data-tool] 提取工具名（read/bash/edit 可分组）
      const row = doc.createElement('div');
      row.setAttribute('data-tool', 'read');
      el.appendChild(row);
    } else {
      el.textContent = n.kind + ':' + k;
    }
    column.appendChild(el);
  });
}

// ── 断言 ────────────────────────────────────────────────────────────────────
let failures = 0;
function assertConverged(label, column, plan) {
  const problems = [];
  const tgHeaders = [...column.querySelectorAll('[data-dsao-tg-header]')];
  const toolCalls = [...column.querySelectorAll('[data-chat-flow-kind="tool-call"]')];
  const tfHeaders = [...column.querySelectorAll('[data-dsao-tf-header]')];

  // 1) 全部 turn 已闭合折叠：所有 tool-call 必须 tf-hidden
  const unhiddenTc = toolCalls.filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
  if (unhiddenTc.length) problems.push(`未隐藏 tool-call ×${unhiddenTc.length}`);

  // 2) 所有 tg-header 必须 tf-hidden（本场景所有组都在闭合 turn 内）
  const visibleTg = tgHeaders.filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
  if (visibleTg.length) {
    problems.push(`可见 tg-header ×${visibleTg.length}: ` +
      visibleTg.map((el) => `"${el.textContent.slice(0, 18)}" next=${describeNext(el)}`).join('; '));
  }

  // 3) 每 turn 恰好一个 tf-header
  const byTurn = {};
  tfHeaders.forEach((h) => {
    const t = h.getAttribute('data-dsao-tf-header');
    byTurn[t] = (byTurn[t] || 0) + 1;
  });
  plan.folds.forEach((f) => {
    if (byTurn[f.turn] !== 1) problems.push(`turn ${f.turn} tf-header 数量=${byTurn[f.turn] || 0}`);
  });

  if (problems.length) {
    failures++;
    console.log(`✗ [${label}] 发散：\n  - ` + problems.join('\n  - '));
    console.log(`    现场快照：`);
    [...column.children].forEach((el) => {
      const kind = el.getAttribute('data-chat-flow-kind');
      const tg = el.hasAttribute('data-dsao-tg-header');
      const tf = el.hasAttribute('data-dsao-tf-header');
      const hid = el.hasAttribute('data-dsao-tf-hidden');
      const tgc = el.hasAttribute('data-dsao-tg-collapsed');
      console.log(`      ${hid ? 'H' : 'V'} ${tf ? 'TF头' : tg ? 'TG头' : kind || '?'} ${el.getAttribute('data-chat-flow-key') || el.textContent.slice(0, 22)}`);
    });
  } else {
    console.log(`✓ [${label}] 收敛（tg-header ${tgHeaders.length} 个全部隐藏，tf-header 每 turn 1 个）`);
  }
}

function describeNext(el) {
  let n = el.nextElementSibling;
  while (n) {
    if (n.getAttribute('data-chat-flow-key') !== null) {
      return `${n.getAttribute('data-chat-flow-kind')}${n.hasAttribute('data-dsao-tf-hidden') ? '(hidden)' : '(VISIBLE)'}`;
    }
    n = n.nextElementSibling;
  }
  return 'null';
}

// ── 场景执行 ────────────────────────────────────────────────────────────────
const column = doc.querySelector('[data-chat-flow]');
const sessionA = makeSession([
  { tools: 3, start: 1, end: 10, keyPrefix: 'A1' },
  { tools: 3, start: 11, end: 20, keyPrefix: 'A2' },
  { tools: 3, start: 21, end: 30, keyPrefix: 'A3' },
]);
const sessionB = makeSession([{ tools: 2, start: 1, end: 5, keyPrefix: 'B1' }]);
const planA = () => tf.planTurnFold(sessionA);
const planB = () => tf.planTurnFold(sessionB);

// 场景 1：实时跑完（基线，应当收敛）
console.log('── 场景 1：会话 A 实时跑完 ──');
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
assertConverged('live-A', column, planA());

// 场景 2：切到 B（泄漏变体：A 的注入头留在列里）
console.log('── 场景 2：切到会话 B（注入头泄漏）──');
renderItems(column, sessionB);
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planB(), {});

// 场景 3：切回 A，多种时序
console.log('── 场景 3：切回会话 A ──');

// O1: tg 扫描 → tf 同步（一轮）
console.log('· O1: tg → tf');
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
assertConverged('switch-back O1', column, planA());

// O2: tf → tg → tf（tf 先跑一轮，tg 扫描后再补一轮）
console.log('· O2: tf → tg → tf');
renderItems(column, sessionA);
tf.applyPlanToColumn(column, planA(), {});
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
assertConverged('switch-back O2', column, planA());

// O3: tg → tf → tg（confirmTimer 第二轮）→ tf
console.log('· O3: tg → tf → tg → tf');
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
assertConverged('switch-back O3', column, planA());

// O4: 只跑 tg 不补 tf（模拟 tf 重同步丢失 —— 预期发散，作为对照）
console.log('· O4: tg → tf → tg（无补充 tf，对照预期发散）');
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, planA(), {});
tg.scanToolGroups(doc.body);
assertConverged('switch-back O4 (对照)', column, planA());

// 场景 4：key 再生成变体 —— 切回 A 时 DOM 键与会话键不一致（模拟应用层重建会话状态）
console.log('── 场景 4：切回时 DOM 键 ≠ 会话键（应用层键再生成）──');
const sessionA2 = makeSession(sessionA.chat.timeline.turns.size && [
  { tools: 3, start: 1, end: 10, keyPrefix: 'R1' },
  { tools: 3, start: 11, end: 20, keyPrefix: 'R2' },
  { tools: 3, start: 21, end: 30, keyPrefix: 'R3' },
]);
renderItems(column, sessionA); // DOM 用旧键
tg.scanToolGroups(doc.body);
tf.applyPlanToColumn(column, tf.planTurnFold(sessionA2), {}); // 计划用新键
const unknownCount = [...column.querySelectorAll('[data-chat-flow-key]')]
  .filter((el) => !tf.planTurnFold(sessionA2).keySet.has(el.getAttribute('data-chat-flow-key'))).length;
console.log(`  DOM 键不在计划内的元素：${unknownCount}（>0 时 applyPlanToColumn 会走 stripColumn 分支）`);
const tgHeadersAfter = [...column.querySelectorAll('[data-dsao-tg-header]')];
const visibleAfter = tgHeadersAfter.filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
console.log(`  strip 后 tg-header=${tgHeadersAfter.length}，其中可见=${visibleAfter.length}`);

// 场景 5：快照落后窗口 —— 切回 A 时快照只含部分 turn（异步分页），
// 先用部分快照同步（模拟落后窗口），快照补全后再同步（模拟收敛 sweep）
console.log('── 场景 5：快照落后 → 补全后再同步（收敛 sweep 验证）──');
// 部分快照：只有后 2 个 turn（timeline/locations/order 同步裁剪）
function partialSession(session, fromTurn) {
  const total = session.chat.timeline.turns.size;
  const keep = [];
  for (let n = fromTurn; n < total; n++) keep.push(n);
  const order2 = [];
  const turnKeys2 = [];
  keep.forEach((n) => {
    const keys = session.chat.locations.getTurn(n);
    keys.forEach((k) => order2.push(k));
    turnKeys2.push(keys);
  });
  return {
    chat: {
      order: order2,
      nodes: session.chat.nodes,
      timeline: { turns: session.chat.timeline.turns },
      locations: { getTurn: (n) => turnKeys2[n - fromTurn] || null },
    },
  };
}
const sessionPartial = partialSession(sessionA, 1); // 只有 turn 1、2
console.log('· 5a: 部分快照同步（落后窗口，预期裸露）');
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);
const planPartial = tf.planTurnFold(sessionPartial);
tf.applyPlanToColumn(column, planPartial, {});
const tgAll5a = [...column.querySelectorAll('[data-dsao-tg-header]')];
const visible5a = tgAll5a.filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
console.log(`  tg-header=${tgAll5a.length}，可见=${visible5a.length}（turn0 的组头裸露=${visible5a.length > 0}）`);

console.log('· 5b: 快照补全后再同步（sweep 第 2/3 轮，预期收敛）');
tf.applyPlanToColumn(column, planA(), {});
assertConverged('switch-back sweep-5b', column, planA());

// 场景 6：部分 key 失配 + 泄漏组头堆叠 + 成员因 tg-collapse 不可见 —— 用户截图冻结态
// 机制：切回后某 turn 的 DOM key 与 plan 部分失配 → 成员不被 tf 隐藏（但 tg-collapse 挡住
// 可见性）；上一轮泄漏的组头堆在该 turn 区间内。此时组头向前看到可见 closing、向后被
// 可见成员打断——旧双判定全失败 → 组头永久裸露（tail/attr 扫描不清理）。
// 正确行为：组头归属由 plan 的 key→turn 位置域决定，与成员可见性无关 → 折叠 turn 内必隐藏。
console.log('── 场景 6：部分 key 失配 + 泄漏组头堆叠（截图冻结态复现）──');
// sessionA3：turn 0 的 key 再生成（模拟窗口重投影），turn 1、2 不变
const sessionA3 = makeSession([
  { tools: 3, start: 1, end: 10, keyPrefix: 'X1' },
  { tools: 3, start: 11, end: 20, keyPrefix: 'A2' },
  { tools: 3, start: 21, end: 30, keyPrefix: 'A3' },
]);
const planA3 = () => tf.planTurnFold(sessionA3);
// DOM 用旧键（sessionA），plan 用新键（sessionA3）→ turn 0 部分失配
renderItems(column, sessionA);
tg.scanToolGroups(doc.body);        // 正常建头
tf.applyPlanToColumn(column, planA(), {});  // 正常收敛（上一轮状态）
// 模拟泄漏堆叠：把 turn 0 的组头挪到 closing 之前（React 换窗时注入头不归 React 管）
const isA1 = (el) => /^A1[uta]-/.test(el.getAttribute('data-chat-flow-key'));
const closing0 = [...column.querySelectorAll('[data-chat-flow-key]')]
  .filter((el) => el.getAttribute('data-chat-flow-kind') === 'assistant-step' && isA1(el))[0];
const leaked = [...column.querySelectorAll('[data-dsao-tg-header]')].filter((h) => {
  // turn 0 的组头：位于 A1- 成员之前
  let n = h.nextElementSibling;
  while (n && n.getAttribute('data-chat-flow-key') === null) n = n.nextElementSibling;
  return n && isA1(n);
});
leaked.forEach((h) => column.insertBefore(h, closing0));
// 切回后的同步：只有 tf sync（tail/attr 扫描不清理组头）
tf.applyPlanToColumn(column, planA3(), {});
const visible6 = [...column.querySelectorAll('[data-dsao-tg-header]')]
  .filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
console.log(`  裸露组头=${visible6.length}（泄漏堆叠 ${leaked.length} 个；>0 = 截图冻结态复现）`);
if (visible6.length > 0) {
  failures++;
  console.log('✗ [场景 6] 组头裸露：' + visible6.map((h) => `"${h.textContent.slice(0, 18)}"`).join('; '));
} else {
  console.log('✓ [场景 6] 收敛（泄漏堆叠组头按位置域全部隐藏）');
}
// 补充断言：turn 0 的 fold 仍在 plan 中（stale tf-header 保留语义）
const tf0 = column.querySelectorAll('[data-dsao-tf-header="0"]');
if (tf0.length !== 1) { failures++; console.log(`✗ [场景 6] turn 0 tf-header 数量=${tf0.length}（应为 1）`); }

// 负空间：用户展开 turn 1 → 其组头必须恢复可见（位置域规则不得误伤展开态）
console.log('· 6b: 展开态负空间（turn 1 展开 → 仅其组头可见）');
tf.applyPlanToColumn(column, planA(), { 1: true });
const vis6b = [...column.querySelectorAll('[data-dsao-tg-header]')]
  .filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
const ownerOf = (h) => {
  let n = h.nextElementSibling;
  while (n && n.getAttribute('data-chat-flow-key') === null) n = n.nextElementSibling;
  return n ? n.getAttribute('data-chat-flow-key').slice(0, 2) : '?';
};
const ok6b = vis6b.length === 1 && ownerOf(vis6b[0]) === 'A2';
console.log(`  可见组头=${vis6b.length}（归属=${vis6b.map(ownerOf)}；应为 1 个、A2）`);
if (!ok6b) { failures++; console.log('✗ [场景 6b] 展开态组头可见性异常'); }
// 还原：全折叠收敛
tf.applyPlanToColumn(column, planA(), {});
assertConverged('switch-back sweep-6c', column, planA());

// 场景 7：aborted + resumed 对 + 部分失配窗口 + 泄漏组头（截图冻结态·位置域回退）
// 机制（调研确认的拓扑）：turn0 aborted（键匹配、已折叠），turn1 resumed-completed
// 键整体再生成（窗口重投影）。泄漏组头落在 turn1 区间内，其右侧全部是失配成员——
// 向前走找不到已知 key → ownerTurn=undefined → 组头永久裸露。
// 正确行为：向前走不到时向后回退，按左侧最近已知 flowItem 的 turn 归属；
// 左侧是 turn0（已折叠）→ 隐藏。两折叠区之间无歧义。
console.log('── 场景 7：aborted+resumed 对 + 部分失配 + 泄漏组头（截图态）──');
const sessionS = makeSession([
  { tools: 2, start: 1, end: 10, keyPrefix: 'S1', reason: 'aborted' },
  { tools: 3, start: 11, end: 836000, keyPrefix: 'S2' },
]);
// 渲染键：turn0 同 sessionS，turn1 再生成（R2 前缀）→ 部分失配
const sessionSRender = makeSession([
  { tools: 2, start: 1, end: 10, keyPrefix: 'S1', reason: 'aborted' },
  { tools: 3, start: 11, end: 836000, keyPrefix: 'R2' },
]);
const planS = () => tf.planTurnFold(sessionS);
renderItems(column, sessionSRender); // DOM：S1 已知 + R2 全未知
tg.scanToolGroups(doc.body);         // 两组各自建头（泄漏的组头就位）
tf.applyPlanToColumn(column, planS(), {});
{
  const tgAll7 = [...column.querySelectorAll('[data-dsao-tg-header]')];
  const visible7 = tgAll7.filter((el) => !el.hasAttribute('data-dsao-tf-hidden'));
  console.log(`  tg-header=${tgAll7.length}，裸露=${visible7.length}` +
    visible7.map((h) => ` "${h.textContent.slice(0, 18)}"`).join(''));
  const tf7 = column.querySelectorAll('[data-dsao-tf-header="0"]');
  if (visible7.length > 0) {
    failures++;
    console.log('✗ [场景 7] 失配区间组头裸露（向前走不到已知 key 时无向后回退）');
  } else {
    console.log('✓ [场景 7] 收敛（失配区间的泄漏组头按左侧归属全部隐藏）');
  }
  if (tf7.length !== 1) { failures++; console.log(`✗ [场景 7] turn0 tf-header 数量=${tf7.length}（应为 1）`); }
}

// 7b: 泄漏同号 tf 头 + 去重保错 —— 泄漏头（React 不管理，切会话原地留存）堆在列首，
// 与 anchor 处新建的头同 turn 号。旧规则按 DOM 顺序保第一个 = 泄漏头，把锚点邻接的
// 正确头当重复删掉 → 头悬在别的 turn 内容上方（「多个 turn / 工具组在外面」的直接来源）。
// 正确行为：保 anchor 邻接的那个（validHeaders），删其余。
console.log('· 7b: 泄漏同号 tf 头去重（应保锚点邻接头）');
{
  const anchor0 = [...column.querySelectorAll('[data-chat-flow-key]')]
    .find((el) => el.getAttribute('data-chat-flow-key').indexOf('S1') === 0 &&
      el.getAttribute('data-chat-flow-kind') === 'tool-call');
  const leakedH = doc.createElement('div');
  leakedH.className = 'dsao-tf-header';
  leakedH.setAttribute('data-dsao-tf-header', '0'); // 同 turn 号泄漏
  column.insertBefore(leakedH, column.firstElementChild);
  tf.applyPlanToColumn(column, planS(), {});
  const tfHeaders7b = [...column.querySelectorAll('[data-dsao-tf-header="0"]')];
  // 正确的头必须仍紧邻锚点（向前跨越注入节点可找到）
  let prev = anchor0.previousElementSibling;
  while (prev && prev.getAttribute('data-chat-flow-key') === null) {
    if (prev.getAttribute('data-dsao-tf-header') === '0') break;
    prev = prev.previousElementSibling;
  }
  const ok7b = tfHeaders7b.length === 1 && prev === tfHeaders7b[0];
  console.log(`  turn0 tf-header=${tfHeaders7b.length}，锚点邻接=${prev === tfHeaders7b[0] && tfHeaders7b.length === 1}`);
  if (!ok7b) {
    failures++;
    console.log('✗ [场景 7b] 去重保错（保了 DOM 第一个而非锚点邻接头）');
  } else {
    console.log('✓ [场景 7b] 收敛（泄漏同号头被删，锚点邻接头保留）');
  }
}

// 场景 8：会话切换全量重置 API（nuke → tg 重建 → tf 同步）
// 注入头是 React 不管理的外来节点，切换会话时原地留存并堆进新列。
// 修复面：resetToolGroups（tg 复位）+ stripColumn（tf 拆除）+ 全量重建一轮收敛。
console.log('── 场景 8：会话切换全量重置 API ──');
if (typeof tg.resetToolGroups !== 'function') {
  failures++;
  console.log('✗ [场景 8] tool-group 未导出 resetToolGroups');
} else {
  renderItems(column, sessionA);   // 切回会话 A（新键子元素）
  tg.resetToolGroups();            // 拆 tg
  doc.querySelectorAll('[data-chat-flow]').forEach((c) => tf.stripColumn(c)); // 拆 tf
  const residue = column.querySelectorAll('[data-dsao-tg-header],[data-dsao-tf-header],[data-dsao-tf-running],[data-dsao-tg-collapsed],[data-dsao-tf-hidden]');
  console.log(`  nuke 后注入残留=${residue.length}（应为 0）`);
  if (residue.length > 0) failures++;
  tg.scanToolGroups(doc.body);     // tg 重建
  tf.applyPlanToColumn(column, planA(), {}); // tf 同步
  assertConverged('switch-back nuke-rebuild', column, planA());
}

// 场景 9：中断续跑归并（aborted + resumed ⇒ 单一折叠头）
// 数据层：turn0 aborted（10分30秒）→ marker 用户消息 → turn1 resumed（22分25秒）。
// 归并后：单头「已完成 · 32分55秒」（活跃时长求和），marker 行保留可见，
// 全部过程（含两段的工具调用）隐藏。
console.log('── 场景 9：中断续跑归并 ──');
const sessionM = makeSession([
  { tools: 2, start: 0, end: 630000, keyPrefix: 'M1', reason: 'aborted' },
  { tools: 2, start: 700000, end: 2045000, keyPrefix: 'M2', marker: true },
]);
renderItems(column, sessionM);
tg.scanToolGroups(doc.body);
const planM = tf.planTurnFold(sessionM);
console.log(`  folds=${planM.folds.length}（应为 1），header="${planM.folds[0] ? planM.folds[0].headerText : '无'}"`);
if (planM.folds.length !== 1 || planM.folds[0].headerText !== '已完成 · 32分55秒') {
  failures++;
  console.log('✗ [场景 9] 归并失败（应为单 fold，头文案 32分55秒）');
}
tf.applyPlanToColumn(column, planM, {});
const tfHeaders9 = column.querySelectorAll('[data-dsao-tf-header]');
if (tfHeaders9.length !== 1) {
  failures++;
  console.log(`✗ [场景 9] tf头=${tfHeaders9.length}（应为 1）`);
} else {
  console.log('✓ [场景 9] 单一折叠头');
}
const markerKey = sessionM.chat.locations.getTurn(1)[0];
const markerEl = column.querySelector(`[data-chat-flow-key="${markerKey}"]`);
if (markerEl && !markerEl.hasAttribute('data-dsao-tf-hidden')) {
  failures++;
  console.log('✗ [场景 9] 折叠态 marker 行裸露（应收进组内）');
} else {
  console.log('✓ [场景 9] 折叠态 marker 行收进组内');
}
const tc9 = [...column.querySelectorAll('[data-chat-flow-kind="tool-call"]')];
if (tc9.some((el) => !el.hasAttribute('data-dsao-tf-hidden'))) {
  failures++;
  console.log('✗ [场景 9] 存在未隐藏的 tool-call');
} else {
  console.log('✓ [场景 9] 全部过程隐藏');
}
// 展开态负空间：展开组 → marker 恢复可见（叙事保留），收起后再次隐藏；
// 展开态收尾分割线：closing 前最后一个 flow item 带 process-end 下划线
tf.applyPlanToColumn(column, planM, { 0: true });
const markerVisibleExpanded = markerEl && !markerEl.hasAttribute('data-dsao-tf-hidden');
const closingKey9 = planM.folds[0].closingKey;
const closingEl9 = column.querySelector(`[data-chat-flow-key="${closingKey9}"]`);
let prevFlow9 = closingEl9 ? closingEl9.previousElementSibling : null;
while (prevFlow9 && prevFlow9.getAttribute('data-chat-flow-key') === null) prevFlow9 = prevFlow9.previousElementSibling;
const endMarkOk = prevFlow9 && prevFlow9.hasAttribute('data-dsao-tf-process-end');
tf.applyPlanToColumn(column, planM, {});
const markerHiddenCollapsed = markerEl && markerEl.hasAttribute('data-dsao-tf-hidden');
const endMarkCleared = prevFlow9 && !prevFlow9.hasAttribute('data-dsao-tf-process-end');
if (!markerVisibleExpanded || !markerHiddenCollapsed || !endMarkOk || !endMarkCleared) {
  failures++;
  console.log(`✗ [场景 9] 展开态负空间异常（marker 展开=${markerVisibleExpanded} 收起=${markerHiddenCollapsed}；分割线 展开=${endMarkOk} 清除=${endMarkCleared}）`);
} else {
  console.log('✓ [场景 9] 展开：marker 可见 + 收尾分割线；收起：均恢复');
}

// 场景 10：状态图标随归并刷新 —— 折叠头在中间段单独成组时以 error 建（红点），
// 链归并后状态取末段（已完成），updateHeader 必须同步刷新图标，否则出现
// 「红点 + 已完成」错位（真实截图 bug）。
console.log('── 场景 10：状态图标随归并刷新 ──');
{
  const sessionE = makeSession([
    { tools: 2, start: 0, end: 5000, keyPrefix: 'E1', reason: 'error' },
  ]);
  const sessionE2 = makeSession([
    { tools: 2, start: 0, end: 5000, keyPrefix: 'E1', reason: 'error' },
    { tools: 1, start: 6000, end: 11000, keyPrefix: 'E2', marker: true },
  ]);
  renderItems(column, sessionE);
  tg.scanToolGroups(doc.body);
  tf.applyPlanToColumn(column, tf.planTurnFold(sessionE), {});
  let hdr10 = column.querySelector('[data-dsao-tf-header]');
  const wasRed = !!(hdr10 && hdr10.querySelector('.dsao-tf-headerIcon') &&
    hdr10.querySelector('.dsao-tf-headerIcon').getAttribute('data-state') === 'error');
  // 归并后的会话：turn0 键相同（头留存），turn1 为 marker 续跑段
  renderItems(column, sessionE2);
  tf.applyPlanToColumn(column, tf.planTurnFold(sessionE2), {});
  hdr10 = column.querySelector('[data-dsao-tf-header]');
  const reasonNow = hdr10 ? hdr10.getAttribute('data-dsao-tf-reason') : null;
  const icon10 = hdr10 ? hdr10.querySelector('.dsao-tf-headerIcon') : null;
  const stateNow = icon10 ? icon10.getAttribute('data-state') : null;
  const text10 = hdr10 && hdr10.querySelector('.dsao-tf-headerText') ? hdr10.querySelector('.dsao-tf-headerText').textContent : '';
  console.log(`  先建错误头(红点)=${wasRed}，归并后 reason=${reasonNow} state=${stateNow} text="${text10}"`);
  if (!wasRed || reasonNow !== 'completed' || stateNow !== 'ok' || text10.indexOf('已完成') !== 0) {
    failures++;
    console.log('✗ [场景 10] 图标未随归并刷新（红点 + 已完成 错位）');
  } else {
    console.log('✓ [场景 10] 图标随归并刷新为已完成');
  }
}

// 场景 11：运行中插话（steering）随折叠收起，展开恢复（codex 调研后的设计）
console.log('── 场景 11：运行中插话随折叠收起 ──');
{
  const sessionST = makeSession([
    { tools: 2, start: 0, end: 60000, keyPrefix: 'ST', steering: true },
  ]);
  renderItems(column, sessionST);
  tg.scanToolGroups(doc.body);
  const planST = tf.planTurnFold(sessionST);
  // 键序：user, t, t, steering, closing, tail
  const stKey = sessionST.chat.locations.getTurn(0)[3];
  const inHidden = planST.folds.length === 1 && planST.folds[0].hiddenKeys.indexOf(stKey) >= 0;
  const headerST = planST.folds.length ? planST.folds[0].headerText : '';
  console.log(`  计划：插话入隐藏集=${inHidden}，头="${headerST}"`);
  tf.applyPlanToColumn(column, planST, {});
  const stEl = column.querySelector(`[data-chat-flow-key="${stKey}"]`);
  const collapsedHidden = stEl && stEl.hasAttribute('data-dsao-tf-hidden');
  tf.applyPlanToColumn(column, planST, { 0: true });
  const expandedVisible = stEl && !stEl.hasAttribute('data-dsao-tf-hidden');
  tf.applyPlanToColumn(column, planST, {});
  const recollapsed = stEl && stEl.hasAttribute('data-dsao-tf-hidden');
  if (!inHidden || headerST.indexOf('1 条插话') < 0 || !collapsedHidden || !expandedVisible || !recollapsed) {
    failures++;
    console.log(`✗ [场景 11] 插话折叠行为异常（隐藏集=${inHidden} 折叠=${collapsedHidden} 展开=${expandedVisible} 再收起=${recollapsed}）`);
  } else {
    console.log('✓ [场景 11] 插话折叠收起、展开恢复、头含计数');
  }
}

console.log(failures === 0 ? '\n全部收敛场景通过' : `\n${failures} 个场景发散`);
process.exit(failures === 0 ? 0 : 1);
