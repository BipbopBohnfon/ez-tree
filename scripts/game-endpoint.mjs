// Studio dev-server endpoints that write exports into the game
// (vite.studio.config.js mounts them):
//   GET  /__game/catalog  -> the game's catalog.json (an empty catalog if none)
//   POST /__game/export   <- {species, files: [{path, base64, keep?}]}
// The export's species record is merged into catalog.json server-side with
// mergeCatalog() (slot rules), before any file is touched: a refused merge
// writes nothing. Files and the catalog are written via temp file + rename.
// Requests are serialised so two exports never race the catalog.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyCatalog, formatCatalog, mergeCatalog } from '../src/studio/export/catalog.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The game's trees folder: $DEINTERLEAVER_GAME_ROOT/assets/art/terrain/trees, or
 *  the game checkout this fork sits in (third_party/ez-tree -> ../..). */
export function treesRoot(env = process.env) {
  const game = env.DEINTERLEAVER_GAME_ROOT ? path.resolve(env.DEINTERLEAVER_GAME_ROOT) : path.resolve(repo, '../..');
  return path.join(game, 'assets/art/terrain/trees');
}

const GLB = /^([a-z0-9][a-z0-9_]*)\.glb$/;
const PNG = /^textures\/([a-z0-9][a-z0-9_]*)_(albedo_alpha|normal_roughness)\.png(\.import)?$/;

/**
 * Checks an export's file list against its species record; returns the
 * absolute target of each file or throws. Only `<variant file>.glb` and
 * `textures/<set>_{albedo_alpha,normal_roughness}.png[.import]` of this
 * species are accepted, and nothing may resolve outside `root`.
 */
export function resolveTargets(root, species, files) {
  const variantFiles = new Set((species.variants ?? []).map((v) => v.file));
  const sets = new Set(Object.values(species.sets ?? {}));
  return files.map((file) => {
    const rel = String(file.path ?? '');
    const glb = GLB.exec(rel);
    const png = PNG.exec(rel);
    if (glb ? !variantFiles.has(glb[1]) : png ? !sets.has(png[1]) : true) {
      throw new Error(`refused path '${rel}': not a GLB or texture of species ${species.id}`);
    }
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error(`refused path '${rel}': outside the trees folder`);
    return target;
  });
}

async function readCatalog(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return emptyCatalog();
    throw new Error(`catalog.json is unreadable: ${error.message}`);
  }
}

async function atomicWrite(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);
}

const exists = (file) => stat(file).then(() => true, () => false);

/** Applies one export; returns {species, written, kept, root}. */
export async function applyExport(root, payload) {
  const { species, files } = payload ?? {};
  if (!species || !Array.isArray(files)) throw new Error('payload needs species and files');
  const targets = resolveTargets(root, species, files);
  const catalogFile = path.join(root, 'catalog.json');
  const merged = mergeCatalog(await readCatalog(catalogFile), species);
  const written = [], kept = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i].keep && await exists(targets[i])) { kept.push(files[i].path); continue; }
    await atomicWrite(targets[i], Buffer.from(files[i].base64 ?? '', 'base64'));
    written.push(files[i].path);
  }
  await atomicWrite(catalogFile, formatCatalog(merged));
  written.push('catalog.json');
  return { species: merged.species.find((s) => s.id === species.id), written, kept, root };
}

const send = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

/** Connect middleware for the two endpoints. */
export function gameEndpoint({ root = treesRoot() } = {}) {
  let queue = Promise.resolve();
  return (req, res, next) => {
    const url = req.url.split('?')[0];
    if (url === '/__game/catalog' && req.method === 'GET') {
      readCatalog(path.join(root, 'catalog.json')).then((c) => send(res, 200, c), (e) => send(res, 500, { error: e.message }));
      return;
    }
    if (url !== '/__game/export') return next();
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      queue = queue.then(async () => {
        try {
          const reply = await applyExport(root, JSON.parse(Buffer.concat(chunks).toString('utf8')));
          console.log(`[game] ${reply.species.id}: wrote ${reply.written.length} files to ${root}`);
          send(res, 200, reply);
        } catch (error) {
          console.error(`[game] export refused: ${error.message}`);
          send(res, 400, { error: error.message });
        }
      });
    });
  };
}
