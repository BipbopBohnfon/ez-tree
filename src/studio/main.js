// Tree Studio: preview, tune and export the game's procedural tree species.
// See README "Tree Studio". State lives here; the viewport, thumbnails and
// design panel are separate modules. window.studio is a small automation
// API (tests/studio-shots.mjs drives it headless).
import { SPECIES, VARIANT_COUNT, bakeSpeciesAtlas, buildVariant, getSpecies } from '@dgreenheck/ez-tree';
import { variantInfo } from '../lib/species/model.js';
import { exportSpecies, readGameCatalog, speciesTextures, writeToGame } from './export/index.js';
import { applyOverride, fingerprint, loadOverrides, saveOverride } from './overrides.js';
import { Viewport } from './viewport.js';
import { ThumbRenderer } from './thumbs.js';
import { renderDesign } from './design.js';
import {
  confirmModal, debounce, fmt, h, imageCanvas, kfmt, section, segmented, slider, toast, toggle,
} from './ui.js';

// ---------------------------------------------------------------- constants
const BIOMES = [
  { id: 'meadow', name: 'Meadow', color: '#6f8a3e' },
  { id: 'forest', name: 'Forest', color: '#465c2c' },
  { id: 'alpine', name: 'Alpine', color: '#7c8270' },
  { id: 'lake_shore', name: 'Lake shore', color: '#5d7843' },
  { id: 'ocean_shore', name: 'Ocean shore', color: '#c8b88c' },
  { id: 'dry_grass', name: 'Dry grass', color: '#b0985a' },
  { id: 'scrub', name: 'Scrub', color: '#8c8156' },
  { id: 'desert', name: 'Desert', color: '#cfae7a' },
];
const DEFAULT_LODS = [30, 70, 150, 400, 1500];
const LOD_NAMES = ['Full', 'LOD1', 'LOD2', 'LOD3', 'LOD4'];
const IDS = Object.keys(SPECIES);
const $ = (s) => document.querySelector(s);
const nn = (i) => String(i + 1).padStart(2, '0');

// ---------------------------------------------------------------- state
const state = {
  speciesId: IDS[0],
  biome: SPECIES[IDS[0]].biomes[0],
  variant: 0,
  compare: null,
  tab: 'design',
  lodMode: 'auto',
  grid: false,
  wind: true,
  wireframe: false,
  forest: false,
  forestScope: 'species',
  level: 1,
  filter: '',
  saved: {},    // id -> saved override (disk)
  working: {},  // id -> working override (unsaved edits included)
  catalog: { species: [] },
  stamps: {},
  info: null,
  exporting: false,
};

const hasEdits = (id) => JSON.stringify(state.working[id] ?? {}) !== JSON.stringify(state.saved[id] ?? {});
const effective = (id) => applyOverride(getSpecies(id), state.working[id] ?? state.saved[id]);
const savedDef = (id) => applyOverride(getSpecies(id), state.saved[id]);

// ---------------------------------------------------------------- viewport
const vp = new Viewport($('#view'), $('#telephoto'));
vp.setWind(state.wind);
const thumbs = new ThumbRenderer();

// Texture sets per (bark source, leaf paint): loads are async and shared.
const texCache = new Map();
function texturesFor(def) {
  const key = `${def.bark.texture}|${JSON.stringify(def.leaves.paint)}`;
  if (!texCache.has(key)) {
    texCache.set(key, speciesTextures(def));
    if (texCache.size > 12) {
      const [oldKey, old] = texCache.entries().next().value;
      texCache.delete(oldKey);
      old.then((t) => t.dispose(), () => {});
    }
  }
  return texCache.get(key);
}

const busy = (text) => {
  $('#busy').classList.toggle('on', !!text);
  if (text) $('#busy-text').textContent = text;
};

/** Everything currently on screen that we own and must dispose. */
let shown = null;
let buildToken = 0;

function disposeShown(s) {
  if (!s) return;
  s.variants.forEach((v) => v.dispose());
  for (const a of s.atlases) { a.map.dispose(); a.normalMap?.dispose(); }
}

/** Impostor atlas sized to the game's texel density: ten variants share 2048². */
function previewAtlas(variants) {
  if (!variants[0]?.impostor) return null;
  const card = variants[0].impostorMode === 'card';
  const width = 2 ** Math.round(Math.log2(2048 * Math.sqrt(variants.length / VARIANT_COUNT)));
  return bakeSpeciesAtlas(variants, vp.renderer, { width, height: card ? width / 2 : width });
}

async function rebuild({ frame = false } = {}) {
  const token = ++buildToken;
  busy(state.forest ? 'planting forest' : 'building');
  try {
    const next = state.forest ? await buildForest(token) : await buildSingle(token);
    if (!next || token !== buildToken) { if (next) disposeShown(next); return; }
    const previous = shown;
    shown = next;
    vp.show(next.items, { forest: state.forest, keepCamera: !frame && !!previous && previous.forest === state.forest });
    disposeShown(previous);
    renderAll();
  } catch (error) {
    console.error(error);
    toast(`Build failed: ${error.message}`, 5000);
  } finally {
    if (token === buildToken) busy(null);
  }
}
const rebuildSoon = debounce(() => rebuild(), 90);

