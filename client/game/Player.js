import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import { Character } from './Character.js';

const FOOT = 0.48;

// Гравитация и импульсы вынесены в именованные константы: раньше это были числа, вкраплённые прямо
// в формулы, и подобрать «ощущение» персонажа, не перечитывая всю функцию, было невозможно.
const GRAVITY = 22.5;
const JUMP_SPEED = 8.7;
const DIVE_SPEED = 10.8;
export const RUN_SPEED = 7.7;
const ACCEL_GROUND = 18;
const ACCEL_AIR = 7.2;

// Окно, в течение которого прыжок сработает, если нажать его чуть раньше приземления.
const JUMP_BUFFER = 0.14;
// Окно, в течение которого прыжок ещё возможен уже после схода с края. Без него точные прыжки
// ощущаются несправедливыми: игрок нажимает вовремя, но персонаж уже формально в воздухе.
const COYOTE_TIME = 0.11;

// Удар сверху: резкий разгон вниз. Им приводят в действие катапульту. Доступен всем — ролей нет,
// и «кто именно бьёт» решают сами игроки, а не разметка уровня.
const SLAM_SPEED = 26;

// Насколько слабее тянет вниз при планировании. Раньше это была способность лёгкой роли;
// теперь ею пользуются все, и она стала частью базового управления, а не привилегией.
const GLIDE_GRAVITY = 0.55;

export class Player {
  constructor(scene, course, effects, options = {}) {
    this.course = course;
    this.effects = effects;
    this.sfx = options.sfx || null;
    this.character = new Character(scene, options);

    this.velocity = new THREE.Vector3();
    this.checkpoint = 0;
    this.spawn = course.spawnFor(0);

    // Позиция физики и позиция отрисовки — разные величины.
    //
    // Физика идёт фиксированным шагом (1/60), а кадры рисуются с частотой монитора, которая с ней
    // не совпадает. Если рисовать прямо по физической позиции, на 144 Гц каждый второй-третий кадр
    // повторял бы предыдущий и движение мелко дрожало бы. Поэтому храним позицию до и после шага, а
    // при отрисовке показываем промежуточное состояние — см. render().
    this.physics = new THREE.Vector3().copy(this.spawn);
    this.previous = new THREE.Vector3().copy(this.spawn);
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
    // Сила удара, полученного за шаг. Препятствия пишут сюда, игра читает и превращает в тряску
    // камеры. Так препятствия не зависят ни от камеры, ни от сцены — их можно гонять ботами.
    this.impact = 0;

    this.onCheckpoint = options.onCheckpoint || (() => {});
    this.onRespawn = options.onRespawn || (() => {});
    this.onFinish = options.onFinish || (() => {});

    this.remote = !!options.remote;
    this.target = null;

    this.slamming = false;
    this.gliding = false;
    // Упавший игрок становится «пузырём» и ждёт напарника.
    this.downed = false;

    // Переиспользуемые векторы: раньше в каждом кадре создавалось по несколько новых THREE.Vector3,
    // и сборщик мусора регулярно давал заметные подтормаживания.
    this._desired = new THREE.Vector3();
    this._scratch = new THREE.Vector3();
  }

  // Позиция для игровой логики и коллизий.
  get position() {
    return this.physics;
  }

  // Позиция, которая реально видна на экране. Камера должна следить именно за ней, иначе
  // сглаживание физики теряется.
  get visualPosition() {
    return this.character.group.position;
  }

