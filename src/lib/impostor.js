import * as THREE from 'three';

let baker;

/** Impostor geometry modes. */
export const ImpostorMode = {
  /** Two crossed static quads (front + side views), 4 triangles. */
  Cross: 'cross',
  /** One quad, pivot at the trunk base, meant to be Y-billboarded, 2 triangles. */
  Card: 'card',
};

/** Union bounding box of the non-empty geometries. */
export function geometryBounds(geometries) {
  const bounds = new THREE.Box3();
  for (const geometry of geometries) {
    if (!geometry?.attributes.position.count) continue;
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox);
  }
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  return bounds;
}

/**
 * The orthographic views an impostor needs, in the geometry's own space.
 * Each view carries the quad it maps onto: `center`, `right` and `up` unit
 * vectors, `width`/`height` extents and the camera direction (`toward`).
 * @param {THREE.Box3} bounds
 * @param {string} mode ImpostorMode
 */
export function impostorViews(bounds, mode = ImpostorMode.Cross) {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3()).multiplyScalar(1.04);
  size.max(new THREE.Vector3(0.01, 0.01, 0.01));
  if (mode === ImpostorMode.Card) {
    // A Y-billboard spins about the trunk axis, so the card is centred on
    // x = z = 0 and wide enough for the widest horizontal reach. Its base
    // sits at the bounds' bottom (the ground for pivot-at-base trees).
    const reach = 1.04 * Math.max(
      Math.abs(bounds.min.x), Math.abs(bounds.max.x),
      Math.abs(bounds.min.z), Math.abs(bounds.max.z), 0.005);
    const height = size.y;
    return [{
      center: new THREE.Vector3(0, bounds.min.y + height / 2, 0),
      right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
      toward: new THREE.Vector3(0, 0, 1), width: reach * 2, height,
    }];
  }
  return [
    {
      center, right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
      toward: new THREE.Vector3(0, 0, 1), width: size.x, height: size.y,
    },
    {
      center, right: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0),
      toward: new THREE.Vector3(1, 0, 0), width: size.z, height: size.y,
    },
  ];
}

/**
 * Quad geometry for the given views. rects[i] = [u0, v0, u1, v1] is the
 * atlas region of view i (defaults: views side by side across [0,1]).
 * Needs no renderer, so headless exporters can emit it and fill the atlas
 * later with setImpostorRects().
 */
export function impostorGeometry(views, rects = defaultRects(views.length)) {
  const positions = [];
  const normals = [];
  const indices = [];
  views.forEach((view, i) => {
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const p = view.center.clone()
        .addScaledVector(view.right, x * view.width)
        .addScaledVector(view.up, y * view.height);
      positions.push(p.x, p.y, p.z);
      normals.push(view.toward.x, view.toward.y, view.toward.z);
    }
    const k = i * 4;
    indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(views.length * 8).fill(0), 2));
  geometry.setIndex(indices);
  setImpostorRects(geometry, rects);
  geometry.computeBoundingSphere();
  geometry.userData.impostorViews = views.length;
  return geometry;
}

/** Rewrites an impostor geometry's UVs so view i samples rects[i]. */
export function setImpostorRects(geometry, rects) {
  const uv = geometry.attributes.uv;
  rects.forEach(([u0, v0, u1, v1], i) => {
    const k = i * 4;
    uv.setXY(k, u0, v0);
    uv.setXY(k + 1, u1, v0);
    uv.setXY(k + 2, u1, v1);
    uv.setXY(k + 3, u0, v1);
  });
  uv.needsUpdate = true;
}

function defaultRects(count) {
  return Array.from({ length: count }, (_, i) => [i / count, 0, (i + 1) / count, 1]);
}

/**
 * Fills the colour of every uncovered texel (mask 0) from its covered
 * neighbourhood with a push-pull pyramid, so bilinear filtering and mipmaps
 * never blend in black. Covered texels and all alpha values are untouched.
 * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels, modified in place
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} [mask] 1 = covered; defaults to alpha > 0
 * @param {number} [channels=3] Colour channels to fill (3 = RGB, 4 = RGBA)
 */
