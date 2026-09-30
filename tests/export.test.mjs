import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildVariant, getSpecies } from '../build/ez-tree.es.js';
import { checkCatalog, emptyCatalog, formatCatalog, mergeCatalog } from '../src/studio/export/catalog.js';
import { decodePNG, encodePNG } from '../src/studio/export/png.js';
import { encodeGLB, parseGLB, variantGLB } from '../src/studio/export/glb.js';
import { applyExport, resolveTargets } from '../scripts/game-endpoint.mjs';

const record = (id, files, extra = {}) => ({
  id, name: id.replace(/(^|_)(\w)/g, (_, s, c) => `${s ? ' ' : ''}${c.toUpperCase()}`),
  biomes: ['forest'], lods: [30, 70, 150, 400, 1500], last_shadow_lod: 1, impostor: 'cross',
  sets: { bark: `${id}_bark`, leaves: `${id}_leaves`, impostor: `${id}_impostor` },
  wind: { bark: [0.001, 0.25], leaves: [0.001, 0.25], impostor: [0.001, 0.25] },
  variants: files.map((n) => ({ name: `${id} ${n}`, file: `${id}_${n}`, height: 10, tris: [5, 4, 3, 2, 4] })),
  ...extra,
});
const slots = (catalog) => catalog.species.flatMap((s) => s.variants.map((v) => [v.file, v.slot]));

test('mergeCatalog: new species append from first_slot 36, in order', () => {
  let c = mergeCatalog(null, record('oak', ['01', '02']));
  assert.deepEqual(slots(c), [['oak_01', 36], ['oak_02', 37]]);
  c = mergeCatalog(c, record('pine', ['01']));
  assert.deepEqual(slots(c), [['oak_01', 36], ['oak_02', 37], ['pine_01', 38]]);
  assert.deepEqual(Object.keys(c), ['version', 'first_slot', 'species']);
  assert.equal(c.first_slot, 36);
  assert.deepEqual(mergeCatalog({}, record('oak', ['01'])).species[0].variants[0].slot, 36);
});

test('mergeCatalog: re-export keeps slots; new variants append after every slot', () => {
  let c = mergeCatalog(null, record('oak', ['01', '02']));
  c = mergeCatalog(c, record('pine', ['01']));
  const again = mergeCatalog(c, record('oak', ['02', '01'], { lods: [40], last_shadow_lod: 0, sets: { bark: 'oak_bark', leaves: 'oak_leaves' }, wind: {} ,
    variants: [{ name: 'oak 02', file: 'oak_02', height: 12, tris: [9] }, { name: 'oak 01', file: 'oak_01', height: 11, tris: [8] }] }));
  assert.deepEqual(slots(again), [['oak_01', 36], ['oak_02', 37], ['pine_01', 38]]);
  assert.equal(again.species[0].variants[0].height, 11, 'fields update');
  assert.deepEqual(again.species[0].lods, [40]);
  const grown = mergeCatalog(c, record('oak', ['01', '02', '03']));
  assert.deepEqual(slots(grown), [['oak_01', 36], ['oak_02', 37], ['oak_03', 39], ['pine_01', 38]]);
  checkCatalog(grown);
  // Inputs are untouched.
  assert.equal(c.species[0].variants.length, 2);
});

