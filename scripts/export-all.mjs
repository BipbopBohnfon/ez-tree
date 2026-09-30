// npm run export:all [-- species ...]
// Headless batch export: starts the studio dev server, opens
// batch.html?species=<list|all> in headless Chromium, which exports every
// species through exportSpecies() + writeToGame() (the studio's own code
// path), and exits non-zero on any failure. The game folder follows
// DEINTERLEAVER_GAME_ROOT (see scripts/game-endpoint.mjs).
// Options: --lods=30,70,150,400,1500 overrides every species' LOD distances.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { runPage } from '../tests/run-browser.mjs';
import { treesRoot } from './game-endpoint.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const lods = args.find((a) => a.startsWith('--lods='))?.slice(7);
const species = args.filter((a) => !a.startsWith('--'));

const server = await createServer({ configFile: path.join(repo, 'vite.studio.config.js'), server: { port: 0, strictPort: false }, logLevel: 'warn' });
await server.listen();
const address = server.httpServer.address();
const query = new URLSearchParams({ species: species.length ? species.join(',') : 'all', ...(lods ? { lods } : {}) });
const url = `http://localhost:${address.port}/batch.html?${query}`;
console.log(`export:all -> ${treesRoot()}\n${url}`);
let ok = false;
try {
  const result = await runPage(url, { timeout: 3600, onLog: (line) => console.log(line) });
  ok = result.ok;
  console.log(result.text);
} finally {
  await server.close();
}
process.exit(ok ? 0 : 1);
