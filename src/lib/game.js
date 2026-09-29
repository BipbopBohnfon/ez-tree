import * as THREE from 'three';
import { Tree } from './tree';
import { Billboard } from './enums';
import {
  bakeAtlas, bakeImpostor, geometryBounds, imageTexture, impostorGeometry, impostorViews,
} from './impostor';
import { getSpecies, speciesSets, speciesWind, variantMeta, variantOptions, VARIANT_COUNT } from './species/index';

/** LOD0 triangle cap for the largest trees (spec: ≤ 16k). */
export const LOD0_TRIANGLE_CAP = 16000;

/**
 * Game LOD tiers (Deinterleaver spec). Distances come from the species'
 * `lods` array, not from here. `target` tiers are fitted to that fraction
 * of LOD0's triangles by thinning leaves (and twigs if needed); `budget`
 * tiers use the triangle-budget mesher. Tier 4 is always the impostor.
 */
export const GAME_LOD_TIERS = [
  { name: 'full', detail: {} },
  { name: 'reduced', target: 0.4, detail: { sectionStride: 2, segmentFactor: 0.6 } },
  { name: 'aggressive', target: 0.15, detail: { sectionStride: 4, segmentFactor: 0.4, billboard: Billboard.Single } },
  { name: 'budget', budget: 1200 },
  { name: 'impostor', impostor: true },
];

const triangles = (p) => (p.branches.index.count + p.leaves.index.count) / 3;

/**
 * Chooses leafFraction / leafScale / minBranchRadius so `detail` meshes to
 * about `goal` triangles. Pure function of the skeleton: deterministic.
 */
function fitDetail(tree, detail, goal) {
  const billboard = detail.billboard ?? tree.options.leaves.billboard;
  const perLeaf = billboard === Billboard.Double ? 4 : 2;
  const leafCount = Math.ceil(tree.skeleton.leaves.length / Math.max(1, detail.leafStride ?? 1));
  // Candidate twig cut-offs: none, then eight radius quantiles.
  const sorted = tree.skeleton.branches.map((b) => b.baseRadius).sort((a, b) => a - b);
  const radii = [0, ...new Set(Array.from({ length: 8 }, (_, k) =>
    sorted[Math.floor((k + 1) / 9 * sorted.length)] ?? 0))];
  let fitted = { ...detail };
  for (const minBranchRadius of radii) {
    const bare = tree.createGeometry({ ...detail, minBranchRadius, leafFraction: 0 });
    const branchTris = triangles(bare);
    bare.branches.dispose(); bare.leaves.dispose();
    const fraction = leafCount ? (goal - branchTris) / (leafCount * perLeaf) : 1;
    fitted = { ...detail, minBranchRadius, leafFraction: Math.min(1, Math.max(0.03, fraction)) };
    if (fraction >= 0.15 || !leafCount) break;
  }
  if (!fitted.minBranchRadius) delete fitted.minBranchRadius;
  // Grow the kept leaves toward the same canopy coverage (area would need
  // 1/sqrt(f); a little under keeps them from reading as balloons), and a
  // bit more when a double card becomes a single one.
  const base = detail.leafScale ?? 1;
  const single = billboard !== tree.options.leaves.billboard ? 1.15 : 1;
  fitted.leafScale = Math.min(2.6, base * single * Math.pow(1 / fitted.leafFraction, 0.4));
  if (fitted.leafFraction >= 1) delete fitted.leafFraction;
  return fitted;
}

/**
 * Builds one game tree: a species variant in metres with its LOD chain.
 *
 * Geometry is uniformly scaled so the tree's top sits at the variant's
 * target height, with the trunk base at the origin (y = 0 is the ground).
 * Impostor geometry is always built; its texture needs a renderer
 * (`bakeImpostor: true` bakes a per-variant atlas, or pass the variants to
 * bakeSpeciesAtlas() for the shared species atlas).
 *
 * @param {string} speciesId
 * @param {number} index Variant 0..9
 * @param {{
 *   lods?: number[],
 *   renderer?: THREE.WebGLRenderer,
 *   bakeImpostor?: boolean,
 *   textures?: {bark?: {map?: THREE.Texture, normalMap?: THREE.Texture}, leaves?: {map?: THREE.Texture, normalMap?: THREE.Texture}},
 *   tiers?: object[],
 * }} [opts] `lods` overrides the species' end distances (length 1..5;
 *   length 1 = full detail only).
 * @returns {{
 *   species: object, index: number, name: string, file: string, options: import('./options').default,
 *   height: number, scale: number, bounds: THREE.Box3, tris: number[], lods: number[],
 *   impostorMode: string, sets: {bark: string, leaves: string, impostor: string}, wind: object,
 *   levels: {index: number, kind: 'mesh'|'impostor', distance: number, detail: object, branches: THREE.BufferGeometry, leaves: THREE.BufferGeometry, tris: number}[],
 *   impostor: {views: object[], geometry: THREE.BufferGeometry}|null,
 *   materials: {bark: THREE.Material, leaves: THREE.Material, impostor: THREE.Material},
 *   lod: THREE.LOD,
 *   dispose: () => void,
 * }}
 */
