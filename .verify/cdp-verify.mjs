// cdp-verify.mjs — headless Chrome CDP verification of the dsh GUI + plugin v1.8.0
// Usage: node .verify/cdp-verify.mjs [waitMs]
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE = process.argv[2] || 'http://127.0.0.1:3080';
const CDP_PORT = 9223;
const WAIT = Number(process.argv[3] || 12000);
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)));

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
await send('Log.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
await send('Page.navigate', { url: BASE }, sessionId);
await new Promise(r => setTimeout(r, WAIT));

const expr = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  return JSON.stringify({
    title: document.title,
    flowColumns: q('[data-chat-flow]'),
    flowItems: q('[data-chat-flow-key]'),
    tfHeaders: q('[data-dsao-tf-header]'),
    tfHidden: q('[data-dsao-tf-hidden]'),
    tfRunning: q('[data-dsao-tf-running]'),
    tgHeaders: q('[data-dsao-tg-header]'),
    toolCallRows: q('[data-chat-flow-kind="tool-call"]'),
    toolNameRows: q('[data-tool]'),
    diffStatOfficial: q('[class*="diffStat"]'),
    pluginDiffBadges: q('[data-dsao-diff-badge]'),
    thinkRows: q('[data-variant="think"]'),
    resumeAnchor: q('[data-dsao-resume-anchor]'),
    resumeArmed: q('[data-dsao-resume]'),
    enhanceBtn: q('[data-dsao-enhance-btn]'),
    mermaidDone: q('[data-dsao-mermaid]'),
    resumeHint: q('[data-dsao-resume-hint]'),
    turnProcessCtrl: q('[data-turn-process]'),
    turnProcessHidden: q('[data-turn-process-hidden]'),
    bodyText: document.body.innerText.slice(0, 300)
  });
})()`;
const evalRes = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, sessionId);
console.log('DOM:', evalRes.result.value);

mkdirSync(OUT_DIR, { recursive: true });
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(join(OUT_DIR, 'shot-full.png'), Buffer.from(shot.data, 'base64'));
console.log('SHOT: shot-full.png', shot.data.length, 'bytes(b64)');

const errors = events
  .filter(e => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error'))
    || e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map(e => e.method === 'Runtime.exceptionThrown'
    ? 'EXC: ' + (e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || '')
    : e.method === 'Log.entryAdded' ? 'LOG: ' + e.params.entry.text : 'CON: ' + (e.params.args || []).map(a => a.value ?? a.description ?? '').join(' '));
console.log('ERRORS(' + errors.length + '):');
for (const e of errors) console.log('  ' + e);
ws.close();
process.exit(0);
