import * as THREE from '/vendor/three.module.js';

export class CameraController {
  constructor(camera) {
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.08;
    this.distance = 8.2;
    this.manualTimer = 0;
    this.target = new THREE.Vector3();
    this.desired = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.mobile =
      !!globalThis.matchMedia?.('(pointer:coarse)').matches ||
      (globalThis.navigator?.maxTouchPoints || 0) > 0;
  }
  reset(player, instant = false) {
    this.yaw = player?.character.group.rotation.y || 0;
    this.pitch = 0.08;
    this.manualTimer = 0;
    if (instant && player) {
      const p = player.position;
      this.camera.position.set(p.x, p.y + 4.7, p.z + 8.2);
      this.target.set(p.x, p.y + 1, p.z - 2);
    }
  }
  update(dt, player, input, course) {
    const orbit = input.consumeCamera();
    if (Math.abs(orbit.x) + Math.abs(orbit.y) > 0.01) {
      const sensitivity = this.mobile ? 0.0062 : 0.0046;
      this.yaw -= orbit.x * sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch - orbit.y * sensitivity * 0.72, -0.13, 0.48);
      this.manualTimer = 2.25;
    } else this.manualTimer = Math.max(0, this.manualTimer - dt);
    if (input.consume('recenter')) {
      this.yaw = player.character.group.rotation.y;
      this.pitch = 0.08;
      this.manualTimer = 0;
    }
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    if (this.manualTimer <= 0 && speed > 1.2) {
      let delta = ((player.character.group.rotation.y - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * (1 - Math.exp(-1.8 * dt));
    }
    const portrait = (globalThis.innerHeight || 800) > (globalThis.innerWidth || 1280),
      distance = this.mobile ? (portrait ? 8.9 : 8.2) : 8.2,
      height = (portrait ? 5.25 : 4.65) + this.pitch * 4.6;
    this.distance = THREE.MathUtils.damp(this.distance, distance, 5, dt);
    const lead = Math.min(2.8, speed * 0.24);
    const forward = new THREE.Vector3(
      -Math.sin(player.character.group.rotation.y),
      0,
      -Math.cos(player.character.group.rotation.y)
    );
    this.target
      .set(player.position.x, player.position.y + 1.05, player.position.z)
      .addScaledVector(forward, 1.7 + lead);
    this.desired.set(
      player.position.x + Math.sin(this.yaw) * this.distance,
      player.position.y + height,
      player.position.z + Math.cos(this.yaw) * this.distance
    );
    const direction = this.desired.clone().sub(this.target),
      wantedDistance = direction.length();
    direction.normalize();
    this.raycaster.set(this.target, direction);
    this.raycaster.far = wantedDistance;
    const hit = this.raycaster.intersectObjects(course.cameraMeshes, false)[0];
    if (hit && hit.distance < wantedDistance)
      this.desired.copy(this.target).addScaledVector(direction, Math.max(2.2, hit.distance - 0.45));
    this.camera.position.lerp(this.desired, 1 - Math.exp(-7.5 * dt));
    this.camera.lookAt(this.target);
    const wantedFov = (this.mobile ? (portrait ? 66 : 61) : 58) + Math.min(7, speed * 0.55);
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, wantedFov, 5, dt);
    this.camera.updateProjectionMatrix();
  }
}