export function bleedColor(data, width, height, mask, channels = 3) {
  if (!mask) {
    mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
  }
  const levels = [];
  let w = width, h = height;
  let color = new Float32Array(w * h * 4);
  let weight = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    weight[i] = 1;
    for (let c = 0; c < channels; c++) color[i * 4 + c] = data[i * 4 + c];
  }
  levels.push({ w, h, color, weight });
  while (w > 1 || h > 1) {
    const nw = Math.max(1, Math.ceil(w / 2)), nh = Math.max(1, Math.ceil(h / 2));
    const ncolor = new Float32Array(nw * nh * 4);
    const nweight = new Float32Array(nw * nh);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!weight[i]) continue;
      const j = (y >> 1) * nw + (x >> 1);
      nweight[j] += weight[i];
      for (let c = 0; c < channels; c++) ncolor[j * 4 + c] += color[i * 4 + c] * weight[i];
    }
    for (let j = 0; j < nw * nh; j++) {
      if (!nweight[j]) continue;
      for (let c = 0; c < channels; c++) ncolor[j * 4 + c] /= nweight[j];
      nweight[j] = 1;
    }
    w = nw; h = nh; color = ncolor; weight = nweight;
    levels.push({ w, h, color, weight });
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const level = levels[l], parent = levels[l + 1];
    for (let y = 0; y < level.h; y++) for (let x = 0; x < level.w; x++) {
      const i = y * level.w + x;
      if (level.weight[i]) continue;
      const j = (y >> 1) * parent.w + (x >> 1);
      for (let c = 0; c < channels; c++) level.color[i * 4 + c] = parent.color[j * 4 + c];
      level.weight[i] = parent.weight[j] ? 1 : 0;
    }
  }
  const base = levels[0];
  for (let i = 0; i < width * height; i++) {
    if (mask[i] || !base.weight[i]) continue;
    for (let c = 0; c < channels; c++) data[i * 4 + c] = base.color[i * 4 + c];
  }
  return data;
}

