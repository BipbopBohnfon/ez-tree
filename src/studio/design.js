// Design panel: live edits of a species' form parameters, written into the
// species' working override (see overrides.js). Each parameter is either a
// fixed value (options.<path>) or varied per variant (vary[<path>] range);
// the ~ button switches between the two.
import { TreeOptions } from '@dgreenheck/ez-tree';
import { getPath } from './overrides.js';
import {
  colorSwatch, dualSlider, fmt, h, hex, hexToHsl, hslToHex, section, segmented, slider, unhex,
} from './ui.js';

/** [path, label, min, max, step, int?] */
const FORM = [
  ['form.lean', 'Lean °', 0, 30, 0.5],
  ['form.leanDirection', 'Lean dir °', 0, 360, 1],
  ['form.bend', 'Trunk bend °', -40, 40, 0.5],
  ['form.windswept', 'Windswept', 0, 2, 0.01],
  ['form.crownFlatten', 'Crown flatten', 0, 3.5, 0.01],
  ['form.crownStart', 'Crown start', 0, 1.5, 0.01],
  ['form.stems', 'Stems', 1, 6, 0.05],
  ['form.stemSpread', 'Stem spread °', 0, 60, 0.5],
  ['branch.force.strength', 'Upward pull', -0.03, 0.03, 0.0005],
];
const TRUNK = [
  ['branch.length.0', 'Length', 1, 80, 0.5],
  ['branch.radius.0', 'Radius', 0.2, 4, 0.02],
  ['branch.gnarliness.0', 'Gnarliness', 0, 0.5, 0.005],
  ['branch.taper.0', 'Taper', 0, 1, 0.01],
  ['branch.twist.0', 'Twist', -0.5, 0.5, 0.01],
  ['branch.sections.0', 'Sections', 3, 20, 1, true],
  ['branch.segments.0', 'Segments', 3, 16, 1, true],
];
const levelParams = (l) => [
  [`branch.children.${l - 1}`, 'Count', 0, 120, 1, true],
  [`branch.angle.${l}`, 'Angle °', 0, 150, 0.5],
  [`branch.length.${l}`, 'Length', 0, 60, 0.25],
  [`branch.radius.${l}`, 'Radius', 0.05, 1.5, 0.01],
  [`branch.start.${l}`, 'Start', 0, 1, 0.01],
  [`branch.droop.${l}`, 'Droop', -1, 3.5, 0.01],
  [`branch.gnarliness.${l}`, 'Gnarliness', 0, 0.5, 0.005],
  [`branch.taper.${l}`, 'Taper', 0, 1, 0.01],
];
const LEAVES = [
  ['leaves.count', 'Per twig', 0, 30, 1, true],
  ['leaves.size', 'Size', 0.3, 10, 0.05],
  ['leaves.sizeVariance', 'Size variance', 0, 1, 0.01],
  ['leaves.start', 'Start', 0, 1, 0.01],
  ['leaves.angle', 'Angle °', 0, 90, 0.5],
];

const DEFAULTS = new TreeOptions();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Renders the design panel into `root`.
 * @param {HTMLElement} root
 * @param {{
 *   def: object, base: object, variant: number, level: number,
 *   edit: (mutate: (override: object) => void, final: boolean) => void,
 *   setLevel: (l: number) => void, save: () => void, revert: () => void, reset: () => void,
 *   dirty: boolean, hasOverride: boolean,
 * }} ctx
 */
