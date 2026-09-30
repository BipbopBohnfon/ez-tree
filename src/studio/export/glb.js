// Minimal glTF 2.0 binary writer for game tree variants (no three.js
// exporter: node and material names must be exact, and nothing but
// POSITION / NORMAL / TEXCOORD_0 / indices may leave).
//
// Layout (what Terrain3D's mesh asset reads):
//   scene -> root node "<stem>" -> children "<stem>LOD0".."<stem>LODn",
//   each LOD node holds one mesh whose primitives are that level's surfaces.
// Every primitive's material is a placeholder named after its texture set;
// the game rebinds it by name. No images, textures or samplers are written.
// Units are metres, Y up; node transforms are identity (Terrain3D takes the
// meshes without their node transforms), so geometry must already sit with
// its pivot at the trunk base.
//
// UVs: three.js samples images with v = 1 at the top row (flipY), glTF with
// v = 0 at the top, so v is written as 1 - v.

const GLTF_FLOAT = 5126;
const GLTF_UINT16 = 5123;
const GLTF_UINT32 = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const pad4 = (n) => (n + 3) & ~3;

function readAttribute(attribute, size) {
  const out = new Float32Array(attribute.count * size);
  const get = [attribute.getX, attribute.getY, attribute.getZ].map((f) => f.bind(attribute));
  for (let i = 0; i < attribute.count; i++) {
    for (let k = 0; k < size; k++) out[i * size + k] = get[k](i);
  }
  return out;
}

function readIndex(geometry, vertexCount) {
  const index = geometry.index;
  if (!index) return Uint32Array.from({ length: vertexCount }, (_, i) => i);
  const out = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++) out[i] = index.getX(i);
  return out;
}

/**
 * Encodes a GLB.
 * @param {{
 *   name: string,
 *   lods: {primitives: {geometry: object, material: string}[]}[],
 *   foliage?: Set<string>|string[],
 * }} model `geometry` is a THREE.BufferGeometry (or anything with the same
 *   attribute accessors) carrying position, normal and uv. Materials named in
 *   `foliage` get alphaMode MASK + doubleSided (informative only; the game
 *   rebinds every material by name).
 * @returns {Uint8Array}
 */
