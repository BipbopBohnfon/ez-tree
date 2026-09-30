// Where the resolved (non-LFS) upstream textures live, shared by
// fetch-textures.mjs and the studio dev server.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Tracked LFS pointers. */
export const SOURCE_ROOT = path.join(repo, 'src/app/public/textures');
/** Gitignored cache of the real files, same layout as SOURCE_ROOT. */
export const CACHE_ROOT = path.join(repo, '.cache/textures');
