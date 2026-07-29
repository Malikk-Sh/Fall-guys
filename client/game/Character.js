import * as THREE from '/vendor/three.module.js';
import { COLORS } from '../core/Config.js';

const standard = (color, roughness = 0.28, metalness = 0.02) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness });
function capsule(radius, length, color, segments = 10) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 6, segments), standard(color));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export class Character {
  constructor(scene, { color = COLORS.pink, accent = COLORS.yellow, name = '', remote = false } = {}) {
    this.group = new THREE.Group();
    this.visual = new THREE.Group();
    this.group.add(this.visual);
    this.remote = remote;
    this.phase = Math.random() * Math.PI * 2;
    this.landPulse = 0;
    this.state = 'idle';
    const body = capsule(0.48, 0.58, color, 14);
    body.scale.set(1.06, 1, 0.93);
    body.position.y = 0.82;
    this.visual.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 10), standard(accent, 0.24));
    belly.scale.set(1, 0.68, 0.18);
    belly.position.set(0, 0.78, -0.43);
    belly.castShadow = true;
    this.visual.add(belly);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 10), standard(0xdffcff, 0.12, 0.1));
    visor.scale.set(1, 0.58, 0.2);
    visor.position.set(0, 1.18, -0.46);
    visor.castShadow = true;
    this.visual.add(visor);
    const eyeMat = standard(COLORS.ink, 0.22);
    for (const x of [-0.105, 0.105]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), eyeMat);
      eye.position.set(x, 1.2, -0.525);
      eye.scale.z = 0.35;
      this.visual.add(eye);
    }
    const antenna = new THREE.Group(),
      stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.22, 7), standard(accent));
    stem.position.y = 0.11;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), standard(accent, 0.2));
    tip.position.y = 0.25;
    antenna.add(stem, tip);
    antenna.position.y = 1.6;
    this.visual.add(antenna);
    this.antenna = antenna;
    this.leftArm = this.limb(-0.53, 0.9, color, true);
    this.rightArm = this.limb(0.53, 0.9, color, true);
    this.leftLeg = this.limb(-0.25, 0.28, color, false);
    this.rightLeg = this.limb(0.25, 0.28, color, false);
    this.visual.add(this.leftArm, this.rightArm, this.leftLeg, this.rightLeg);
    for (const leg of [this.leftLeg, this.rightLeg]) {
      const boot = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 7), standard(COLORS.purpleDark, 0.3));
      boot.scale.set(1.05, 0.65, 1.3);
      boot.position.set(0, -0.42, -0.08);
      boot.castShadow = true;
      leg.add(boot);
    }
    if (name) this.addNameplate(name);
    this.group.position.set(0, 1.15, 7);
    scene.add(this.group);
    this.scene = scene;
  }
  limb(x, y, color, arm) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const part = capsule(arm ? 0.105 : 0.14, arm ? 0.32 : 0.3, color, 8);
    part.position.y = arm ? -0.2 : -0.22;
    part.rotation.z = arm ? (x < 0 ? -0.1 : 0.1) : 0;
    pivot.add(part);
    return pivot;
  }
  addNameplate(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 80;
    const ctx = canvas.getContext('2d');
    ctx.font = '900 31px Trebuchet MS';
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 10;
    ctx.strokeText(name, 192, 48);
    ctx.fillStyle = '#2b1768';
    ctx.fillText(name, 192, 48);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })
    );
    sprite.position.y = 2.1;
    sprite.scale.set(3.3, 0.69, 1);
    this.group.add(sprite);
    this.nameplate = sprite;
  }
  setColor(color, accent) {
    this.visual.children[0].material.color.setHex(color);
    this.visual.children[1].material.color.setHex(accent);
  }
  animate(dt, { speed = 0, grounded = true, vertical = 0, diving = false } = {}) {
    this.phase += dt * (4 + speed * 1.25);
    const run = Math.min(1, speed / 7),
      swing = Math.sin(this.phase) * run;
    this.state = diving ? 'dive' : !grounded ? 'air' : run > 0.08 ? 'run' : 'idle';
    if (this.state === 'run') {
      this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, swing * 0.82, 13, dt);
      this.rightArm.rotation.x = THREE.MathUtils.damp(this.rightArm.rotation.x, -swing * 0.82, 13, dt);
      this.leftLeg.rotation.x = THREE.MathUtils.damp(this.leftLeg.rotation.x, -swing * 0.68, 15, dt);
      this.rightLeg.rotation.x = THREE.MathUtils.damp(this.rightLeg.rotation.x, swing * 0.68, 15, dt);
    } else if (this.state === 'air') {
      const arm = -0.9 - Math.max(0, vertical) * 0.025;
      this.leftArm.rotation.x = THREE.MathUtils.damp(this.leftArm.rotation.x, arm, 10, dt);
      this.rightArm.rotation.x = THREE.MathUtils.damp(this.rightArm.rotation.x, arm, 10, dt);
      this.leftLeg.rotation.x = THREE.MathUtils.damp(this.leftLeg.rotation.x, 0.28, 10, dt);
      this.rightLeg.rotation.x = THREE.MathUtils.damp(this.rightLeg.rotation.x, -0.28, 10, dt);
    } else {
      for (const limb of [this.leftArm, this.rightArm, this.leftLeg, this.rightLeg])
        limb.rotation.x = THREE.MathUtils.damp(limb.rotation.x, 0, 8, dt);
    }
    const diveAngle = diving ? -1.24 : 0;
    this.visual.rotation.x = THREE.MathUtils.damp(this.visual.rotation.x, diveAngle, diving ? 13 : 9, dt);
    this.visual.position.y =
      Math.sin(this.phase * 0.5) * 0.025 * (1 - run) + Math.abs(Math.sin(this.phase)) * run * 0.055;
    this.visual.rotation.z = Math.sin(this.phase * 0.5) * 0.018 * (1 - run);
    this.antenna.rotation.z = Math.sin(this.phase * 0.85) * 0.14;
    this.landPulse = Math.max(0, this.landPulse - dt * 4.4);
    const squash = Math.sin(this.landPulse * Math.PI) * 0.16;
    this.visual.scale.set(1 + squash * 0.55, 1 - squash, 1 + squash * 0.55);
  }
  landed(strength = 1) {
    this.landPulse = Math.min(1, 0.45 + strength * 0.4);
  }
  dispose() {
    this.scene.remove(this.group);
  }
}