  // Один шаг физики. Всегда вызывается с постоянным dt — см. Game.loop.
  step(dt, input, cameraYaw, elapsed) {
    if (this.finished || this.remote) return;
    this.previous.copy(this.physics);

    const move = input.movement();
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    // Движение задаётся относительно камеры: «вперёд» — это туда, куда смотрит игрок, а не
    // фиксированное направление мира.
    const desired = this._desired.set(
      cos * move.x - sin * move.forward,
      0,
      -sin * move.x - cos * move.forward
    );
    if (desired.lengthSq() > 1) desired.normalize();
    // Куда игрок ХОЧЕТ двигаться по X, независимо от того, что с ним делают внешние силы.
    // Ветру нужно именно намерение: сама скорость к моменту проверки уже содержит его снос,
    // и по ней выходило бы, что сдуваемый игрок «бежит по ветру».
    this.intentX = desired.x;

    if (input.consume('jump')) this.jumpBuffer = JUMP_BUFFER;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    this.diveCooldown = Math.max(0, this.diveCooldown - dt);
    this.diveTimer = Math.max(0, this.diveTimer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0 && this.diveTimer <= 0) {
      this.velocity.y = JUMP_SPEED;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.effects.burst(this._scratch.copy(this.physics).setY(this.physics.y - 0.3), COLORS.white, 8, 0.72);
      this.sfx?.jump();
    }

    if (input.consume('dive') && this.diveCooldown <= 0) {
      const direction =
        desired.lengthSq() > 0.02
          ? desired
          : this._scratch.set(
              -Math.sin(this.character.group.rotation.y),
              0,
              -Math.cos(this.character.group.rotation.y)
            );
      this.velocity.x = direction.x * DIVE_SPEED;
      this.velocity.z = direction.z * DIVE_SPEED;
      this.velocity.y = Math.max(this.velocity.y, 3.25);
      this.diveTimer = 0.58;
      this.diveCooldown = 0.9;
      this.grounded = false;
      this.effects.burst(this.physics, COLORS.yellow, 12, 1);
      this.sfx?.dive();
    }

    const maxSpeed = this.diveTimer > 0 ? DIVE_SPEED : RUN_SPEED;
    const accel = this.grounded ? ACCEL_GROUND : ACCEL_AIR;
    // Во время рывка управление почти отключается — это делает рывок осмысленным решением,
    // а не просто способом двигаться быстрее.
    const control = this.diveTimer > 0 ? 0.28 : 1;
    this.velocity.x = THREE.MathUtils.damp(this.velocity.x, desired.x * maxSpeed, accel * control, dt);
    this.velocity.z = THREE.MathUtils.damp(this.velocity.z, desired.z * maxSpeed, accel * control, dt);
    if (move.magnitude < 0.05 && this.grounded) {
      this.velocity.x = THREE.MathUtils.damp(this.velocity.x, 0, 12, dt);
      this.velocity.z = THREE.MathUtils.damp(this.velocity.z, 0, 12, dt);
    }

    // Планирование: удержание прыжка в воздухе на пути вниз ослабляет гравитацию. Доступно всем.
    this.gliding = !this.grounded && this.velocity.y < 0 && input.isHeld?.('jump') === true;
    const gravityScale = this.slamming ? 1.8 : this.gliding ? GLIDE_GRAVITY : 1;
    this.velocity.y -= GRAVITY * gravityScale * dt;
    const previousY = this.physics.y;
    this.physics.addScaledVector(this.velocity, dt);

    const landingVelocity = this.velocity.y;
    const surface = this.course.surfaceAt(this.physics, previousY, this.velocity.y);
    const wasGrounded = this.grounded;
    this.grounded = false;
    if (surface && this.velocity.y <= 1.5) {
      this.physics.y = surface.y + FOOT;
      // Перенос движущейся платформой: сдвиг платформы за кадр добавляется к позиции игрока,
      // иначе он соскальзывал бы с неё, стоя на месте.
      this.physics.add(surface.delta);
      this.velocity.y = 0;
      this.grounded = true;
      this.slamming = false;
      if (!wasGrounded && landingVelocity < -3.2) {
        const strength = Math.min(1, Math.abs(landingVelocity) / 12);
        this.character.landed(strength);
        this.effects.burst(
          this._scratch.copy(this.physics).setY(this.physics.y - 0.4),
          COLORS.white,
          Math.min(12, 4 + Math.floor(Math.abs(landingVelocity))),
          0.55
        );
        this.sfx?.land(strength);
        // Жёсткое приземление ощущается ударом — мягкое не должно трясти экран вовсе.
        if (strength > 0.45) this.impact = Math.max(this.impact, (strength - 0.45) * 0.6);
      }
    }

    this.course.interact(this, elapsed, this.effects, this.sfx);

    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontal > 0.28) {
      const wanted = Math.atan2(-this.velocity.x, -this.velocity.z);
      this.character.group.rotation.y = this.angleDamp(this.character.group.rotation.y, wanted, 12, dt);
    }
    if (this.grounded && horizontal > 2.2) this.sfx?.footstep();
    // Свист при затяжном падении — единственная подсказка, что уже пора беспокоиться.
    if (!this.grounded && this.velocity.y < -9) {
      this.sfx?.fall(Math.min(1, (-this.velocity.y - 9) / 12));
    }
    if (this.diveTimer > 0 && Math.random() < dt * 18) {
      this.effects.trail(this._scratch.copy(this.physics).setY(this.physics.y + 0.35), COLORS.yellow);
    }

    this.character.animate(dt, {
      speed: horizontal,
      grounded: this.grounded,
      vertical: this.velocity.y,
      diving: this.diveTimer > 0
    });

    const next = this.course.checkpointFor(this.physics, this.checkpoint);
    if (next > this.checkpoint) {
      this.checkpoint = next;
      this.spawn.copy(this.course.spawnFor(next));
      this.effects.burst(this.physics, COLORS.mint, 18, 1);
      this.sfx?.checkpoint();
      this.onCheckpoint(next);
    }

    if (this.physics.y < -8) this.respawn();

