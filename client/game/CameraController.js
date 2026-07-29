import * as THREE from 'three';

// Камера: слежение с орбитой, автодоворотом, упреждением и защитой от заслонов.
//
// В кооперативном режиме к этому добавляется динамическое кадрирование: когда напарник близко,
// камера отъезжает и смещает точку взгляда к середине между игроками, чтобы оба были видны.
// Это ключевая вещь для кооп-механик — иначе игрок не видит, что делает второй, и координация
// разваливается.

// Расстояние, ближе которого напарник начинает влиять на кадр.
const COOP_FRAME_DISTANCE = 18;

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

    // Тряска экрана: сила затухает со временем, смещение накладывается на итоговую позицию камеры.
    this.shake = 0;
    this.reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Переиспользуемые векторы — чтобы не создавать мусор каждый кадр.
    this._forward = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._focus = new THREE.Vector3();
  }

  reset(player, instant = false) {
    this.yaw = player?.character.group.rotation.y || 0;
    this.pitch = 0.08;
    this.manualTimer = 0;
    this.shake = 0;
    if (instant && player) {
      const p = player.visualPosition;
      this.camera.position.set(p.x, p.y + 4.7, p.z + 8.2);
      this.target.set(p.x, p.y + 1, p.z - 2);
    }
  }

  // Вызывается при ударах, жёстких приземлениях и запусках катапульты.
  addShake(strength) {
    if (this.reducedMotion) return;
    this.shake = Math.min(1, this.shake + strength);
  }

  // `partner` — позиция напарника в кооп-режиме либо null.
  update(dt, player, input, course, partner = null) {
    const orbit = input.consumeCamera();
    if (Math.abs(orbit.x) + Math.abs(orbit.y) > 0.01) {
      const sensitivity = this.mobile ? 0.0062 : 0.0046;
      this.yaw -= orbit.x * sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch - orbit.y * sensitivity * 0.72, -0.13, 0.48);
      // После ручного поворота автодоворот на время отключается, иначе камера вырывается из рук.
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

    const portrait = (globalThis.innerHeight || 800) > (globalThis.innerWidth || 1280);
    let wantedDistance = this.mobile ? (portrait ? 8.9 : 8.2) : 8.2;
    const height = (portrait ? 5.25 : 4.65) + this.pitch * 4.6;

    // Камера следит за ПОЗИЦИЕЙ ОТРИСОВКИ, а не физики: физика идёт фиксированным шагом, и слежение
    // за ней вернуло бы в кадр то самое дрожание, ради устранения которого сделана интерполяция.
    const self = player.visualPosition;
    this._focus.copy(self);

    // Динамическое кадрирование в коопе: точка взгляда уезжает к напарнику, камера отъезжает —
    // ровно настолько, чтобы оба оставались в кадре, и не дальше.
    if (partner) {
      const separation = self.distanceTo(partner);
      if (separation < COOP_FRAME_DISTANCE) {
        const weight = 0.5 * (1 - separation / COOP_FRAME_DISTANCE);
        this._focus.lerp(partner, weight);
        wantedDistance += Math.min(5.5, separation * 0.42);
      }
    }

    this.distance = THREE.MathUtils.damp(this.distance, wantedDistance, 5, dt);

    // Упреждение: чем быстрее бежит игрок, тем дальше вперёд смотрит камера — иначе на скорости
    // препятствия появляются в кадре слишком поздно, чтобы среагировать.
    const lead = Math.min(2.8, speed * 0.24);
    const rotation = player.character.group.rotation.y;
    this._forward.set(-Math.sin(rotation), 0, -Math.cos(rotation));
    this.target
      .set(this._focus.x, this._focus.y + 1.05, this._focus.z)
      .addScaledVector(this._forward, 1.7 + lead);
    this.desired.set(
      this._focus.x + Math.sin(this.yaw) * this.distance,
      this._focus.y + height,
      this._focus.z + Math.cos(this.yaw) * this.distance
    );

    // Защита от заслонов: если между точкой взгляда и желаемым местом камеры есть геометрия,
    // подтягиваем камеру ближе, чтобы не смотреть внутрь платформы.
    const direction = this._direction.copy(this.desired).sub(this.target);
    const wantedLength = direction.length();
    direction.normalize();
    this.raycaster.set(this.target, direction);
    this.raycaster.far = wantedLength;
    const hit = this.raycaster.intersectObjects(course.cameraMeshes, false)[0];
    if (hit && hit.distance < wantedLength) {
      this.desired.copy(this.target).addScaledVector(direction, Math.max(2.2, hit.distance - 0.45));
    }

    this.camera.position.lerp(this.desired, 1 - Math.exp(-7.5 * dt));

    if (this.shake > 0.001) {
      // Затухание тряски и случайное смещение, пропорциональное оставшейся силе.
      const amount = this.shake * this.shake * 0.42;
      this.camera.position.x += (Math.random() * 2 - 1) * amount;
      this.camera.position.y += (Math.random() * 2 - 1) * amount;
      this.shake = Math.max(0, this.shake - dt * 3.2);
    }

    this.camera.lookAt(this.target);

    // Поле зрения слегка расширяется на скорости — дешёвый и очень действенный способ передать разгон.
    const wantedFov = (this.mobile ? (portrait ? 66 : 61) : 58) + Math.min(7, speed * 0.55);
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, wantedFov, 5, dt);
    this.camera.updateProjectionMatrix();
  }
}
