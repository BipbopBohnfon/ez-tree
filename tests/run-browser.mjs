// Browser test driver: node tests/run-browser.mjs <url> [timeoutSec]
// Needs a dev server (npx vite --port 5199) and chromium. Prints the page's
// #result text once it leaves RUNNING; exits 0 only on a PASS prefix.
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
const [url, timeout = 240] = process.argv.slice(2);
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('chromium', ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
  `--remote-debugging-port=${port}`, '--window-size=1600,1400', `--user-data-dir=${tmpdir()}/ez-tree-cdp-${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('console:', m.params.args.map((a) => a.value ?? a.description).join(' ')); });
const send = (method, params = {}) => new Promise((r) => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
await send('Runtime.enable');
await send('Page.navigate', { url });
const start = Date.now();
let text = 'RUNNING';
while (Date.now() - start < timeout * 1000) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', { expression: "document.querySelector('#result')?.textContent ?? 'RUNNING'" });
  text = r?.result?.value ?? 'RUNNING';
  if (!text.startsWith('RUNNING')) break;
}
console.log(text);
chrome.kill();
process.exit(text.startsWith('PASS') ? 0 : 1);