export function buildVariant(speciesId, index, opts = {}) {
  const species = getSpecies(speciesId);
  const meta = variantMeta(speciesId, index);
  const options = variantOptions(speciesId, index);
  const lods = opts.lods ?? species.lods;
  if (!Array.isArray(lods) || lods.length < 1 || lods.length > 5) {
    throw new RangeError('lods must hold 1..5 end distances');
  }
  const tiers = opts.tiers ?? GAME_LOD_TIERS;
  const tree = new Tree(options);
  const full = tree.createGeometry({});

  const levels = [];
  const tris = [];
  let lod0Tris = triangles(full);
  let lod0 = full;
  let lod0Detail = { ...(species.lodDetail?.[0] ?? {}) };
  if (lod0Tris > LOD0_TRIANGLE_CAP) {
    full.branches.dispose(); full.leaves.dispose();
    lod0Detail = fitDetail(tree, lod0Detail, LOD0_TRIANGLE_CAP * 0.97);
    lod0 = tree.createGeometry(lod0Detail);
    lod0Tris = triangles(lod0);
  } else if (Object.keys(lod0Detail).length) {
    full.branches.dispose(); full.leaves.dispose();
    lod0 = tree.createGeometry(lod0Detail);
    lod0Tris = triangles(lod0);
  }

  // Metres: scale about the trunk base so LOD0's crown top meets the target.
  const raw = geometryBounds([lod0.branches, lod0.leaves]);
  const scale = meta.height / Math.max(1e-6, raw.max.y);

  let impostor = null;
  for (let i = 0; i < lods.length; i++) {
    const tier = tiers[i];
    let product;
    let detail;
    let kind = 'mesh';
    if (i === 0) {
      product = lod0;
      detail = lod0Detail;
    } else if (tier.impostor) {
      kind = 'impostor';
    } else if (tier.budget) {
      // Never let the budget tier out-weigh the tier before it.
      const previous = tris[i - 1] ?? lod0Tris;
      const budget = Math.max(24, Math.min(tier.budget, Math.round(previous * 0.6)));
      detail = { triangleBudget: budget, ...(species.lodDetail?.[i] ?? {}) };
      product = tree.createGeometry(detail);
    } else {
      const baseDetail = { ...tier.detail, ...(species.lodDetail?.[i] ?? {}) };
      detail = tier.target ? fitDetail(tree, baseDetail, tier.target * lod0Tris) : baseDetail;
      product = tree.createGeometry(detail);
    }
    if (kind === 'mesh') {
      product.branches.scale(scale, scale, scale);
      product.leaves.scale(scale, scale, scale);
      product.branches.computeBoundingSphere();
      product.leaves.computeBoundingSphere();
      levels.push({ index: i, kind, distance: lods[i], detail, branches: product.branches, leaves: product.leaves, tris: triangles(product) });
    } else {
      levels.push({ index: i, kind, distance: lods[i], detail: { impostor: species.impostor }, branches: null, leaves: null, tris: 0 });
    }
    tris.push(levels[i].tris);
  }

  const bounds = geometryBounds([levels[0].branches, levels[0].leaves]);
  const impostorLevel = levels.find((l) => l.kind === 'impostor');
  const sets = speciesSets(species);
  if (impostorLevel) {
    const views = impostorViews(bounds, species.impostor);
    const geometry = impostorGeometry(views);
    const empty = new THREE.BufferGeometry();
    empty.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    empty.setIndex([]);
    impostorLevel.branches = empty;
    impostorLevel.leaves = geometry;
    impostorLevel.tris = geometry.index.count / 3;
    tris[impostorLevel.index] = impostorLevel.tris;
    impostor = { views, geometry };
  }

  const materials = createMaterials(species, sets, opts.textures);
  if (impostor && opts.bakeImpostor && opts.renderer) {
    const baked = bakeImpostor(
      { branches: levels[0].branches, leaves: levels[0].leaves },
      materials.bark, materials.leaves, opts.renderer, species.impostor);
    impostor.geometry.dispose();
    impostor.geometry = impostorLevel.leaves = baked.leaves;
    baked.branches.dispose();
    materials.impostor.dispose();
    materials.impostor = baked.leavesMaterial;
    materials.impostor.name = sets.impostor;
  }

  const lod = new THREE.LOD();
  lod.name = meta.file;
  levels.forEach((level, i) => {
    const group = new THREE.Group();
    group.name = `${meta.file}LOD${i}`;
    if (level.branches.index.count) {
      const mesh = new THREE.Mesh(level.branches, materials.bark);
      mesh.name = `${group.name}_bark`;
      group.add(mesh);
    }
    if (level.leaves.index.count) {
      const mesh = new THREE.Mesh(level.leaves, level.kind === 'impostor' ? materials.impostor : materials.leaves);
      mesh.name = `${group.name}_${level.kind === 'impostor' ? 'impostor' : 'leaves'}`;
      group.add(mesh);
    }
    const shadows = i <= (species.lastShadowLod ?? 1);
    group.traverse((o) => { if (o.isMesh) { o.castShadow = shadows; o.receiveShadow = true; } });
    // THREE.LOD takes activation distances; catalog `lods` are end distances.
    lod.addLevel(group, i === 0 ? 0 : lods[i - 1]);
  });

  return {
    species, index, name: meta.name, file: meta.file, options,
    height: bounds.max.y, scale, bounds, tris, lods,
    impostorMode: species.impostor, sets, wind: speciesWind(species),
    levels, impostor, materials, lod,
    dispose() {
      levels.forEach((l) => { l.branches?.dispose(); l.leaves?.dispose(); });
      Object.values(materials).forEach((m) => m.dispose());
    },
  };
}