test('mergeCatalog: refuses anything that would move, drop or duplicate a slot', () => {
  const c = mergeCatalog(mergeCatalog(null, record('oak', ['01', '02'])), record('pine', ['01']));
  assert.throws(() => mergeCatalog(c, record('oak', ['01'])), /missing from the export/);
  const moved = record('oak', ['01', '02']);
  moved.variants[1].slot = 40;
  assert.throws(() => mergeCatalog(c, moved), /asks for slot 40/);
  const pinned = record('oak', ['01', '02']);
  pinned.variants[0].slot = 36;
  assert.equal(mergeCatalog(c, pinned).species[0].variants[0].slot, 36, 'naming the held slot is fine');
  assert.throws(() => mergeCatalog(c, { ...record('elm', ['01']), variants: [{ name: 'x', file: 'pine_01', height: 1, tris: [1, 1, 1, 1, 1] }] }), /belongs to species pine/);
  assert.throws(() => mergeCatalog(c, record('elm', ['01', '01'])), /repeated/);
  assert.throws(() => mergeCatalog(c, { ...record('elm', ['01']), name: 'Oak' }), /name 'Oak'/);
  assert.throws(() => mergeCatalog(c, { ...record('elm', ['01']), sets: { bark: 'oak_bark', leaves: 'elm_leaves', impostor: 'elm_impostor' } }), /set 'oak_bark'/);
  assert.throws(() => mergeCatalog({ ...c, first_slot: 35 }, record('elm', ['01'])), /first_slot/);
  const gap = structuredClone(c);
  gap.species[1].variants[0].slot = 39;
  assert.throws(() => mergeCatalog(gap, record('elm', ['01'])), /contiguous/);
  assert.throws(() => mergeCatalog(c, { ...record('elm', ['01']), lods: [30, 70], sets: { bark: 'b', leaves: 'l', impostor: 'i' } }), /sets are not bark, leaves$/);
});

test('formatCatalog: stable, parses back to the same catalog', () => {
  const c = mergeCatalog(mergeCatalog(null, record('oak', ['01', '02'])), record('pine', ['01']));
  const text = formatCatalog(c);
  assert.deepEqual(JSON.parse(text), c);
  assert.equal(formatCatalog(JSON.parse(text)), text);
  assert.match(text, /\n {8}\{"slot": 36, "name": "oak 01", "file": "oak_01", "height": 10, "tris": \[5, 4, 3, 2, 4\]\}/);
  assert.deepEqual(JSON.parse(formatCatalog(emptyCatalog())), emptyCatalog());
});

test('PNG: encode/decode round trip keeps straight alpha bytes', async () => {
  const width = 37, height = 23;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 131 + (i >> 7) * 17) & 255;
  // Colour under zero alpha must survive (a canvas would zero it).
  data.set([200, 120, 40, 0], 0);
  const png = await encodePNG({ data, width, height });
  assert.deepEqual([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  const back = await decodePNG(png);
  assert.equal(back.width, width);
  assert.equal(back.height, height);
  assert.deepEqual(back.data, data);
  const flat = await encodePNG({ data: new Uint8ClampedArray(64 * 64 * 4).fill(7), width: 64, height: 64 });
  assert.ok(flat.length < 300, `flat image compresses (${flat.length} B)`);
  await assert.rejects(encodePNG({ data: new Uint8Array(3), width: 1, height: 1 }), /width\*height\*4/);
});

test('GLB: variant structure — root, LOD nodes, set-named materials, no images', () => {
  const variant = buildVariant('field_oak', 2);
  try {
    const { json, bin } = parseGLB(variantGLB(variant));
    const lods = getSpecies('field_oak').lods.length;
    assert.equal(json.asset.version, '2.0');
    assert.deepEqual(json.scenes[json.scene].nodes, [0]);
    assert.equal(json.nodes[0].name, 'field_oak_03');
    assert.equal(json.nodes[0].children.length, lods);
    json.nodes[0].children.forEach((child, i) => {
      const node = json.nodes[child];
      assert.equal(node.name, `field_oak_03LOD${i}`);
      assert.equal(node.translation ?? node.matrix ?? node.rotation ?? node.scale, undefined, 'identity transforms');
      const mesh = json.meshes[node.mesh];
      const names = mesh.primitives.map((p) => json.materials[p.material].name);
      assert.deepEqual(names, i === 4 ? ['field_oak_impostor'] : ['field_oak_bark', 'field_oak_leaves']);
      let tris = 0;
      for (const p of mesh.primitives) {
        assert.deepEqual(Object.keys(p.attributes).sort(), ['NORMAL', 'POSITION', 'TEXCOORD_0']);
        tris += json.accessors[p.indices].count / 3;
      }
      assert.equal(tris, variant.tris[i], `LOD${i} triangles`);
    });
    assert.deepEqual(json.materials.map((m) => m.name).sort(), ['field_oak_bark', 'field_oak_impostor', 'field_oak_leaves']);
    for (const key of ['images', 'textures', 'samplers']) assert.equal(json[key], undefined, `no ${key}`);
    assert.ok(json.materials.every((m) => !JSON.stringify(m).includes('Texture')), 'placeholder materials');
    // Metres, pivot at the trunk base: LOD0 spans the ground to the variant height.
    const pos = json.accessors[json.meshes[json.nodes[1].mesh].primitives[0].attributes.POSITION];
    assert.ok(Math.abs(pos.min[1]) < 0.5, `trunk base at y=0 (${pos.min[1]})`);
    const top = Math.max(...json.meshes[json.nodes[1].mesh].primitives.map((p) => json.accessors[p.attributes.POSITION].max[1]));
    assert.ok(Math.abs(top - variant.height) < 1e-3, 'top at variant height');
    assert.equal(json.buffers[0].byteLength, bin.length);
    for (const v of json.bufferViews) assert.equal(v.byteOffset % 4, 0);
  } finally {
    variant.dispose();
  }
});

test('GLB: one LOD when lods has one entry; UV v flipped to glTF', () => {
  const variant = buildVariant('mesquite', 0, { lods: [60] });
  try {
    const { json, bin } = parseGLB(variantGLB(variant));
    assert.deepEqual(json.nodes.map((n) => n.name), ['mesquite_01', 'mesquite_01LOD0']);
    const p = json.meshes[0].primitives[1];
    const acc = json.accessors[p.attributes.TEXCOORD_0];
    const view = json.bufferViews[acc.bufferView];
    const uvs = new Float32Array(bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + view.byteLength));
    const src = variant.levels[0].leaves.attributes.uv;
    assert.ok(Math.abs(uvs[1] - (1 - src.getY(0))) < 1e-6);
  } finally {
    variant.dispose();
  }
  assert.throws(() => encodeGLB({ name: 'x', lods: [{ primitives: [] }] }), /no triangles/);
});

