// Species export: builds every variant of a species, bakes the species
// impostor atlas, packs its texture sets and writes one GLB per variant.
// Browser only (WebGL for the atlas). The studio UI and batch.html both go
// through exportSpecies() + writeToGame().
import { SPECIES, bakeSpeciesAtlas, buildSpecies, getSpecies } from '@dgreenheck/ez-tree';
import { variantGLB } from './glb.js';
import { speciesTextures, textureSetFiles } from './textures.js';

export { mergeCatalog, formatCatalog, checkCatalog, emptyCatalog } from './catalog.js';
export { encodeGLB, parseGLB, variantGLB } from './glb.js';
export { encodePNG, decodePNG } from './png.js';
export { speciesTextures, textureSetFiles, BARK_SIZE } from './textures.js';

/** Every species id, in roster order. */
export const SPECIES_IDS = Object.keys(SPECIES);

const round = (x, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

/**
 * Exports one species.
 * @param {string} speciesId
 * @param {{
 *   renderer: import('three').WebGLRenderer,
 *   lods?: number[],
 *   impostor?: 'cross'|'card',
 *   barkSize?: number,
 *   textureBase?: string,
 *   onProgress?: (p: {stage: string, done: number, total: number, message: string}) => void,
 * }} opts `lods` overrides the species' end distances (length 1..5; fewer
 *   than 5 exports no impostor), `impostor` its impostor mode.
 * @returns {Promise<{files: {path: string, bytes: Uint8Array, keep?: boolean}[], species: object}>}
 *   paths relative to the game's assets/art/terrain/trees/; `species` is the
 *   catalog record (variants without slots: the catalog merge assigns them).
 */
export async function exportSpecies(speciesId, opts = {}) {
  const species = getSpecies(speciesId);
  const { renderer, onProgress = () => {} } = opts;
  const lods = opts.lods ?? species.lods;
  const impostorMode = opts.impostor ?? species.impostor;
  const hasImpostor = lods.length === 5;
  if (hasImpostor && !renderer) throw new Error('exportSpecies: a renderer is needed to bake the impostor atlas');
  const total = 4;
  const step = (done, stage, message) => onProgress({ stage, done, total, message });

  step(0, 'textures', `${species.name}: loading bark, painting leaves`);
  const tex = await speciesTextures(species, { base: opts.textureBase, barkSize: opts.barkSize });
  let variants = [];
  try {
    step(1, 'build', `${species.name}: building ${lods.length}-level variants`);
    variants = buildSpecies(speciesId, { lods, impostor: impostorMode, textures: tex.textures });
    const sets = { ...variants[0].sets };
    const packed = { [sets.bark]: tex.packed.bark, [sets.leaves]: tex.packed.leaves };
    if (hasImpostor) {
      step(2, 'atlas', `${species.name}: baking the impostor atlas`);
      const atlas = bakeSpeciesAtlas(variants, renderer);
      packed[sets.impostor] = { albedo: atlas.albedo, normal: atlas.normal };
      atlas.map.dispose();
      atlas.normalMap?.dispose();
    } else {
      delete sets.impostor;
    }
    step(3, 'encode', `${species.name}: writing GLBs and PNGs`);
    const files = variants.map((v) => ({ path: `${v.file}.glb`, bytes: variantGLB(v) }));
    files.push(...await textureSetFiles(packed));

    const wind = {};
    for (const role of Object.keys(sets)) wind[role] = variants[0].wind[role];
    const record = {
      id: species.id,
      name: species.name,
      biomes: [...species.biomes],
      lods: [...lods],
      last_shadow_lod: Math.min(species.lastShadowLod ?? 1, lods.length - 1),
      ...(hasImpostor ? { impostor: impostorMode } : {}),
      sets,
      wind,
      variants: variants.map((v) => ({ name: v.name, file: v.file, height: round(v.height), tris: [...v.tris] })),
    };
    step(4, 'done', `${species.name}: ${files.length} files`);
    return { files, species: record };
  } finally {
    variants.forEach((v) => v.dispose());
    tex.dispose();
  }
}

function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Sends an export to the studio dev server (POST /__game/export), which
 * merges the species into the game's catalog.json and writes the files.
 * @param {{files: {path: string, bytes: Uint8Array, keep?: boolean}[], species: object}} result
 * @param {{endpoint?: string}} [opts]
 * @returns {Promise<{species: object, written: string[], kept: string[], root: string}>}
 *   the merged catalog record (with slots) and what was written
 */
export async function writeToGame(result, { endpoint = '/__game/export' } = {}) {
  const body = JSON.stringify({
    species: result.species,
    files: result.files.map((f) => ({ path: f.path, keep: !!f.keep, base64: base64(f.bytes) })),
  });
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const reply = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || reply.error) throw new Error(`writeToGame: ${reply.error ?? response.status}`);
  return reply;
}

/** The game's current catalog (GET /__game/catalog). */
export async function readGameCatalog({ endpoint = '/__game/catalog' } = {}) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`readGameCatalog: HTTP ${response.status}`);
  return response.json();
}
