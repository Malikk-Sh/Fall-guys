import * as THREE from 'three';

// Камера: слежение с орбитой, автодоворотом, упреждением и защитой от заслонов.
//
// В кооперативном режиме к этому добавляется динамическое кадрирование: когда напарник близко,
// камера отъезжает и смещает точку взгляда к середине между игроками, чтобы оба были видны.
// Это ключевая вещь для кооп-механик — иначе игрок не видит, что делает второй, и координация
// разваливается.

// Расстояние, ближе которого напарник начинает влиять на кадр.
const COOP_FRAME_DISTANCE = 18;
const SPECTATOR_DISTANCE_BONUS = 0.85;
const SPECTATOR_HEIGHT_BONUS = 0.28;

// Два режима камеры.
//
// `follow` — прежнее поведение: через пару секунд после ручного поворота камера сама
// возвращается за спину персонажа, а точка взгляда смещается вперёд по направлению ПЕРСОНАЖА.
// Удобно, пока бежишь по прямой, и мешает, как только надо осмотреться: камера вырывается из рук.
//
// `free` — камера следует за позицией персонажа, но не за его поворотом. Куда повернули — туда и
// смотрит, пока не повернут снова. Персонаж при этом остаётся в кадре: полностью «отвязывать»
// камеру в мировую точку нельзя, иначе через секунду бега смотреть будет не на что.
//
// В кооперативе разница особенно заметна: половину времени нужно смотреть на напарника, а не
// туда, куда бежишь сам, — и в `follow` камера отбирала взгляд обратно каждые две секунды.
export const CAMERA_MODES = ['follow', 'free'];
const STORAGE_KEY = 'wobble-camera-mode';

export class CameraController {
  // `settings` — настройки управления. Отсюда берутся сила тряски и решение про уменьшенную
  // анимацию; чувствительность и инверсия осей учтены раньше, во вводе, потому что обзор двигают
  // и палец, и клавиши, и сходятся оба источника именно там.
  constructor(camera, settings = null) {
    this.camera = camera;
    this.settings = settings;
    this.mode = CameraController.storedMode();
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

    // Короткие presentation-only импульсы. Они никогда не записываются в yaw/pitch игрока:
    // управление и автодоворот продолжают жить в своей системе координат, а эффект существует
    // только в итоговом кадре и полностью исчезает после duration.
    this.impulseYaw = 0;
    this.impulsePitch = 0;
    this.impulseFov = 0;
    this.impulseTime = 0;
    this.impulseDuration = 0;

    // Переиспользуемые векторы — чтобы не создавать мусор каждый кадр.
    this._forward = new THREE.Vector3();
    this._direction = new THREE.Vector3();
    this._focus = new THREE.Vector3();
  }

  // Выбор игрока переживает перезагрузку: менять его каждый запуск заново — та ещё мелочь,
  // но именно из таких мелочей складывается ощущение, что игра тебя не слушает.
  static storedMode() {
    try {
      const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
      return CAMERA_MODES.includes(saved) ? saved : 'follow';
    } catch {
      return 'follow';
    }
  }

