// Species overrides: the one place Tree Studio edits become species defs.
//
// An override is a sparse JSON patch over a species def
// (src/lib/species/<id>.js), saved as src/lib/species/overrides/<id>.json by
// POST /__studio/species/:id. Plain objects merge key by key, arrays and
// scalars replace, and `null` deletes a key (so `vary: {"form.lean": null}`
// stops a parameter varying). `seedNudge: {"<variant index>": n}` offsets a
// variant's seed (buildVariant honours it).
//
// The studio preview, the studio export and batch.html all build from
// effectiveSpecies(), so an exported tree equals the previewed one.
import { SPECIES, getSpecies } from '@dgreenheck/ez-tree';

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge `patch` over `base` (new object; inputs untouched). */
export function mergePatch(base, patch) {
  if (!isPlain(patch)) return structuredClone(patch);
  const out = isPlain(base) ? structuredClone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isPlain(value)) out[key] = mergePatch(out[key], value);
    else out[key] = structuredClone(value);
  }
  return out;
}

/** A species def with its override applied (the registered def when none). */
export function applyOverride(species, override) {
  if (!override || !Object.keys(override).length) return species;
  const merged = mergePatch(species, override);
  // Identity is not overridable: ids, names and sets are catalog keys.
  merged.id = species.id;
  merged.name = species.name;
  return merged;
}

/** Every saved override, {id: json} (GET /__studio/overrides). */
export async function loadOverrides({ endpoint = '/__studio/overrides' } = {}) {
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`loadOverrides: HTTP ${response.status}`);
  return response.json();
}

/** Saves (or with an empty override, removes) one species' override. */
export async function saveOverride(id, override) {
  const empty = !override || !Object.keys(override).length;
  const response = await fetch(`/__studio/species/${encodeURIComponent(id)}`, {
    method: empty ? 'DELETE' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: empty ? undefined : JSON.stringify(override),
  });
  const reply = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok || reply.error) throw new Error(`saveOverride: ${reply.error ?? response.status}`);
  return reply;
}

/** The def a species builds and exports from: registered def + saved override. */
export function effectiveSpecies(id, overrides = {}) {
  return applyOverride(getSpecies(id), overrides[id]);
}

/** Every effective species, {id: def}, in roster order. */
export function effectiveRoster(overrides = {}) {
  return Object.fromEntries(Object.keys(SPECIES).map((id) => [id, effectiveSpecies(id, overrides)]));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isPlain(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** FNV-1a over the def's stable JSON: changes whenever anything a build reads changes. */
export function fingerprint(species) {
  const text = stable(species);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Reads a dotted path ('branch.length.0') out of an object. */
export function getPath(object, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), object);
}

/** Sparse patch that sets a dotted path to `value` (for building overrides). */
export function patchAt(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  keys.slice(0, -1).forEach((k) => { node = node[k] = {}; });
  node[keys.at(-1)] = value;
  return root;
}
