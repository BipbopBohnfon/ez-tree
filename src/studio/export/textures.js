// Texture-set packing for the game (.scratch/ez_trees/spec.md): each set is
// `<set>_albedo_alpha.png` (sRGB colour + alpha) and
// `<set>_normal_roughness.png` (OpenGL normal RGB + roughness A), 8-bit RGBA,
// straight alpha. Browser only (image decoding, WebGL textures).
//
// Tints: the game draws a set with its textures alone, so a species' bark
// and leaf tints are multiplied into the packed albedo. The THREE textures
// returned for previews and impostor baking stay untinted, because the
// library's placeholder materials multiply the tint themselves.
import * as THREE from 'three';
import { imageTexture, leafTextures } from '@dgreenheck/ez-tree';
import { encodePNG } from './png.js';

/** Bark texture edge in pixels. The ambientCG sources are 1024²; 512²
 *  matches the game's shipped fir_bark and keeps ten species' bark ~1/4 the
 *  size, which reads fine on trunks seen beyond a couple of metres. */
export const BARK_SIZE = 512;

/** Where the dev server serves the resolved upstream textures (fetch:textures). */
export const TEXTURE_BASE = '/textures/';

/** URLs of a species' bark source images (ambientCG `<id>_1K-JPG` sets). */
export function barkSourceUrls(barkId, base = TEXTURE_BASE) {
  const stem = `${base}bark/${barkId}_1K-JPG/${barkId}_1K-JPG_`;
  return { color: `${stem}Color.jpg`, normal: `${stem}NormalGL.jpg`, roughness: `${stem}Roughness.jpg` };
}

/**
 * Fetches an image and returns its top-down RGBA bytes at `size`² (or its
 * own size). No premultiplication or colour conversion.
 */
export async function loadImage(url, size) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`texture ${url}: HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size < 1024 && (await blob.text()).startsWith('version https://git-lfs')) {
    throw new Error(`texture ${url} is a Git LFS pointer; run npm run fetch:textures`);
  }
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none', colorSpaceConversion: 'none',
    ...(size ? { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' } : {}),
  });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: new Uint8Array(data.buffer), width, height };
}

const tintBytes = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

/** Copy of an RGBA image with RGB multiplied by an sRGB hex tint. */
export function tintImage(image, tint) {
  const data = new Uint8Array(image.data);
  if (tint === undefined || tint === null || tint === 0xffffff) return { ...image, data };
  const [r, g, b] = tintBytes(tint);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * r / 255);
    data[i + 1] = Math.round(data[i + 1] * g / 255);
    data[i + 2] = Math.round(data[i + 2] * b / 255);
  }
  return { ...image, data };
}

/**
 * Packs bark sources into the set's two images: albedo (colour, alpha 255)
 * and normal (NormalGL RGB, roughness from the roughness map's red in A).
 */
export function packBark({ color, normal, roughness }) {
  const n = color.width * color.height * 4;
  if (normal.data.length !== n || roughness.data.length !== n) throw new Error('bark sources differ in size');
  const albedo = new Uint8Array(color.data);
  const packed = new Uint8Array(normal.data);
  for (let i = 0; i < n; i += 4) {
    albedo[i + 3] = 255;
    packed[i + 3] = roughness.data[i];
  }
  return {
    albedo: { data: albedo, width: color.width, height: color.height },
    normal: { data: packed, width: color.width, height: color.height },
  };
}

/**
 * A species' bark and leaf sets: the raw untinted images, THREE textures
 * for buildVariant's `textures` (previews, impostor baking), and `packed`
 * images (tint applied) ready for the game.
 * @param {import('../../lib/species/model').SpeciesDef} species
 * @param {{base?: string, barkSize?: number}} [opts]
 */
export async function speciesTextures(species, { base = TEXTURE_BASE, barkSize = BARK_SIZE } = {}) {
  const urls = barkSourceUrls(species.bark.texture, base);
  const [color, normal, roughness] = await Promise.all([
    loadImage(urls.color, barkSize), loadImage(urls.normal, barkSize), loadImage(urls.roughness, barkSize),
  ]);
  const bark = packBark({ color, normal, roughness });
  const barkMap = imageTexture(bark.albedo, THREE.SRGBColorSpace);
  const barkNormal = imageTexture(bark.normal, THREE.NoColorSpace);
  for (const t of [barkMap, barkNormal]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const leaf = leafTextures(species.leaves.paint);
  return {
    textures: {
      bark: { map: barkMap, normalMap: barkNormal },
      leaves: { map: leaf.map, normalMap: leaf.normalMap },
    },
    packed: {
      bark: { albedo: tintImage(bark.albedo, species.bark.tint), normal: bark.normal },
      leaves: { albedo: tintImage(leaf.albedo, species.leaves.tint), normal: leaf.normal },
    },
    dispose() { [barkMap, barkNormal, leaf.map, leaf.normalMap].forEach((t) => t.dispose()); },
  };
}

/** Game import settings (assets/art/terrain/meshes/README.md): lossless,
 *  mipmapped, no alpha-border repair, no normal-map compression for the
 *  normal/roughness pair. Written only when the game has no .import yet. */
export function textureImportSidecar(kind) {
  return `[remap]

importer="texture"
type="CompressedTexture2D"

[params]

compress/mode=0
compress/high_quality=false
compress/lossy_quality=0.7
compress/normal_map=${kind === 'normal_roughness' ? 2 : 0}
compress/channel_pack=0
mipmaps/generate=true
mipmaps/limit=-1
roughness/mode=0
roughness/src_normal=""
process/fix_alpha_border=false
process/premult_alpha=false
process/normal_map_invert_y=false
process/size_limit=0
detect_3d/compress_to=0
`;
}

/**
 * Encodes texture sets as game files.
 * @param {Object<string, {albedo: object, normal: object}>} sets set name -> images
 * @returns {Promise<{path: string, bytes: Uint8Array, keep?: boolean}[]>} paths
 *   relative to the trees folder; `keep` files are written only when absent
 */
export async function textureSetFiles(sets) {
  const files = [];
  const encoder = new TextEncoder();
  for (const [name, { albedo, normal }] of Object.entries(sets)) {
    for (const [kind, image] of [['albedo_alpha', albedo], ['normal_roughness', normal]]) {
      const path = `textures/${name}_${kind}.png`;
      files.push({ path, bytes: await encodePNG(image) });
      files.push({ path: `${path}.import`, bytes: encoder.encode(textureImportSidecar(kind)), keep: true });
    }
  }
  return files;
}
