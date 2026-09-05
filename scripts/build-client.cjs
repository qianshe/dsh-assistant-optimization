// build-client.cjs — lib/client.js 构建化改造
//
// 背景：lib/client.js 长期手工镜像 src/modules，双向漂移造成过多次真机事故
// （confirmTimer ReferenceError、turnMeta 漏传、manageLatestGroup 丢头）。
// 本脚本把 lib 变成「从 src 生成的产物」：
//
//   extract  lib → src：每个 ModuleLoader 块拆成 head（LOAD→defineProperty，
//            逐字节）+ body（中间部分，逐字节写回 src/modules/<name>.js）+
//            tail（return/收尾，逐字节）；块序与文件头存入 manifest。
//            —— 机械回灌：src 从此与线上行为 1:1。
//   build    src → lib：按 manifest 把 src 文件重新包进各自的 head/tail，
//            生成 lib/client.js。此后 lib 是产物，永远不要再手改。
//   verify   build 输出与现有 lib 逐字节比对，证明往返无损。
//
// 保真约定：head/body/tail 全部原样捕获（各块缩进/空行习惯不一：多数
// 2-tab、model-compact 1-tab、markers 的 return 前无空行——全部按字节
// 保留）。src 文件 = body 原文 + 单个换行；body 尾部的空行不入文件，
// 由 manifest 的 blankBeforeReturn 记录、build 时还原。
//
// 运行：node scripts/build-client.cjs extract | build | verify

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIB = path.join(ROOT, 'lib', 'client.js');
const MANIFEST = path.join(__dirname, 'client-bundle.manifest.json');
const LOAD_LINE = 'window.__ModuleLoader__.load({';
const DEFINE_MARKER = 'Object.defineProperty(exports, Symbol.toStringTag';
const RETURN_TRIM = 'return module.exports;';
const MAIN_ID = 'dsh-assistant-optimization';

function parseLib(text) {
  const lines = text.replace(/\r/g, '').split('\n'); // CRLF 归一为 LF（git autocrlf 工作区）
  const blocks = [];
  const fileHeader = [];
  const isBlockHeader = (idx) =>
    lines[idx] !== undefined && lines[idx].indexOf('// ── ') === 0 && lines[idx + 1] === LOAD_LINE;
  let i = 0;
  let pendingBlanks = 0;
  while (i < lines.length) {
    if (isBlockHeader(i)) {
      const id = /id:\s*"([^"]+)"/.exec(lines[i + 2])[1];
      const blanksBefore = pendingBlanks;
      pendingBlanks = 0;
      let p = i + 2;
      while (lines[p] === undefined || lines[p].indexOf(DEFINE_MARKER) === -1) p++;
      // head = 块头注释 → defineProperty 行（逐字节）
      const head = lines.slice(i, p + 1);
      // body = defineProperty 之后 → return 之前（逐字节）；尾部空行剥离并记录
      let b = p + 1;
      let r = b;
      while (lines[r] === undefined || lines[r].trim() !== RETURN_TRIM) r++;
      let end = r;
      const blankLines = [];
      while (end > b && lines[end - 1].trim() === '') { end--; blankLines.unshift(lines[end]); }
      const body = lines.slice(b, end);
      // tail = return 行 → '});'（逐字节，含各自缩进）
      let t = r;
      while (lines[t] === undefined || lines[t].trim() !== '});') t++;
      const tail = lines.slice(r, t + 1);
      blocks.push({ id, headerLine: lines[i], head, body, blankLines, tail, blanksBefore });
      i = t + 1; // 越过 '});'
      if (lines[i] === '' && isBlockHeader(i + 1)) { i += 1; pendingBlanks = 1; } // 块间距空行
      continue;
    }
    if (lines[i] === '') { pendingBlanks++; i++; continue; }
    pendingBlanks = 0;
    fileHeader.push(lines[i]);
    i++;
  }
  return { fileHeader, blocks };
}

function blockText(block, body) {
  return [
    ...block.head,
    ...body,
    ...(block.blankLines || []),
    ...block.tail,
  ].join('\n');
}

function srcPathFor(id) {
  return id === MAIN_ID
    ? path.join(ROOT, 'src', 'client.js')
    : path.join(ROOT, 'src', 'modules', id.replace(/^dsao\//, '') + '.js');
}

function modeExtract() {
  const text = fs.readFileSync(LIB, 'utf8');
  const { fileHeader, blocks } = parseLib(text);
  const manifest = {
    order: blocks.map((b) => b.id),
    fileHeader,
    headers: {},
    blocks: {},
  };
  for (const b of blocks) {
    manifest.headers[b.id] = b.headerLine;
    manifest.blocks[b.id] = {
      head: b.head,
      tail: b.tail,
      blankLines: b.blankLines,
      blanksBefore: b.blanksBefore,
    };
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  for (const b of blocks) {
    fs.writeFileSync(srcPathFor(b.id), b.body.join('\n') + '\n');
    console.log(`extract: ${path.relative(ROOT, srcPathFor(b.id))} (${b.body.length} 行)`);
  }
  console.log(`extract: manifest 写入（${blocks.length} 个块）`);
}

function buildText() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const parts = [manifest.fileHeader.join('\n')];
  manifest.order.forEach((id, idx) => {
    const raw = fs.readFileSync(srcPathFor(id), 'utf8');
    const body = raw.split('\n');
    while (body.length && body[body.length - 1] === '') body.pop();
    const meta = manifest.blocks[id];
    const block = { head: meta.head, tail: meta.tail, blankLines: meta.blankLines };
    const blanks = Math.max(0, meta.blanksBefore);
    parts.push('\n'.repeat(blanks) + blockText(block, body));
  });
  return parts.join('\n') + '\n';
}

function modeBuild() {
  const text = buildText();
	fs.writeFileSync(LIB, text.split("\r").join(""), { encoding: "utf8" });
  console.log(`build: lib/client.js 生成（${text.split('\n').length} 行）`);
}

function modeVerify() {
  const original = fs.readFileSync(LIB, 'utf8');
  const rebuilt = buildText();
  if (original === rebuilt) {
    console.log(`verify: 往返无损（${original.split('\n').length} 行逐字节一致）`);
    return;
  }
  const a = original.split('\n');
  const b = rebuilt.split('\n');
  let bad = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      bad++;
      if (bad <= 5) console.log(`verify: 行 ${i + 1}\n  原: ${JSON.stringify((a[i] || '').slice(0, 90))}\n  新: ${JSON.stringify((b[i] || '').slice(0, 90))}`);
    }
  }
  console.log(`verify: ${bad} 行不一致`);
  process.exit(1);
}

const mode = process.argv[2];
if (mode === 'extract') modeExtract();
else if (mode === 'build') modeBuild();
else if (mode === 'verify') modeVerify();
else { console.log('usage: node scripts/build-client.cjs extract|build|verify'); process.exit(2); }
