// cdp-mermaid-probe.mjs — check code-block DOM structure for the mermaid observer
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2];
const TITLE = process.argv[3];
const CDP_PORT = 9223;
const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, (msg) => msg.error ? rej(new Error(method)) : res(msg.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: BASE }, sessionId);
await new Promise(r => setTimeout(r, 12000));
const clickExpr = `(() => {
  const title = ${JSON.stringify(TITLE)};
  const els = [...document.querySelectorAll('div,button,a,[role="button"],li')];
  let best = null, bestDepth = Infinity;
  for (const el of els) {
    if (!(el.textContent || '').trim().startsWith(title)) continue;
    const d = el.querySelectorAll('*').length;
    if (d < bestDepth) { bestDepth = d; best = el; }
  }
  if (!best) return 'not-found';
  best.click(); return 'ok';
})()`;
await send('Runtime.evaluate', { expression: clickExpr, returnByValue: true }, sessionId);
await new Promise(r => setTimeout(r, 14000));
const expr = `(() => {
  const md = document.querySelectorAll('.md-code-block');
  const first = md[0];
  let structure = null;
  if (first) {
    const banner = first.firstElementChild;
    const inner = banner && banner.firstElementChild;
    const info = inner && inner.firstElementChild;
    structure = {
      blockClass: first.className,
      bannerClass: banner && banner.className,
      innerClass: inner && inner.className,
      infoText: info && (info.textContent || '').trim(),
      hasPre: !!first.querySelector('pre')
    };
  }
  return JSON.stringify({
    mdCodeBlock: md.length,
    structure,
    preCount: document.querySelectorAll('[data-chat-flow] pre').length,
    codeBlockClassSamples: [...new Set([...document.querySelectorAll('[data-chat-flow] [class*="code"], [data-chat-flow] pre')].slice(0, 6).map(e => e.className))].slice(0, 6)
  });
})()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
console.log('MERMAID-PROBE:', res.result.value);
ws.close();
process.exit(0);
