// Tree catalog merge (.scratch/ez_trees/spec.md, "Catalog contract").
// Pure functions: no I/O. The dev server's POST /__game/export merges every
// exported species into the game's catalog.json with mergeCatalog().
//
// Slot rules: slots are Terrain3D mesh ids, contiguous from first_slot (36),
// append-only, never reused or reordered. Re-exporting a variant (same file)
// keeps its slot; a new variant or species appends. Anything that would move,
// drop or duplicate a slot throws.

export const CATALOG_VERSION = 1;
export const FIRST_SLOT = 36;
export const MAX_LODS = 5;

const SPECIES_KEYS = ['id', 'name', 'biomes', 'lods', 'last_shadow_lod', 'impostor', 'sets', 'wind', 'variants'];
const VARIANT_KEYS = ['slot', 'name', 'file', 'height', 'tris'];
const SET_ROLES = ['bark', 'leaves', 'impostor'];
const FILE_SAFE = /^[a-z0-9][a-z0-9_]*$/;

/** A new, empty catalog. */
export function emptyCatalog() {
  return { version: CATALOG_VERSION, first_slot: FIRST_SLOT, species: [] };
}

const fail = (message) => { throw new Error(`catalog: ${message}`); };

function pick(object, keys) {
  const out = {};
  for (const key of keys) if (object[key] !== undefined) out[key] = object[key];
  return out;
}

/** Checks the slot rules of a whole catalog; throws on the first break. */
export function checkCatalog(catalog) {
  if (catalog.version !== CATALOG_VERSION) fail(`version is not ${CATALOG_VERSION}`);
  if (catalog.first_slot !== FIRST_SLOT) fail(`first_slot is not ${FIRST_SLOT}`);
  if (!Array.isArray(catalog.species)) fail('species is not a list');
  const ids = new Set(), names = new Set(), sets = new Set(), files = new Set(), slots = new Set();
  for (const species of catalog.species) {
    if (!species.id || ids.has(species.id)) fail(`species id '${species.id}' is missing or repeated`);
    ids.add(species.id);
    if (!species.name || names.has(species.name)) fail(`species ${species.id}: name '${species.name}' is missing or taken`);
    names.add(species.name);
    const lods = species.lods;
    if (!Array.isArray(lods) || lods.length < 1 || lods.length > MAX_LODS) fail(`species ${species.id}: lods is not 1..${MAX_LODS} distances`);
    if (!lods.every((d, i) => typeof d === 'number' && d > (i ? lods[i - 1] : 0))) fail(`species ${species.id}: lods do not rise from above 0`);
    const shadow = species.last_shadow_lod;
    if (!Number.isInteger(shadow) || shadow < -1 || shadow >= lods.length) fail(`species ${species.id}: last_shadow_lod out of range`);
    const impostor = lods.length === MAX_LODS;
    if (impostor && !['cross', 'card'].includes(species.impostor)) fail(`species ${species.id}: impostor is not cross or card`);
    const roles = Object.keys(species.sets ?? {});
    if (!species.sets?.bark || !species.sets?.leaves || roles.includes('impostor') !== impostor || roles.some((r) => !SET_ROLES.includes(r))) {
      fail(`species ${species.id}: sets are not bark, leaves${impostor ? ' and impostor' : ''}`);
    }
    for (const role of roles) {
      const set = species.sets[role];
      if (!FILE_SAFE.test(set) || sets.has(set)) fail(`species ${species.id}: set '${set}' is malformed or taken`);
      sets.add(set);
    }
    for (const [role, pair] of Object.entries(species.wind ?? {})) {
      if (!roles.includes(role) || !Array.isArray(pair) || pair.length !== 2 || !(pair[0] >= 0) || !(pair[1] > 0)) {
        fail(`species ${species.id}: wind for ${role} is not [bend, sway_rate] of one of its sets`);
      }
    }
    if (!Array.isArray(species.variants) || !species.variants.length) fail(`species ${species.id} has no variants`);
    for (const variant of species.variants) {
      if (!Number.isInteger(variant.slot)) fail(`species ${species.id}: variant ${variant.file} has no slot`);
      if (slots.has(variant.slot)) fail(`slot ${variant.slot} is repeated`);
      slots.add(variant.slot);
      if (!variant.name || names.has(variant.name)) fail(`slot ${variant.slot}: name '${variant.name}' is missing or taken`);
      names.add(variant.name);
      if (!FILE_SAFE.test(variant.file ?? '') || files.has(variant.file)) fail(`slot ${variant.slot}: file '${variant.file}' is malformed or repeated`);
      files.add(variant.file);
      if (variant.tris && variant.tris.length !== lods.length) fail(`slot ${variant.slot}: tris has ${variant.tris.length} entries for ${lods.length} lods`);
    }
  }
  for (let slot = FIRST_SLOT; slot < FIRST_SLOT + slots.size; slot++) {
    if (!slots.has(slot)) fail(`slots are not contiguous from ${FIRST_SLOT} (no ${slot})`);
  }
  return catalog;
}

