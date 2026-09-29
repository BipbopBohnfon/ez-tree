import * as THREE from 'three';
import RNG from './rng';
import { bleedColor, createCanvas, imageTexture } from './impostor';

/** Leaf silhouettes the painter can draw. */
export const LeafShape = {
  Ovate: 'ovate',
  Lanceolate: 'lanceolate',
  Needle: 'needle',
  Pinnate: 'pinnate',
  Bipinnate: 'bipinnate',
};

/**
 * @typedef {Object} LeafPaintParams
 * @property {string} shape LeafShape
 * @property {number} [count=7] Leaves on the twig (needles: needles per side
 *   per side-shoot; pinnate: leaflet pairs; bipinnate: pinnae pairs)
 * @property {number} [length=0.32] Leaf length as a fraction of the texture
 * @property {number} [width=0.45] Leaf width / length
 * @property {number} [spread=50] Angle of leaves off the twig (degrees)
 * @property {number[][]} [colors] Two [h, s, l] endpoints (h 0..360, s/l 0..1);
 *   each leaf picks a colour between them
 * @property {number} [backShade=0.12] Lightness drop on the leaf's shaded half
 * @property {false|{color?: string, width?: number}} [stem] Twig; false hides it
 * @property {number} [branches=0] Side shoots off the main twig (needle/pinnate)
 * @property {number} [droop=0] Leaves hang: 0 = spread upward, 1 = hang down
 * @property {number} [seed=1]
 * @property {number} [size=512] Texture size in pixels (square)
 * @property {number} [roughness=0.65] Constant roughness for the companion map
 * @property {number} [bump=2.5] Normal strength of the height-from-alpha relief
 */

const DEFAULT_COLORS = [[95, 0.45, 0.28], [110, 0.5, 0.38]];

/**
 * Paints a leaf-cluster texture: a twig rising from the bottom centre (the
 * point ez-tree attaches a leaf card to its branch) with leaves along it on
 * a transparent background. Browser only (2D canvas).
 *
 * Returns raw top-down RGBA images, unpremultiplied: `albedo` (colour bled
 * into transparent texels so mips and filtering stay fringe-free) and
 * `normal` (OpenGL normal from a height-from-alpha relief in RGB, constant
 * roughness in A).
 * @param {LeafPaintParams} params
 * @returns {{albedo: {data: Uint8ClampedArray, width: number, height: number}, normal: {data: Uint8ClampedArray, width: number, height: number}}}
 */
