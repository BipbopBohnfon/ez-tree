import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Tree } from '../src/lib/tree.js';

const assert = (value, message) => { if (!value) throw new Error(message); };
const count = (root) => {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3; });
  return n;
};
try {
  const renderer = new THREE.WebGLRenderer({ alpha: true });
  renderer.setSize(256, 256);
  document.body.appendChild(renderer.domElement);
  renderer.setClearColor(0x123456, 0.25);
  renderer.setViewport(1, 2, 200, 201);
  renderer.setScissor(3, 4, 100, 101);
  renderer.setScissorTest(true);
  const tree = new Tree();
  tree.loadPreset('Ash Medium');
  // Synthetic alpha-cutout fixture: bundled images may be Git LFS pointers.
  const leafCanvas = document.createElement('canvas');
  leafCanvas.width = leafCanvas.height = 64;
  const leafContext = leafCanvas.getContext('2d');
  leafContext.fillStyle = '#477c32';
  leafContext.beginPath(); leafContext.ellipse(32, 32, 18, 30, 0, 0, Math.PI * 2); leafContext.fill();
  const leafMap = new THREE.CanvasTexture(leafCanvas);
  leafMap.colorSpace = THREE.SRGBColorSpace;
  tree.options.leaves.map = leafMap;
  tree.options.bark.tint = 0x65513e;
  tree.generate();
  const detail = Tree.defaultLODLevels[4].detail;
  const product = tree.createGeometry(detail, renderer);
  assert(product.leaves.index.count / 3 === 4, 'impostor must have 4 triangles');
  assert(renderer.getClearColor(new THREE.Color()).getHex() === 0x123456, 'clear color restored');
  assert(renderer.getClearAlpha() === 0.25, 'clear alpha restored');
  assert(renderer.getViewport(new THREE.Vector4()).equals(new THREE.Vector4(1, 2, 200, 201)), 'viewport restored');
  assert(renderer.getScissorTest(), 'scissor test restored');
  const canvas = product.leavesMaterial.map.image;
  const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  for (const view of [0, 1]) {
    let opaque = 0, clear = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = view * 512; x < (view + 1) * 512; x++) {
      const alpha = pixels[(y * canvas.width + x) * 4 + 3];
      if (alpha) opaque++; else clear++;
    }
    assert(opaque > 1000 && clear > 1000, `view ${view} has a tree silhouette and transparent background`);
  }
  const mesh = new THREE.Mesh(product.leaves, product.leavesMaterial);
  const glb = await new GLTFExporter().parseAsync(mesh, { binary: true });
  const parsed = await new GLTFLoader().parseAsync(glb, '');
  assert(count(parsed.scene) === 4, 'GLB round trip triangle count');
  const exported = parsed.scene.children[0];
  assert(exported.material.map && exported.material.alphaTest > 0 && exported.material.side === THREE.DoubleSide, 'GLB preserves atlas and cutout');
  let mapDisposed = false, materialDisposed = false;
  product.leavesMaterial.map.addEventListener('dispose', () => { mapDisposed = true; });
  product.leavesMaterial.addEventListener('dispose', () => { materialDisposed = true; });
  product.leaves.dispose(); product.branches.dispose();
  assert(mapDisposed && materialDisposed, 'owned resources disposed');
  tree.generateLODs(undefined, renderer);
  assert(tree.lod.levels.length === 5 && count(tree.lod.levels[4].object) === 4, 'automatic LODs include impostor');
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 0, 1000); camera.updateMatrixWorld();
  tree.updateMatrixWorld(); tree.lod.update(camera);
  assert(tree.lod.levels[4].object.visible && !tree.lod.levels[0].object.visible, 'distant LOD selected');
  let cleaned = false;
  tree.lod.levels[4].object.children[1].material.map.addEventListener('dispose', () => { cleaned = true; });
  tree.generate();
  assert(cleaned && !tree.lod, 'regeneration cleans impostor');
  const full = count(tree);
  for (const [i, level] of Tree.defaultLODLevels.entries()) {
    const p = tree.createGeometry(level.detail, renderer);
    const group = new THREE.Group();
    if (p.branches.attributes.position.count) group.add(new THREE.Mesh(p.branches, tree.branchesMesh.material));
    if (p.leaves.attributes.position.count) group.add(new THREE.Mesh(p.leaves, p.leavesMaterial ?? tree.leavesMesh.material));
    const binary = await new GLTFExporter().parseAsync(group, { binary: true });
    const loaded = await new GLTFLoader().parseAsync(binary, '');
    assert(count(loaded.scene) === count(group), `LOD${i} GLB preserves triangle count`);
    p.branches.dispose(); p.leaves.dispose();
  }
  tree.applyDetail(detail, renderer);
  assert(count(tree) === 4, 'preview uses impostor');
  tree.applyDetail({});
  assert(count(tree) === full && tree.leavesMesh.material.isMeshStandardMaterial, 'preview restores full detail and leaf material');
  tree.generateLODs([{ distance: 0, detail }], renderer);
  assert(count(tree) === 4, 'impostor-only custom LOD does not leave full meshes visible');
  tree.applyDetail({});
  assert(!tree.lod && count(tree) === full, 'applyDetail tears down automatic LOD');
  renderer.setScissorTest(false);
  renderer.setSize(740, 370);
  renderer.setClearColor(0x9bb9d0, 1);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x777777, 3));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(-20, 50, 70); scene.add(sun);
  tree.position.x = -65; scene.add(tree);
  for (const [offset, spec] of [[0, Tree.defaultLODLevels[3].detail], [65, detail]]) {
    const p = tree.createGeometry(spec, renderer);
    const group = new THREE.Group();
    group.add(new THREE.Mesh(p.branches, tree.branchesMesh.material), new THREE.Mesh(p.leaves, p.leavesMaterial ?? tree.leavesMesh.material));
    group.position.x = offset; scene.add(group);
  }
  const reviewCamera = new THREE.OrthographicCamera(-110, 110, 100, -10, 0.1, 500);
  reviewCamera.position.set(0, 0, 200); reviewCamera.lookAt(0, 0, 0);
  renderer.render(scene, reviewCamera);
  canvas.style.width = '650px'; canvas.style.background = '#9bb9d0';
  document.body.appendChild(canvas);
  document.querySelector('#result').textContent = 'PASS: bake, renderer state, atlas alpha, 4-triangle GLB round trip, LOD selection, cleanup, preview restoration';
} catch (error) {
  document.querySelector('#result').textContent = `FAIL: ${error.stack}`;
  console.error(error);
}
