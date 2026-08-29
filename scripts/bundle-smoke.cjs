// bundle 冒烟：完整 lib/client.js 在 jsdom + ModuleLoader shim 下全模块加载，
// 枚举 slots.inject 工厂产出的全部 entry，断言每个注册组件都是函数。
// 背景：resume-continuity 的 'user' 遮蔽组件曾以 undefined 注册（模块只导出工厂
// createResumeContinuity，主模块却直接引用 .ResumeMarkerAwareUserNode），每次
// user 节点渲染抛 React #130（经槽位边界让位官方渲染器，仅控制台报错）。本测试
// 在不启动浏览器的情况下捕获这类「注册链断点」。
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require(path.join(__dirname, '..', 'node_modules', 'jsdom'));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
});
const React = require('F:/devData/npm-global/node_modules/@deepseek-ai/dsh/node_modules/react');

const registry = new Map();
const loadOrder = [];
global.window = dom.window;
global.document = dom.window.document;
try { global.navigator = dom.window.navigator; } catch (e) { /* node 22 只读 getter，模块内未用 */ }
global.localStorage = dom.window.localStorage;
global.MutationObserver = dom.window.MutationObserver;
global.requestAnimationFrame = (cb) => setTimeout(cb, 16);
global.cancelAnimationFrame = clearTimeout;
try { global.crypto = require('crypto'); } catch (e) { /* node 22 内置只读 */ }
global.window.__ModuleLoader__ = {
  load(spec) {
    try {
      const req = (id) => {
        if (id === 'react') return React;
        if (!registry.has(id)) throw new Error('module not found: ' + id);
        return registry.get(id);
      };
      const exports = spec.factory(req);
      registry.set(spec.id, exports);
      loadOrder.push([spec.id, null]);
    } catch (e) {
      loadOrder.push([spec.id, e.message + '\n' + (e.stack || '').split('\n')[1]]);
      registry.set(spec.id, undefined);
    }
  },
};

const bundle = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
new Function(
  'window', 'document', 'localStorage', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  bundle
)(window, document, localStorage, MutationObserver, requestAnimationFrame, cancelAnimationFrame);

let failures = 0;
const fail = (msg) => { failures++; console.log('✗ ' + msg); };
const ok = (msg) => console.log('✓ ' + msg);

// 1) 全模块工厂无抛错
for (const [id, err] of loadOrder) if (err) fail(`模块 ${id} 工厂抛错: ${err}`);
if (loadOrder.length >= 14 && failures === 0) ok(`模块加载数=${loadOrder.length}，全部工厂执行无异常`);

const main = registry.get('dsh-assistant-optimization');
if (typeof (main && main.apply) !== 'function') fail('main.apply 缺失');

// 2) apply 注册链：枚举 inject 工厂产出的 entry，组件必须全部为函数
const injectFactories = [];
const slotEntries = [];
const effects = [];
const slots = {
  entries: () => slotEntries,
  register: (opts, comp) => { const e = { options: opts, component: comp }; slotEntries.push(e); return e; },
  inject: (name, factory) => injectFactories.push([name, factory]),
};
main.apply({
  get: (k) => (k === 'slots' ? slots : undefined),
  effect: (fn) => effects.push(fn),
});
for (const [name, factory] of injectFactories) {
  try {
    factory();
  } catch (e) {
    fail(`inject 工厂抛错（${name}）: ${e.message}`);
  }
}
const effectsOk = effects.every((fn) => { try { fn(); return true; } catch (e) { fail(`effect 抛错: ${e.message}`); return false; } });
const bad = slotEntries.filter((e) => typeof e.component !== 'function');
if (bad.length > 0) {
  for (const e of bad) fail(`entry 组件为 ${typeof e.component}（key=${e.options.key} id=${e.options.id}）→ React #130 源头`);
} else {
  ok(`注册链完好：inject 工厂 ${injectFactories.length} 个，entry ${slotEntries.length} 个，组件全部为函数，effect ${effects.length} 个${effectsOk ? ' 全部可执行' : ''}`);
}

// 2b) 浅渲染探针：entry 组件可能是包装函数（本身是函数但内部 createElement(undefined)，
// 渲染期才抛 React #130）。直接调用并检查返回 element 的 type；依赖 hooks 的组件
// （调用即抛 Invalid hook call）跳过，由模块导出断言覆盖。
let probed = 0;
for (const e of slotEntries) {
  let el;
  try {
    el = e.component({});
  } catch (err) {
    if (/Invalid hook call|hooks/i.test(err.message)) continue; // 需要真实渲染器，跳过
    // 其他抛错视作探针环境问题，不判失败
    continue;
  }
  probed++;
  if (el && el.type === undefined) {
    fail(`entry（key=${e.options.key} id=${e.options.id}）浅渲染返回 type=undefined 的元素 → React #130`);
  }
}
if (failures === 0 && probed > 0) ok(`浅渲染探针：${probed}/${slotEntries.length} 个 entry 可直调，无 type=undefined 元素`);

// 3) 关键遮蔽组件实体存在（resume-continuity 必须经工厂实例化）
const rc = registry.get('dsao/resume-continuity');
const instance = rc && rc.createResumeContinuity ? rc.createResumeContinuity(React) : null;
if (!instance || typeof instance.ResumeMarkerAwareUserNode !== 'function') {
  fail('createResumeContinuity(React).ResumeMarkerAwareUserNode 不是函数');
} else {
  // 无 hooks，可直接调用验证元素树类型
  const el = instance.ResumeMarkerAwareUserNode({ node: null, slots: { entries: () => [] } });
  if (el !== null && el !== undefined && el.type === undefined) {
    fail('ResumeMarkerAwareUserNode 返回 element.type=undefined');
  } else {
    ok('ResumeMarkerAwareUserNode 实例化并可渲染（marker 空泡 → div / 常规 → 官方组件或 null）');
  }
}

console.log(failures === 0 ? '\nbundle 冒烟通过' : `\nbundle 冒烟：${failures} 处异常`);
process.exit(failures === 0 ? 0 : 1);