export function paintLeaves(params) {
  const p = {
    shape: LeafShape.Ovate, count: 7, length: 0.32, width: 0.45, spread: 50,
    colors: DEFAULT_COLORS, backShade: 0.12, stem: {}, branches: 0, droop: 0,
    seed: 1, size: 512, roughness: 0.65, bump: 2.5, ...params,
  };
  const size = p.size;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const rng = new RNG(p.seed);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const stemColor = p.stem?.color ?? '#5a4630';
  const stemWidth = (p.stem?.width ?? 0.012) * size;
  const color = () => {
    const t = rng.random();
    const [a, b] = p.colors;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  };
  const hsl = ([h, s, l], dl = 0) =>
    `hsl(${h.toFixed(1)} ${(s * 100).toFixed(1)}% ${(Math.max(0, Math.min(1, l + dl)) * 100).toFixed(1)}%)`;

  // Main twig: a gentle curve from bottom centre to near the top.
  const bend = rng.random(0.06, -0.06) * size;
  const twig = (t) => ({
    x: size / 2 + bend * Math.sin(Math.PI * t),
    y: size * (1 - 0.9 * t),
    angle: Math.atan2(-0.9 * size, bend * Math.PI * Math.cos(Math.PI * t)),
  });
  const drawTwig = () => {
    if (p.stem === false) return;
    ctx.strokeStyle = stemColor;
    ctx.lineWidth = stemWidth;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const { x, y } = twig(i / 24);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  /** One simple leaf blade, base at (0,0), pointing up (-y) in local space. */
  const blade = (length, width, shape, fill) => {
    const w = width * length / 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    if (shape === LeafShape.Lanceolate) {
      ctx.bezierCurveTo(w * 1.1, -length * 0.15, w * 0.9, -length * 0.6, 0, -length);
      ctx.bezierCurveTo(-w * 0.9, -length * 0.6, -w * 1.1, -length * 0.15, 0, 0);
    } else {
      ctx.bezierCurveTo(w * 1.35, -length * 0.1, w * 1.25, -length * 0.75, 0, -length);
      ctx.bezierCurveTo(-w * 1.25, -length * 0.75, -w * 1.35, -length * 0.1, 0, 0);
    }
    ctx.closePath();
    ctx.fillStyle = hsl(fill);
    ctx.fill();
    // Shaded half + midrib fake the blade's fold.
    ctx.save();
    ctx.clip();
    ctx.fillStyle = hsl(fill, -p.backShade);
    ctx.fillRect(0, -length, w * 2, length);
    ctx.restore();
    ctx.strokeStyle = hsl(fill, 0.1);
    ctx.lineWidth = Math.max(1, length * 0.025);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -length * 0.92);
    ctx.stroke();
  };

  const place = (x, y, angle, draw) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    draw();
    ctx.restore();
  };

  /** Leaf angle off a twig heading `heading`, on side ±1. */
  const leafAngle = (heading, side, spread) => {
    // heading is the canvas-space direction of the twig; local blades point -y.
    const up = heading + Math.PI / 2;
    const off = side * spread * (1 - p.droop) + side * p.droop * (Math.PI - spread);
    return up + off;
  };

  const spread = THREE.MathUtils.degToRad(p.spread);
  const L = p.length * size;

  if (p.shape === LeafShape.Needle) {
    // Needle shoots: the twig and side shoots carry dense short needles.
    const shoots = [{ from: 0, heading: null, len: 1 }];
    for (let b = 0; b < p.branches; b++) {
      shoots.push({ from: 0.2 + 0.65 * (b + rng.random()) / p.branches, side: b % 2 ? 1 : -1, len: 0.35 + rng.random(0.2) });
    }
    drawTwig();
    for (const shoot of shoots) {
      const base = twig(shoot.from);
      const heading = shoot.side ? base.angle + shoot.side * rng.random(0.9, 0.5) : null;
      const pointAt = (t) => shoot.side
        ? { x: base.x + Math.cos(heading) * t * shoot.len * size * 0.9, y: base.y + Math.sin(heading) * t * shoot.len * size * 0.9, angle: heading }
        : twig(t);
      if (shoot.side && p.stem !== false) {
        const end = pointAt(1);
        ctx.strokeStyle = stemColor;
        ctx.lineWidth = stemWidth * 0.6;
        ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      }
      const n = Math.round(p.count * shoot.len * 2);
      for (let i = 0; i < n; i++) {
        const t = 0.05 + 0.95 * (i + rng.random()) / n;
        const at = pointAt(t);
        for (const side of [-1, 1]) {
          const fill = color();
          const len = L * (0.7 + rng.random(0.3)) * (1 - 0.35 * t);
          place(at.x, at.y, leafAngle(at.angle, side, spread * (0.8 + rng.random(0.4))), () => {
            ctx.strokeStyle = hsl(fill);
            ctx.lineWidth = Math.max(2, p.width * 0.02 * size);
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
          });
        }
      }
    }
  } else if (p.shape === LeafShape.Pinnate || p.shape === LeafShape.Bipinnate) {
    // Compound leaves: `branches` rachises off the twig (or the twig itself).
    const rachises = Math.max(1, p.branches || 1);
    drawTwig();
    for (let r = 0; r < rachises; r++) {
      const t0 = rachises === 1 ? 0.1 : 0.15 + 0.75 * (r + rng.random(0.8, 0.2)) / rachises;
      const base = twig(t0);
      const side = rachises === 1 ? 0 : (r % 2 ? 1 : -1);
      const heading = base.angle + side * spread * 0.8;
      const rlen = (rachises === 1 ? 0.85 : 0.42 + rng.random(0.12)) * size;
      const at = (t) => ({ x: base.x + Math.cos(heading) * t * rlen, y: base.y + Math.sin(heading) * t * rlen });
      if (p.stem !== false) {
        const end = at(1);
        ctx.strokeStyle = stemColor;
        ctx.lineWidth = stemWidth * 0.5;
        ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(end.x, end.y); ctx.stroke();
      }
      for (let i = 0; i < p.count; i++) {
        const t = 0.12 + 0.86 * (i + 0.5) / p.count;
        const q = at(t);
        for (const s of [-1, 1]) {
          const angle = leafAngle(heading, s, Math.PI / 2 * 0.85);
          if (p.shape === LeafShape.Pinnate) {
            place(q.x, q.y, angle, () => blade(L * (1 - 0.3 * Math.abs(t - 0.5)), p.width, LeafShape.Ovate, color()));
          } else {
            // A pinna: tiny leaflets along a secondary axis.
            const plen = L * (0.9 - 0.6 * Math.abs(t - 0.5));
            place(q.x, q.y, angle, () => {
              if (p.stem !== false) {
                ctx.strokeStyle = stemColor;
                ctx.lineWidth = Math.max(1, stemWidth * 0.25);
                ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -plen); ctx.stroke();
              }
              const leaflets = 9;
              for (let k = 0; k < leaflets; k++) {
                const y = -plen * (0.1 + 0.9 * (k + 0.5) / leaflets);
                for (const s2 of [-1, 1]) {
                  place(0, y, s2 * 1.1, () => blade(plen * 0.24, p.width, LeafShape.Lanceolate, color()));
                }
              }
            });
          }
        }
      }
      if (p.shape === LeafShape.Pinnate) {
        const tip = at(0.98);
        place(tip.x, tip.y, heading + Math.PI / 2, () => blade(L, p.width, LeafShape.Ovate, color()));
      }
    }
  } else {
    // Simple leaves (ovate/lanceolate), alternating along the twig with a
    // terminal leaf, plus optional side shoots.
    drawTwig();
    const drawOn = (pointAt, count, scale) => {
      for (let i = 0; i < count; i++) {
        const t = 0.12 + 0.8 * (i + rng.random(0.8, 0.2)) / count;
        const at = pointAt(t);
        const side = i % 2 ? 1 : -1;
        const len = L * scale * (0.75 + rng.random(0.35)) * (1 - 0.25 * t);
        place(at.x, at.y, leafAngle(at.angle, side, spread * (0.8 + rng.random(0.4))), () => {
          if (p.stem !== false) {
            ctx.strokeStyle = stemColor;
            ctx.lineWidth = Math.max(1, stemWidth * 0.4);
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len * 0.12); ctx.stroke();
          }
          ctx.translate(0, -len * 0.1);
          blade(len, p.width * (0.9 + rng.random(0.2)), p.shape, color());
        });
      }
      const tip = pointAt(0.97);
      place(tip.x, tip.y, tip.angle + Math.PI / 2, () => blade(L * scale * 0.85, p.width, p.shape, color()));
    };
    for (let b = 0; b < p.branches; b++) {
      const base = twig(0.25 + 0.55 * (b + rng.random()) / p.branches);
      const side = b % 2 ? 1 : -1;
      const heading = base.angle + side * spread * 0.9;
      const len = (0.35 + rng.random(0.15)) * size;
      if (p.stem !== false) {
        ctx.strokeStyle = stemColor;
        ctx.lineWidth = stemWidth * 0.6;
        ctx.beginPath(); ctx.moveTo(base.x, base.y);
        ctx.lineTo(base.x + Math.cos(heading) * len, base.y + Math.sin(heading) * len); ctx.stroke();
      }
      drawOn((t) => ({ x: base.x + Math.cos(heading) * t * len, y: base.y + Math.sin(heading) * t * len, angle: heading }),
        Math.max(2, Math.round(p.count / 2)), 0.8);
    }
    drawOn(twig, p.count, 1);
  }

  const image = ctx.getImageData(0, 0, size, size);
  const albedo = { data: image.data, width: size, height: size };
  const normal = { data: heightNormals(image.data, size, size, p.bump, p.roughness), width: size, height: size };
  // Binary-ish alpha keeps alpha-scissor clean; colour bleeds under it.
  bleedColor(albedo.data, size, size, null, 3);
  return { albedo, normal };
}