async function buildSingle(token) {
  const def = effective(state.speciesId);
  const tex = await texturesFor(def);
  if (token !== buildToken) return null;
  const indices = [state.variant, ...(state.compare !== null && state.compare !== state.variant ? [state.compare] : [])];
  const variants = indices.map((i) => buildVariant(def.id, i, { species: def, textures: tex.textures }));
  const atlas = previewAtlas(variants);
  const radius = Math.max(...variants.map((v) => Math.max(-v.bounds.min.x, v.bounds.max.x, -v.bounds.min.z, v.bounds.max.z)));
  const items = variants.map((variant, k) => ({ variant, x: variants.length === 2 ? (k ? 1 : -1) * (radius + 1.2) : 0 }));
  return { forest: false, def, tex, variants, atlases: atlas ? [atlas] : [], items };
}

/** ~60 trees on a patch: every variant of the species (or of every species in the biome). */
async function buildForest(token) {
  const ids = state.forestScope === 'biome'
    ? IDS.filter((id) => effective(id).biomes.includes(state.biome))
    : [state.speciesId];
  const variants = [], atlases = [], pools = [];
  for (const id of ids) {
    const def = effective(id);
    const tex = await texturesFor(def);
    if (token !== buildToken) { variants.forEach((v) => v.dispose()); return null; }
    const built = Array.from({ length: VARIANT_COUNT }, (_, i) => buildVariant(id, i, { species: def, textures: tex.textures }));
    if (built[0].impostor) atlases.push(bakeSpeciesAtlas(built, vp.renderer));
    variants.push(...built);
    pools.push(built);
    await new Promise((r) => setTimeout(r, 0));
  }
  // Deterministic dart throwing on a disc, spacing by crown radius.
  let seed = 1234567;
  const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const crown = (v) => Math.max(1.5, Math.max(-v.bounds.min.x, v.bounds.max.x, -v.bounds.min.z, v.bounds.max.z) * 0.8);
  const meanCrown = variants.reduce((n, v) => n + crown(v), 0) / variants.length;
  const radius = Math.sqrt(60) * meanCrown * 1.35;
  const items = [];
  for (let tries = 0; items.length < 60 && tries < 6000; tries++) {
    const pool = pools[Math.floor(rnd() * pools.length)];
    const variant = pool[Math.floor(rnd() * pool.length)];
    const scale = 0.85 + rnd() * 0.3;
    const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * radius;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const cr = crown(variant) * scale;
    if (items.some((o) => Math.hypot(o.x - x, o.z - z) < (o.cr + cr) * 0.75)) continue;
    items.push({ variant, x, z, scale, rotation: rnd() * Math.PI * 2, cr });
  }
  return { forest: true, variants, atlases, items, def: effective(state.speciesId) };
}

// ---------------------------------------------------------------- thumbnails
const thumbCache = new Map(); // key -> canvas
let thumbJob = 0;
async function refreshThumbs() {
  const job = ++thumbJob;
  const def = effective(state.speciesId);
  const fp = fingerprint(def);
  const tex = await texturesFor(def);
  for (let i = 0; i < VARIANT_COUNT; i++) {
    if (job !== thumbJob) return;
    const key = `${fp}#${i}`;
    if (!thumbCache.has(key)) {
      const v = buildVariant(def.id, i, { species: def, textures: tex.textures, lods: [def.lods[0]] });
      thumbCache.set(key, thumbs.render(v));
      v.dispose();
      if (thumbCache.size > 240) thumbCache.delete(thumbCache.keys().next().value);
    }
    renderStrip();
    await new Promise((r) => setTimeout(r, 0));
  }
}
const refreshThumbsSoon = debounce(refreshThumbs, 350);

function renderStrip() {
  const def = effective(state.speciesId);
  const fp = fingerprint(def);
  const strip = $('#strip');
  strip.replaceChildren(...Array.from({ length: VARIANT_COUNT }, (_, i) => {
    const canvas = thumbCache.get(`${fp}#${i}`);
    const meta = variantInfo(def, i);
    const nudge = def.seedNudge?.[i];
    const el = h(`div.thumb${i === state.variant ? '.on' : ''}${i === state.compare ? '.cmp' : ''}${canvas ? '' : '.loading'}`, {
      title: `${meta.name} (click; shift-click to compare)`,
      on: { click: (e) => selectVariant(i, e.shiftKey) },
    },
    canvas ? cloneCanvas(canvas) : null,
    h('span.n', nn(i)),
    h('span.h', `${fmt(meta.height, 0.1)} m`),
    nudge ? h('span.nudge', `seed ${nudge > 0 ? '+' : ''}${nudge}`) : null,
    state.compare !== null && i === state.variant ? h('span.tagc.a', 'A') : null,
    i === state.compare ? h('span.tagc', 'B') : null);
    return el;
  }));
}
function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

// ---------------------------------------------------------------- status
function speciesStatus(id) {
  const record = state.catalog.species?.find((s) => s.id === id);
  if (!record) return 'none';
  const def = effective(id);
  if (state.stamps[id]) return state.stamps[id] === fingerprint(def) ? 'ok' : 'changed';
  const lods = def.lods;
  const sameShape = JSON.stringify(record.lods) === JSON.stringify(lods)
    && (lods.length === 5 ? record.impostor === def.impostor : !record.impostor)
    && record.variants.every((v, i) => Math.abs(v.height - variantInfo(def, i).height) < 0.02);
  return sameShape ? 'ok' : 'changed';
}
const STATUS_TEXT = { none: 'not exported', ok: 'exported', changed: 'changed' };
const badge = (id) => {
  const s = speciesStatus(id);
  return h(`span.badge.st-${s}`, h(`i.dot.st-${s}`), STATUS_TEXT[s]);
};

