// cdp-session-verify.mjs — open a real session headlessly and verify plugin DOM effects
// Usage: node .verify/cdp-session-verify.mjs <baseUrl-with-token> <sessionTitlePrefix> [waitMsg]
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2];
const TITLE = process.argv[3];
const WAIT_MSG = Number(process.argv[4] || 14000);
const CDP_PORT = 9223;
const OUT_DIR = dirname(fileURLToPath(import.meta.url));

const ver = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP websocket failed')); });

let seq = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
  if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else if (msg.method) events.push(msg);
};
function send(method, params = {}, sessionId) {
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, (msg) => msg.error ? rej(new Error(method + ': ' + JSON.stringify(msg.error))) : res(msg.result));
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: BASE }, sessionId);
await new Promise(r => setTimeout(r, 12000));

// Click the session row whose text starts with TITLE (deepest match = the row itself).
const clickExpr = `(() => {
  const title = ${JSON.stringify(TITLE)};
  const els = [...document.querySelectorAll('div,button,a,[role="button"],li')];
  let best = null, bestDepth = Infinity;
  for (const el of els) {
    const text = (el.textContent || '').trim();
    if (!text.startsWith(title)) continue;
    const depth = el.querySelectorAll('*').length;
    if (depth < bestDepth) { bestDepth = depth; best = el; }
  }
  if (!best) return 'not-found';
  best.click();
  return 'clicked(depth=' + bestDepth + ')';
})()`;
const clickRes = await send('Runtime.evaluate', { expression: clickExpr, returnByValue: true }, sessionId);
console.log('CLICK:', clickRes.result.value);
await new Promise(r => setTimeout(r, WAIT_MSG));

const expr = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const headers = [...document.querySelectorAll('[data-dsao-tf-header]')].map(h => (h.textContent || '').trim());
  const tg = [...document.querySelectorAll('[data-dsao-tg-header]')].map(h => (h.textContent || '').trim().slice(0, 60));
  const flowKinds = {};
  document.querySelectorAll('[data-chat-flow-kind]').forEach(el => {
    const k = el.getAttribute('data-chat-flow-kind');
    flowKinds[k] = (flowKinds[k] || 0) + 1;
  });
  return JSON.stringify({
    flowColumns: q('[data-chat-flow]'),
    flowItems: q('[data-chat-flow-key]'),
    flowKinds,
    tfHeaders: q('[data-dsao-tf-header]'),
    tfHeaderTexts: headers.slice(0, 8),
    tfHidden: q('[data-dsao-tf-hidden]'),
    tfRunning: q('[data-dsao-tf-running]'),
    tgHeaders: q('[data-dsao-tg-header]'),
    tgHeaderTexts: tg.slice(0, 4),
    toolNameRows: q('[data-tool]'),
    officialDiffStat: q('[class*="diffStat"]'),
    pluginDiffBadges: q('[data-dsao-diff-badge]'),
    thinkRows: q('[data-variant="think"]'),
    officialTurnProcess: q('[data-turn-process]'),
    officialProcessHidden: q('[data-turn-process-hidden]'),
    enhanceBtn: q('[data-dsao-enhance-btn]'),
    resumeAnchor: q('[data-dsao-resume-anchor]'),
    resumeArmed: q('[data-dsao-resume]'),
    mermaidDone: q('[data-dsao-mermaid]'),
    bodyHead: document.body.innerText.slice(0, 200)
  });
})()`;
const evalRes = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
console.log('DOM:', evalRes.result.value);

mkdirSync(OUT_DIR, { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(join(OUT_DIR, 'shot-session.png'), Buffer.from(shot.data, 'base64'));
console.log('SHOT: shot-session.png');

const errors = events
  .filter(e => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error'))
    || e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.method === 'Runtime.exceptionThrown'
    ? 'EXC: ' + (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '')
    : e.method === 'Log.entryAdded' ? 'LOG: ' + e.params.entry.text : 'CON: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
console.log('ERRORS(' + errors.length + '):');
for (const e of errors) console.log('  ' + e.slice(0, 600));
ws.close();
process.exit(0);