/** Normal map (OpenGL, +Y up) from a blurred alpha height; roughness in A. */
function heightNormals(rgba, width, height, strength, roughness) {
  const h = new Float32Array(width * height);
  for (let i = 0; i < h.length; i++) h[i] = rgba[i * 4 + 3] / 255;
  const blurred = boxBlur(boxBlur(h, width, height, 3), width, height, 3);
  const out = new Uint8ClampedArray(width * height * 4);
  const at = (x, y) => blurred[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    // Image rows go down; OpenGL green points up the texture.
    const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
    const n = new THREE.Vector3(-dx, -dy, 1).normalize();
    const i = (y * width + x) * 4;
    out[i] = (n.x * 0.5 + 0.5) * 255;
    out[i + 1] = (n.y * 0.5 + 0.5) * 255;
    out[i + 2] = (n.z * 0.5 + 0.5) * 255;
    out[i + 3] = roughness * 255;
  }
  return out;
}

function boxBlur(src, width, height, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = 2 * radius + 1;
  for (let y = 0; y < height; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) sum += src[y * width + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      tmp[y * width + x] = sum / span;
      sum += src[y * width + Math.min(width - 1, x + radius + 1)] - src[y * width + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / span;
      sum += tmp[Math.min(height - 1, y + radius + 1) * width + x] - tmp[Math.max(0, y - radius) * width + x];
    }
  }
  return out;
}

/**
 * Leaf textures ready for a material: `map` (sRGB) and `normalMap`
 * (linear, roughness in alpha).
 * @param {LeafPaintParams} params
 */
export function leafTextures(params) {
  const { albedo, normal } = paintLeaves(params);
  return {
    albedo, normal,
    map: imageTexture(albedo, THREE.SRGBColorSpace, { cutoff: 0.5 }),
    normalMap: imageTexture(normal, THREE.NoColorSpace),
  };
}