// ---------------------------------------------------------------- rail
function renderRail() {
  const list = $('#species-list');
  const filter = state.filter.toLowerCase();
  list.replaceChildren(...BIOMES.map((biome) => {
    const ids = IDS.filter((id) => effective(id).biomes.includes(biome.id) && (!filter || SPECIES[id].name.toLowerCase().includes(filter)));
    if (!ids.length) return null;
    return h('div.biome',
      h('div.biome-head', h('span.sw', { style: { background: biome.color } }), biome.name, h('span.count', ids.length)),
      ...ids.map((id) => {
        const def = effective(id);
        const on = id === state.speciesId && biome.id === state.biome;
        return h(`div.sp${on ? '.on' : ''}`, { on: { click: () => selectSpecies(id, biome.id) }, 'data-id': id },
          h('span.name', def.name, hasEdits(id) ? h('span', { style: { color: 'var(--warn)' }, title: 'unsaved edits' }, ' •') : null),
          h('span.meta', `${def.height[0]}–${def.height[1]} m · ${VARIANT_COUNT} var`),
          badge(id));
      }));
  }).filter(Boolean));
}

// ---------------------------------------------------------------- top bar + HUD
function renderTop() {
  const def = effective(state.speciesId);
  const biome = BIOMES.find((b) => b.id === state.biome);
  $('#crumbs').replaceChildren(h('span', biome?.name ?? state.biome), h('span.sep', '›'), h('b', def.name), h('span.sep', '›'),
    h('span', state.forest ? `Forest · ${state.forestScope === 'biome' ? 'whole biome' : 'all variants'}` : `Variant ${nn(state.variant)}${state.compare !== null ? ` vs ${nn(state.compare)}` : ''}`));
  const dirty = IDS.some(hasEdits);
  const chip = $('#save-state');
  chip.textContent = dirty ? 'unsaved edits' : 'overrides saved';
  chip.className = `chip ${dirty ? 'dirty' : 'ok'}`;
}

let hudLast = 0;
function renderHud(force = false) {
  const now = performance.now();
  if (!force && now - hudLast < 100) return;
  hudLast = now;
  const info = vp.info;
  const v = shown?.variants?.[0];
  if (!v) return;
  const def = shown.def;
  const level = info.level ?? 0;
  const tris = state.forest ? null : v.tris[level];
  const pips = h('div.lod-pips', ...v.levels.map((l, i) => h(`i${l.kind === 'impostor' ? '.imp' : ''}${!info.culled && i === level ? '.on' : ''}${info.culled ? '.culled' : ''}`)));
  const title = state.forest ? `${def.name} forest` : v.name;
  const sub = state.forest
    ? `${shown.items.length} trees · ${shown.variants.length} variants · WASD to walk`
    : `${v.file} · ${v.levels.length === 1 ? 'no LOD' : `${v.levels.length} levels`}${v.impostor ? ` · ${v.impostorMode} impostor` : ''}`;
  $('#hud').replaceChildren(
    h('div.title', title), h('div.sub', sub),
    h('div.row',
      h('div.kv', h('span', 'height'), h('b', `${fmt(v.height, 0.01)} m`)),
      h('div.kv', h('span', 'distance'), h('b', `${fmt(info.distance, info.distance > 100 ? 1 : 0.1)} m`)),
      h('div.kv', h('span', info.pinned ? 'pinned' : 'lod'), h('b', { style: { color: info.culled ? 'var(--danger)' : v.levels[level]?.kind === 'impostor' ? 'var(--info)' : 'var(--accent)' } },
        info.culled ? 'culled' : LOD_NAMES[level])),
      tris !== null ? h('div.kv', h('span', 'tris'), h('b', kfmt(tris))) : h('div.kv', h('span', 'fps'), h('b', fmt(vp.fps, 1)))),
    pips);
  $('#tele-lod').textContent = info.culled ? '' : `${LOD_NAMES[level]} · ${kfmt(v.tris[level] ?? 0)} tris`;
  if (state.tab === 'lod') updateLodLive();
}
vp.onFrame(() => renderHud());