export function renderDesign(root, ctx) {
  const { def, base, edit } = ctx;
  const setIn = (o, keys, value) => {
    let node = o;
    keys.slice(0, -1).forEach((k) => { node = node[k] = node[k] && typeof node[k] === 'object' ? node[k] : {}; });
    node[keys.at(-1)] = value;
  };

  const row = ([path, label, min, max, step, int]) => {
    const varied = def.vary?.[path];
    const baseValue = base.vary?.[path] ?? getPath(base.options, path) ?? getPath(DEFAULTS, path);
    const value = varied ?? getPath(def.options, path) ?? getPath(DEFAULTS, path);
    const current = varied ? varied.slice(0, 2) : value;
    const changed = !same(varied ? varied.slice(0, 2) : value, Array.isArray(baseValue) ? baseValue.slice(0, 2) : baseValue);
    const lo = Math.min(min, ...(varied ? varied.slice(0, 2) : [value ?? min]));
    const hi = Math.max(max, ...(varied ? varied.slice(0, 2) : [value ?? max]));
    const val = h('span.val');
    const show = (v) => { val.textContent = Array.isArray(v) ? `${fmt(v[0], step)}–${fmt(v[1], step)}` : fmt(v, step); };
    show(current ?? 0);
    const control = varied
      ? dualSlider({
        min: lo, max: hi, step, value: current,
        onInput: (range, final) => {
          show(range);
          edit((o) => setIn(o, ['vary', path], int ? [...range, 'int'] : range), final);
        },
      })
      : slider({
        min: lo, max: hi, step, value: value ?? 0,
        onInput: (v, final) => {
          show(v);
          edit((o) => setIn(o, ['options', ...path.split('.')], v), final);
        },
      });
    const vary = h(`button.vary-btn${varied ? '.on' : ''}`, {
      title: varied ? 'Varies per variant: click to fix' : 'Fixed: click to vary per variant',
      on: {
        click: () => edit((o) => {
          if (varied) {
            const mid = (varied[0] + varied[1]) / 2;
            setIn(o, ['vary', path], null);
            setIn(o, ['options', ...path.split('.')], int ? Math.round(mid) : mid);
          } else {
            const v = value ?? 0;
            const spread = Math.max(Math.abs(v) * 0.15, step * 4);
            const range = [Math.max(min, v - spread), Math.min(max, v + spread)].map((x) => (int ? Math.round(x) : +x.toFixed(4)));
            setIn(o, ['vary', path], int ? [...range, 'int'] : range);
          }
        }, true),
      },
    }, '~');
    return h(`div.prow${changed ? '.changed' : ''}`, { title: path }, h('label', label), control, val, vary);
  };

  root.replaceChildren();
  const actions = h('div.btn-row',
    h('button.btn.accent.grow', { disabled: !ctx.dirty, on: { click: ctx.save }, title: 'Write src/lib/species/overrides/<id>.json (Ctrl+S)' }, ctx.dirty ? 'Save override' : 'Saved'),
    h('button.btn.ghost', { disabled: !ctx.dirty, on: { click: ctx.revert }, title: 'Discard unsaved edits' }, 'Revert'),
    h('button.btn.warn', { disabled: !ctx.hasOverride, on: { click: ctx.reset }, title: 'Back to the species def (removes the override)' }, 'Reset'),
  );
  root.append(section('Override', `overrides/${def.id}.json`, actions,
    h('p.note', 'Edits regenerate live. Saved overrides feed both this preview and every export (studio and batch).')));

  // Size + variant seed
  const [hLo, hHi] = def.height;
  const heightVal = h('span.val', `${fmt(hLo, 0.1)}–${fmt(hHi, 0.1)}`);
  const nudge = def.seedNudge?.[ctx.variant] ?? 0;
  const nn = String(ctx.variant + 1).padStart(2, '0');
  const setNudge = (n) => edit((o) => {
    o.seedNudge = { ...(o.seedNudge ?? {}) };
    if (n) o.seedNudge[ctx.variant] = n; else delete o.seedNudge[ctx.variant];
    if (!Object.keys(o.seedNudge).length) delete o.seedNudge;
  }, true);
  root.append(section('Size & seed', `${def.name} ${nn}`,
    h(`div.prow${same(def.height, base.height) ? '' : '.changed'}`, h('label', 'Height m'),
      dualSlider({
        min: 1, max: 40, step: 0.5, value: def.height,
        onInput: (r, final) => { heightVal.textContent = `${fmt(r[0], 0.1)}–${fmt(r[1], 0.1)}`; edit((o) => { o.height = r; }, final); },
      }), heightVal, h('span')),
    h(`div.prow${nudge ? '.changed' : ''}`, h('label', `Seed ${nn}`),
      segmented([{ value: -1, label: '−', title: 'Previous seed ([)' }, { value: 0, label: 'base' }, { value: 1, label: '+', title: 'Next seed (])' }], null,
        (d) => setNudge(d ? nudge + d : 0), { full: true }),
      h('span.val', nudge ? `${nudge > 0 ? '+' : ''}${nudge}` : '0'), h('span')),
  ));

  root.append(section('Form', 'whole tree', ...FORM.map(row)));
  root.append(section('Trunk', null, ...TRUNK.map(row)));

  const levels = def.options.branch?.levels ?? 3;
  const level = Math.min(Math.max(1, ctx.level), Math.max(1, levels));
  const levelSeg = segmented([0, 1, 2, 3].map((l) => ({ value: l, label: String(l), title: `${l} recursion levels` })), levels,
    (l) => edit((o) => { o.options = o.options ?? {}; o.options.branch = { ...(o.options.branch ?? {}), levels: l }; }, true));
  const pick = segmented([1, 2, 3].filter((l) => l <= Math.max(1, levels)).map((l) => ({ value: l, label: `L${l}` })), level,
    (l) => ctx.setLevel(l), { accent: true });
  root.append(section('Branches', null,
    h('div.prow', h('label', 'Levels'), levelSeg, h('span'), h('span')),
    levels ? h('div.prow', h('label', 'Edit level'), pick, h('span'), h('span')) : null,
    ...(levels ? levelParams(level).map(row) : [])));

  const colors = def.leaves.paint.colors ?? [];
  const leafColor = (i) => colorSwatch(hslToHex(colors[i]), (v, final) => edit((o) => {
    const next = colors.map((c) => [...c]);
    next[i] = hexToHsl(v);
    o.leaves = { ...(o.leaves ?? {}), paint: { ...(o.leaves?.paint ?? {}), colors: next } };
  }, final));
  root.append(section('Leaves', def.leaves.paint.shape,
    ...LEAVES.map(row),
    colors.length ? h('div.color-row', h('label', 'Leaf colours'), h('span.swatches', ...colors.map((_, i) => leafColor(i)))) : null,
    h('div.color-row', h('label', 'Leaf tint'), colorSwatch(hex(def.leaves.tint ?? 0xffffff),
      (v, final) => edit((o) => { o.leaves = { ...(o.leaves ?? {}), tint: unhex(v) }; }, final))),
  ));
  root.append(section('Bark', def.bark.texture,
    h('div.color-row', h('label', 'Bark tint'), colorSwatch(hex(def.bark.tint ?? 0xffffff),
      (v, final) => edit((o) => { o.bark = { ...(o.bark ?? {}), tint: unhex(v) }; }, final))),
  ));
}
