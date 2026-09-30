// Tree Studio headless run: node tests/studio-shots.mjs <outDir> [shot ...]
// Starts the studio dev server on a free port (5201+), opens it in headless
// Chromium and captures the named shots (default: all). The game root MUST be
// a scratch folder: DEINTERLEAVER_GAME_ROOT is required and the run refuses a
// path holding project.godot. `export` exports one species there and checks
// the override round trip (preview LOD0 == exported GLB LOD0).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { openBrowser } from './run-browser.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [outDir = 'studio-shots', ...wanted] = process.argv.slice(2);
const game = process.env.DEINTERLEAVER_GAME_ROOT;
if (!game || existsSync(path.join(game, 'project.godot'))) {
  console.error('Set DEINTERLEAVER_GAME_ROOT to a scratch folder (not a Godot project).');
  process.exit(2);
}
const trees = path.join(game, 'assets/art/terrain/trees');
mkdirSync(trees, { recursive: true });
if (!existsSync(path.join(trees, 'catalog.json'))) {
  writeFileSync(path.join(trees, 'catalog.json'), '{"version":1,"first_slot":36,"species":[]}\n');
}
mkdirSync(outDir, { recursive: true });
const want = (name) => !wanted.length || wanted.includes(name);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await createServer({ configFile: path.join(repo, 'vite.studio.config.js'), server: { port: 5201, strictPort: false }, logLevel: 'warn' });
await server.listen();
const url = `http://localhost:${server.httpServer.address().port}/`;
console.log(`studio ${url} -> ${trees}`);
const errors = [];
const page = await openBrowser(url, { width: 1600, height: 960, onError: (t) => { errors.push(t); console.error('page:', t); } });
let failed = false;
const check = (ok, message) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`); if (!ok) failed = true; };
const settle = async (ms = 600) => {
  await page.waitFor('window.studio && window.studio.idle', 180);
  await sleep(ms);
};
const shot = async (name) => { await page.screenshot(path.join(outDir, `${name}.png`)); console.log(`shot ${name}`); };
const js = (expr) => page.evaluate(expr);

try {
  check(await page.waitFor('window.studio && window.studio.shown() && window.studio.idle', 180), 'studio boots and builds');
  await page.waitFor('window.studio.thumbsReady()', 180);
  await settle(1500);

  if (want('default')) await shot('01-default');

  if (want('lod4')) {
    // Card species (Norway Spruce) and cross species (Field Oak) pinned at LOD4.
    await js("studio.selectSpecies('norway_spruce', 'forest'); studio.selectTab('lod')");
    await page.waitFor('window.studio.thumbsReady()', 180);
    await settle();
    await js('studio.setLodMode(4)');
    await settle(800);
    await shot('02-lod4-card-norway-spruce');
    await js("studio.selectSpecies('field_oak', 'meadow')");
    await settle();
    await js('studio.setLodMode(4)');
    await settle(800);
    await shot('03-lod4-cross-field-oak');
    await js("studio.setLodMode('auto')");
  }

  if (want('flyout')) {
    await js("studio.selectSpecies('beech', 'forest'); studio.selectTab('lod')");
    await settle();
    await js('studio.flyOut()');
    await sleep(4500);
    await shot('04-auto-flyout-mid');
    await page.waitFor('!studio.vp.flying', 60);
    await js('studio.setDistance(520)');
    await sleep(800);
    await shot('05-auto-flown-out');
    await js('studio.vp.frame()');
  }

  if (want('forest')) {
    await js("studio.selectSpecies('silver_birch', 'meadow'); studio.selectTab('lod')");
    await page.waitFor('window.studio.thumbsReady()', 180);
    await js('studio.setForest(true)');
    await settle(2500);
    await shot('06-forest');
    await js('studio.setForest(false)');
    await settle();
  }

  if (want('design')) {
    await js("studio.selectSpecies('umbrella_acacia', 'dry_grass'); studio.selectTab('design')");
    await settle();
    await js(`studio.edit((o) => {
      o.vary = { 'form.crownFlatten': [0.3, 0.8], 'branch.angle.1': [40, 60] };
      o.options = { form: { stemSpread: 32 } };
      o.leaves = { tint: 0xd8e8a0 };
    })`);
    await settle(800);
    await page.waitFor('window.studio.thumbsReady()', 120);
    await settle(500);
    await shot('07-design-edited');
  }

  if (want('inspect')) {
    await js("studio.selectSpecies('field_oak', 'meadow'); studio.selectTab('inspect')");
    await settle(1000);
    await shot('08-inspector');
  }

  if (want('export')) {
    // Round trip: edit + save an override, export into the scratch root,
    // compare the GLB's LOD0 with the preview.
    await js("studio.selectSpecies('olive', 'scrub'); studio.selectTab('design')");
    await settle();
    await js(`studio.edit((o) => { o.height = [6, 9]; o.options = { branch: { children: { 0: 5 } } }; o.seedNudge = { 0: 3 }; })`);
    await settle();
    await js('studio.save()');
    const preview = await js(`(() => {
      const v = studio.shown().variants[0];
      const verts = v.levels[0].branches.attributes.position.count + v.levels[0].leaves.attributes.position.count;
      return { file: v.file, height: v.height, verts, tris: v.tris };
    })()`);
    const saved = JSON.parse(readFileSync(path.join(repo, 'src/lib/species/overrides/olive.json'), 'utf8'));
    check(saved.height?.[0] === 6 && saved.seedNudge?.['0'] === 3, 'override saved to src/lib/species/overrides/olive.json');
    await js("studio.exportOne('olive')");
    await page.waitFor("document.querySelector('#modal').classList.contains('on') || document.querySelector('#export-label')?.textContent.startsWith('done')", 30);
    await js("document.querySelector('#modal').classList.contains('on') && document.querySelector('#modal-ok').click()");
    check(await page.waitFor("document.querySelector('#export-label')?.textContent.startsWith('done')", 600), 'export finished');
    await settle(800);
    await shot('09-export-log');
    const glbPath = path.join(trees, `${preview.file}.glb`);
    check(existsSync(glbPath), `GLB written: ${glbPath}`);
    const { parseGLB } = await import('../src/studio/export/glb.js');
    const glb = parseGLB(new Uint8Array(readFileSync(glbPath)));
    const nodes = glb.json.nodes;
    const lod0 = nodes.find((n) => n.name === `${preview.file}LOD0`);
    const meshNodes = (lod0?.children ?? []).map((i) => nodes[i]).filter((n) => n.mesh !== undefined);
    let verts = 0, maxY = 0;
    for (const n of [lod0, ...meshNodes]) {
      if (n?.mesh === undefined) continue;
      for (const prim of glb.json.meshes[n.mesh].primitives) {
        const acc = glb.json.accessors[prim.attributes.POSITION];
        verts += acc.count;
        maxY = Math.max(maxY, acc.max[1]);
      }
    }
    console.log(`preview LOD0 verts ${preview.verts} height ${preview.height.toFixed(3)} | GLB LOD0 verts ${verts} height ${maxY.toFixed(3)}`);
    check(verts === preview.verts, 'round trip: exported LOD0 vertex count equals preview');
    check(Math.abs(maxY - preview.height) < 1e-3, 'round trip: exported LOD0 height equals preview');
    const catalog = JSON.parse(readFileSync(path.join(trees, 'catalog.json'), 'utf8'));
    const record = catalog.species.find((s) => s.id === 'olive');
    check(record && record.variants[0].slot === 36 && Math.abs(record.variants[0].height - preview.height) < 0.01, 'catalog record: slot 36, height matches preview');
    check(JSON.stringify(record?.variants[0].tris) === JSON.stringify(preview.tris), 'catalog tris equal preview tris');
    // Leave the olive override out of the repo.
    if (!process.env.KEEP_OVERRIDE) rmSync(path.join(repo, 'src/lib/species/overrides/olive.json'), { force: true });
  }

  if (want('perf')) {
    await js("studio.selectSpecies('field_oak', 'meadow')");
    await settle(1000);
    const frames0 = await js('studio.vp.frames');
    await sleep(3000);
    const frames1 = await js('studio.vp.frames');
    console.log(`fps (swiftshader, software GL): ${((frames1 - frames0) / 3).toFixed(1)}`);
  }
} finally {
  await page.close();
  await server.close();
}
const real = errors.filter((e) => !/favicon|GPU stall|WebGL/.test(e));
check(!real.length, `no page errors (${real.length})`);
process.exit(failed ? 1 : 0);