    if (
      !this.finished &&
      this.checkpoint >= this.course.spec.segmentCount &&
      this.physics.z < this.course.spec.finishZ &&
      this.physics.y > -3
    ) {
      this.finished = true;
      this.velocity.set(0, 0, 0);
      this.effects.burst(this.physics, COLORS.yellow, 30, 1.25);
      this.sfx?.finish();
      this.onFinish();
    }
  }

  // Промежуточное состояние между двумя шагами физики. alpha — доля незавершённого шага (0..1).
  render(alpha) {
    if (this.remote) return;
    this.character.group.position.lerpVectors(this.previous, this.physics, alpha);
  }

  // Удар сверху: доступен ГРУЗУ в воздухе. Приводит в действие катапульту и тяжёлые механизмы.
  startSlam() {
    if (this.grounded || this.slamming) return false;
    this.slamming = true;
    this.velocity.y = -SLAM_SPEED;
    this.velocity.x *= 0.3;
    this.velocity.z *= 0.3;
    return true;
  }

  // Подброс катапультой: импульс приходит извне, поэтому применяется напрямую.
  applyLaunch(vector) {
    this.velocity.set(vector.x, vector.y, vector.z);
    this.grounded = false;
    this.slamming = false;
  }

  // Падение в кооперативе не откатывает обоих к чекпоинту: упавший ждёт напарника «пузырём».
  goDown(position) {
    this.downed = true;
    this.teleport(position);
    this.character.visual.scale.set(0.85, 0.85, 0.85);
  }

  revive() {
    if (!this.downed) return false;
    this.downed = false;
    this.character.visual.scale.set(1, 1, 1);
    return true;
  }

  // Мгновенное перемещение без эффектов и звука: расстановка на старте, предпросмотр в меню.
  // Обязательно синхронизирует все три позиции, иначе кадр отрисовки проинтерполирует телепорт.
  teleport(position) {
    this.physics.copy(position);
    this.previous.copy(position);
    this.character.group.position.copy(position);
    this.velocity.set(0, 0, 0);
  }

  angleDamp(current, target, smoothing, dt) {
    // Кратчайший путь по кругу: без нормализации разворот через 0° прокручивал бы модель назад.
    let delta = ((target - current + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (delta < -Math.PI) delta += Math.PI * 2;
    return current + delta * (1 - Math.exp(-smoothing * dt));
  }

  respawn(authoritativePosition = null, notify = true) {
    if (notify) this.respawns++;
    this.effects.burst(this.physics, COLORS.cyan, 18, 1);
    this.physics.copy(authoritativePosition || this.spawn);
    // Сбрасываем и предыдущую позицию тоже: иначе кадр отрисовки проинтерполирует телепорт
    // и персонаж «пролетит» через полкарты.
    this.previous.copy(this.physics);
    this.character.group.position.copy(this.physics);
    this.velocity.set(0, 0, 0);
    this.diveTimer = 0;
    this.grounded = false;
    this.character.visual.scale.set(1.35, 0.72, 1.35);
    this.sfx?.respawn();
    if (notify) this.onRespawn(this.checkpoint);
  }

  snapshot() {
    return {
      x: +this.physics.x.toFixed(3),
      y: +this.physics.y.toFixed(3),
      z: +this.physics.z.toFixed(3),
      ry: +this.character.group.rotation.y.toFixed(3),
      vx: +this.velocity.x.toFixed(2),
      vy: +this.velocity.y.toFixed(2),
      vz: +this.velocity.z.toFixed(2),
      checkpoint: this.checkpoint,
      state: this.downed
        ? 'downed'
        : this.slamming
          ? 'slam'
          : this.diveTimer > 0
            ? 'dive'
            : this.grounded
              ? 'ground'
              : 'air'
    };
  }

  // Состояние удалённого игрока приходит уже проинтерполированным из SnapshotBuffer, поэтому здесь
  // остаётся только применить его. Небольшое сглаживание всё же оставлено: оно скрывает скачок в
  // момент, когда буфер переключается с экстраполяции обратно на интерполяцию.
  applyRemote(state, dt, detail = 'full') {
    if (!state) return;
    this.character.setDetail(detail);
    const target = this._scratch.set(state.x, state.y, state.z);
    const group = this.character.group;
    const distance = group.position.distanceTo(target);
    if (distance > 8) group.position.copy(target);
    else group.position.lerp(target, 1 - Math.exp(-24 * dt));
    this.physics.copy(group.position);

    group.rotation.y = this.angleDamp(group.rotation.y, state.ry || 0, 12, dt);
    const speed = Math.hypot(state.vx || 0, state.vz || 0);
    this.character.animate(dt, {
      speed,
      grounded: state.state === 'ground',
      vertical: state.vy || 0,
      diving: state.state === 'dive' || state.state === 'slam'
    });
    this.checkpoint = state.checkpoint || 0;
    this.target = state;
  }

  dispose() {
    this.character.dispose();
  }
}
