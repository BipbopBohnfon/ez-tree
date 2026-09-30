// Offscreen variant thumbnails: LOD0 drawn by a small dedicated renderer
// (its own canvas, so tone mapping and sRGB output match the viewport) and
// copied into a fresh canvas. Callers cache by key.
import * as THREE from 'three';

const W = 200, H = 250;

export class ThumbRenderer {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setSize(W, H, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.4);
    sun.position.set(0.6, 1, 0.8);
    this.scene.add(sun, new THREE.HemisphereLight(0xcfe3ff, 0x4a4030, 1.1));
    this.camera = new THREE.PerspectiveCamera(30, W / H, 0.1, 2000);
  }

  /** @param {ReturnType<import('@dgreenheck/ez-tree').buildVariant>} variant @returns {HTMLCanvasElement} */
  render(variant) {
    const group = variant.lod.levels[0].object.clone();
    group.visible = true;
    this.scene.add(group);
    const b = variant.bounds;
    const size = b.getSize(new THREE.Vector3());
    const span = Math.max(size.y, Math.max(size.x, size.z) * (H / W));
    const dist = (span * 0.56) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const center = b.getCenter(new THREE.Vector3());
    this.camera.position.set(center.x + dist * 0.6, center.y + dist * 0.12, center.z + dist * 0.8);
    this.camera.lookAt(center);
    this.renderer.render(this.scene, this.camera);
    this.scene.remove(group);
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.getContext('2d').drawImage(this.renderer.domElement, 0, 0);
    return canvas;
  }
}