const normalVertex = /* glsl */`
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;
const normalFragment = /* glsl */`
  uniform sampler2D map;
  uniform bool hasMap;
  uniform float cutoff;
  uniform float roughness;
  uniform bool faceForward;
  varying vec3 vNormal;
  varying vec2 vUv;
  void main() {
    if (hasMap && texture2D(map, vUv).a < cutoff) discard;
    vec3 n = normalize(vNormal);
    if (faceForward) n.z = abs(n.z);
    gl_FragColor = vec4(n * 0.5 + 0.5, roughness);
  }`;

/**
 * Renders views of a set of meshes into RGBA pixel buffers: albedo+alpha
 * (sRGB, unlit, cut-out alpha is exactly 0 or 255; colour bled into
 * uncovered texels) and, optionally, a view-space normal (OpenGL, RGB) +
 * roughness (A) companion, flat and fully rough where uncovered. Renderer state is restored.
 * @param {{geometry: THREE.BufferGeometry, material: THREE.Material, roughness?: number, faceForward?: boolean}[]} parts
 * @param {object[]} views from impostorViews()
 * @param {{width: number, height: number}[]} sizes pixel size per view
 * @param {THREE.WebGLRenderer} renderer
 * @param {{normals?: boolean}} [options]
 * @returns {{albedo: Uint8ClampedArray, normal?: Uint8ClampedArray, width: number, height: number}[]}
 */
export function renderViews(parts, views, sizes, renderer, { normals = false } = {}) {
  const flatMaterials = parts.map(({ material }) => new THREE.MeshBasicMaterial({
    color: material.color, map: material.map?.image ? material.map : null,
    alphaTest: material.alphaTest, side: THREE.DoubleSide, toneMapped: false,
  }));
  const normalMaterials = parts.map(({ material, roughness = 1, faceForward = true }) => new THREE.ShaderMaterial({
    uniforms: {
      map: { value: material.map?.image ? material.map : null },
      hasMap: { value: Boolean(material.map?.image) },
      cutoff: { value: material.alphaTest || 0.5 },
      roughness: { value: roughness },
      faceForward: { value: faceForward },
    },
    vertexShader: normalVertex, fragmentShader: normalFragment, side: THREE.DoubleSide,
  }));
  const meshes = parts.map(({ geometry }, i) => new THREE.Mesh(geometry, flatMaterials[i]));
  const scene = new THREE.Scene();
  meshes.forEach((mesh) => scene.add(mesh));
  const saved = {
    target: renderer.getRenderTarget(),
    face: renderer.getActiveCubeFace(), mip: renderer.getActiveMipmapLevel(),
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    viewport: renderer.getViewport(new THREE.Vector4()),
    scissor: renderer.getScissor(new THREE.Vector4()), scissorTest: renderer.getScissorTest(),
    autoClear: renderer.autoClear, xr: renderer.xr.enabled,
  };
  const out = [];
  try {
    renderer.xr.enabled = false;
    renderer.autoClear = true;
    renderer.setScissorTest(false);
    const depth = parts.reduce((d, { geometry }) => {
      geometry.computeBoundingSphere();
      return Math.max(d, geometry.boundingSphere.center.length() + geometry.boundingSphere.radius);
    }, 1);
    views.forEach((view, v) => {
      const { width, height } = sizes[v];
      const camera = new THREE.OrthographicCamera(
        -view.width / 2, view.width / 2, view.height / 2, -view.height / 2, 0.01, depth * 4);
      camera.position.copy(view.center).addScaledVector(view.toward, depth * 2);
      camera.up.copy(view.up);
      camera.lookAt(view.center);
      const read = (colorSpace, clear, materials) => {
        const target = new THREE.WebGLRenderTarget(width, height);
        target.texture.colorSpace = colorSpace;
        meshes.forEach((mesh, i) => { mesh.material = materials[i]; });
        renderer.setClearColor(clear[0], clear[1]);
        renderer.setRenderTarget(target);
        renderer.setViewport(0, 0, width, height);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
        target.dispose();
        // Flip rows: GL reads bottom-up, images are top-down.
        const image = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          image.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
        }
        return image;
      };
      const albedo = read(THREE.SRGBColorSpace, [0x000000, 0], flatMaterials);
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) {
        mask[i] = albedo[i * 4 + 3] > 0 ? 1 : 0;
        albedo[i * 4 + 3] = mask[i] ? 255 : 0;
      }
      bleedColor(albedo, width, height, mask, 3);
      const result = { albedo, width, height };
      if (normals) {
        const normal = read(THREE.NoColorSpace, [0x8080ff, 1], normalMaterials);
        for (let i = 0; i < mask.length; i++) {
          if (!mask[i]) { normal[i * 4] = 128; normal[i * 4 + 1] = 128; normal[i * 4 + 2] = 255; normal[i * 4 + 3] = 255; }
        }
        // Uncovered texels stay flat-up and fully rough: bleeding averaged
        // canopy normals there only adds shading noise at cut-out edges.
        result.normal = normal;
      }
      out.push(result);
    });
  } finally {
    renderer.setRenderTarget(saved.target, saved.face, saved.mip);
    renderer.setViewport(saved.viewport);
    renderer.setScissor(saved.scissor);
    renderer.setScissorTest(saved.scissorTest);
    renderer.setClearColor(saved.clear, saved.alpha);
    renderer.autoClear = saved.autoClear;
    renderer.xr.enabled = saved.xr;
    flatMaterials.forEach((m) => m.dispose());
    normalMaterials.forEach((m) => m.dispose());
  }
  return out;
}

export function createCanvas(width, height) {
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('No canvas implementation available');
}

export function defaultRenderer() {
  baker ??= new THREE.WebGLRenderer({ alpha: true, antialias: false });
  return baker;
}

/** Bake orthogonal views into a portable RGBA atlas; no runtime shader required. */
export function bakeImpostor(source, bark, leaf, renderer, mode = ImpostorMode.Cross) {
  renderer ??= defaultRenderer();
  const bounds = geometryBounds([source.branches, source.leaves]);
  const views = impostorViews(bounds, mode);
  const resolution = 512;
  const images = renderViews(
    [{ geometry: source.branches, material: bark }, { geometry: source.leaves, material: leaf }],
    views, views.map(() => ({ width: resolution, height: resolution })), renderer);
  const canvas = createCanvas(resolution * views.length, resolution);
  const context = canvas.getContext('2d');
  images.forEach((image, view) => {
    context.putImageData(new ImageData(image.albedo, resolution, resolution), view * resolution, 0);
  });
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const leavesMaterial = new THREE.MeshBasicMaterial({
    name: 'TreeImpostor', map, alphaTest: 0.1, side: THREE.DoubleSide,
    toneMapped: false,
  });
  const leaves = impostorGeometry(views);
  leaves.addEventListener('dispose', () => { map.dispose(); leavesMaterial.dispose(); });
  const branches = new THREE.BufferGeometry();
  branches.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
  branches.setIndex([]);
  return { branches, leaves, leavesMaterial };
}

/**
 * Packs rectangles (pixel sizes) into a width x height sheet with a shelf
 * packer after scaling them all by the largest common factor that fits.
 * @param {{width: number, height: number}[]} sizes natural sizes (any unit)
 * @returns {{scale: number, cells: {x: number, y: number, width: number, height: number}[]}}
 */
export function packCells(sizes, width, height, padding = 4) {
  const order = sizes.map((_, i) => i).sort((a, b) => sizes[b].height - sizes[a].height || a - b);
  const attempt = (scale) => {
    const cells = new Array(sizes.length);
    let x = padding, y = padding, shelf = 0;
    for (const i of order) {
      const w = Math.max(4, Math.floor(sizes[i].width * scale));
      const h = Math.max(4, Math.floor(sizes[i].height * scale));
      if (x + w + padding > width) { x = padding; y += shelf + padding; shelf = 0; }
      if (w + 2 * padding > width || y + h + padding > height) return null;
      cells[i] = { x, y, width: w, height: h };
      x += w + padding;
      shelf = Math.max(shelf, h);
    }
    return cells;
  };
  let lo = 0, hi = Math.max(width, height) / Math.min(...sizes.map((s) => Math.min(s.width, s.height)));
  let best = attempt(lo);
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const cells = attempt(mid);
    if (cells) { lo = mid; best = cells; } else hi = mid;
  }
  return { scale: lo, cells: best };
}

/**
 * Uploadable texture from a top-down RGBA image ({data, width, height}).
 * Rows are flipped so v = 1 is the image's top row, matching canvas
 * textures and the UV rects bakeAtlas() writes.
 */
export function imageTexture(image, colorSpace = THREE.SRGBColorSpace, { cutoff } = {}) {
  const { data, width, height } = image;
  const flipped = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    flipped.set(data.subarray(y * width * 4, (y + 1) * width * 4), (height - 1 - y) * width * 4);
  }
  const texture = new THREE.DataTexture(flipped, width, height, THREE.RGBAFormat);
  texture.colorSpace = colorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  if (cutoff !== undefined) {
    texture.mipmaps = coverageMips({ data: flipped, width, height }, cutoff);
    texture.generateMipmaps = false;
  }
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Box-filtered mip chain whose alpha is rescaled per level so the fraction
 * of texels passing an alpha-scissor `cutoff` matches level 0. Without it,
 * thin leaves and needles fade below the cutoff within a few mips and
 * foliage vanishes at distance.
 * @returns {{data: Uint8Array, width: number, height: number}[]}
 */
export function coverageMips(image, cutoff = 0.5) {
  const threshold = cutoff * 255;
  const coverage = (d) => {
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] >= threshold) n++;
    return n / (d.length / 4);
  };
  const target = coverage(image.data);
  const levels = [image];
  let { data, width, height } = image;
  while (width > 1 || height > 1) {
    const w = Math.max(1, width >> 1), h = Math.max(1, height >> 1);
    const next = new Uint8Array(w * h * 4);
    const alpha = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0, 0];
      let n = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const sx = Math.min(width - 1, 2 * x + dx), sy = Math.min(height - 1, 2 * y + dy);
        const i = (sy * width + sx) * 4;
        for (let c = 0; c < 4; c++) sum[c] += data[i + c];
        n++;
      }
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) next[o + c] = sum[c] / n;
      alpha[y * w + x] = sum[3] / n;
    }
    // Binary search the alpha scale that restores level-0 coverage.
    let lo = 0.5, hi = 8;
    for (let k = 0; k < 16; k++) {
      const mid = (lo + hi) / 2;
      let n = 0;
      for (let i = 0; i < alpha.length; i++) if (alpha[i] * mid >= threshold) n++;
      if (n / alpha.length < target) lo = mid; else hi = mid;
    }
    for (let i = 0; i < alpha.length; i++) next[i * 4 + 3] = Math.min(255, alpha[i] * hi);
    levels.push({ data: next, width: w, height: h });
    data = next; width = w; height = h;
  }
  return levels;
}

/** Copies a top-down RGBA image into a larger one at (x, y). */
function blit(target, source, x, y) {
  for (let row = 0; row < source.height; row++) {
    target.data.set(
      source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4),
      ((y + row) * target.width + x) * 4);
  }
}

/**
 * Bakes every variant's impostor views of one species into a single atlas
 * and rewrites each variant's impostor geometry UVs into its own cells.
 * Cells share one texel density, so a shorter variant gets a smaller cell.
 *
 * Returns raw, unpremultiplied top-down RGBA images: `albedo` (sRGB colour
 * bled into every transparent texel, alpha exactly 0/255) and `normal`
 * (view-space OpenGL normal RGB + roughness A). Keep them as raw bytes when
 * encoding; a 2D canvas premultiplies and would lose the bled colour.
 * @param {{parts: {geometry: THREE.BufferGeometry, material: THREE.Material, roughness?: number}[], views: object[], impostor: THREE.BufferGeometry}[]} entries
 * @param {THREE.WebGLRenderer} renderer
 * @param {{width?: number, height?: number, padding?: number, normals?: boolean}} [options]
 * @returns {{albedo: {data: Uint8ClampedArray, width: number, height: number}, normal?: {data: Uint8ClampedArray, width: number, height: number}, width: number, height: number, cells: object[][], texelsPerUnit: number}}
 */
export function bakeAtlas(entries, renderer, { width = 2048, height = 2048, padding = 4, normals = true } = {}) {
  renderer ??= defaultRenderer();
  const flat = [];
  entries.forEach((entry, e) => entry.views.forEach((view, v) => flat.push({ e, v, view })));
  const { scale, cells } = packCells(flat.map(({ view }) => ({ width: view.width, height: view.height })), width, height, padding);
  const albedo = { data: new Uint8ClampedArray(width * height * 4), width, height };
  const normal = normals ? { data: new Uint8ClampedArray(width * height * 4), width, height } : undefined;
  const mask = new Uint8Array(width * height);
  const perEntry = entries.map(() => []);
  entries.forEach((entry, e) => {
    const mine = flat.map((f, i) => ({ ...f, cell: cells[i] })).filter((f) => f.e === e);
    const images = renderViews(entry.parts, mine.map((f) => f.view),
      mine.map((f) => ({ width: f.cell.width, height: f.cell.height })), renderer, { normals });
    mine.forEach((f, k) => {
      const { cell } = f;
      blit(albedo, { data: images[k].albedo, width: cell.width, height: cell.height }, cell.x, cell.y);
      if (normals) blit(normal, { data: images[k].normal, width: cell.width, height: cell.height }, cell.x, cell.y);
      for (let y = 0; y < cell.height; y++) for (let x = 0; x < cell.width; x++) {
        if (images[k].albedo[(y * cell.width + x) * 4 + 3]) mask[(cell.y + y) * width + cell.x + x] = 1;
      }
      perEntry[e][f.v] = cell;
    });
    // Half-texel inset keeps bilinear taps inside the cell.
    setImpostorRects(entry.impostor, perEntry[e].map((c) => [
      (c.x + 0.5) / width, 1 - (c.y + c.height - 0.5) / height,
      (c.x + c.width - 0.5) / width, 1 - (c.y + 0.5) / height,
    ]));
  });
  // Re-bleed the whole sheet so gutters and mip levels stay clean too.
  bleedColor(albedo.data, width, height, mask, 3);
  if (normal) {
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) continue;
      normal.data.set([128, 128, 255, 255], i * 4);
    }
  }
  return { albedo, normal, width, height, cells: perEntry, texelsPerUnit: scale };
}
