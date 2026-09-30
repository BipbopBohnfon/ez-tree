import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildVariant, getSpecies } from '../build/ez-tree.es.js';
import { applyOverride, fingerprint, mergePatch, patchAt } from '../src/studio/overrides.js';
import { overridePath, readOverrides, writeOverride } from '../scripts/studio-endpoint.mjs';

const verts = (v) => v.levels[0].branches.attributes.position.count + v.levels[0].leaves.attributes.position.count;

test('mergePatch: objects merge, arrays replace, null deletes', () => {
  const base = { a: { b: 1, c: [1, 2] }, vary: { 'x.y': [0, 1], 'z': [2, 3] } };
  const out = mergePatch(base, { a: { c: [9] }, vary: { 'x.y': null, 'w': [4, 5] } });
  assert.deepEqual(out, { a: { b: 1, c: [9] }, vary: { 'z': [2, 3], 'w': [4, 5] } });
  assert.deepEqual(base.vary['x.y'], [0, 1], 'input untouched');
  assert.deepEqual(patchAt('branch.length.0', 3), { branch: { length: { 0: 3 } } });
});

test('applyOverride keeps identity and changes the build', () => {
  const base = getSpecies('olive');
  const species = applyOverride(base, { id: 'hacked', name: 'X', height: [6, 9], seedNudge: { 0: 3 } });
  assert.equal(species.id, 'olive');
  assert.equal(species.name, base.name);
  assert.notEqual(fingerprint(species), fingerprint(base));
  assert.equal(fingerprint(applyOverride(base, {})), fingerprint(base));
  const plain = buildVariant('olive', 0);
  const tuned = buildVariant('olive', 0, { species });
  assert.ok(tuned.height >= 6 && tuned.height <= 9, `override height ${tuned.height}`);
  assert.notEqual(tuned.options.seed, plain.options.seed, 'seed nudge applies');
  const again = buildVariant('olive', 0, { species });
  assert.equal(verts(again), verts(tuned), 'deterministic');
  [plain, tuned, again].forEach((v) => v.dispose());
});

test('override endpoint: path-safe ids, write, read, remove', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-overrides-'));
  try {
    for (const bad of ['../x', 'a/b', 'A', '', 'x.json', '..']) assert.throws(() => overridePath(bad, dir), /refused/);
    await writeOverride('field_oak', { height: [11, 12] }, dir);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'field_oak.json'), 'utf8')), { height: [11, 12] });
    assert.deepEqual(await readOverrides(dir), { field_oak: { height: [11, 12] } });
    await assert.rejects(writeOverride('field_oak', [1, 2], dir), /object/);
    await writeOverride('field_oak', {}, dir);
    assert.equal(existsSync(path.join(dir, 'field_oak.json')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
