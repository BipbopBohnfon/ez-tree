// Headless batch export (npm run export:all): batch.html?species=all or
// ?species=field_oak,beech. Exports each species through exportSpecies() and
// writeToGame(), one after another. #result reads RUNNING until done, then
// PASS or FAIL (the driver's exit status).
import * as THREE from 'three';
import { SPECIES_IDS, exportSpecies, writeToGame } from './export/index.js';
import { effectiveSpecies, fingerprint, loadOverrides } from './overrides.js';

const result = document.querySelector('#result');
const log = document.querySelector('#log');
const say = (line) => { console.log(line); log.textContent += `${line}\n`; };

const params = new URLSearchParams(location.search);
const asked = (params.get('species') ?? 'all').split(',').map((s) => s.trim()).filter(Boolean);
const ids = asked.includes('all') ? SPECIES_IDS : asked;
const lods = params.get('lods') ? params.get('lods').split(',').map(Number) : undefined;
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: false });

// Studio overrides (src/lib/species/overrides/*.json) apply here exactly as
// in the studio preview.
const overrides = await loadOverrides().catch(() => ({}));
const failures = [];
const summary = [];
for (const id of ids) {
  const t0 = performance.now();
  try {
    const species = effectiveSpecies(id, overrides);
    if (overrides[id]) say(`  ${id}: studio override applied`);
    const exported = await exportSpecies(id, { renderer, lods, species, onProgress: (p) => say(`  ${p.stage}: ${p.message}`) });
    const bytes = (re) => exported.files.filter((f) => re.test(f.path)).reduce((n, f) => n + f.bytes.length, 0);
    const reply = await writeToGame(exported);
    const slots = reply.species.variants.map((v) => v.slot);
    if (!lods) {
      await fetch('/__studio/stamps', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, fingerprint: fingerprint(species) }) }).catch(() => {});
    }
    const line = `${id}: slots ${slots[0]}..${slots.at(-1)}  glb ${(bytes(/\.glb$/) / 1e6).toFixed(2)} MB  png ${(bytes(/\.png$/) / 1e6).toFixed(2)} MB  ` +
      `atlas ${exported.texelsPerUnit.toFixed(1)} px/m  (${reply.written.length} written, ${reply.patched.length} patched, ${reply.kept.length} kept) ${((performance.now() - t0) / 1000).toFixed(1)}s`;
    summary.push(line);
    say(line);
  } catch (error) {
    failures.push(`${id}: ${error.message}`);
    say(`FAIL ${id}: ${error.stack}`);
  }
}
renderer.dispose();
result.textContent = failures.length
  ? `FAIL ${failures.length}/${ids.length}\n${failures.join('\n')}`
  : `PASS ${ids.length} species\n${summary.join('\n')}`;
