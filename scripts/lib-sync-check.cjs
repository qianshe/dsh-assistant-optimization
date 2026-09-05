// lib-sync-check — lib/client.js 与 src/modules 的双体一致性检查（构建化前安全网）
//
// lib/client.js 目前是手工镜像的 bundle：每个 dsao/* 模块块由对应
// src/modules/*.js 镜像而来。历史上三次事故（confirmTimer ReferenceError、
// turnMeta 漏传、manageLatestGroup 丢头）都是「改了 src 漏了 lib」或反向。
// 本检查比对两侧的函数名/导出名，抓「单侧存在」的漂移。
//
// 已知结构性分歧走 ALLOWLIST（lib 内联了 src 的工厂封装、或 lib 先行实现
// 待回灌）——这些进入构建化改造的回灌清单，新增漂移仍会报警。
//
// 运行：node scripts/lib-sync-check.cjs
// 退出码 0 = 无漂移；1 = 发现漂移（打印清单）。

'use strict';
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src', 'modules');
const LIB = path.join(__dirname, '..', 'lib', 'client.js');

const src = fs.readFileSync(LIB, 'utf8'); // 命名易混：这是 lib 的内容

// 已知结构性分歧（构建化回灌清单；新漂移不在名单内会报警）
const ALLOWLIST = new Set([
  // lib 打包时内联了 src 的工厂封装，组件/导出名不同、逻辑一致
  'exports.DEFAULT_MARKERS',      // lib 有同名 var，bundle 内无需 export
  'createPromptEnhance',          // lib 直接内联 PromptEnhanceMount
  'exports.createPromptEnhance',
  'searchSummary',                // lib 已实现（lib/client.js 内 searchSummary）
  'exports.searchSummary',
  'createTagsSetting',
  'createWindsurfKeySetting',
  'exports.createTagsSetting',
  'exports.createWindsurfKeySetting',
  'createWrapper',
  'exports.createWrapper',
  // tool-group classifyMutations 的两个时代实现（lib: chrome 检测一代；
  // src: isRelevantKind/hasRelevantKind 二代）——构建化时统一
  'isRelevantKind',
  'hasRelevantKind',
]);

function functionNames(code) {
  const names = new Set();
  const re = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return names;
}

const MODULES = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));
let drift = 0;
const fail = (msg) => { drift++; console.log('✗ ' + msg); };

for (const mod of MODULES) {
  const modCode = fs.readFileSync(path.join(SRC_DIR, mod + '.js'), 'utf8');
  const srcFns = functionNames(modCode);

  // 1) src 的函数必须在 lib 全文出现（同名存在性，不管块位置）
  for (const name of srcFns) {
    if (ALLOWLIST.has(name)) continue;
    if (!new RegExp(`function\\s+${name}\\s*\\(`).test(src)) {
      fail(`dsao/${mod}: src 有 function ${name}，lib 缺失`);
    }
  }

  // 2) src 的导出：lib 要么有同名导出、要么有同名函数/变量（内联形态）
  const exportRe = /exports\.([A-Za-z_$][\w$]*)\s*=/g;
  let em;
  while ((em = exportRe.exec(modCode)) !== null) {
    const name = em[1];
    if (ALLOWLIST.has('exports.' + name) || ALLOWLIST.has(name)) continue;
    const exported = new RegExp(`exports\\.${name}\\s*=`).test(src);
    const present = new RegExp(`(?:exports\\.${name}\\s*=|function\\s+${name}\\s*\\(|var\\s+${name}\\s*=)`).test(src);
    if (!exported && !present) fail(`dsao/${mod}: src 导出 ${name}，lib 无对应实现`);
  }

  // 3) lib 单侧新增的函数（回灌候选清单，信息性输出）
  const start = src.indexOf(`id: "dsao/${mod}"`);
  if (start !== -1) {
    const nextLoad = src.indexOf('__ModuleLoader__.load', start + 10);
    const libBlock = src.slice(start, nextLoad === -1 ? src.length : nextLoad);
    for (const name of functionNames(libBlock)) {
      if (!srcFns.has(name) && !ALLOWLIST.has(name)) {
        console.log(`· 回灌候选: dsao/${mod} lib-only function ${name}`);
      }
    }
  }
}

// 主入口接线检查
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'client.js'), 'utf8');
const entryRe = /id:\s*"([\w-]+)"/g;
let im;
const entryIds = new Set();
while ((im = entryRe.exec(clientSrc)) !== null) entryIds.add(im[1]);
for (const id of entryIds) {
  if (id === 'turn-fold' || id === 'thinking-tags' || id === 'windsurf-key') {
    if (!src.includes(`id: "${id}"`)) fail(`主入口: src 注册的 entry "${id}" 在 lib 中缺失`);
  }
}
const sm = /const inject = \[([^\]]*)\]/.exec(clientSrc);
if (sm) {
  const services = sm[1].replace(/'/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  // 锚定行首（lib 4282 行注释里也有一处字面量）
  const mainInject = /^\s*exports\.inject = \[([^\]]*)\]/m.exec(src);
  const libServices = mainInject ? mainInject[1].replace(/"/g, '').split(',').map((x) => x.trim()).filter(Boolean) : [];
  for (const svc of services) {
    if (!libServices.includes(svc)) fail(`主入口: src 声明服务 "${svc}"，lib exports.inject 缺失`);
  }
}

if (drift === 0) console.log(`lib-sync: ${MODULES.length} 个模块无单侧漂移（已知结构分歧 ${ALLOWLIST.size} 项在回灌清单）`);
else console.log(`\n${drift} 处漂移`);
process.exit(drift === 0 ? 0 : 1);
