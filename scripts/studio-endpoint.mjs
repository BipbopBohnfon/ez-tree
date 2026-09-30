// Tree Studio dev-server endpoints (vite.studio.config.js mounts them next to
// scripts/game-endpoint.mjs):
//   GET    /__studio/info              -> {gameRoot, treesRoot, overridesDir}
//   GET    /__studio/overrides         -> {<species id>: override JSON}
//   POST   /__studio/species/:id       <- override JSON; writes
//                                         src/lib/species/overrides/<id>.json
//   DELETE /__studio/species/:id       -> removes that override (reset)
//   GET    /__studio/stamps            -> {<species id>: fingerprint} for this game root
//   POST   /__studio/stamps            <- {id, fingerprint} records an export
// Species ids must be snake_case; nothing resolves outside the overrides
// folder. Stamps live in the gitignored .cache/studio/stamps.json, keyed by
// the trees folder, so "changed since export" follows DEINTERLEAVER_GAME_ROOT.
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treesRoot } from './game-endpoint.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OVERRIDES_DIR = path.join(repo, 'src/lib/species/overrides');
const STAMPS_FILE = path.join(repo, '.cache/studio/stamps.json');
const ID = /^[a-z][a-z0-9_]{0,63}$/;

/** Absolute override path for a species id, or throws. */
export function overridePath(id, dir = OVERRIDES_DIR) {
  if (!ID.test(String(id))) throw new Error(`refused species id '${id}'`);
  const file = path.resolve(dir, `${id}.json`);
  if (path.dirname(file) !== path.resolve(dir)) throw new Error(`refused species id '${id}'`);
  return file;
}

async function atomicWrite(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text);
  await rename(temp, file);
}

/** Every override in `dir`: {id: json}. Unreadable files are skipped with a warning. */
export async function readOverrides(dir = OVERRIDES_DIR) {
  const out = {};
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  for (const name of names.sort()) {
    const id = name.replace(/\.json$/, '');
    if (!name.endsWith('.json') || !ID.test(id)) continue;
    try { out[id] = JSON.parse(await readFile(path.join(dir, name), 'utf8')); } catch (error) {
      console.warn(`[studio] skipped override ${name}: ${error.message}`);
    }
  }
  return out;
}

/** Writes (or, for an empty/null body, removes) one override. */
export async function writeOverride(id, override, dir = OVERRIDES_DIR) {
  const file = overridePath(id, dir);
  if (override === null || (typeof override === 'object' && !Object.keys(override).length)) {
    await rm(file, { force: true });
    return { id, removed: true };
  }
  if (typeof override !== 'object' || Array.isArray(override)) throw new Error('override must be a JSON object');
  await atomicWrite(file, `${JSON.stringify(override, null, 2)}\n`);
  return { id, written: path.relative(repo, file) };
}

async function readStamps() {
  try { return JSON.parse(await readFile(STAMPS_FILE, 'utf8')); } catch { return {}; }
}

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); }
  });
});

/** Connect middleware for the /__studio endpoints. */
export function studioEndpoint({ root = treesRoot(), dir = OVERRIDES_DIR } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  return (req, res, next) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/__studio/')) return next();
    const fail = (e) => send(res, 400, { error: e.message });
    if (url === '/__studio/info' && req.method === 'GET') {
      return send(res, 200, { gameRoot: path.resolve(root, '../../../..'), treesRoot: root, overridesDir: path.relative(repo, dir) });
    }
    if (url === '/__studio/overrides' && req.method === 'GET') {
      return void readOverrides(dir).then((o) => send(res, 200, o), fail);
    }
    if (url === '/__studio/stamps') {
      if (req.method === 'GET') return void readStamps().then((s) => send(res, 200, s[root] ?? {}), fail);
      if (req.method === 'POST') {
        return void readBody(req).then((body) => serial(async () => {
          if (!ID.test(String(body?.id)) || typeof body.fingerprint !== 'string') throw new Error('stamp needs id and fingerprint');
          const stamps = await readStamps();
          stamps[root] = { ...(stamps[root] ?? {}), [body.id]: body.fingerprint };
          await atomicWrite(STAMPS_FILE, JSON.stringify(stamps, null, 2));
          send(res, 200, stamps[root]);
        })).catch(fail);
      }
    }
    const match = /^\/__studio\/species\/([^/]+)$/.exec(url);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (req.method === 'DELETE') return void serial(() => writeOverride(id, null, dir)).then((r) => send(res, 200, r), fail);
      if (req.method === 'POST') {
        return void readBody(req).then((body) => serial(() => writeOverride(id, body, dir)))
          .then((r) => { console.log(`[studio] override ${id}: ${r.removed ? 'removed' : r.written}`); send(res, 200, r); }, fail);
      }
    }
    return send(res, 404, { error: `no studio endpoint ${req.method} ${url}` });
  };
}