test('game endpoint: path rules, server-side merge, keep files, atomic catalog', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trees-'));
  try {
    const species = record('oak', ['01']);
    const ok = (p) => resolveTargets(root, species, [{ path: p }]);
    assert.equal(ok('oak_01.glb')[0], path.join(root, 'oak_01.glb'));
    ok('textures/oak_bark_albedo_alpha.png');
    ok('textures/oak_impostor_normal_roughness.png.import');
    for (const bad of ['../oak_01.glb', 'textures/../../x.png', 'pine_01.glb', 'oak_01.gltf', '/etc/passwd',
      'textures/elm_bark_albedo_alpha.png', 'textures/sub/oak_bark_albedo_alpha.png', 'catalog.json']) {
      assert.throws(() => ok(bad), /refused path/, bad);
    }
    const b64 = (s) => Buffer.from(s).toString('base64');
    const files = [
      { path: 'oak_01.glb', base64: b64('glb') },
      { path: 'textures/oak_bark_albedo_alpha.png.import', base64: b64('first'), keep: true },
    ];
    const reply = await applyExport(root, { species, files });
    assert.equal(reply.species.variants[0].slot, 36);
    assert.deepEqual(reply.written, ['oak_01.glb', 'textures/oak_bark_albedo_alpha.png.import', 'catalog.json']);
    files[1].base64 = b64('second');
    const again = await applyExport(root, { species, files });
    assert.deepEqual(again.kept, ['textures/oak_bark_albedo_alpha.png.import']);
    assert.equal(await readFile(path.join(root, 'textures/oak_bark_albedo_alpha.png.import'), 'utf8'), 'first');
    // A refused merge writes nothing.
    await writeFile(path.join(root, 'oak_01.glb'), 'old');
    await assert.rejects(applyExport(root, { species: record('oak', ['02']), files: [{ path: 'oak_02.glb', base64: b64('x') }] }), /missing from the export/);
    assert.equal(existsSync(path.join(root, 'oak_02.glb')), false);
    const catalog = JSON.parse(await readFile(path.join(root, 'catalog.json'), 'utf8'));
    assert.deepEqual(slots(catalog), [['oak_01', 36]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