// ---------------------------------------------------------------- toolbar
const ICONS = {
  frame: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/></svg>',
  grid: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M1 5h14M1 11h14M5 1v14M11 1v14"/></svg>',
  wind: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1 6h9a2 2 0 1 0-2-2M1 10h12a2 2 0 1 1-2 2"/></svg>',
  wire: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 1 15 13H1z M8 1v12 M4.5 7h7"/></svg>',
  forest: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 1 1 9h3l-2 4h6L6 9h3zM11.5 4 8.8 9.5h2l-1.5 3.5h4.4L12.2 9.5h2z"/></svg>',
};
function renderToolbar() {
  const tool = (key, label, on, kbd, click, title) => {
    const b = h(`button.tool${on ? '.on' : ''}`, { title, on: { click } });
    b.innerHTML = `${ICONS[key]}<span>${label}</span><kbd>${kbd}</kbd>`;
    return b;
  };
  const bar = $('#toolbar');
  bar.replaceChildren(
    tool('frame', 'Frame', false, 'F', () => vp.frame(), 'Frame the tree'),
    tool('grid', 'Grid', state.grid, 'G', () => setGrid(!state.grid), 'Metre grid (1 m / 10 m)'),
    tool('wind', 'Wind', state.wind, 'V', () => setWind(!state.wind), 'Wind sway (catalog bend/rate)'),
    tool('wire', 'Wire', state.wireframe, 'X', () => setWireframe(!state.wireframe), 'Wireframe'),
    h('i.tool-sep'),
    tool('forest', 'Forest', state.forest, 'T', () => setForest(!state.forest), 'Scatter ~60 trees; WASD walks'),
    ...(state.forest ? [segmented([{ value: 'species', label: 'Species' }, { value: 'biome', label: 'Biome' }], state.forestScope,
      (s) => setForest(true, s))] : []),
  );
  $('#walk-hint').classList.toggle('on', state.forest);
}

// ---------------------------------------------------------------- LOD tab
let lodLive = null;
function renderLod() {
  const root = $('#tab-lod');
  const def = effective(state.speciesId);
  const v = shown?.variants?.[0];
  const base = getSpecies(state.speciesId);
  const chain = def.lods.length;
  const modes = [{ value: 'auto', label: 'Auto', title: 'By camera distance (Q)' },
    ...LOD_NAMES.map((n, i) => ({ value: i, label: n, title: `Pin ${n} (${i + 1})` }))];
  const modeSeg = segmented(modes, state.lodMode, setLodMode, { full: true, accent: true });
  [...modeSeg.children].forEach((b, i) => { if (i > chain) b.disabled = true; });

  const distVal = h('span.val');
  const logMin = Math.log(5), logMax = Math.log(2000);
  const distSlider = slider({
    min: 0, max: 1, step: 0.001, value: 0.2,
    onInput: (t) => { if (state.lodMode !== 'auto') setLodMode('auto'); vp.stopFlight(); vp.setDistance(Math.exp(logMin + t * (logMax - logMin))); },
  });
  const readDist = h('b'), readLod = h('b'), readEnd = h('b');
  lodLive = { distSlider, distVal, readDist, readLod, readEnd, logMin, logMax, rows: [] };

  const rows = (v?.levels ?? []).map((l, i) => {
    const max = Math.max(...v.tris);
    const endInput = h('input.search', {
      type: 'number', value: def.lods[i], min: 1, step: 1, style: { width: '66px', height: '22px', padding: '0 6px', textAlign: 'right' },
      title: 'End distance (m) of this level',
      on: {
        change: (e) => {
          const lods = [...def.lods];
          lods[i] = Math.max(1, Number(e.target.value));
          if (!lods.every((d, k) => !k || d > lods[k - 1])) { toast('End distances must rise level by level'); e.target.value = def.lods[i]; return; }
          edit((o) => { o.lods = lods; }, true);
        },
      },
    });
    const tr = h(`tr${l.kind === 'impostor' ? '.imp' : ''}`,
      h('td', LOD_NAMES[i]), h('td', { style: { color: 'var(--muted)' } }, l.kind === 'impostor' ? `${v.impostorMode}` : i === 0 ? 'native' : ['', 'reduced', 'aggressive', 'budget'][i]),
      h('td.r', kfmt(l.tris)),
      h('td', { style: { width: '70px' } }, h('div.bar', { style: { width: `${Math.max(3, (l.tris / max) * 100)}%` } })),
      h('td.r', endInput));
    lodLive.rows.push(tr);
    return tr;
  });

  const chainSeg = segmented([1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 1 ? 'None' : String(n), title: n === 5 ? 'Full chain with impostor' : `${n} levels` })), chain,
    (n) => edit((o) => {
      const src = base.lods.length >= n ? base.lods : DEFAULT_LODS;
      const lods = def.lods.length >= n ? def.lods.slice(0, n) : [...def.lods, ...src.slice(def.lods.length, n)];
      o.lods = lods;
    }, true), { full: true });
  const impSeg = segmented([{ value: 'cross', label: 'Cross · 4 tris' }, { value: 'card', label: 'Card · 2 tris' }], def.impostor,
    (m) => edit((o) => { o.impostor = m; }, true), { full: true });

  root.replaceChildren(
    section('Mode', state.lodMode === 'auto' ? 'camera distance' : 'pinned', modeSeg,
      h('div.kv-grid', { style: { marginTop: '10px' } },
        h('span', state.forest ? 'Nearest tree' : 'Camera distance'), readDist, h('span', state.forest ? 'Trees per level' : 'Active level'), readLod, h('span', state.forest ? 'Patch' : 'Level ends at'), readEnd)),
    section('Fly out', '5 m → 1500 m',
      h('div.prow', h('label', 'Distance'), distSlider, distVal, h('span')),
      h('div.btn-row', { style: { marginTop: '6px' } },
        h('button.btn.accent.grow', { on: { click: flyOut }, title: 'Dolly from 5 m to 1500 m (O)' }, 'Fly out'),
        h('button.btn', { on: { click: () => { vp.stopFlight(); vp.frame(); } } }, 'Back')),
      h('p.note', 'The telephoto inset keeps the tree readable once it is a few pixels tall.')),
    section('Chain', `${chain} level${chain > 1 ? 's' : ''}`,
      h('table.lod-table', h('thead', h('tr', h('th', 'Level'), h('th', 'Kind'), h('th.r', 'Tris'), h('th', ''), h('th.r', 'End m'))), h('tbody', ...rows))),
    section('Chain length', null, chainSeg,
      h('div', { style: { marginTop: '10px' } }, h('div.sec-h', 'Impostor', h('span.aside', chain === 5 ? 'LOD4' : 'needs 5 levels')), impSeg),
      h('p.note', 'Chain and impostor edits are part of the species override; export follows them.')),
    section('Display', null,
      toggle('Wireframe', state.wireframe, setWireframe),
      toggle('Metre grid', state.grid, setGrid),
      toggle('Wind sway', state.wind, setWind),
      h('div.kv-grid', { style: { marginTop: '6px' } }, h('span', 'Shadows'), h('b', `LOD0–${Math.min(def.lastShadowLod ?? 1, chain - 1)}`))),
  );
  updateLodLive();
}

