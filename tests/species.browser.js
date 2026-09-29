// Visual check page. ?species=<id> renders that species' ten variants at
// LOD0, variant ?chain=<n>'s LOD chain (using the baked species atlas),
// the atlas and the painted leaf set. ?roster=1 renders LOD0 of every
// variant of every species, one row per species.
import * as THREE from 'three';
import {
  SPECIES, bakeSpeciesAtlas, buildSpecies, buildVariant, leafTextures,
} from '../src/lib/index.js';

const params = new URLSearchParams(location.search);
const result = document.querySelector('#result');
const W = Number(params.get('w') ?? 1600);
const H = Number(params.get('h') ?? 900);

const canvas = document.querySelector('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setSize(W, H);
renderer.setClearColor(0xa9c3d6, 1);

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x6a5a48, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-30, 60, 80);
  scene.add(sun);
}

/** Lays objects out left to right on y = 0; returns the frustum to fit. */
function row(scene, items, y0, gap) {
  let x = 0, top = 0;
  const placed = [];
  for (const { object, bounds } of items) {
    const w = Math.max(bounds.max.x - bounds.min.x, 1);
    object.position.set(x - bounds.min.x, y0, 0);
    scene.add(object);
    placed.push(object);
    x += w + gap;
    top = Math.max(top, bounds.max.y);
  }
  return { width: x - gap, top };
}

function renderRows(rows, label) {
  // rows: [{ items, label }]; each row gets its own band of the canvas.
  renderer.setScissorTest(true);
  const band = H / rows.length;
  rows.forEach((r, i) => {
    const scene = new THREE.Scene();
    lights(scene);
    const gap = r.gap ?? 1.5;
    const { width, top } = row(scene, r.items, 0, gap);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(width + 40, 60), new THREE.MeshStandardMaterial({ color: 0x6f6a55 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(width / 2, 0, 0);
    scene.add(ground);
    const aspect = W / band;
    let halfH = top * 0.56, halfW = halfH * aspect;
    if (halfW < width * 0.52) { halfW = width * 0.52; halfH = halfW / aspect; }
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 1000);
    const cy = halfH - top * 0.04;
    cam.position.set(width / 2, cy + 20 * Math.tan(0.12), 200);
    cam.lookAt(width / 2, cy, 0);
    const y = H - (i + 1) * band;
    renderer.setViewport(0, y, W, band);
    renderer.setScissor(0, y, W, band);
    renderer.render(scene, cam);
  });
  renderer.setScissorTest(false);
}

function preview(image, maxWidth, title) {
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
  c.style.width = `${Math.min(maxWidth, image.width)}px`;
  c.title = title;
  document.querySelector('#aux').appendChild(c);
}

const texturesFor = (species) => {
  const leaf = leafTextures({ ...species.leaves.paint, seed: 7 });
  return { leaf, textures: { leaves: { map: leaf.map, normalMap: leaf.normalMap } } };
};

const assert = (value, message) => { if (!value) throw new Error(message); };
const pow2 = (n) => (n & (n - 1)) === 0;

function checkAtlas(atlas, variants, species) {
  assert(pow2(atlas.width) && pow2(atlas.height), 'atlas is power-of-two');
  const { data, width, height } = atlas.albedo;
  let black = 0, partial = 0, covered = 0;
  for (let i = 0; i < width * height; i++) {
    const a = data[i * 4 + 3];
    if (a !== 0 && a !== 255) partial++;
    if (a) covered++;
    else if (data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] === 0) black++;
  }
  assert(partial === 0, `atlas alpha is binary (${partial} partial texels)`);
  assert(black === 0, `colour bled into every transparent texel (${black} black)`);
  assert(covered > 0.05 * width * height, 'atlas has content');
  const n = atlas.normal.data;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3]) assert(n[i * 4 + 2] >= 127, 'impostor normals face the viewer');
  }
  const cells = atlas.cells.flat();
  cells.forEach((c, i) => cells.slice(i + 1).forEach((d) => assert(
    c.x + c.width <= d.x || d.x + d.width <= c.x || c.y + c.height <= d.y || d.y + d.height <= c.y, 'cells overlap')));
  variants.forEach((v, k) => {
    const tris = v.impostor.geometry.index.count / 3;
    assert(tris === (species.impostor === 'card' ? 2 : 4), `impostor triangles ${tris}`);
    const uv = v.impostor.geometry.attributes.uv;
    atlas.cells[k].forEach((c, view) => {
      for (let q = 0; q < 4; q++) {
        const x = uv.getX(view * 4 + q) * width, y = (1 - uv.getY(view * 4 + q)) * height;
        assert(x >= c.x && x <= c.x + c.width && y >= c.y && y <= c.y + c.height, `variant ${k} view ${view} UV outside its cell`);
      }
    });
  });
}

function checkLeaf(image) {
  const { data, width, height } = image;
  let covered = 0, black = 0;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] >= 128) covered++;
    else if (data[i * 4 + 3] === 0 && data[i * 4] + data[i * 4 + 1] + data[i * 4 + 2] === 0) black++;
  }
  const f = covered / (width * height);
  assert(f > 0.08 && f < 0.85, `leaf coverage ${f.toFixed(2)}`);
  assert(black === 0, 'leaf colour bled under transparency');
}

const lodLevelObject = (variant, i) => {
  const group = variant.lod.levels[i].object.clone();
  return { object: group, bounds: variant.bounds };
};

try {
  const t0 = performance.now();
  if (params.get('leaves')) {
    canvas.style.display = 'none';
    for (const species of Object.values(SPECIES)) {
      const { leaf } = texturesFor(species);
      preview(leaf.albedo, 300, species.id);
    }
    document.querySelector('#aux').style.flexWrap = 'wrap';
  } else if (params.get('roster')) {
    const rows = Object.values(SPECIES).map((species) => {
      const { textures } = texturesFor(species);
      const variants = buildSpecies(species.id, { textures, lods: [1] });
      return { items: variants.map((v) => ({ object: v.lod.levels[0].object, bounds: v.bounds })), gap: species.height[1] * 0.12 };
    });
    renderRows(rows);
  } else {
    const id = params.get('species') ?? 'field_oak';
    const species = SPECIES[id];
    const { leaf, textures } = texturesFor(species);
    const variants = buildSpecies(id, { textures });
    const atlas = bakeSpeciesAtlas(variants, renderer);
    const chain = variants[Number(params.get('chain') ?? 0)];
    renderRows([
      { items: variants.map((v) => ({ object: v.lod.levels[0].object, bounds: v.bounds })), gap: species.height[1] * 0.1 },
      { items: chain.levels.map((_, i) => lodLevelObject(chain, i)), gap: species.height[1] * 0.15 },
    ]);
    checkAtlas(atlas, variants, species);
    checkLeaf(leaf.albedo);
    preview(atlas.albedo, 900, 'atlas albedo');
    preview(atlas.normal, 450, 'atlas normal');
    preview(leaf.albedo, 256, 'leaf albedo');
    preview(leaf.normal, 256, 'leaf normal');
    result.textContent = `${id}: tris ${variants.map((v) => v.tris.join('/')).join('  ')}\n` +
      `heights ${variants.map((v) => v.height.toFixed(1)).join(' ')}  atlas ${atlas.width}x${atlas.height} ${atlas.texelsPerUnit.toFixed(1)} px/m`;
  }
  result.textContent = `PASS ${(performance.now() - t0).toFixed(0)}ms ` + result.textContent.replace('RUNNING', '');
} catch (error) {
  result.textContent = `FAIL: ${error.stack}`;
  console.error(error);
}
