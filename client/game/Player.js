import * as THREE from 'three';
import { COLORS } from '../core/Config.js';
import {
  PLAYER_SIMULATION_CONSTANTS,
  dampScalar,
  movementIntent,
  playerTuning,
  resolveGroundContact
} from '/shared/playerSimulation.js';
import { applyWallBounce } from '/shared/courseWalls.js';
import { Character } from './Character.js';
import { PLAYER_FOOT } from './PlayerDimensions.js';

// Основные параметры движения теперь принадлежат pure shared-симуляции. Клиент читает ровно те
// же значения, которые будут использовать authoritative server tick и prediction/reconciliation.
const {
  GRAVITY,
  JUMP_SPEED,
  DIVE_SPEED,
  ACCEL_GROUND,
  ACCEL_AIR,
  ROLL_SPEED,
  LANDING_RETENTION_TIME,
  KNOCKDOWN_IMMUNITY_TIME,
  GETUP_TIME,
  JUMP_BUFFER,
  COYOTE_TIME,
  GLIDE_GRAVITY
} = PLAYER_SIMULATION_CONSTANTS;

// Старый public import сохраняется для world-механик (например, кооперативного ветра), но источник
// истины теперь shared/playerSimulation.js, а не второй набор чисел в Player.js.
export const RUN_SPEED = PLAYER_SIMULATION_CONSTANTS.RUN_SPEED;
export { playerTuning };

const KNOCKDOWN_MIN_TIME = 1.05;
const KNOCKDOWN_MAX_TIME = 1.65;

// Удар сверху: резкий разгон вниз. Им приводят в действие катапульту. Доступен всем — ролей нет,
// и «кто именно бьёт» решают сами игроки, а не разметка уровня.
const SLAM_SPEED = 26;

