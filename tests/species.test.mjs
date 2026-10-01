import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GAME_LOD_TIERS, LOD0_TRIANGLE_CAP, SPECIES, Tree, VARIANT_COUNT, bleedColor, buildVariant,
  packCells, speciesWind, variantMeta, variantOptions,
} from '../build/ez-tree.es.js';

const ids = Object.keys(SPECIES);
const size = (b) => ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z });

test('roster: fourteen species with catalog fields', () => {
  assert.deepEqual(ids, ['field_oak', 'silver_birch', 'beech', 'norway_spruce', 'stone_pine',
    'weeping_willow', 'maritime_pine', 'umbrella_acacia', 'olive', 'mesquite', 'juniper', 'pinyon_pine', 'alder', 'bald_cypress']);
  for (const s of Object.values(SPECIES)) {
    assert.ok(s.lods.length >= 1 && s.lods.length <= 5, s.id);
    assert.ok(s.lods.every((d, i) => i === 0 || d > s.lods[i - 1]), `${s.id} lods ascend`);
    assert.ok(['cross', 'card'].includes(s.impostor));
    assert.ok(s.leaves.paint?.shape, `${s.id} leaf painter params`);
    const wind = speciesWind(s);
    assert.ok(wind.bark[0] > 0 && wind.leaves[1] > 0);
    assert.equal(variantMeta(s.id, 0).name, `${s.name} 01`);
    assert.equal(variantMeta(s.id, 9).file, `${s.id}_10`);
  }
});

for (const id of ids) {
  test(`${id}: ten variants in metres, LOD tiers, determinism, variety`, () => {
    const species = SPECIES[id];
    const built = [];
    for (let i = 0; i < VARIANT_COUNT; i++) {
      const v = buildVariant(id, i);
      const [lo, hi] = species.height;
      const meta = variantMeta(id, i);
      assert.ok(meta.height >= lo && meta.height <= hi, `${id} ${i} target ${meta.height}`);
      assert.ok(Math.abs(v.height - meta.height) < 1e-3 * meta.height, `${id} ${i} height ${v.height} != ${meta.height}`);
      // Splayed stems may sink their base ring a little into the soil.
      assert.ok(v.bounds.min.y >= -Math.max(0.03 * v.height, 0.3), `${id} ${i} below ground: ${v.bounds.min.y}`);
      // Trunk base at the origin: the lowest trunk ring is centred there.
      const pos = v.levels[0].branches.attributes.position;
      let cx = 0, cz = 0, n = 0;
      for (let k = 0; k < pos.count; k++) {
        if (Math.abs(pos.getY(k)) < 0.02 * v.height) { cx += pos.getX(k); cz += pos.getZ(k); n++; }
      }
      assert.ok(n > 0 && Math.hypot(cx / n, cz / n) < 0.05 * v.height, `${id} ${i} trunk base off origin`);

      const [t0, t1, t2, t3, t4] = v.tris;
      assert.equal(v.levels.length, species.lods.length);
      assert.ok(t0 <= LOD0_TRIANGLE_CAP, `${id} ${i} LOD0 ${t0}`);
      assert.ok(t1 / t0 > 0.3 && t1 / t0 < 0.5, `${id} ${i} LOD1 ${t1}/${t0}`);
      assert.ok(t2 / t0 > 0.1 && t2 / t0 < 0.2, `${id} ${i} LOD2 ${t2}/${t0}`);
      assert.ok(t3 <= 1200 && t3 < t2, `${id} ${i} LOD3 ${t3}`);
      assert.equal(t4, species.impostor === 'card' ? 2 : 4);
      for (const level of v.levels) {
        for (const g of [level.branches, level.leaves]) {
          assert.ok(g.attributes.position.array.every(Number.isFinite));
          assert.ok(g.index.array.every((k) => k < g.attributes.position.count));
        }
      }
      // THREE.LOD activation distances are the previous level's end.
      assert.deepEqual(v.lod.levels.map((l) => l.distance), [0, ...species.lods.slice(0, -1)]);
      assert.equal(v.levels[0].leaves.attributes.position.count > 0, true);
      assert.equal(v.materials.bark.name, `${id}_bark`);
      built.push(v);
    }
    // Determinism: same input, byte-identical geometry.
    for (const i of [0, 7]) {
      const again = buildVariant(id, i);
      for (const [a, b] of again.levels.map((l, k) => [l, built[i].levels[k]])) {
        assert.deepEqual(a.branches.attributes.position.array, b.branches.attributes.position.array);
        assert.deepEqual(a.leaves.attributes.position.array, b.leaves.attributes.position.array);
      }
      again.dispose();
    }
    // Variety: variants differ in form parameters, not only the seed...
    const keys = Object.keys(species.vary);
    const get = (o, path) => path.split('.').reduce((n, k) => n[k], o);
    const opts = built.map((_, i) => variantOptions(id, i));
    for (const key of keys) {
      const values = new Set(opts.map((o) => get(o, key)));
      const [lo, hi, kind] = species.vary[key];
      const want = kind === 'int' ? Math.min(3, Math.round(hi) - Math.round(lo) + 1) : VARIANT_COUNT;
      assert.ok(values.size >= want, `${id} ${key} takes ${values.size} values`);
    }
    // ...and in the result: every pair differs in proportions or complexity.
    for (let a = 0; a < built.length; a++) for (let b = a + 1; b < built.length; b++) {
      const sa = size(built[a].bounds), sb = size(built[b].bounds);
      const widthA = (sa.x + sa.z) / sa.y, widthB = (sb.x + sb.z) / sb.y;
      const differ = Math.abs(widthA - widthB) > 0.02 * widthA ||
        Math.abs(sa.y - sb.y) > 0.02 * sa.y || built[a].tris[0] !== built[b].tris[0];
      assert.ok(differ, `${id} variants ${a} and ${b} look alike`);
    }
    built.forEach((v) => v.dispose());
  });
}

