/** @type {import('./model').SpeciesDef} */
export default {
  id: 'alder', name: 'Alder', biomes: ['lake_shore', 'fen'],
  height: [8, 14],
  lods: [30, 70, 150, 400, 1500],
  lastShadowLod: 1,
  impostor: 'card',
  bark: { texture: 'Bark006', tint: 0x8e8478, textureScale: { x: 1, y: 3 }, saturation: 0.5 },
  leaves: {
    paint: { shape: 'ovate', count: 7, length: 0.22, width: 0.75, spread: 55, branches: 3, droop: 0.2, colors: [[100, 0.38, 0.22], [112, 0.36, 0.32]], stem: { color: '#3e3022', width: 0.008 } },
  },
  swayRate: 0.3,
  options: {
    type: 'deciduous',
    branch: {
      levels: 3,
      angle: { 1: 42, 2: 50, 3: 40 },
      children: { 0: 8, 1: 4, 2: 3 },
      force: { direction: { x: 0, y: 1, z: 0 }, strength: 0.003 },
      gnarliness: { 0: 0.06, 1: 0.14, 2: 0.18, 3: 0.1 },
      length: { 0: 24, 1: 12, 2: 7, 3: 2 },
      radius: { 0: 1.1, 1: 0.55, 2: 0.6, 3: 0.7 },
      sections: { 0: 12, 1: 6, 2: 4, 3: 2 },
      segments: { 0: 8, 1: 5, 2: 3, 3: 3 },
      start: { 1: 0.22, 2: 0.2, 3: 0.1 },
      taper: { 0: 0.7, 1: 0.6, 2: 0.7, 3: 0.7 },
      droop: { 2: 0.5, 3: 0.8 },
    },
    leaves: { billboard: 'double', angle: 30, count: 3, start: 0.1, size: 2.5, sizeVariance: 0.25, alphaTest: 0.5 },
  },
  vary: {
    'branch.length.0': [20, 30],
    'branch.length.1': [9, 15],
    'branch.angle.1': [34, 52],
    'branch.children.0': [6, 10, 'int'],
    'form.lean': [0, 8],
    'form.leanDirection': [0, 360],
  },
};
