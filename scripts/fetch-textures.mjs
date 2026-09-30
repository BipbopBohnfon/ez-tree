// npm run fetch:textures
// The upstream textures under src/app/public/textures are Git LFS pointer
// files. This resolves each pointer from GitHub's LFS media endpoint, checks
// its sha256 and size against the pointer, and writes the real file into the
// gitignored cache (.cache/textures/<path under textures/>). The tracked
// pointers are left alone so the git tree stays clean.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CACHE_ROOT, SOURCE_ROOT } from './texture-paths.mjs';

const MEDIA = 'https://media.githubusercontent.com/media/dgreenheck/ez-tree/main/';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** {oid, size} of a Git LFS pointer file, or null when the file is real content. */
export function parsePointer(text) {
  if (!text.startsWith('version https://git-lfs.github.com/spec/v1')) return null;
  const oid = /oid sha256:([0-9a-f]{64})/.exec(text)?.[1];
  const size = Number(/size (\d+)/.exec(text)?.[1]);
  return oid && Number.isFinite(size) ? { oid, size } : null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function fetchOne(file, pointer) {
  const rel = path.relative(SOURCE_ROOT, file);
  const target = path.join(CACHE_ROOT, rel);
  try {
    const existing = await readFile(target);
    if (existing.length === pointer.size && sha256(existing) === pointer.oid) return 'cached';
  } catch {}
  const url = MEDIA + path.relative(repo, file).split(path.sep).map(encodeURIComponent).join('/');
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== pointer.size) throw new Error(`size ${bytes.length} != ${pointer.size}`);
      if (sha256(bytes) !== pointer.oid) throw new Error('sha256 mismatch');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(`${target}.part`, bytes);
      await rename(`${target}.part`, target);
      return 'fetched';
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${rel}: ${lastError.message} (${url})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const counts = { fetched: 0, cached: 0, real: 0 };
  const failures = [];
  const jobs = [];
  for await (const file of walk(SOURCE_ROOT)) {
    const head = (await stat(file)).size < 1024 ? await readFile(file, 'utf8') : '';
    const pointer = parsePointer(head);
    if (!pointer) { counts.real++; continue; }
    jobs.push(fetchOne(file, pointer).then((r) => counts[r]++, (e) => failures.push(e.message)));
    if (jobs.length % 6 === 0) await Promise.all(jobs.splice(0));
  }
  await Promise.all(jobs);
  console.log(`textures: ${counts.fetched} fetched, ${counts.cached} cached, ${counts.real} not LFS -> ${path.relative(repo, CACHE_ROOT)}/`);
  if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
}