/**
 * Merges one exported species into a catalog and returns a new catalog
 * (the inputs are not modified). `existing` may be null/undefined/{} for no
 * catalog yet.
 *
 * `speciesRecord` is a catalog species entry whose variants may omit `slot`:
 * - an unknown species is appended, its variants taking the next slots;
 * - a known species (same id) takes the record's fields, and each variant
 *   whose `file` is already catalogued keeps its slot; new files append;
 * - a variant that names a slot must name the one it already has.
 * Throws when the merge would move, drop or duplicate a slot (e.g. a
 * catalogued variant missing from the record), or break a catalog rule.
 * @param {object|null|undefined} existing
 * @param {object} speciesRecord
 * @returns {object} merged catalog, keys in contract order
 */
export function mergeCatalog(existing, speciesRecord) {
  const base = existing && Object.keys(existing).length ? structuredClone(existing) : emptyCatalog();
  checkCatalog(base);
  const record = structuredClone(speciesRecord);
  if (!record?.id) fail('the species record has no id');
  if (!Array.isArray(record.variants) || !record.variants.length) fail(`species ${record.id} has no variants`);
  const recordFiles = new Set();
  for (const v of record.variants) {
    if (recordFiles.has(v.file)) fail(`species ${record.id}: file '${v.file}' is repeated`);
    recordFiles.add(v.file);
  }

  let nextSlot = FIRST_SLOT + base.species.reduce((n, s) => n + s.variants.length, 0);
  const index = base.species.findIndex((s) => s.id === record.id);
  const previous = index >= 0 ? base.species[index] : null;
  const known = new Map((previous?.variants ?? []).map((v) => [v.file, v.slot]));
  for (const file of known.keys()) {
    if (!recordFiles.has(file)) fail(`species ${record.id}: variant '${file}' (slot ${known.get(file)}) is missing from the export; slots are never dropped`);
  }
  // Another species' variant using one of these files would be moved.
  for (const other of base.species) {
    if (other.id === record.id) continue;
    for (const v of other.variants) {
      if (recordFiles.has(v.file)) fail(`species ${record.id}: file '${v.file}' belongs to species ${other.id} (slot ${v.slot})`);
    }
  }

  const variants = record.variants.map((v) => {
    const slot = known.has(v.file) ? known.get(v.file) : nextSlot++;
    if (v.slot !== undefined && v.slot !== slot) {
      fail(`species ${record.id}: variant '${v.file}' asks for slot ${v.slot} but ${known.has(v.file) ? 'holds' : 'would take'} ${slot}`);
    }
    return pick({ ...v, slot }, VARIANT_KEYS);
  }).sort((a, b) => a.slot - b.slot);

  const merged = pick({ ...record, variants }, SPECIES_KEYS);
  if (merged.sets) merged.sets = pick(merged.sets, SET_ROLES);
  if (merged.wind) merged.wind = pick(merged.wind, SET_ROLES);
  if (index >= 0) base.species[index] = merged;
  else base.species.push(merged);
  return checkCatalog({ version: base.version, first_slot: base.first_slot, species: base.species.map((s) => pick(s, SPECIES_KEYS)) });
}

/**
 * Pretty, stable JSON for catalog.json: two-space indent, one line per
 * variant, number/string arrays and small objects inline.
 * @param {object} catalog
 * @returns {string}
 */
export function formatCatalog(catalog) {
  const inline = (value) => JSON.stringify(value).replace(/,(?=["{[\d-])/g, ', ').replace(/":/g, '": ');
  const species = catalog.species.map((s) => {
    const lines = SPECIES_KEYS.filter((k) => k !== 'variants' && s[k] !== undefined)
      .map((k) => `      ${JSON.stringify(k)}: ${inline(s[k])}`);
    const variants = s.variants.map((v) => `        ${inline(pick(v, VARIANT_KEYS))}`).join(',\n');
    lines.push(`      "variants": [\n${variants}\n      ]`);
    return `    {\n${lines.join(',\n')}\n    }`;
  });
  const list = species.length ? `[\n${species.join(',\n')}\n  ]` : '[]';
  return `{\n  "version": ${catalog.version},\n  "first_slot": ${catalog.first_slot},\n  "species": ${list}\n}\n`;
}
