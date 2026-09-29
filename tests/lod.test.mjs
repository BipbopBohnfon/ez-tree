import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tree, TreePreset } from '../build/ez-tree.es.js';

const triangles = (p) => (p.branches.index.count + p.leaves.index.count) / 3;
const dispose = (p) => { p.branches.dispose(); p.leaves.dispose(); };

test('default distances include LOD3 and LOD4', () => {
  assert.deepEqual(Tree.defaultLODLevels.map((l) => l.distance), [0, 100, 250, 400, 700]);
});

for (const preset of Object.keys(TreePreset)) {
  test(`${preset}: LOD3 budget, valid indices, reproducibility and unchanged full detail`, () => {
    for (const seed of [1, 42, 65535]) {
      const tree = new Tree();
      tree.loadPreset(preset);
      tree.options.seed = seed;
      tree.generate();
      const before = tree.createGeometry();
      const lod = tree.createGeometry(Tree.defaultLODLevels[3].detail);
      assert.ok(triangles(lod) >= 800 && triangles(lod) <= 2000, `${triangles(lod)} triangles`);
      const again = tree.createGeometry(Tree.defaultLODLevels[3].detail);
      const after = tree.createGeometry();
      for (const key of ['branches', 'leaves']) {
        const g = lod[key];
        assert.ok([...g.attributes.position.array].every(Number.isFinite));
        assert.ok([...g.index.array].every((i) => i < g.attributes.position.count));
        assert.deepEqual(g.attributes.position.array, again[key].attributes.position.array);
        assert.deepEqual(before[key].attributes.position.array, after[key].attributes.position.array);
        assert.deepEqual(before[key].index.array, after[key].index.array);
      }
      [before, lod, again, after].forEach(dispose);
    }
  });
}

test('budget validation and bare trees', () => {
  const tree = new Tree();
  tree.generate();
  tree.skeleton.leaves = [];
  for (const budget of [NaN, Infinity, -1, 0]) {
    assert.throws(() => tree.createGeometry({ triangleBudget: budget }), RangeError);
  }
  const p = tree.createGeometry({ triangleBudget: 1400 });
  assert.ok(triangles(p) <= 1400);
  assert.equal(p.leaves.index.count, 0);
  dispose(p);
});