export function encodeGLB({ name, lods, foliage = [] }) {
  if (!name) throw new Error('GLB: name is required');
  if (!lods?.length) throw new Error('GLB: at least one LOD is required');
  const foliageSet = new Set(foliage);
  const json = {
    asset: { version: '2.0', generator: 'ez-tree deinterleaver exporter' },
    scene: 0,
    scenes: [{ name, nodes: [0] }],
    nodes: [{ name, children: lods.map((_, i) => i + 1) }],
    meshes: [],
    materials: [],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
  };
  const chunks = [];
  let byteLength = 0;
  const materialIndex = new Map();

  const view = (typed, target) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
    const offset = byteLength;
    chunks.push({ offset, bytes });
    byteLength = pad4(offset + bytes.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target });
    return json.bufferViews.length - 1;
  };
  const accessor = (typed, type, componentType, target, extra = {}) => {
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3 }[type];
    json.accessors.push({
      bufferView: view(typed, target), componentType, count: typed.length / components, type, ...extra,
    });
    return json.accessors.length - 1;
  };
  const material = (materialName) => {
    if (!materialIndex.has(materialName)) {
      const entry = { name: materialName, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 } };
      if (foliageSet.has(materialName)) Object.assign(entry, { alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true });
      json.materials.push(entry);
      materialIndex.set(materialName, json.materials.length - 1);
    }
    return materialIndex.get(materialName);
  };

  lods.forEach((lod, i) => {
    const nodeName = `${name}LOD${i}`;
    const primitives = [];
    for (const { geometry, material: materialName } of lod.primitives) {
      if (!materialName) throw new Error(`GLB: ${nodeName} has a primitive without a material name`);
      const { position, normal, uv } = geometry.attributes;
      if (!position || !normal || !uv) throw new Error(`GLB: ${nodeName}/${materialName} needs position, normal and uv`);
      const indices = readIndex(geometry, position.count);
      if (!indices.length) continue;
      const positions = readAttribute(position, 3);
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let v = 0; v < position.count; v++) {
        for (let k = 0; k < 3; k++) {
          const x = positions[v * 3 + k];
          if (x < min[k]) min[k] = x;
          if (x > max[k]) max[k] = x;
        }
      }
      const normals = readAttribute(normal, 3);
      for (let v = 0; v < normal.count; v++) {
        const x = normals[v * 3], y = normals[v * 3 + 1], z = normals[v * 3 + 2];
        const l = Math.hypot(x, y, z) || 1;
        normals[v * 3] = x / l; normals[v * 3 + 1] = y / l; normals[v * 3 + 2] = z / l;
      }
      const uvs = readAttribute(uv, 2);
      for (let v = 0; v < uv.count; v++) uvs[v * 2 + 1] = 1 - uvs[v * 2 + 1];
      const small = position.count <= 65535;
      primitives.push({
        attributes: {
          POSITION: accessor(positions, 'VEC3', GLTF_FLOAT, ARRAY_BUFFER, { min, max }),
          NORMAL: accessor(normals, 'VEC3', GLTF_FLOAT, ARRAY_BUFFER),
          TEXCOORD_0: accessor(uvs, 'VEC2', GLTF_FLOAT, ARRAY_BUFFER),
        },
        indices: accessor(small ? Uint16Array.from(indices) : indices, 'SCALAR',
          small ? GLTF_UINT16 : GLTF_UINT32, ELEMENT_ARRAY_BUFFER),
        material: material(materialName),
        mode: 4,
      });
    }
    if (!primitives.length) throw new Error(`GLB: ${nodeName} has no triangles`);
    json.meshes.push({ name: nodeName, primitives });
    json.nodes.push({ name: nodeName, mesh: json.meshes.length - 1 });
  });

  json.buffers[0].byteLength = byteLength;
  const bin = new Uint8Array(byteLength);
  for (const { offset, bytes } of chunks) bin.set(bytes, offset);
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = pad4(jsonBytes.length);
  const total = 12 + 8 + jsonLength + 8 + byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength);
  dv.setUint32(20 + jsonLength, byteLength, true);
  dv.setUint32(24 + jsonLength, CHUNK_BIN, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

/**
 * The GLB of one built variant (buildVariant's result): one LOD node per
 * level, bark/leaves/impostor primitives named after the variant's sets.
 * @param {ReturnType<import('../../lib/game').buildVariant>} variant
 * @returns {Uint8Array}
 */
export function variantGLB(variant) {
  const { sets } = variant;
  return encodeGLB({
    name: variant.file,
    foliage: [sets.leaves, sets.impostor],
    lods: variant.levels.map((level) => ({
      primitives: [
        { geometry: level.branches, material: sets.bark },
        { geometry: level.leaves, material: level.kind === 'impostor' ? sets.impostor : sets.leaves },
      ].filter((p) => p.geometry?.index?.count ?? p.geometry?.attributes?.position?.count),
    })),
  });
}

/**
 * Splits a GLB into its JSON document and binary chunk (tests, inspection).
 * @param {Uint8Array} bytes
 * @returns {{json: object, bin: Uint8Array}}
 */
export function parseGLB(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(4, true) !== 2) throw new Error('GLB: not glTF 2 binary');
  if (dv.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB: length mismatch');
  const jsonLength = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== CHUNK_JSON) throw new Error('GLB: first chunk is not JSON');
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)));
  let bin = new Uint8Array(0);
  if (20 + jsonLength < bytes.byteLength) {
    const binLength = dv.getUint32(20 + jsonLength, true);
    if (dv.getUint32(24 + jsonLength, true) !== CHUNK_BIN) throw new Error('GLB: second chunk is not BIN');
    bin = bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength);
  }
  return { json, bin };
}
