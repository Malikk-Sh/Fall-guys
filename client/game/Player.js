import * as THREE from '/vendor/three.module.js';
import { COLORS } from '../core/Config.js';
import { Character } from './Character.js';

const FOOT = 0.48;

export class Player {
  constructor(scene, course, effects, options = {}) {
    this.course = course;
    this.effects = effects;
    this.character = new Character(scene, options);
    this.velocity = new THREE.Vector3();
    this.checkpoint = 0;
    this.spawn = course.spawnFor(0);
    this.character.group.position.copy(this.spawn);
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.diveTimer = 0;
    this.diveCooldown = 0;
    this.finished = false;
    this.respawns = 0;
    this.hitTimes = new Map();
    this.lastLandVelocity = 0;
    this.onCheckpoint = options.onCheckpoint || (() => {});
    this.onRespawn = options.onRespawn || (() => {});
    this.onFinish = options.onFinish || (() => {});
    this.remote = !!options.remote;
    this.target = null;
    this.networkVelocity = new THREE.Vector3();
  }
  get position() {
    return this.character.group.position;
  }
  update(dt, input, cameraYaw, elapsed) {
    if (this.finished || this.remote) return;
    const move = input.movement();
    const sin = Math.sin(cameraYaw),
      cos = Math.cos(cameraYaw),
      desired = new THREE.Vector3(cos * move.x - sin * move.forward, 0, -sin * move.x - cos * move.forward);
    if (desired.lengthSq() > 1) desired.normalize();
    if (input.consume('jump')) this.jumpBuffer = 0.14;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? 0.11 : Math.max(0, this.coyote - dt);
    this.diveCooldown = Math.max(0, this.diveCooldown - dt);
    this.diveTimer = Math.max(0, this.diveTimer - dt);
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.diveTimer <= 0) {
      this.velocity.y = 8.7;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.effects.burst(this.position.clone().add(new THREE.Vector3(0, -0.3, 0)), COLORS.white, 8, 0.72);
    }
    if (input.consume('dive') && this.diveCooldown <= 0) {
      const direction =
        desired.lengthSq() > 0.02
          ? desired
          : new THREE.Vector3(
              -Math.sin(this.character.group.rotation.y),
              0,
              -Math.cos(this.character.group.rotation.y)
            );
      this.velocity.x = direction.x * 10.8;
      this.velocity.z = direction.z * 10.8;
      this.velocity.y = Math.max(this.velocity.y, 3.25);
      this.diveTimer = 0.58;
      this.diveCooldown = 0.9;
      this.grounded = false;
      this.effects.burst(this.position, COLORS.yellow, 12, 1);
    }
    const maxSpeed = this.diveTimer > 0 ? 10.8 : 7.7,
      accel = this.grounded ? 18 : 7.2,
      control = this.diveTimer > 0 ? 0.28 : 1;
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, desired.x * maxSpeed, accel * control, dt);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, desired.z * maxSpeed, accel * control, dt);
    if (move.magnitude < 0.05 && this.grounded) {
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, 0, 12, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, 0, 12, dt);
    }
    this.velocity.y -= 22.5 * dt;
    const previousY = this.position.y;
    this.position.addScaledVector(this.velocity, dt);
    const landingVelocity = this.velocity.y,
      surface = this.course.surfaceAt(this.position, previousY, this.velocity.y);
    this.grounded = false;
    if (surface && this.velocity.y <= 1.5) {
      this.position.y = surface.y + FOOT;
      this.position.add(surface.delta);
      this.velocity.y = 0;
      this.grounded = true;
      if (landingVelocity < -3.2) {
        this.character.landed(Math.min(1, Math.abs(landingVelocity) / 12));
        this.effects.burst(
          this.position.clone().add(new THREE.Vector3(0, -0.4, 0)),
          COLORS.white,
          Math.min(12, 4 + Math.floor(Math.abs(landingVelocity))),
          0.55
        );
      }
    }
    this.course.interact(this, elapsed, this.effects);
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal > 0.28) {
      const wanted = Math.atan2(-this.velocity.x, -this.velocity.z);
      this.character.group.rotation.y = this.angleDamp(this.character.group.rotation.y, wanted, 12, dt);
    }
    if (this.diveTimer > 0 && Math.random() < dt * 18)
      this.effects.trail(this.position.clone().add(new THREE.Vector3(0, 0.35, 0)), COLORS.yellow);
    this.character.animate(dt, {
      speed: horizontal,
      grounded: this.grounded,
      vertical: this.velocity.y,
      diving: this.diveTimer > 0
    });
    const next = this.course.checkpointFor(this.position, this.checkpoint);
    if (next > this.checkpoint) {
      this.checkpoint = next;
      this.spawn.copy(this.course.spawnFor(next));
      this.effects.burst(this.position, COLORS.mint, 18, 1);
      this.onCheckpoint(next);
    }
    if (this.position.y < -8) this.respawn();
    if (
      !this.finished &&
      this.checkpoint >= this.course.spec.segmentCount &&
      this.position.z < this.course.spec.finishZ &&
      this.position.y > -3
    ) {
      this.finished = true;
      this.velocity.set(0, 0, 0);
      this.effects.burst(this.position, COLORS.yellow, 30, 1.25);
      this.onFinish();
    }
  }
  angleDamp(current, target, smoothing, dt) {
    let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return current + delta * (1 - Math.exp(-smoothing * dt));
  }
  respawn(authoritativePosition = null, notify = true) {
    if (notify) this.respawns++;
    this.effects.burst(this.position, COLORS.cyan, 18, 1);
    this.position.copy(authoritativePosition || this.spawn);
    this.velocity.set(0, 0, 0);
    this.diveTimer = 0;
    this.grounded = false;
    this.character.visual.scale.set(1.35, 0.72, 1.35);
    if (notify) this.onRespawn(this.checkpoint);
  }
  snapshot() {
    return {
      x: +this.position.x.toFixed(3),
      y: +this.position.y.toFixed(3),
      z: +this.position.z.toFixed(3),
      ry: +this.character.group.rotation.y.toFixed(3),
      vx: +this.velocity.x.toFixed(2),
      vz: +this.velocity.z.toFixed(2),
      checkpoint: this.checkpoint,
      state: this.diveTimer > 0 ? 'dive' : this.grounded ? 'ground' : 'air'
    };
  }
  applyRemote(state, dt) {
    if (!state) return;
    const target = new THREE.Vector3(state.x, state.y, state.z),
      distance = this.position.distanceTo(target);
    if (distance > 8) this.position.copy(target);
    else this.position.lerp(target, 1 - Math.exp(-12 * dt));
    this.character.group.rotation.y = this.angleDamp(this.character.group.rotation.y, state.ry || 0, 12, dt);
    const speed = Math.hypot(state.vx || 0, state.vz || 0);
    this.character.animate(dt, {
      speed,
      grounded: state.state === 'ground',
      vertical: 0,
      diving: state.state === 'dive'
    });
    this.checkpoint = state.checkpoint || 0;
    this.target = state;
  }
  dispose() {
    this.character.dispose();
  }
}
