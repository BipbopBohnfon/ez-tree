# EZ-Tree

![NPM Version](https://img.shields.io/npm/v/%40dgreenheck%2Fez-tree)
![NPM Downloads](https://img.shields.io/npm/dw/%40dgreenheck%2Fez-tree)
![GitHub Repo stars](https://img.shields.io/github/stars/dgreenheck/ez-tree)
![X (formerly Twitter) Follow](https://img.shields.io/twitter/follow/dangreenheck)
![YouTube Channel Subscribers](https://img.shields.io/youtube/channel/subscribers/UCrdx_EU_Wx8_uBfqO0cI-9Q)

<p align="center">
<img src="https://github.com/user-attachments/assets/cb5f5edd-3e1b-453d-925f-734965126b17">
</p>

# About
EZ-Tree is a procedural tree generator with dozens of tunable parameters. The standalone tree generation code is published as a library and can be imported into your own application for dynamically generating trees on demand. Additionally, there is a standalone web app which allows you to create trees within the browser and export as .PNG or .GLB files.

# App
https://eztree.dev

# Installation

```js
npm i @dgreenheck/ez-tree
```

# Usage

```js
// Create new instance
const tree = new Tree();

// Set parameters
tree.options.seed = 12345;
tree.options.trunk.length = 20;
tree.options.branch.levels = 3;

// Generate tree and add to your Three.js scene
tree.generate();
scene.add(tree);
```

Any time the tree parameters are changed, you must call `generate()` to regenerate the geometry.

## Levels of Detail (LODs)

For scenes with many trees, `generateLODs()` builds the tree at multiple levels of detail hosted in a `THREE.LOD` object inside the tree group. The renderer automatically switches levels based on camera distance. All levels derive from the same skeleton. Mesh levels simplify branches and foliage; the last level uses a baked whole-tree impostor.

```js
const tree = new Tree();
tree.loadPreset('Ash Medium');
tree.generateLODs(Tree.defaultLODLevels, renderer); // instead of generate()
scene.add(tree);
```

The default levels (`Tree.defaultLODLevels`) are:

| Level | Distance | Tree triangles |
| --- | ---: | --- |
| LOD0 | 0 | Full detail |
| LOD1 | 100 | Approximately 40% |
| LOD2 | 250 | Approximately 20% |
| LOD3 | 400 | Budget of 1,400 (bundled presets: 1,028–1,400) |
| LOD4 | 700 | 4: two crossed, double-sided impostor cards |

LOD3 keeps thick branches with triangular cross-sections and distributes enlarged leaf cards across the canopy. `triangleBudget` overrides the other meshing controls. Very sparse custom trees can fall below 800 triangles; small presets whose LOD2 already falls below 800 can have a larger LOD3. The budget excludes the optional trellis support mesh, which remains separate.

LOD4 bakes front and side views into a 1024×512 RGBA atlas. It is static (no wind), uses an unlit alpha-cutout material, and remains visible from side angles without camera-facing shaders. Its atlas/material export with the GLB. It is intended for distant, roughly ground-level views, not overhead views.

**Wait for source textures to finish loading before baking LOD4.** The demo preloads its selectable textures. Baking requires a browser canvas and WebGL; pass your renderer to reuse its context. If omitted, a shared offscreen renderer is created lazily. Headless geometry-only callers can use `Tree.defaultLODLevels.slice(0, 4)` to exclude the impostor. Existing LOD0–2 geometry settings are unchanged; default generation and ZIP export now include five levels.

You can pass custom levels:

```js
tree.generateLODs([
  { distance: 0, detail: {} }, // full detail
  {
    distance: 80,
    hysteresis: 0.05,
    detail: {
      sectionStride: 3,    // sample every 3rd ring along each branch
      segmentFactor: 0.75, // reduce radial segments to 75% (min 3)
      leafStride: 2,       // keep every 2nd leaf...
      leafScale: 1.4,      // ...enlarged to preserve canopy coverage
      billboard: 'single', // drop the second crossed leaf quad
    },
  },
]);
```

LOD0–3 share one bark material and one leaf material, so `tree.update(time)` animates their wind. LOD4 owns a static atlas/material. Calling `generate()` afterwards tears the LOD down and restores the single full-detail mesh pair (note that exporting a tree generated with `generateLODs()` to GLB will include every level).

If you have your own LOD or instancing system, `tree.createGeometry(detail, renderer?)` returns raw `{ branches, leaves }` geometry without touching the tree's own meshes. For `{ impostor: true }`, it also returns **`leavesMaterial`**, which must be used with the returned leaf geometry (branch geometry is empty). Dispose both geometries when done; disposing impostor leaf geometry also releases its owned atlas and material, never the source textures. Do not dispose it while clones still share it.

`tree.applyDetail(detail, renderer?)` replaces the visible mesh pair and handles its material and disposal automatically, as used by the preview buttons. It tears down any automatic LOD group. `generate()` restores full detail.

### LOD checks

```sh
npm run build:lib
node tests/lod.test.mjs
# Browser/WebGL + GLB round-trip checks (serve the repository root):
npx vite --host 127.0.0.1 --port 5199
# Open http://127.0.0.1:5199/tests/lod.browser.html; expect PASS.
```

The browser check uses a synthetic alpha-cutout leaf texture so it also works before Git LFS texture assets have been downloaded.

# Tree Studio (Deinterleaver)

A preview, tuning and export tool for the game's ten tree species (`src/studio`).

```bash
npm run fetch:textures        # once: real bark images into .cache/textures
npm run studio                # http://localhost:5200 (STUDIO_PORT=5201 to move it)
DEINTERLEAVER_GAME_ROOT=/path/to/game npm run studio   # export somewhere else
```

- **Rail**: species by biome with height range, variant count and export status
  (not exported / exported / changed since export, from the game's `catalog.json`
  and `.cache/studio/stamps.json`).
- **Variant strip**: ten cached thumbnails; click selects, shift-click compares two.
- **Viewport**: orbit camera, sky and sun with shadows, biome-tinted ground, a 1.75 m
  figure for scale, metre grid (G), wind sway (V), wireframe (X), forest mode (T:
  ~60 trees of the species or the whole biome, WASD walk).
- **LOD tab**: Auto (by camera distance, with a 5 → 1500 m fly-out and a telephoto
  inset) or pinned Full/LOD1..LOD4; per-level triangles; end distances, chain length
  and impostor mode (cross / card, card previewed Y-billboarded).
- **Design tab**: live form parameters. Each is fixed or varied per variant (`~`),
  plus height range, leaf colours and tints, bark tint and a per-variant seed nudge.
  Saving writes `src/lib/species/overrides/<id>.json` (a sparse patch over the species
  def; `null` deletes a key). `src/studio/overrides.js` applies it for the preview, the
  studio export and `npm run export:all`, so an exported tree equals the previewed one.
- **Inspect tab**: height, trunk radius, triangles, packed texture sets (bark, leaves,
  impostor atlas + normal), wind, catalog slots.
- **Export tab**: target folder, Export species / Export all (confirms before
  overwriting), progress and a log of files and slots.

Press `?` in the studio for every shortcut. Headless check (screenshots plus the
override round trip; the game root must be a scratch folder):

```bash
DEINTERLEAVER_GAME_ROOT=/tmp/scratch-game npm run studio:shots -- /tmp/shots
```

# Running Standalone App Locally

To run the standalone app locally, you first need to build the EZ-Tree library before running the app.

```bash
npm install
npm run app
```

# Running App with Docker

```bash
docker compose build
docker compose up -d
```

# Tree Parameters

The `TreeOptions` class defines an options object that controls various parameters of a procedurally generated tree. Each property of this object allows for customization of the tree's appearance, including bark, branches, and leaves. Below is a detailed explanation of each property of the `TreeOptions` object.

## General Properties

- **`seed`**: Sets the initial value for random generation, ensuring consistent tree generation when using the same seed.
- **`type`**: Defines the type of the tree, which can be set to one of the options from the `TreeType` enumeration (e.g., `TreeType.Deciduous`).

## Bark Parameters

The `bark` object controls the appearance and properties of the tree trunk.

- **`type`**: Specifies the type of bark texture to use, selected from the `BarkType` enumeration (e.g., `BarkType.Oak`).
- **`tint`**: Determines the color tint applied to the bark, defined as a hexadecimal color value (e.g., `0xffffff` for white).
- **`flatShading`**: Boolean property indicating whether to use flat shading (`true`) or smooth shading (`false`) for the bark.
- **`textured`**: Boolean value that indicates if a texture is applied to the bark (`true` or `false`).
- **`textureScale`**: Controls the scale of the bark texture in both the `x` and `y` axes. It is an object with properties `x` and `y` to define the scaling factors.

## Branch Parameters

The `branch` object defines parameters for the trunk and branch levels of the tree.

- **`levels`**: Number of recursive branch levels. Setting this to `0` creates only the trunk, while higher values add more branches.
- **`angle`**: Defines the angle, in degrees, at which child branches grow relative to their parent branch. This is specified separately for each level.
- **`children`**: Specifies the number of child branches at each level, with the index (`0`, `1`, `2`, etc.) representing the level.
- **`force`**: Represents an external directional force encouraging tree growth, defined by `direction` (a vector object `{ x, y, z }`) and `strength` (a numeric value).
- **`gnarliness`**: Defines how twisted or curled each branch level should be, specified for each level.
- **`length`**: Length of the branches at each level. This is an object with keys representing each level.
- **`radius`**: Radius (or thickness) of the branches at each level.
- **`sections`**: Number of segments along the length of each branch level, controlling the resolution of the branch mesh.
- **`segments`**: Number of radial segments that make up each branch, with a higher value resulting in a smoother cylinder.
- **`start`**: Specifies where along the parent branch (as a fraction from `0` to `1`) the child branches should start forming.
- **`taper`**: Controls the tapering of the branches at each level. A value between `0` and `1` defines the reduction in radius from base to tip.
- **`twist`**: Defines the amount of twisting applied to each branch level.

## Leaf Parameters

The `leaves` object defines properties that control the appearance and placement of leaves.

- **`type`**: Specifies the type of leaf texture, selected from the `LeafType` enumeration (e.g., `LeafType.Oak`).
- **`billboard`**: Defines how leaves are rendered. The `Billboard` enumeration can be set to `Single` or `Double` to indicate single or perpendicular double-sided leaves.
- **`angle`**: Defines the angle of the leaves relative to the parent branch, in degrees.
- **`count`**: Number of leaves to generate.
- **`start`**: Specifies where along the length of the branch (as a value between `0` and `1`) leaves should start growing.
- **`size`**: Size of the leaves, represented as a numeric value.
- **`sizeVariance`**: Specifies how much variance in size each leaf instance should have, making the leaves look more natural.
- **`tint`**: Tint color applied to the leaves, defined as a hexadecimal color value (e.g., `0xffffff` for white).
- **`alphaTest`**: Sets the alpha threshold for leaf transparency, controlling the transparency of the leaf textures.