/**
 * Placeholder materials named after the species' texture sets (the game
 * rebinds them by name). Bark is opaque; leaves and impostor are alpha-
 * scissored and two-sided.
 */
function createMaterials(species, sets, textures = {}) {
  const bark = new THREE.MeshStandardMaterial({
    name: sets.bark, color: new THREE.Color(species.bark.tint),
    map: textures.bark?.map ?? null, normalMap: textures.bark?.normalMap ?? null,
    roughness: species.bark.roughness ?? 0.95, metalness: 0,
  });
  const leaves = new THREE.MeshStandardMaterial({
    name: sets.leaves, color: new THREE.Color(species.leaves.tint ?? 0xffffff),
    map: textures.leaves?.map ?? null, normalMap: textures.leaves?.normalMap ?? null,
    alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: species.leaves.roughness ?? 0.65, metalness: 0,
  });
  const impostor = new THREE.MeshStandardMaterial({
    name: sets.impostor, map: textures.impostor?.map ?? null,
    normalMap: textures.impostor?.normalMap ?? null,
    alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
  });
  return { bark, leaves, impostor };
}

/**
 * Builds all ten variants of a species (see buildVariant for opts).
 * @returns {ReturnType<typeof buildVariant>[]}
 */
export function buildSpecies(speciesId, opts = {}) {
  return Array.from({ length: VARIANT_COUNT }, (_, i) => buildVariant(speciesId, i, opts));
}

/**
 * Bakes one atlas for a species: every variant's impostor views packed into
 * one power-of-two sheet (default 2048x2048 for cross, 2048x1024 for card),
 * rewrites each variant's impostor UVs into its cells, and points every
 * variant's impostor material at the shared textures.
 * Browser only (WebGL).
 * @param {ReturnType<typeof buildVariant>[]} variants built with an impostor level
 * @param {THREE.WebGLRenderer} renderer
 * @param {{width?: number, height?: number, padding?: number, normals?: boolean}} [options]
 * @returns {{albedo: {data: Uint8ClampedArray, width: number, height: number}, normal?: {data: Uint8ClampedArray, width: number, height: number}, map: THREE.DataTexture, normalMap?: THREE.DataTexture, material: THREE.MeshStandardMaterial, cells: object[][], texelsPerUnit: number}}
 */
export function bakeSpeciesAtlas(variants, renderer, options = {}) {
  const withImpostor = variants.filter((v) => v.impostor);
  if (!withImpostor.length) throw new Error('No variant has an impostor level');
  const card = withImpostor[0].impostorMode === 'card';
  const sheet = { width: 2048, height: card ? 1024 : 2048, ...options };
  const atlas = bakeAtlas(withImpostor.map((v) => ({
    parts: [
      { geometry: v.levels[0].branches, material: v.materials.bark, roughness: v.species.bark.roughness ?? 0.95 },
      { geometry: v.levels[0].leaves, material: v.materials.leaves, roughness: v.species.leaves.roughness ?? 0.65 },
    ],
    views: v.impostor.views,
    impostor: v.impostor.geometry,
  })), renderer, sheet);
  const map = imageTexture(atlas.albedo, THREE.SRGBColorSpace, { cutoff: 0.5 });
  const normalMap = atlas.normal ? imageTexture(atlas.normal, THREE.NoColorSpace) : undefined;
  const material = new THREE.MeshStandardMaterial({
    name: withImpostor[0].sets.impostor, map, normalMap,
    alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85, metalness: 0,
  });
  for (const variant of withImpostor) {
    variant.materials.impostor.dispose();
    variant.materials.impostor = material;
    variant.lod.traverse((o) => { if (o.isMesh && o.geometry === variant.impostor.geometry) o.material = material; });
  }
  return { ...atlas, map, normalMap, material };
}