test('lods length 1 yields a single full-detail level; custom distances pass through', () => {
  const one = buildVariant('field_oak', 3, { lods: [120] });
  assert.equal(one.levels.length, 1);
  assert.equal(one.lod.levels.length, 1);
  assert.equal(one.impostor, null);
  const full = buildVariant('field_oak', 3);
  assert.equal(one.tris[0], full.tris[0]);
  const three = buildVariant('field_oak', 3, { lods: [10, 20, 30] });
  assert.equal(three.levels.length, 3);
  assert.deepEqual(three.lod.levels.map((l) => l.distance), [0, 10, 20]);
  assert.throws(() => buildVariant('field_oak', 3, { lods: [] }), RangeError);
  assert.throws(() => buildVariant('field_oak', 10), RangeError);
  assert.throws(() => buildVariant('nope', 0), RangeError);
  [one, full, three].forEach((v) => v.dispose());
});

test('game tiers keep the upstream demo defaults intact', () => {
  assert.equal(GAME_LOD_TIERS.length, 5);
  assert.ok(GAME_LOD_TIERS[4].impostor);
  assert.deepEqual(Tree.defaultLODLevels.map((l) => l.distance), [0, 100, 250, 400, 700]);
});

test('form options: defaults are upstream-identical, each option changes growth', () => {
  const positions = (edit) => {
    const tree = new Tree();
    tree.loadPreset('Oak Medium');
    tree.options.seed = 5;
    edit?.(tree.options);
    tree.generate();
    const p = tree.createGeometry();
    return p.branches.attributes.position.array;
  };
  const base = positions();
  assert.deepEqual(positions((o) => {
    Object.assign(o.form, { lean: 0, bend: 0, windswept: 0, stems: 1, crownFlatten: 0, floor: null });
    o.branch.droop = { 0: 0, 1: 0, 2: 0, 3: 0 };
  }), base);
  const edits = {
    lean: (o) => { o.form.lean = 10; },
    bend: (o) => { o.form.bend = 20; },
    windswept: (o) => { o.form.windswept = 1; },
    stems: (o) => { o.form.stems = 3; },
    crownFlatten: (o) => { o.form.crownFlatten = 2; o.form.crownStart = 0.3; },
    droop: (o) => { o.branch.droop[2] = 1.5; },
    floor: (o) => { o.branch.droop[1] = 3; o.form.floor = 5; },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const changed = positions(edit);
    assert.notDeepEqual(changed, base, name);
    if (name === 'floor') {
      const tree = new Tree(); tree.loadPreset('Oak Medium'); tree.options.seed = 5; edit(tree.options);
      tree.generate();
      for (const b of tree.skeleton.branches) for (const s of b.sections.slice(1)) assert.ok(s.origin.y >= 5 - 1e-9);
    }
  }
  // Droop makes branches hang: mean tip height drops.
  const tips = (edit) => {
    const tree = new Tree(); tree.loadPreset('Oak Medium'); tree.options.seed = 5; edit?.(tree.options);
    tree.generate();
    const ends = tree.skeleton.branches.map((b) => b.sections.at(-1).origin.y);
    return ends.reduce((a, b) => a + b) / ends.length;
  };
  assert.ok(tips((o) => { o.branch.droop[2] = 2; o.branch.droop[3] = 2; }) < tips() - 1);
  // Several stems: several trunks start at the origin.
  const tree = new Tree(); tree.loadPreset('Oak Medium'); tree.options.form.stems = 4; tree.generate();
  const trunks = tree.skeleton.branches.filter((b) => b.sections[0].origin.lengthSq() === 0);
  assert.equal(trunks.length, 4);
});

test('packCells fits every cell without overlap; bleedColor fills transparent texels', () => {
  const sizes = Array.from({ length: 20 }, (_, i) => ({ width: 5 + (i % 4), height: 10 + (i % 3) * 2 }));
  const { cells, scale } = packCells(sizes, 2048, 1024, 4);
  assert.ok(scale > 0);
  cells.forEach((c, i) => {
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= 2048 && c.y + c.height <= 1024);
    for (const d of cells.slice(i + 1)) {
      assert.ok(c.x + c.width <= d.x || d.x + d.width <= c.x || c.y + c.height <= d.y || d.y + d.height <= c.y, 'overlap');
    }
  });
  const data = new Uint8ClampedArray(8 * 8 * 4);
  data.set([200, 100, 50, 255], (3 * 8 + 3) * 4);
  bleedColor(data, 8, 8);
  for (let i = 0; i < 64; i++) {
    assert.deepEqual([...data.subarray(i * 4, i * 4 + 3)], [200, 100, 50]);
    assert.equal(data[i * 4 + 3], i === 27 ? 255 : 0);
  }
});
