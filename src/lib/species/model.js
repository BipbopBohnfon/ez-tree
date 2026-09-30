import TreeOptions from '../options';
import RNG from '../rng';

/** Variants per species (the catalog's NN suffix runs 01..VARIANT_COUNT). */
export const VARIANT_COUNT = 10;

/**
 * @typedef {Object} SpeciesDef
 * @property {string} id Catalog id (snake_case)
 * @property {string} name Display / group name
 * @property {string[]} biomes
 * @property {[number, number]} height Target height range in metres
 * @property {number[]} lods End distance (m) of each LOD, length 1..5
 * @property {number} [lastShadowLod=1]
 * @property {'cross'|'card'} impostor
 * @property {{texture: string, tint: number, textureScale?: {x: number, y: number}, roughness?: number, saturation?: number, gain?: number}} bark
 *   `texture` names the source bark set (ambientCG id) the exporter packs;
 *   `saturation` (1 = source) and `gain` (1 = source) grade the source
 *   colour before the tint (a white birch from a tan photo)
 * @property {{tint?: number, paint: import('../leafpaint').LeafPaintParams, roughness?: number}} leaves
 * @property {number} [swayRate=0.25] Wind sway rate for every set
 * @property {object} options Partial TreeOptions JSON (generator units)
 * @property {Object<string, [number, number] | [number, number, 'int']>} vary
 *   Dotted TreeOptions paths sampled per variant, stratified across the ten
 *   variants so each parameter covers its whole range
 * @property {Object<number, object>} [lodDetail] Per-tier LODDetail overrides
 * @property {number} [stemThin] Multi-stem limb sharing: each stem grows
 *   children[0] / stems^stemThin main limbs (at least 2)
 */

/** FNV-1a 32-bit hash of a string. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function setPath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (const key of keys.slice(0, -1)) node = node[key];
  node[keys[keys.length - 1]] = value;
}

/**
 * Stratified sample in [0, 1) for variant `index` of parameter `key`:
 * the ten variants take ten different strata in a per-parameter shuffled
 * order, jittered inside the stratum. Pure function of (species, key, index).
 */
export function stratum(speciesId, key, index) {
  const rng = new RNG(hash(`${speciesId}/${key}`) & 0x7fffffff);
  const order = Array.from({ length: VARIANT_COUNT }, (_, k) => k);
  for (let k = order.length - 1; k > 0; k--) {
    const r = Math.floor(rng.random() * (k + 1));
    [order[k], order[r]] = [order[r], order[k]];
  }
  const jitter = new RNG(hash(`${speciesId}/${key}/${index}`) & 0x7fffffff).random(0.85, 0.15);
  return (order[index % VARIANT_COUNT] + jitter) / VARIANT_COUNT;
}

/** Catalog-facing variant identity and target height. */
export function variantInfo(species, index) {
  const nn = String(index + 1).padStart(2, '0');
  const [lo, hi] = species.height;
  return {
    index,
    name: `${species.name} ${nn}`,
    file: `${species.id}_${nn}`,
    height: Math.round((lo + (hi - lo) * stratum(species.id, 'height', index)) * 100) / 100,
  };
}

/**
 * Deterministic TreeOptions for one variant: the species base options, each
 * `vary` range sampled at the variant's stratum, and a variant seed.
 * @param {SpeciesDef} species
 * @param {number} index 0..VARIANT_COUNT-1
 * @returns {TreeOptions}
 */
export function speciesVariantOptions(species, index) {
  if (!Number.isInteger(index) || index < 0 || index >= VARIANT_COUNT) {
    throw new RangeError(`variant index must be 0..${VARIANT_COUNT - 1}`);
  }
  const options = new TreeOptions();
  options.copy(structuredClone(species.options));
  options.seed = hash(`${species.id}#${index}`) % 65536;
  options.bark.type = species.bark.texture;
  options.bark.tint = species.bark.tint;
  if (species.bark.textureScale) options.bark.textureScale = { ...species.bark.textureScale };
  options.leaves.type = species.id;
  if (species.leaves.tint !== undefined) options.leaves.tint = species.leaves.tint;
  for (const [path, [lo, hi, kind]] of Object.entries(species.vary ?? {})) {
    const value = lo + (hi - lo) * stratum(species.id, path, index);
    setPath(options, path, kind === 'int' ? Math.round(value) : value);
  }
  // Multi-stem variants share one crown budget: each stem carries fewer
  // main limbs (children[0] / stems^stemThin), so a three-stem tree is not
  // three trees' worth of leaves thinned back under the LOD0 cap.
  if (species.stemThin && options.form.stems > 1) {
    const children = options.branch.children;
    children[0] = Math.max(2, Math.round(children[0] / Math.pow(options.form.stems, species.stemThin)));
  }
  // Keep drooping and splayed limbs above the ground plane.
  // Leaf cards hang up to one leaf length below their branch.
  if (options.form.floor === null) {
    options.form.floor = 0.03 * options.branch.length[0] +
      options.leaves.size * (1 + options.leaves.sizeVariance);
  }
  return options;
}

/** Catalog wind entry: bend ≈ 0.35 / h² for the species' mean height. */
export function speciesWind(species) {
  const h = (species.height[0] + species.height[1]) / 2;
  const bend = Math.round((0.35 / (h * h)) * 1e5) / 1e5;
  const rate = species.swayRate ?? 0.25;
  return { bark: [bend, rate], leaves: [bend, rate], impostor: [bend, rate] };
}

/** Texture-set names for a species (globally unique by species id). */
export function speciesSets(species) {
  return {
    bark: `${species.id}_bark`,
    leaves: `${species.id}_leaves`,
    impostor: `${species.id}_impostor`,
  };
}