export class Player {
  constructor(scene, course, effects, options = {}) {
    this.course = course;
    this.effects = effects;
    this.sfx = options.sfx || null;
    // Вибрация идёт рядом со звуком, но своим путём: у неё свой регулятор и свой ноль. На
    // беззвучном телефоне она — единственная обратная связь, а глухому игроку нужна тем более,
    // поэтому выключенный звук её выключать не должен.
    this.haptics = options.haptics || null;
    this.character = new Character(scene, options);
    this.cosmetics = options.cosmetics || null;
    this.knockdownControl = THREE.MathUtils.clamp(Number(options.knockdownControl) || 0, 0, 1);

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
    this.rollTimer = 0;
    this.landingRetention = 0;
    this.recoveryWindow = 0;
    this.knockdownTimer = 0;
    this.knockdownImmunityTimer = 0;
    this.getupTimer = 0;
    this.finished = false;
    this.respawns = 0;
    // Счётчики для целей испытания дня. Ведутся всегда, а не только в дни соответствующей цели:
    // условная запись «только когда нужно» разошлась бы с правилом при первой же его смене.
    this.dashes = 0;
    this.hits = 0;
    this.hitTimes = new Map();
    this.lastLandVelocity = 0;
    // Настройка управления под модификатор дня. Пустой объект — обычная игра.
    this.tuning = playerTuning(options.modifier);
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

    const knockedDown = this.knockdownTimer > 0;
    this.knockdownImmunityTimer = Math.max(0, this.knockdownImmunityTimer - dt);
    if (knockedDown) {
      this.knockdownTimer = Math.max(0, this.knockdownTimer - dt);
      if (this.knockdownTimer === 0) {
        this.getupTimer = GETUP_TIME;
        this.knockdownImmunityTimer = KNOCKDOWN_IMMUNITY_TIME;
      }
    } else {
      this.getupTimer = Math.max(0, this.getupTimer - dt);
    }
    const rawMove = input.movement();
    const moveScale = knockedDown ? this.knockdownControl : 1;
    const move = {
      x: rawMove.x * moveScale,
      forward: rawMove.forward * moveScale,
      magnitude: rawMove.magnitude * moveScale
    };
    // Движение задаётся относительно камеры: «вперёд» — это туда, куда смотрит игрок, а не
    // фиксированное направление мира. Сам поворот и нормализация живут в общем ядре: пока это была
    // отдельная формула здесь, клиент играл по одной арифметике, а предсказание переигрывало ввод
    // по другой.
    const intent = movementIntent({ moveX: move.x, moveZ: move.forward, cameraYaw });
    const desired = this._desired.set(intent.x, 0, intent.z);
    // Куда игрок ХОЧЕТ двигаться по X, независимо от того, что с ним делают внешние силы.
    // Ветру нужно именно намерение: сама скорость к моменту проверки уже содержит его снос,
    // и по ней выходило бы, что сдуваемый игрок «бежит по ветру».
    this.intentX = desired.x;

    if (knockedDown && this.knockdownControl < 0.8) {
      input.consume('jump');
      input.consume('dive');
      this.jumpBuffer = 0;
    } else if (input.consume('jump')) this.jumpBuffer = JUMP_BUFFER;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.coyote = this.grounded ? COYOTE_TIME : Math.max(0, this.coyote - dt);
    this.diveCooldown = Math.max(0, this.diveCooldown - dt);
    this.diveTimer = Math.max(0, this.diveTimer - dt);
    this.rollTimer = Math.max(0, this.rollTimer - dt);
    this.landingRetention = Math.max(0, this.landingRetention - dt);
    this.recoveryWindow = Math.max(0, this.recoveryWindow - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0 && this.diveTimer <= 0) {
      this.velocity.y = JUMP_SPEED * this.tuning.jump;
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      // Прыжок в коротком окне после dive→roll мгновенно завершает перекат, но сохраняет темп.
      // Это тот же jump, поэтому на телефоне не появляется новая кнопка.
      if (this.recoveryWindow > 0) {
        this.recoveryWindow = 0;
        this.landingRetention = LANDING_RETENTION_TIME;
      }
      this.rollTimer = 0;
      this.effects.burst(this._scratch.copy(this.physics).setY(this.physics.y - 0.3), COLORS.white, 8, 0.72);
      this.sfx?.jump();
      this.haptics?.vibrate(0.32);
    }

    if ((!knockedDown || this.knockdownControl >= 0.8) && input.consume('dive') && this.diveCooldown <= 0) {
      const direction =
        desired.lengthSq() > 0.02
          ? desired
          : this._scratch.set(
              -Math.sin(this.character.group.rotation.y),
              0,
              -Math.cos(this.character.group.rotation.y)
            );
      const diveSpeed = DIVE_SPEED * this.tuning.dash;
      this.velocity.x = direction.x * diveSpeed;
      this.velocity.z = direction.z * diveSpeed;
      this.velocity.y = Math.max(this.velocity.y, 3.25);
      this.diveTimer = 0.58;
      this.rollTimer = 0;
      this.recoveryWindow = 0;
      this.diveCooldown = 0.9 * this.tuning.dashCooldown;
      this.grounded = false;
      this.dashes++;
      this.effects.burst(this.physics, COLORS.yellow, 12, 1);
      this.sfx?.dive();
      this.haptics?.vibrate(0.5);
    }

    const retainedSpeed = Math.min(ROLL_SPEED, Math.hypot(this.velocity.x, this.velocity.z));
    const maxSpeed =
      this.diveTimer > 0
        ? DIVE_SPEED * this.tuning.dash
        : this.rollTimer > 0
          ? ROLL_SPEED
          : this.landingRetention > 0
            ? Math.max(RUN_SPEED, retainedSpeed)
            : RUN_SPEED;
    // Сцепление с землёй меняет только наземное ускорение: в воздухе держаться не за что, и
    // «скользкий воздух» был бы не правилом, а поломкой управления.
    const accel = this.grounded ? ACCEL_GROUND * this.tuning.groundGrip : ACCEL_AIR;
    // Во время рывка управление почти отключается — это делает рывок осмысленным решением,
    // а не просто способом двигаться быстрее.
    const control = knockedDown
      ? this.knockdownControl
      : this.diveTimer > 0
        ? 0.28
        : this.rollTimer > 0
          ? 0.48
          : 1;
    this.velocity.x = dampScalar(this.velocity.x, desired.x * maxSpeed, accel * control, dt);
    this.velocity.z = dampScalar(this.velocity.z, desired.z * maxSpeed, accel * control, dt);
    if (move.magnitude < 0.05 && this.grounded) {
      const stop = (knockedDown ? 3.2 : 12) * this.tuning.groundGrip;
      this.velocity.x = dampScalar(this.velocity.x, 0, stop, dt);
      this.velocity.z = dampScalar(this.velocity.z, 0, stop, dt);
    }

    // Планирование: удержание прыжка в воздухе на пути вниз ослабляет гравитацию. Доступно всем.
    this.gliding =
      !knockedDown &&
      this.tuning.glide &&
      !this.grounded &&
      this.velocity.y < 0 &&
      input.isHeld?.('jump') === true;
    const gravityScale = this.slamming ? 1.8 : this.gliding ? GLIDE_GRAVITY : 1;
    this.velocity.y -= GRAVITY * this.tuning.gravity * gravityScale * dt;
    const previousY = this.physics.y;
    this.physics.addScaledVector(this.velocity, dt);

    // Wall-bounce требует обычного прыжка, нажатого непосредственно у подсвеченной стены.
    // На любых других поверхностях буфер просто продолжает ждать приземления.
    const wallNormal =
      !this.grounded && this.jumpBuffer > 0
        ? this.course.wallBounceAt?.(this.physics, this.previous, this.velocity)
        : null;
    if (wallNormal) {
      // Сам отскок считает общее ядро: серверная симуляция обязана разворачивать игрока тем же
      // правилом, иначе оттолкнувшийся от стены разойдётся с сервером на ровном месте.
      const bounced = applyWallBounce(
        {
          position: this.physics,
          velocity: this.velocity,
          jumpBuffer: this.jumpBuffer,
          diveTimer: this.diveTimer,
          rollTimer: this.rollTimer,
          recoveryWindow: this.recoveryWindow
        },
        wallNormal,
        this.previous,
        { jumpSpeed: JUMP_SPEED }
      ).state;
      this.jumpBuffer = bounced.jumpBuffer;
      this.diveTimer = bounced.diveTimer;
      this.rollTimer = bounced.rollTimer;
      this.recoveryWindow = bounced.recoveryWindow;
      // Presentation запускается здесь, а не по скорости или близости к стене: только физика знает,
      // что wall-bounce действительно состоялся. На gameplay-state этот сигнал не влияет.
      this.character.wallBounced?.(wallNormal);
      this.impact = Math.max(this.impact, 0.12);
      this.effects.burst(this.physics, COLORS.cyan, 10, 0.8);
      this.sfx?.jump();
      this.haptics?.vibrate(0.42);
    }

    // Постановка на опору живёт в общем ядре: серверная симуляция обязана ставить игрока на пол по
    // тем же правилам, иначе паритет движения не на чем доказывать. Здесь остаётся только подача.
    const contact = resolveGroundContact(
      {
        position: this.physics,
        velocity: this.velocity,
        grounded: this.grounded,
        diveTimer: this.diveTimer,
        rollTimer: this.rollTimer,
        recoveryWindow: this.recoveryWindow,
        landingRetention: this.landingRetention,
        slamming: this.slamming
      },
      {
        colliders: this.course.platforms,
        previousY,
        footOffset: PLAYER_FOOT,
        intent,
        wasGrounded: this.grounded
      }
    );
    const settled = contact.state;
    this.physics.set(settled.position.x, settled.position.y, settled.position.z);
    this.velocity.y = settled.velocity.y;
    this.grounded = settled.grounded;
    this.slamming = settled.slamming;
    this.diveTimer = settled.diveTimer;
    this.rollTimer = settled.rollTimer;
    this.recoveryWindow = settled.recoveryWindow;
    this.landingRetention = settled.landingRetention;
    for (const event of contact.events) {
      if (event.name !== 'land') continue;
      const strength = Math.min(1, Math.abs(event.landingVelocity) / 12);
      this.character.landed(strength);
      this.effects.burst(
        this._scratch.copy(this.physics).setY(this.physics.y - 0.4),
        COLORS.white,
        Math.min(12, 4 + Math.floor(Math.abs(event.landingVelocity))),
        0.55
      );
      this.sfx?.land(strength);
      this.haptics?.vibrate(strength * 0.8);
      // Жёсткое приземление ощущается ударом — мягкое не должно трясти экран вовсе.
      if (strength > 0.45) this.impact = Math.max(this.impact, (strength - 0.45) * 0.6);
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
      this.effects.trail(
        this._scratch.copy(this.physics).setY(this.physics.y + 0.35),
        // Цвет берётся из render, а старое поле `color` остаётся запасным: у унаследованных
        // следов оно и есть источник, у новых его нет вовсе.
        this.cosmetics?.trail?.render?.primary ?? this.cosmetics?.trail?.color ?? COLORS.yellow
      );
    }

    this.character.animate(dt, {
      speed: horizontal,
      grounded: this.grounded,
      vertical: this.velocity.y,
      diving: this.diveTimer > 0 || this.rollTimer > 0,
      knockedDown: this.knockdownTimer > 0,
      recovering: this.getupTimer > 0
    });

    const next = this.course.checkpointFor(this.physics, this.checkpoint);
    if (next > this.checkpoint) {
      this.checkpoint = next;
      this.spawn.copy(this.course.spawnFor(next));
      this.effects.burst(this.physics, COLORS.mint, 18, 1);
      this.sfx?.checkpoint();
      this.haptics?.vibrate(0.7);
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
      this.haptics?.vibrate(1);
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
    if (this.grounded || this.slamming || this.knockdownTimer > 0) return false;
    this.slamming = true;
    this.velocity.y = -SLAM_SPEED;
    this.velocity.x *= 0.3;
    this.velocity.z *= 0.3;
    return true;
  }

  // Сильный контакт не замораживает физику: персонаж продолжает лететь от импульса,
  // но на короткое время теряет управление и процедурно обмякает. Это НЕ coop-down state.
  knockDown(strength = 0.5) {
    if (this.finished || this.downed || this.knockdownTimer > 0 || this.knockdownImmunityTimer > 0)
      return false;
    const duration = THREE.MathUtils.clamp(0.8 + strength * 1.2, KNOCKDOWN_MIN_TIME, KNOCKDOWN_MAX_TIME);
    this.knockdownTimer = Math.max(this.knockdownTimer, duration);
    this.getupTimer = 0;
    this.jumpBuffer = 0;
    this.diveTimer = 0;
    this.rollTimer = 0;
    this.recoveryWindow = 0;
    this.slamming = false;
    this.gliding = false;
    return true;
  }

  // Подброс катапультой: импульс приходит извне, поэтому применяется напрямую.
  applyLaunch(vector) {
    this.velocity.set(vector.x, vector.y, vector.z);
    this.grounded = false;
    this.slamming = false;
    this.rollTimer = 0;
    this.recoveryWindow = 0;
    this.knockdownTimer = 0;
    this.knockdownImmunityTimer = 0;
    this.getupTimer = 0;
  }

  // Падение в кооперативе не откатывает обоих к чекпоинту: упавший ждёт напарника «пузырём».
  goDown(position) {
    this.knockdownTimer = 0;
    this.knockdownImmunityTimer = 0;
    this.getupTimer = 0;
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
    this.rollTimer = 0;
    this.landingRetention = 0;
    this.recoveryWindow = 0;
    this.knockdownTimer = 0;
    this.knockdownImmunityTimer = 0;
    this.getupTimer = 0;
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
    this.rollTimer = 0;
    this.landingRetention = 0;
    this.recoveryWindow = 0;
    this.knockdownTimer = 0;
    this.knockdownImmunityTimer = 0;
    this.getupTimer = 0;
    this.grounded = false;
    // Наклон и смещение позы сбивания снимаются здесь же, вместе с таймерами: логический сброс их
    // не касается, и возрождение оставляло игрока лежащим (см. Character.resetPose). Масштаб ниже
    // выставляется уже намеренно — это приседание при появлении, а не остаток прежней позы.
    this.character.resetPose();
    this.character.visual.scale.set(1.35, 0.72, 1.35);
    this.sfx?.respawn();
    this.haptics?.vibrate(0.6);
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
        : this.knockdownTimer > 0
          ? 'knockdown'
          : this.slamming
            ? 'slam'
            : this.diveTimer > 0 || this.rollTimer > 0
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
    // Скорость из снапшота переносится в вектор, а не только в анимацию.
    //
    // Удалённый игрок физику не считает, и раньше его velocity оставался нулевым — модель бежала,
    // а «по приборам» стояла. Пока за таким смотрели со стороны, это ничего не меняло; с досмотром
    // гонки он стал попадать под камеру, а та берёт из velocity и автодоворот, и упреждение, и
    // угол обзора. Соперник ехал бы в кадре так, будто стоит на месте.
    this.velocity.set(state.vx || 0, state.vy || 0, state.vz || 0);
    const speed = Math.hypot(state.vx || 0, state.vz || 0);
    this.character.animate(dt, {
      speed,
      grounded: state.state === 'ground',
      vertical: state.vy || 0,
      diving: state.state === 'dive' || state.state === 'slam',
      knockedDown: state.state === 'knockdown'
    });
    this.checkpoint = state.checkpoint || 0;
    this.target = state;
  }

  dispose() {
    this.character.dispose();
  }
}
