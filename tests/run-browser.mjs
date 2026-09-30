// Browser test driver: node tests/run-browser.mjs <url> [timeoutSec]
// Needs a dev server (npx vite --port 5199) and chromium. Prints the page's
// #result text once it leaves RUNNING; exits 0 only on a PASS prefix.
// runPage() is the same driver as a function (scripts/export-all.mjs).
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens `url` in headless Chromium and waits for #result to leave RUNNING.
 * @param {string} url
 * @param {{timeout?: number, onLog?: (text: string) => void}} [opts] timeout in
 *   seconds; onLog receives the page's console.log lines
 * @returns {Promise<{ok: boolean, text: string}>} ok when #result starts with PASS
 */
export async function runPage(url, { timeout = 240, onLog } = {}) {
  const port = 9300 + Math.floor(Math.random() * 500);
  const profile = `${tmpdir()}/ez-tree-cdp-${port}`;
  const chrome = spawn('chromium', ['--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox',
    `--remote-debugging-port=${port}`, '--window-size=1600,1400', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let target;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
    }
    if (!target) throw new Error('chromium did not start');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
      if (m.method === 'Runtime.consoleAPICalled') {
        const line = m.params.args.map((a) => a.value ?? a.description).join(' ');
        if (m.params.type === 'error') console.error('console:', line);
        else if (m.params.type === 'log' && onLog) onLog(line);
      }
    });
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
    ws.close();
    return { ok: text.startsWith('PASS'), text };
  } finally {
    chrome.kill();
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, timeout = 240] = process.argv.slice(2);
  const { ok, text } = await runPage(url, { timeout: Number(timeout) });
  console.log(text);
  process.exit(ok ? 0 : 1);
}
