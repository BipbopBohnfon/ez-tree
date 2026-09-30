// Tree Studio viewport: sky + sun with shadows, biome-tinted ground, metre
// grid, a 1.75 m human for scale, orbit / walk camera, LOD selection by
// camera distance (or pinned), Y-billboarded impostor cards, vertex wind
// sway, wireframe, a fly-out dolly and a telephoto inset that keeps a far
// tree readable.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const SUN_ELEVATION = 36;
const SUN_AZIMUTH = 62;
const TAU = Math.PI * 2;

/** Shared uniforms for the wind sway patch. */
const wind = { uTime: { value: 0 }, uWindOn: { value: 0 } };
const patched = new WeakSet();

/**
 * Adds a cheap vertex sway (tip travel = bend * h^2, as the game's wind) to a
 * tree material. Geometry is in metres with y = 0 at the trunk base.
 */
export function patchWind(material, [bend, rate]) {
  if (!material || patched.has(material)) return;
  patched.add(material);
  const uniforms = { uBend: { value: bend }, uRate: { value: rate } };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, wind, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime, uWindOn, uBend, uRate;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        vec3 root = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float ph = dot(root.xz, vec2(0.37, 0.71));
        float w = uTime * uRate * 6.2831853;
        float hh = max(transformed.y, 0.0);
        float k = uWindOn * uBend * hh * hh;
        transformed.x += k * (0.75 * sin(w + ph) + 0.25 * sin(2.3 * w + 1.7 * ph));
        transformed.z += k * 0.45 * cos(0.8 * w + ph);
      }`);
  };
  material.customProgramCacheKey = () => 'studio-wind';
  material.needsUpdate = true;
}

/** Clear-day gradient dome with a soft sun glow (cheaper and calmer than the Preetham sky). */
function gradientSky(sunDir) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      zenith: { value: new THREE.Color(0x2f67a8) },
      horizon: { value: new THREE.Color(0xc6d9e8) },
      ground: { value: new THREE.Color(0x8d9aa3) },
      sun: { value: sunDir.clone() },
    },
    vertexShader: `varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: `uniform vec3 zenith, horizon, ground, sun; varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 c = y > 0.0 ? mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(horizon, ground, clamp(-y * 6.0, 0.0, 1.0));
        float s = max(dot(normalize(vDir), normalize(sun)), 0.0);
        c += vec3(1.0, 0.92, 0.78) * (pow(s, 900.0) * 3.0 + pow(s, 24.0) * 0.18);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.scale.setScalar(15000);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return mesh;
}

function groundTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b4b4b4';
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * size, y = rnd() * size, r = 1 + rnd() * 7;
    const v = 150 + rnd() * 80;
    ctx.fillStyle = `rgba(${v},${v},${v},${0.15 + rnd() * 0.25})`;
    for (const [dx, dy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      ctx.beginPath(); ctx.arc(x + dx, y + dy, r, 0, TAU); ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(800, 800);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function human() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a3038, roughness: 0.8 });
  const g = new THREE.Group();
  g.name = 'human-1.75m';
  const add = (geometry, x, y, z = 0, rz = 0) => {
    const m = new THREE.Mesh(geometry, mat);
    m.position.set(x, y, z); m.rotation.z = rz; m.castShadow = true; g.add(m);
  };
  add(new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), -0.1, 0.44);
  add(new THREE.CapsuleGeometry(0.075, 0.72, 4, 10), 0.1, 0.44);
  add(new THREE.CapsuleGeometry(0.17, 0.42, 6, 14), 0, 1.13);
  add(new THREE.CapsuleGeometry(0.05, 0.56, 4, 8), -0.25, 1.1, 0, 0.08);
  add(new THREE.CapsuleGeometry(0.05, 0.56, 4, 8), 0.25, 1.1, 0, -0.08);
  add(new THREE.SphereGeometry(0.105, 16, 12), 0, 1.645);
  g.userData.dispose = () => { mat.dispose(); g.traverse((o) => o.geometry?.dispose()); };
  return g;
}

export class Viewport {
  constructor(canvas, telephotoEl) {
    this.canvas = canvas;
    this.telephotoEl = telephotoEl;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 30000);
    this.camera.position.set(18, 7, 22);
    this.tele = new THREE.PerspectiveCamera(5, 220 / 260, 0.1, 30000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.maxDistance = 4000;
    this.controls.minDistance = 0.5;
    this.controls.addEventListener('start', () => { this.flight = null; });

    this.#sky();
    this.#ground();

    this.human = human();
    this.scene.add(this.human);

    this.trees = new THREE.Group();
    this.scene.add(this.trees);
    this.entries = [];
    this.lodMode = 'auto';
    this.focus = { center: new THREE.Vector3(0, 6, 0), radius: 8, height: 12, lods: [30] };
    this.keys = new Set();
    this.walk = false;
    this.clock = new THREE.Clock();
    this.info = { distance: 0, level: 0, culled: false };
    this.frameListeners = [];
    this.frames = 0;
    this.fps = 60;

    window.addEventListener('keydown', (e) => { if (!e.target.closest?.('input, textarea')) this.keys.add(e.code); });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
    this.renderer.setAnimationLoop(() => this.#tick());
  }

  #sky() {
    this.sunDir = new THREE.Vector3().setFromSphericalCoords(1,
      THREE.MathUtils.degToRad(90 - SUN_ELEVATION), THREE.MathUtils.degToRad(SUN_AZIMUTH));
    const sky = gradientSky(this.sunDir);
    this.scene.add(sky);

    // Image-based light from the same sky (soft fill).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(gradientSky(this.sunDir));
    this.scene.environment = pmrem.fromScene(envScene, 0.02).texture;
    this.scene.environmentIntensity = 0.95;
    pmrem.dispose();

    this.sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xcfe3ff, 0x4a4030, 0.5);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.Fog(0xc6d9e8, 1200, 9000);
  }

  #ground() {
    this.groundMat = new THREE.MeshStandardMaterial({ color: 0x5f7a45, roughness: 0.98, map: groundTexture() });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(8000, 64), this.groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.scene.add(ground);
    const minor = new THREE.GridHelper(60, 60, 0xffffff, 0xffffff);
    minor.material.transparent = true; minor.material.opacity = 0.13; minor.material.depthWrite = false;
    const major = new THREE.GridHelper(200, 20, 0xffffff, 0xffffff);
    major.material.transparent = true; major.material.opacity = 0.28; major.material.depthWrite = false;
    this.grid = new THREE.Group();
    this.grid.add(minor, major);
    this.grid.position.y = 0.015;
    this.grid.visible = false;
    this.scene.add(this.grid);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setBiomeColor(hex) { this.groundMat.color.set(hex); }
  setGrid(on) { this.grid.visible = on; }
  setWind(on) { wind.uWindOn.value = on ? 1 : 0; }
  setWireframe(on) {
    this.wireframe = on;
    this.#materials().forEach((m) => { m.wireframe = on; });
  }
  setLodMode(mode) { this.lodMode = mode; }

  #materials() {
    const set = new Set();
    this.trees.traverse((o) => { if (o.isMesh) set.add(o.material); });
    return set;
  }

  /**
   * Shows trees. `items`: [{variant, x?, z?, scale?, rotation?}], each a
   * buildVariant() result (owned by the caller). `forest` switches the
   * camera to walk mode and the focus to the patch.
   */
  show(items, { forest = false, keepCamera = false } = {}) {
    this.trees.clear();
    this.entries = [];
    const box = new THREE.Box3();
    for (const item of items) {
      const v = item.variant;
      for (const m of Object.values(v.materials)) patchWind(m, v.wind.leaves ?? v.wind.bark);
      const lod = items.length > 1 && forest ? v.lod.clone() : v.lod;
      lod.autoUpdate = false;
      lod.position.set(item.x ?? 0, 0, item.z ?? 0);
      lod.rotation.y = item.rotation ?? 0;
      lod.scale.setScalar(item.scale ?? 1);
      this.trees.add(lod);
      const card = v.impostorMode === 'card' && v.levels.at(-1)?.kind === 'impostor'
        ? lod.levels.at(-1).object : null;
      this.entries.push({ lod, variant: v, card, ends: v.lods });
      lod.updateMatrixWorld(true);
      const b = v.bounds.clone().applyMatrix4(lod.matrixWorld);
      box.union(b);
    }
    if (this.wireframe) this.setWireframe(true);
    if (box.isEmpty()) box.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const main = this.entries[0];
    this.focus = {
      center, radius: Math.max(size.x, size.z) / 2, height: size.y, box,
      origin: main ? main.lod.position.clone() : new THREE.Vector3(),
      lods: main?.ends ?? [30],
    };
    this.walk = forest;
    // Human beside the tree, just outside the crown on the default view's
    // left (between the two trees when comparing, at the patch edge in a forest).
    const reach = Math.max(size.x, size.z) / 2 + 1.2;
    if (forest) this.human.position.set(box.min.x - 3, 0, box.max.z + 6);
    else if (items.length === 2) this.human.position.set(center.x, 0, center.z + 1.5);
    else this.human.position.set(center.x - 0.77 * reach, 0, center.z + 0.63 * reach);
    this.human.visible = true;
    this.#fitShadow();
    if (!keepCamera) this.frame();
  }

  #fitShadow() {
    const { box } = this.focus;
    const r = Math.max(4, box.getBoundingSphere(new THREE.Sphere()).radius * 1.15);
    const c = box.getCenter(new THREE.Vector3());
    const cam = this.sun.shadow.camera;
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.5; cam.far = r * 4;
    cam.updateProjectionMatrix();
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(this.sunDir, r * 2);
  }

  /** Frames the current trees (orbit) or puts the camera at the patch edge (walk). */
  frame() {
    this.flight = null;
    const { center, height, radius, box } = this.focus;
    if (this.walk) {
      const eye = new THREE.Vector3(box.min.x - 6, 1.7, box.max.z + 10);
      this.camera.position.copy(eye);
      this.controls.target.set(center.x, Math.min(height * 0.35, 8), center.z);
    } else {
      const wide = radius * (this.entries.length === 2 ? 0.8 : 1.05) / this.camera.aspect;
      const half = Math.max(height * 0.55, wide);
      const dist = half / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) + radius * 0.45;
      const dir = new THREE.Vector3(0.62, 0.12, 0.76).normalize();
      this.controls.target.set(center.x, height * 0.46, center.z);
      this.camera.position.copy(this.controls.target).addScaledVector(dir, dist);
    }
    this.controls.update();
  }

  /** Puts the camera `d` metres from the focused tree's base along the current view direction. */
  setDistance(d) {
    const { origin, height } = this.focus;
    const target = new THREE.Vector3(origin.x, height * 0.5, origin.z);
    const dir = this.camera.position.clone().sub(target);
    dir.y = Math.max(dir.y, 0.05 * dir.length());
    dir.normalize();
    // Solve |target + dir*t - origin| = d for t (camera distance to the LOD pivot).
    const off = target.clone().sub(origin);
    const b = off.dot(dir);
    const t = -b + Math.sqrt(Math.max(0, b * b - (off.lengthSq() - d * d)));
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, Math.max(0.5, t));
    this.controls.update();
  }

  /** Dollies from `from` to `to` metres over `seconds` (exponential). */
  flyOut({ from = 5, to = 1500, seconds = 10 } = {}) {
    this.flight = { from, to, seconds, t: 0 };
  }
  get flying() { return !!this.flight; }
  stopFlight() { this.flight = null; }

  onFrame(fn) { this.frameListeners.push(fn); }

  #walk(dt) {
    if (!this.walk) return;
    const move = new THREE.Vector3();
    const fwd = this.controls.target.clone().sub(this.camera.position).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (this.keys.has('KeyW')) move.add(fwd);
    if (this.keys.has('KeyS')) move.sub(fwd);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (!move.lengthSq()) return;
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 22 : 6;
    move.normalize().multiplyScalar(speed * dt);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  #tick() {
    const dt = Math.min(0.1, this.clock.getDelta());
    wind.uTime.value += dt;
    this.frames++;
    this.fps = this.fps * 0.95 + (1 / Math.max(dt, 1e-4)) * 0.05;
    if (this.flight) {
      // Wall clock, so a slow frame rate does not stretch the flight.
      const f = this.flight;
      f.start ??= performance.now();
      f.t = (performance.now() - f.start) / 1000 / f.seconds;
      const k = Math.min(1, f.t);
      this.setDistance(f.from * Math.pow(f.to / f.from, k));
      if (k >= 1) this.flight = null;
    }
    this.#walk(dt);
    this.controls.update();

    const camPos = this.camera.position;
    const pos = new THREE.Vector3();
    const hist = [0, 0, 0, 0, 0, 0];
    let nearest = Infinity;
    this.entries.forEach((e, i) => {
      const lod = e.lod;
      pos.setFromMatrixPosition(lod.matrixWorld);
      const d = camPos.distanceTo(pos);
      const levels = lod.levels;
      let level = 0;
      if (this.lodMode === 'auto') {
        while (level < levels.length - 1 && d >= levels[level + 1].distance) level++;
      } else {
        level = Math.min(Number(this.lodMode), levels.length - 1);
      }
      const culled = this.lodMode === 'auto' && d > e.ends[e.ends.length - 1];
      levels.forEach((l, k) => { l.object.visible = !culled && k === level; });
      if (e.card) {
        e.card.rotation.y = Math.atan2(camPos.x - pos.x, camPos.z - pos.z) - lod.rotation.y;
      }
      hist[culled ? 5 : level]++;
      nearest = Math.min(nearest, d);
      if (i === 0) this.info = { distance: d, level, culled, pinned: this.lodMode !== 'auto', count: levels.length };
    });
    this.info.hist = hist;
    this.info.nearest = nearest;

    const r = this.renderer;
    r.setScissorTest(false);
    r.setViewport(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    r.render(this.scene, this.camera);
    this.#telephoto();
    for (const fn of this.frameListeners) fn(this.info);
  }

  /** Narrow-FOV inset from the same eye point, so LOD swaps stay visible when the tree is a few pixels. */
  #telephoto() {
    const el = this.telephotoEl;
    const main = this.entries[0];
    const show = !this.walk && main && this.entries.length === 1 && this.info.distance > 60 && !this.info.culled;
    el.classList.toggle('on', !!show);
    if (!show) return;
    const rect = el.getBoundingClientRect();
    const host = this.canvas.getBoundingClientRect();
    const x = rect.left - host.left, y = host.bottom - rect.bottom;
    const { height } = this.focus;
    const target = new THREE.Vector3().setFromMatrixPosition(main.lod.matrixWorld);
    target.y += height * 0.5;
    const d = this.camera.position.distanceTo(target);
    this.tele.position.copy(this.camera.position);
    this.tele.aspect = rect.width / rect.height;
    this.tele.fov = Math.max(0.02, THREE.MathUtils.radToDeg(2 * Math.atan((height * 0.62) / d)));
    this.tele.far = d * 3;
    this.tele.near = Math.max(0.1, d * 0.2);
    this.tele.lookAt(target);
    this.tele.updateProjectionMatrix();
    const r = this.renderer;
    r.setScissorTest(true);
    r.setScissor(x, y, rect.width, rect.height);
    r.setViewport(x, y, rect.width, rect.height);
    // Fog off for the inset without a program switch: push it out of range.
    const fog = this.scene.fog;
    const [near, far] = [fog.near, fog.far];
    fog.near = 1e7; fog.far = 2e7;
    r.render(this.scene, this.tele);
    fog.near = near; fog.far = far;
    r.setScissorTest(false);
  }
}
