import * as THREE from 'three';
import { Character } from '../Character.js';

const FRONT_ANGLE = Math.PI - 0.32;
const AUTO_ROTATE_DELAY = 2.6;

export class CosmeticPreview {
  constructor(canvas, { reducedMotion = false, quality = 'high' } = {}) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.disposed = false;
    this.autoRotate = false;
    this.idle = 0;
    this.angle = this.targetAngle = FRONT_ANGLE;
    this.dragging = false;
    this.pointerId = null;
    this.lastPointerX = 0;
    this.loadout = {};
    this.thumbnailCache = new Map();
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality !== 'low',
      alpha: true,
      powerPreference: 'low-power'
    });
    this.renderer.setPixelRatio(Math.min(1.75, globalThis.devicePixelRatio || 1));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = quality === 'high';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    this.scene.add(new THREE.HemisphereLight(0xe4f0ff, 0x242e4a, 1.5));
    const key = new THREE.DirectionalLight(0xfff3df, 3.2);
    key.position.set(-3, 5, 4);
    key.castShadow = quality === 'high';
    key.shadow.mapSize.set(512, 512);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 3, bottom: -2, near: 0.1, far: 14 });
    key.shadow.normalBias = 0.025;
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x85e9ff, 2.5);
    rim.position.set(3, 2.5, -3);
    this.scene.add(rim);
    const fill = new THREE.DirectionalLight(0xd0a6ff, 0.65);
    fill.position.set(3, 1, 4);
    this.scene.add(fill);
    this.stage = new THREE.Group();
    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(0.9, 1, 0.16, 64),
      new THREE.MeshStandardMaterial({ color: 0x28364f, roughness: 0.44, metalness: 0.3 })
    );
    platform.position.y = -0.08;
    platform.receiveShadow = true;
    this.stage.add(platform);
    const lightRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.014, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0x88eee2, toneMapped: false })
    );
    lightRing.rotation.x = Math.PI / 2;
    lightRing.position.y = 0.003;
    this.stage.add(lightRing);
    this.scene.add(this.stage);
    this.pivot = new THREE.Group();
    this.scene.add(this.pivot);
    this.character = this.createCharacter();
    this.bindPointer();
    if (typeof globalThis.ResizeObserver === 'function') {
      this.resizeObserver = new globalThis.ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    this.resize();
  }

  bindPointer() {
    const start = event => {
      if (this.dragging || (event.button !== undefined && event.button !== 0)) return;
      this.dragging = true;
      this.pointerId = event.pointerId;
      this.idle = 0;
      this.lastPointerX = event.clientX;
      this.canvas.setPointerCapture?.(event.pointerId);
    };
    const move = event => {
      if (!this.dragging || event.pointerId !== this.pointerId) return;
      this.targetAngle += (event.clientX - this.lastPointerX) * 0.011;
      this.lastPointerX = event.clientX;
      this.idle = 0;
      event.preventDefault();
    };
    const end = event => {
      if (event.pointerId !== this.pointerId) return;
      this.dragging = false;
      const pointerId = this.pointerId;
      this.pointerId = null;
      if (this.canvas.hasPointerCapture?.(pointerId)) this.canvas.releasePointerCapture(pointerId);
    };
    const key = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') this.resetRotation();
      else this.targetAngle += event.key === 'ArrowLeft' ? -0.25 : 0.25;
      this.idle = 0;
    };
    this.handlers = { start, move, end, key };
    this.canvas.addEventListener('pointerdown', start);
    this.canvas.addEventListener('pointermove', move, { passive: false });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      this.canvas.addEventListener(type, end);
    this.canvas.addEventListener('keydown', key);
  }

  setLoadout(loadout) {
    if (this.disposed) return;
    this.loadout = { ...loadout };
    this.character.setCosmetics(this.loadout);
    this.frameCharacter();
  }

  createCharacter() {
    const character = new Character(this.pivot, { name: '', remote: false });
    character.group.position.set(0, 0, 0);
    character.group.rotation.y = FRONT_ANGLE;
    const bounds = new THREE.Box3().setFromObject(character.group);
    character.group.position.y = -bounds.min.y + 0.025;
    return character;
  }

  frameCharacter(character = this.character) {
    const box = new THREE.Box3().setFromObject(character.group);
    box.expandByObject(this.stage);
    const size = box.getSize(new THREE.Vector3()),
      center = box.getCenter(new THREE.Vector3());
    const vertical = Math.max(size.y + 0.18, 1.85),
      horizontal = Math.max(size.x + 0.3, 1.75);
    const distance =
      Math.max(vertical, horizontal / this.camera.aspect) /
      (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    this.camera.position.set(0, center.y + 0.3, distance + size.z * 0.5);
    this.camera.lookAt(0, center.y - 0.08, 0);
  }

  // One context serves both the showroom and every card. A neutral mannequin keeps
  // thumbnails independent of the live pose/emote, without rebuilding the inspected outfit.
  // Read immediately after render: preserveDrawingBuffer stays off.
  thumbnail(item, baseBody) {
    return this.snapshot({ body: baseBody, [item.slot]: item }, item.id);
  }

  snapshot(loadout, key) {
    if (this.disposed) return null;
    if (this.thumbnailCache.has(key)) return this.thumbnailCache.get(key);
    this.thumbnailCharacter ||= this.createCharacter();
    const ratio = this.renderer.getPixelRatio();
    let result = null;
    try {
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(192, 192, false);
      this.camera.aspect = 1;
      this.camera.updateProjectionMatrix();
      this.character.group.visible = false;
      this.thumbnailCharacter.group.visible = true;
      this.thumbnailCharacter.setCosmetics(loadout);
      this.frameCharacter(this.thumbnailCharacter);
      this.renderer.render(this.scene, this.camera);
      result = this.canvas.toDataURL('image/png');
      if (this.thumbnailCache.size >= 96) this.thumbnailCache.delete(this.thumbnailCache.keys().next().value);
      this.thumbnailCache.set(key, result);
    } finally {
      this.thumbnailCharacter.group.visible = false;
      this.character.group.visible = true;
      this.renderer.setPixelRatio(ratio);
      this.resize();
      this.renderer.render(this.scene, this.camera);
    }
    return result;
  }

  playEmote(id) {
    return !this.disposed && !this.reducedMotion && this.character.playEmote(id);
  }
  playFinish() {
    return !this.disposed && !this.reducedMotion && Boolean(this.character.cosmetics?.playFinish());
  }
  resetRotation() {
    this.targetAngle = FRONT_ANGLE;
    this.idle = 0;
  }
  setAutoRotate(enabled) {
    this.autoRotate = Boolean(enabled);
    this.idle = 0;
  }
  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
  }

  resize() {
    if (this.disposed) return;
    const width = Math.max(80, this.canvas.clientWidth || 320),
      height = Math.max(80, this.canvas.clientHeight || 380);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.frameCharacter();
  }

  update(dt) {
    if (this.disposed) return;
    // A queued RAF timestamp can precede a costly first render. Negative time makes
    // exponential damping explode; resuming a hidden tab must not fast-forward a pose either.
    dt = Number.isFinite(dt) ? THREE.MathUtils.clamp(dt, 0, 0.05) : 0;
    this.idle += dt;
    if (this.autoRotate && !this.dragging && !this.reducedMotion && this.idle > AUTO_ROTATE_DELAY)
      this.targetAngle += dt * 0.32;
    this.angle = this.reducedMotion
      ? this.targetAngle
      : THREE.MathUtils.damp(this.angle, this.targetAngle, 9, dt);
    this.character.group.rotation.y = this.angle;
    if (!this.reducedMotion)
      this.character.animate(dt, { speed: 0, grounded: true, vertical: 0, diving: false });
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.canvas.removeEventListener('pointerdown', this.handlers.start);
    this.canvas.removeEventListener('pointermove', this.handlers.move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      this.canvas.removeEventListener(type, this.handlers.end);
    this.canvas.removeEventListener('keydown', this.handlers.key);
    this.character.dispose();
    this.thumbnailCharacter?.dispose();
    this.stage.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    this.thumbnailCache.clear();
    this.renderer.dispose();
  }
}
