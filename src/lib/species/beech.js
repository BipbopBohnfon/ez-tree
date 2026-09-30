/** @type {import('./model').SpeciesDef} */
export default {
  id: 'beech', name: 'Beech', biomes: ['forest'],
  height: [15, 25],
  lods: [30, 70, 150, 400, 1500],
  lastShadowLod: 1,
  impostor: 'card',
  bark: { texture: 'Bark008', tint: 0xc4c2bc, textureScale: { x: 1, y: 4 }, saturation: 0, gain: 1.1 },
  leaves: {
    paint: { shape: 'ovate', count: 8, length: 0.26, width: 0.58, spread: 65, branches: 2, colors: [[92, 0.5, 0.26], [108, 0.48, 0.36]] },
  },
  options: {
    type: 'deciduous',
    branch: {
      levels: 3,
      angle: { 1: 48, 2: 45, 3: 40 },
      children: { 0: 9, 1: 5, 2: 3 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.01 },
      gnarliness: { 0: 0.03, 1: 0.1, 2: 0.15, 3: 0.1 },
      length: { 0: 42, 1: 22, 2: 11, 3: 5 },
      radius: { 0: 2.0, 1: 0.55, 2: 0.6, 3: 0.7 },
      sections: { 0: 12, 1: 7, 2: 5, 3: 2 },
      segments: { 0: 10, 1: 6, 2: 3, 3: 3 },
      start: { 1: 0.45, 2: 0.2, 3: 0.1 },
      taper: { 0: 0.7, 1: 0.6, 2: 0.7, 3: 0.7 },
      droop: { 2: 0.3 },
    },
    leaves: { billboard: 'double', angle: 30, count: 4, start: 0.15, size: 3.4, sizeVariance: 0.25, alphaTest: 0.5 },
  },
  vary: {
    'branch.length.0': [36, 48],
    'branch.length.1': [18, 26],
    'branch.angle.1': [40, 58],
    'branch.children.0': [8, 11, 'int'],
    'branch.start.1': [0.35, 0.55],
    'form.lean': [0, 4],
    'form.leanDirection': [0, 360],
  },
};