function updateLodLive() {
  if (!lodLive || !shown?.variants?.[0]) return;
  const info = vp.info;
  const v = shown.variants[0];
  lodLive.readDist.textContent = `${fmt(info.distance, 0.1)} m`;
  lodLive.readLod.textContent = info.culled ? 'culled (beyond last end)' : `${LOD_NAMES[info.level]}${info.pinned ? ' (pinned)' : ''}`;
  lodLive.readEnd.textContent = info.culled ? '—' : `${v.lods[info.level]} m`;
  if (state.forest && info.hist) {
    lodLive.readDist.textContent = `${fmt(info.nearest, 0.1)} m`;
    lodLive.readLod.textContent = info.hist.map((n, i) => (n ? `${i === 5 ? 'culled' : LOD_NAMES[i]} ${n}` : null)).filter(Boolean).join(' · ');
    lodLive.readEnd.textContent = `${shown.items.length} trees`;
  }
  const t = (Math.log(Math.max(5, info.distance)) - lodLive.logMin) / (lodLive.logMax - lodLive.logMin);
  if (vp.flying || !lodLive.distSlider.matches(':active')) lodLive.distSlider.set(Math.min(1, Math.max(0, t)));
  lodLive.distVal.textContent = `${fmt(info.distance, 1)}`;
  lodLive.rows.forEach((tr, i) => tr.classList.toggle('active', !info.culled && i === info.level));
}

// ---------------------------------------------------------------- inspector
function renderInspect() {
  const root = $('#tab-inspect');
  const v = shown?.variants?.[0];
  if (!v || !shown.tex) {
    root.replaceChildren(section('Inspector', null, h('p.note', state.forest ? 'Leave forest mode to inspect one variant.' : 'Building…')));
    return;
  }
  const def = shown.def;
  const record = state.catalog.species?.find((s) => s.id === def.id);
  const slot = record?.variants.find((x) => x.file === v.file)?.slot;
  const sx = v.bounds.max.x - v.bounds.min.x, sz = v.bounds.max.z - v.bounds.min.z;
  const trunk = (v.options.branch.radius[0] ?? 1) * v.scale * (v.options.form.stems > 1 ? v.options.form.stemRadius : 1);
  const atlas = shown.atlases[0];
  const texTile = (image, caption) => h('div.tex', imageCanvas(image, 256), h('div.cap', caption));
  root.replaceChildren(
    section('Variant', v.file,
      h('div.kv-grid',
        h('span', 'Name'), h('b', v.name),
        h('span', 'Height'), h('b', `${fmt(v.height)} m`),
        h('span', 'Trunk radius (base)'), h('b', `${fmt(trunk, 0.001)} m`),
        h('span', 'Crown footprint'), h('b', `${fmt(sx, 0.1)} × ${fmt(sz, 0.1)} m`),
        h('span', 'Generator scale'), h('b', `${fmt(v.scale, 0.0001)} m/unit`),
        h('span', 'Seed'), h('b', String(v.options.seed)))),
    section('Triangles', `${v.levels.length} level${v.levels.length > 1 ? 's' : ''}`,
      h('div.kv-grid', ...v.levels.flatMap((l, i) => [h('span', `${LOD_NAMES[i]} · ${l.kind === 'impostor' ? v.impostorMode : `≤ ${v.lods[i]} m`}`), h('b', kfmt(l.tris))]))),
    section('Texture sets', 'as packed for the game',
      h('div.tex-grid',
        texTile(shown.tex.packed.bark.albedo, `${v.sets.bark}_albedo_alpha`),
        texTile(shown.tex.packed.bark.normal, `${v.sets.bark}_normal_roughness`),
        texTile(shown.tex.packed.leaves.albedo, `${v.sets.leaves}_albedo_alpha`),
        texTile(shown.tex.packed.leaves.normal, `${v.sets.leaves}_normal_roughness`),
        atlas ? texTile(atlas.albedo, `${v.sets.impostor}_albedo_alpha`) : null,
        atlas?.normal ? texTile(atlas.normal, `${v.sets.impostor}_normal_roughness`) : null),
      atlas ? h('p.note', `Preview atlas: ${atlas.albedo.width}×${atlas.albedo.height} for ${shown.variants.length} variant(s), the texel density of the exported 10-variant sheet.`) : null),
    section('Wind', '[bend, sway rate]',
      h('div.kv-grid', ...Object.entries(v.wind).flatMap(([set, [bend, rate]]) => [h('span', set), h('b', `${bend} · ${rate}`)]))),
    section('Game catalog', record ? `${STATUS_TEXT[speciesStatus(def.id)]}` : 'not exported',
      record
        ? h('div.kv-grid',
          h('span', 'This variant'), h('b', slot !== undefined ? `slot ${slot}` : '—'),
          h('span', 'Species slots'), h('b', `${record.variants[0].slot}–${record.variants.at(-1).slot}`),
          h('span', 'Exported LODs'), h('b', record.lods.join(' / ')),
          h('span', 'Impostor'), h('b', record.impostor ?? 'none'),
          h('span', 'Exported height'), h('b', `${record.variants.find((x) => x.file === v.file)?.height ?? '—'} m`),
          h('span', 'Exported tris'), h('b', record.variants.find((x) => x.file === v.file)?.tris.map(kfmt).join(' / ') ?? '—'))
        : h('p.note', 'No slots yet: the first export appends this species after the catalog\'s last slot.')),
  );
}