  toggleMode() {
    this.mode = this.mode === 'follow' ? 'free' : 'follow';
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, this.mode);
    } catch {
      // Приватный режим браузера — не повод падать.
    }
    return this.mode;
  }

  reset(player, instant = false) {
    this.yaw = player?.character.group.rotation.y || 0;
    this.pitch = 0.08;
    this.manualTimer = 0;
    this.shake = 0;
    this.impulseYaw = 0;
    this.impulsePitch = 0;
    this.impulseFov = 0;
    this.impulseTime = 0;
    this.impulseDuration = 0;
    if (instant && player) {
      const p = player.visualPosition;
      this.camera.position.set(p.x, p.y + 4.7, p.z + 8.2);
      this.target.set(p.x, p.y + 1, p.z - 2);
    }
  }

  // Во сколько раз трясти. Ноль — не трясти вовсе: и по регулятору, и по просьбе уменьшить
  // анимацию. Спрашивается каждый раз, а не запоминается при создании: настройку меняют посреди
  // игры, и камера, узнавшая о ней только при следующем запуске, — это невыполненная просьба.
  get shakeScale() {
    return this.settings ? this.settings.shakeScale : 1;
  }

  // Вызывается при ударах, жёстких приземлениях и запусках катапульты.
  addShake(strength) {
    const scale = this.shakeScale;
    if (scale <= 0) return;
    this.shake = Math.min(1, this.shake + strength * scale);
  }

  // Короткий visual-only толчок камеры для уже случившегося gameplay-события.
  //
  // Важное ограничение: yaw/pitch здесь — только временные смещения кадра. Они не могут изменить
  // направление управления, режим follow/free или положение персонажа. Сильные значения режутся,
  // а reduced motion отключает весь пространственный импульс. Компонент shake дополнительно проходит
  // через обычный пользовательский регулятор тряски в addShake().
  addImpulse({ yaw = 0, pitch = 0, fov = 0, shake = 0, duration = 0.15 } = {}) {
    if (this.settings?.reducedMotion) return false;
    const finite = value => (Number.isFinite(value) ? value : 0);
    const life = THREE.MathUtils.clamp(finite(duration) || 0.15, 0.05, 0.5);
    const nextYaw = THREE.MathUtils.clamp(this.impulseYaw + finite(yaw), -0.18, 0.18);
    const nextPitch = THREE.MathUtils.clamp(this.impulsePitch + finite(pitch), -0.12, 0.12);
    const nextFov = THREE.MathUtils.clamp(this.impulseFov + finite(fov), -3.5, 3.5);
    const changed = nextYaw !== 0 || nextPitch !== 0 || nextFov !== 0 || finite(shake) > 0;
    if (!changed) return false;

    this.impulseYaw = nextYaw;
    this.impulsePitch = nextPitch;
    this.impulseFov = nextFov;
    const remaining = Math.max(this.impulseTime, life);
    this.impulseTime = remaining;
    this.impulseDuration = remaining;
    if (finite(shake) > 0) this.addShake(finite(shake));
    return true;
  }

  // `partner` — позиция напарника в кооп-режиме либо null.
  update(dt, player, input, course, partner = null) {
    // Смещение приходит уже с учётом чувствительности и инверсии — их применяет ввод.
    const orbit = input.consumeCamera();
    if (Math.abs(orbit.x) + Math.abs(orbit.y) > 0.01) {
      const sensitivity = this.mobile ? 0.0062 : 0.0046;
      this.yaw -= orbit.x * sensitivity;
      this.pitch = THREE.MathUtils.clamp(this.pitch - orbit.y * sensitivity * 0.72, -0.13, 0.48);
      // После ручного поворота автодоворот на время отключается, иначе камера вырывается из рук.
      this.manualTimer = 2.25;
    } else this.manualTimer = Math.max(0, this.manualTimer - dt);

    // Смена режима. Возвращает новое значение, чтобы игра могла показать уведомление.
    if (input.consume('cameraMode')) {
      const mode = this.toggleMode();
      globalThis.dispatchEvent?.(new CustomEvent('camera-mode-change', { detail: mode }));
    }

    // Быстро посмотреть за спину: работает в обоих режимах и не меняет выбранный.
    if (input.consume('recenter')) {
      this.yaw = player.character.group.rotation.y;
      this.pitch = 0.08;
      this.manualTimer = 0;
    }

    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    // Автодоворот — только в режиме слежения. В свободном камера держит направление, пока её
    // не повернут: в этом весь смысл режима.
    if (this.mode === 'follow' && this.manualTimer <= 0 && speed > 1.2) {
      let delta = ((player.character.group.rotation.y - this.yaw + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (delta < -Math.PI) delta += Math.PI * 2;
      this.yaw += delta * (1 - Math.exp(-1.8 * dt));
    }

    // Presentation impulse затухает квадратично: начало читается ясно, хвост быстро растворяется.
    // Базовые yaw/pitch не меняются, поэтому после эффекта камере не из чего «возвращаться».
    const impulseLife =
      this.impulseTime > 0 && this.impulseDuration > 0 ? this.impulseTime / this.impulseDuration : 0;
    const impulseWeight = impulseLife * impulseLife;
    const renderYaw = this.yaw + this.impulseYaw * impulseWeight;
    const renderPitch = this.pitch + this.impulsePitch * impulseWeight;

    const portrait = (globalThis.innerHeight || 800) > (globalThis.innerWidth || 1280);
    const spectatorFrame = Boolean(player.remote && !this.settings?.reducedMotion);
    let wantedDistance = this.mobile ? (portrait ? 8.9 : 8.2) : 8.2;
    if (spectatorFrame) wantedDistance += SPECTATOR_DISTANCE_BONUS;
    const height =
      (portrait ? 5.25 : 4.65) + renderPitch * 4.6 + (spectatorFrame ? SPECTATOR_HEIGHT_BONUS : 0);

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
    // Куда смещать точку взгляда. В режиме слежения — вперёд по направлению ПЕРСОНАЖА (кадр
    // «ведёт» бегущего). В свободном — вперёд по направлению КАМЕРЫ: иначе поворот персонажа
    // утаскивал бы точку взгляда вбок, и камера, формально свободная, всё равно ходила бы за ним.
    const rotation = this.mode === 'follow' ? player.character.group.rotation.y : renderYaw;
    this._forward.set(-Math.sin(rotation), 0, -Math.cos(rotation));
    this.target
      .set(this._focus.x, this._focus.y + 1.05, this._focus.z)
      .addScaledVector(this._forward, 1.7 + lead);
    this.desired.set(
      this._focus.x + Math.sin(renderYaw) * this.distance,
      this._focus.y + height,
      this._focus.z + Math.cos(renderYaw) * this.distance
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
    const wantedFov =
      (this.mobile ? (portrait ? 66 : 61) : 58) + Math.min(7, speed * 0.55) + this.impulseFov * impulseWeight;
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, wantedFov, 5, dt);
    this.camera.updateProjectionMatrix();

    if (this.impulseTime > 0) {
      this.impulseTime = Math.max(0, this.impulseTime - dt);
      if (this.impulseTime === 0) {
        this.impulseYaw = 0;
        this.impulsePitch = 0;
        this.impulseFov = 0;
        this.impulseDuration = 0;
      }
    }
  }
}
