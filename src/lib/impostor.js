import * as THREE from 'three';

let baker;

/** Bake orthogonal views into a portable RGBA atlas; no runtime shader required. */
export function bakeImpostor(source, bark, leaf, renderer) {
  if (!renderer) {
    baker ??= new THREE.WebGLRenderer({ alpha: true, antialias: false });
    renderer = baker;
  }
  const bounds = new THREE.Box3();
  for (const geometry of [source.branches, source.leaves]) {
    if (!geometry.attributes.position.count) continue;
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
  }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).multiplyScalar(1.04);
  size.max(new THREE.Vector3(0.01, 0.01, 0.01));

  // Basic materials preserve source tint/alpha without baking scene lighting
  // or the animated leaf shader into a permanent texture.
  const flat = (material) => new THREE.MeshBasicMaterial({
    color: material.color, map: material.map?.image ? material.map : null,
    alphaTest: material.alphaTest, side: THREE.DoubleSide,
    toneMapped: false,
  });
  const materials = [flat(bark), flat(leaf)];
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(source.branches, materials[0]), new THREE.Mesh(source.leaves, materials[1]));
  const resolution = 512;
  const target = new THREE.WebGLRenderTarget(resolution, resolution);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const canvas = document.createElement('canvas');
  canvas.width = resolution * 2;
  canvas.height = resolution;
  const context = canvas.getContext('2d');
  const pixels = new Uint8Array(resolution * resolution * 4);
  const saved = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear, xr: renderer.xr.enabled,
  };
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setClearColor(0, 0);
    for (let view = 0; view < 2; view++) {
      const width = view === 0 ? size.x : size.z;
      const depth = Math.max(size.x, size.z, size.y);
      const camera = new THREE.OrthographicCamera(-width / 2, width / 2, size.y / 2, -size.y / 2, 0.01, depth * 4);
      camera.position.copy(center).add(view === 0 ? new THREE.Vector3(0, 0, depth * 2) : new THREE.Vector3(depth * 2, 0, 0));
      camera.lookAt(center);
      renderer.setRenderTarget(target);
      renderer.setViewport(0, 0, resolution, resolution);
      renderer.setScissorTest(false);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, 0, 0, resolution, resolution, pixels);
      const image = context.createImageData(resolution, resolution);
      for (let y = 0; y < resolution; y++) {
        image.data.set(pixels.subarray(y * resolution * 4, (y + 1) * resolution * 4), (resolution - 1 - y) * resolution * 4);
      }
      context.putImageData(image, view * resolution, 0);
    }
  } finally {
    renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    renderer.setViewport(saved.viewport);
    renderer.setScissor(saved.scissor);
    renderer.setScissorTest(saved.scissorTest);
    renderer.setClearColor(saved.clear, saved.alpha);
    renderer.autoClear = saved.autoClear;
    renderer.xr.enabled = saved.xr;
    target.dispose();
    materials.forEach((material) => material.dispose());
  }

  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const leavesMaterial = new THREE.MeshBasicMaterial({
    name: 'TreeImpostor', map, alphaTest: 0.1, side: THREE.DoubleSide,
    toneMapped: false,
  });
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let view = 0; view < 2; view++) {
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      positions.push(center.x + (view === 0 ? x * size.x : 0), center.y + y * size.y, center.z + (view === 1 ? -x * size.z : 0));
      uvs.push((view + x + 0.5) / 2, y + 0.5);
    }
    const i = view * 4;
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  const leaves = new THREE.BufferGeometry();
  leaves.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  leaves.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  leaves.setIndex(indices);
  leaves.computeVertexNormals();
  leaves.computeBoundingSphere();
  leaves.addEventListener('dispose', () => { map.dispose(); leavesMaterial.dispose(); });
  const branches = new THREE.BufferGeometry();
  branches.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  branches.setIndex([]);
  return { branches, leaves, leavesMaterial };
}