// ---------------------------------------------------------------- export tab
const exportLog = [];
function logLine(text, cls = '') { exportLog.push({ text, cls }); renderLog(); }
function renderLog() {
  const el = $('#export-log');
  if (!el) return;
  el.replaceChildren(...exportLog.map((l) => h(`div${l.cls ? `.${l.cls}` : ''}`, l.text)));
  el.scrollTop = el.scrollHeight;
}
function setProgress(fraction, label) {
  const bar = $('#export-bar'); const text = $('#export-label');
  if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  if (text) text.textContent = label;
}
function renderExport() {
  const root = $('#tab-export');
  const def = effective(state.speciesId);
  const status = speciesStatus(def.id);
  const exported = IDS.filter((id) => speciesStatus(id) !== 'none').length;
  root.replaceChildren(
    section('Target', 'DEINTERLEAVER_GAME_ROOT',
      h('div.path-box', state.info?.treesRoot ?? '…'),
      h('p.note', `catalog.json · ${state.catalog.species?.length ?? 0} species · ${state.catalog.species?.reduce((n, s) => n + s.variants.length, 0) ?? 0} slots from ${state.catalog.first_slot ?? 36}`)),
    section('Export', `${exported}/${IDS.length} exported`,
      h('div.kv-grid', { style: { marginBottom: '10px' } },
        h('span', def.name), h('span.end', badge(def.id)),
        h('span', 'Chain'), h('b', `${def.lods.join(' / ')} m`),
        h('span', 'Impostor'), h('b', def.lods.length === 5 ? def.impostor : 'none')),
      h('div.btn-row',
        h('button.btn.accent.grow', { disabled: state.exporting, on: { click: () => exportOne(def.id) }, id: 'export-one' }, `Export ${def.name}`),
        h('button.btn', { disabled: state.exporting, on: { click: exportAll }, id: 'export-all' }, 'Export all')),
      h('div.progress', h('i#export-bar')), h('div.progress-label#export-label', state.exporting ? 'exporting…' : 'idle'),
      status === 'changed' ? h('p.note', { style: { color: 'var(--warn)' } }, 'Changed since the last export.') : null),
    section('Log', h('button.btn.ghost', { style: { height: '20px', padding: '0 8px' }, on: { click: () => { exportLog.length = 0; renderLog(); } } }, 'clear'),
      h('div.log#export-log')),
  );
  renderLog();
}

async function refreshCatalog() {
  const [catalog, stamps] = await Promise.all([
    readGameCatalog().catch((e) => { toast(`Catalog: ${e.message}`); return { species: [] }; }),
    fetch('/__studio/stamps').then((r) => r.json()).catch(() => ({})),
  ]);
  state.catalog = catalog;
  state.stamps = stamps;
}

async function runExport(id, index, total) {
  if (hasEdits(id)) await save(id);
  const def = savedDef(id);
  const t0 = performance.now();
  logLine(`▸ ${def.name}`, 'hd');
  const result = await exportSpecies(id, {
    renderer: vp.renderer, species: def,
    onProgress: (p) => { setProgress((index + p.done / p.total) / total, p.message); logLine(`  ${p.stage}: ${p.message}`, 'dim'); },
  });
  const bytes = result.files.reduce((n, f) => n + f.bytes.length, 0);
  const reply = await writeToGame(result);
  await fetch('/__studio/stamps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, fingerprint: fingerprint(def) }) });
  const slots = reply.species.variants.map((v) => v.slot);
  logLine(`  wrote ${reply.written.length} files (${(bytes / 1e6).toFixed(1)} MB), patched ${reply.patched.length}, kept ${reply.kept.length}`, 'ok');
  const glbs = reply.written.filter((f) => f.endsWith('.glb'));
  if (glbs.length) logLine(`    ${glbs.length} GLB  ${glbs[0]} … ${glbs.at(-1)}`, 'dim');
  for (const f of reply.written.filter((x) => x.endsWith('.png'))) logLine(`    ${f.replace('textures/', 'textures/ ')}`, 'dim');
  const sidecars = reply.written.filter((f) => f.endsWith('.import')).length;
  if (sidecars) logLine(`    ${sidecars} new .import sidecars`, 'dim');
  if (reply.written.includes('catalog.json')) logLine('    catalog.json merged', 'dim');
  logLine(`  slots ${slots[0]}–${slots.at(-1)} · ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'ok');
  return reply;
}

async function exportOne(id) {
  if (state.exporting) return;
  await refreshCatalog();
  const def = effective(id);
  if (speciesStatus(id) !== 'none') {
    const ok = await confirmModal(`Overwrite ${def.name}?`,
      `${def.name} is already in the game catalog. Re-exporting rewrites its ${VARIANT_COUNT} GLBs and texture sets in\n${state.info?.treesRoot}\nSlots are kept.`, 'Overwrite');
    if (!ok) return;
  }
  await exportIds([id]);
}

async function exportAll() {
  if (state.exporting) return;
  await refreshCatalog();
  const existing = IDS.filter((id) => speciesStatus(id) !== 'none');
  const ok = await confirmModal('Export all species?',
    `${IDS.length} species × ${VARIANT_COUNT} variants into\n${state.info?.treesRoot}${existing.length ? `\n\n${existing.length} already exported will be overwritten (slots kept).` : ''}`,
    existing.length ? 'Export and overwrite' : 'Export all');
  if (!ok) return;
  await exportIds(IDS);
}

async function exportIds(ids) {
  state.exporting = true;
  renderExport();
  selectTab('export');
  const errors = [];
  for (let i = 0; i < ids.length; i++) {
    try { await runExport(ids[i], i, ids.length); } catch (error) {
      errors.push(ids[i]);
      logLine(`  ✕ ${ids[i]}: ${error.message}`, 'err');
      console.error(error);
    }
  }
  state.exporting = false;
  await refreshCatalog();
  renderAll();
  setProgress(1, errors.length ? `${errors.length} failed: ${errors.join(', ')}` : `done · ${ids.length} species`);
  logLine(errors.length ? `✕ ${errors.length} of ${ids.length} failed` : `✓ ${ids.length} species exported`, errors.length ? 'err' : 'ok');
  toast(errors.length ? 'Export finished with errors' : 'Export complete');
}

// ---------------------------------------------------------------- design edits
function edit(mutate, final) {
  const id = state.speciesId;
  const next = structuredClone(state.working[id] ?? state.saved[id] ?? {});
  mutate(next);
  state.working[id] = next;
  rebuildSoon();
  if (final) {
    refreshThumbsSoon();
    renderRail(); renderTop();
    if (state.tab === 'design') renderDesignTab();
  }
}

async function save(id = state.speciesId) {
  const override = state.working[id] ?? {};
  try {
    await saveOverride(id, override);
    state.saved[id] = structuredClone(override);
    if (!Object.keys(override).length) delete state.saved[id];
    toast(`Saved overrides/${id}.json`);
  } catch (error) {
    toast(error.message, 5000);
    throw error;
  }
  renderRail(); renderTop();
  if (state.tab === 'design') renderDesignTab();
}

function renderDesignTab() {
  const id = state.speciesId;
  renderDesign($('#tab-design'), {
    def: effective(id), base: getSpecies(id), variant: state.variant, level: state.level,
    edit, dirty: hasEdits(id), hasOverride: !!state.saved[id] || !!Object.keys(state.working[id] ?? {}).length,
    setLevel: (l) => { state.level = l; renderDesignTab(); },
    save: () => save(id),
    revert: () => { state.working[id] = structuredClone(state.saved[id] ?? {}); afterDefChange(); },
    reset: () => { state.working[id] = {}; afterDefChange(); },
  });
}

function afterDefChange() {
  rebuild();
  refreshThumbs();
  renderAll();
}

// ---------------------------------------------------------------- selection
function selectSpecies(id, biome) {
  const changed = id !== state.speciesId;
  state.speciesId = id;
  state.biome = biome ?? (effective(id).biomes.includes(state.biome) ? state.biome : effective(id).biomes[0]);
  vp.setBiomeColor(BIOMES.find((b) => b.id === state.biome)?.color ?? '#5f7a45');
  if (changed) { state.variant = 0; state.compare = null; state.level = 1; }
  rebuild({ frame: changed });
  refreshThumbs();
  renderAll();
}

function selectVariant(i, compare = false) {
  if (compare && i !== state.variant) state.compare = state.compare === i ? null : i;
  else { state.variant = i; if (state.compare === i) state.compare = null; if (!compare) state.compare = null; }
  if (state.forest) state.forest = false;
  rebuild({ frame: compare || state.compare !== null });
  renderAll();
}

function setLodMode(mode) { state.lodMode = mode; vp.setLodMode(mode); renderLod(); }
function setGrid(on) { state.grid = on; vp.setGrid(on); renderToolbar(); if (state.tab === 'lod') renderLod(); }
function setWind(on) { state.wind = on; vp.setWind(on); renderToolbar(); if (state.tab === 'lod') renderLod(); }
function setWireframe(on) { state.wireframe = on; vp.setWireframe(on); renderToolbar(); if (state.tab === 'lod') renderLod(); }
function setForest(on, scope = state.forestScope) {
  state.forest = on;
  state.forestScope = scope;
  if (on) state.compare = null;
  rebuild({ frame: true });
  renderAll();
}
function flyOut() {
  if (state.forest) setForest(false);
  setLodMode('auto');
  vp.flyOut({ from: 5, to: 1500, seconds: 10 });
}

function selectTab(tab) {
  state.tab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  renderTab();
}
function renderTab() {
  if (state.tab === 'design') renderDesignTab();
  else if (state.tab === 'lod') renderLod();
  else if (state.tab === 'inspect') renderInspect();
  else renderExport();
}
function renderAll() {
  renderRail(); renderTop(); renderToolbar(); renderStrip(); renderTab(); renderHud(true);
}

// ---------------------------------------------------------------- keyboard
const HELP = [
  ['↑ ↓', 'previous / next species'], ['← →', 'previous / next variant'], ['Shift + click', 'compare two variants'],
  ['Q', 'LOD auto'], ['1 – 5', 'pin Full, LOD1 … LOD4'], ['O', 'fly out 5 → 1500 m'],
  ['F', 'frame'], ['G', 'metre grid'], ['V', 'wind sway'], ['X', 'wireframe'],
  ['T', 'forest mode'], ['W A S D', 'walk (forest)'], ['[ ]', 'seed nudge (variant)'], ['Ctrl + S', 'save override'],
  ['Ctrl + E', 'export species'], ['?', 'this sheet'],
];
$('#help-body').replaceChildren(h('div.help-grid', ...HELP.flatMap(([k, d]) => [h('span', ...k.split(' ').map((x) => (x === '+' || x === '–' || x === '…' ? ` ${x} ` : h('kbd.k', x)))), h('span', d)])));
const showHelp = (on) => $('#help').classList.toggle('on', on);
$('#help-btn').addEventListener('click', () => showHelp(true));
$('#help-close').addEventListener('click', () => showHelp(false));

window.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select')) return;
  if ($('#modal').classList.contains('on')) return;
  const key = e.key;
  if ((e.ctrlKey || e.metaKey) && key === 's') { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && key === 'e') { e.preventDefault(); exportOne(state.speciesId); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const walking = state.forest && ['w', 'a', 's', 'd', 'W', 'A', 'S', 'D'].includes(key);
  if (walking) return;
  const order = BIOMES.flatMap((b) => IDS.filter((id) => effective(id).biomes.includes(b.id)).map((id) => [id, b.id]));
  const at = order.findIndex(([id, b]) => id === state.speciesId && b === state.biome);
  const handled = {
    ArrowDown: () => selectSpecies(...order[(at + 1) % order.length]),
    ArrowUp: () => selectSpecies(...order[(at - 1 + order.length) % order.length]),
    ArrowRight: () => selectVariant((state.variant + 1) % VARIANT_COUNT),
    ArrowLeft: () => selectVariant((state.variant + VARIANT_COUNT - 1) % VARIANT_COUNT),
    q: () => setLodMode('auto'),
    1: () => setLodMode(0), 2: () => setLodMode(1), 3: () => setLodMode(2), 4: () => setLodMode(3), 5: () => setLodMode(4),
    o: flyOut, f: () => vp.frame(), g: () => setGrid(!state.grid), v: () => setWind(!state.wind),
    x: () => setWireframe(!state.wireframe), t: () => setForest(!state.forest),
    '[': () => nudgeSeed(-1), ']': () => nudgeSeed(1),
    '?': () => showHelp(!$('#help').classList.contains('on')),
    Escape: () => showHelp(false),
  }[key];
  if (handled) { e.preventDefault(); handled(); }
});
function nudgeSeed(delta) {
  const i = state.variant;
  edit((o) => {
    o.seedNudge = { ...(o.seedNudge ?? {}) };
    const n = (o.seedNudge[i] ?? 0) + delta;
    if (n) o.seedNudge[i] = n; else delete o.seedNudge[i];
    if (!Object.keys(o.seedNudge).length) delete o.seedNudge;
  }, true);
}

document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('#filter').addEventListener('input', (e) => { state.filter = e.target.value; renderRail(); });

// ---------------------------------------------------------------- boot
async function boot() {
  const [info, overrides] = await Promise.all([
    fetch('/__studio/info').then((r) => r.json()).catch(() => null),
    loadOverrides().catch(() => ({})),
  ]);
  state.info = info;
  state.saved = overrides;
  state.working = structuredClone(overrides);
  if (info) {
    $('#game-root').textContent = `game: ${info.gameRoot}`;
    $('#game-root').title = `Exports land in ${info.treesRoot}`;
  }
  await refreshCatalog();
  selectSpecies(state.speciesId, state.biome);
}

// Automation hooks (tests/studio-shots.mjs).
window.studio = {
  state, vp,
  get idle() { return !$('#busy').classList.contains('on') && !state.exporting; },
  selectSpecies, selectVariant, selectTab, setLodMode, setForest, setGrid, setWind, setWireframe, flyOut,
  setDistance: (d) => { vp.stopFlight(); vp.setDistance(d); },
  edit: (mutate) => edit(mutate, true),
  save, exportOne, exportAll, effective, refreshCatalog,
  shown: () => shown,
  thumbsReady: () => {
    const fp = fingerprint(effective(state.speciesId));
    return Array.from({ length: VARIANT_COUNT }, (_, i) => thumbCache.has(`${fp}#${i}`)).every(Boolean);
  },
};
boot();
