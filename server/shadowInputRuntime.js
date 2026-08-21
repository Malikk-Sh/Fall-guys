'use strict';

const { ClientInputQueue } = require('./clientInputQueue');
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const {
  PLAYER_SIMULATION_CONSTANTS,
  applyKnockdown,
  createPlayerSimulationState,
  movementIntent,
  resolveGroundContact,
  stepPlayerMotion
} = require('../shared/playerSimulation.js');

const { JUMP_SPEED } = PLAYER_SIMULATION_CONSTANTS;
const { PLAYER_BODY_RADIUS, PLAYER_FOOT, PLAYER_OBSTACLE_RADIUS } = require('../shared/playerDimensions.js');
const { applyObstacleImpulses } = require('../shared/courseImpulses.js');
const { applyWallBounce, wallBounceNormalAt } = require('../shared/courseWalls.js');
const { shadowCourseWorldFor } = require('./shadowCourseWorld');
const { advanceShadowRaceProgress, createShadowRaceProgress } = require('./shadowRaceProgress');

const SERVER_SIMULATION_HZ = 30;
const SERVER_SIMULATION_DT = 1 / SERVER_SIMULATION_HZ;
const SERVER_SIMULATION_INTERVAL_MS = 1000 / SERVER_SIMULATION_HZ;
const ERROR_SAMPLE_LIMIT = 512;

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function stateFromLegacy(legacy = {}) {
  return createPlayerSimulationState({
    position: {
      x: finite(legacy.x),
      y: finite(legacy.y),
      z: finite(legacy.z)
    },
    velocity: {
      x: finite(legacy.vx),
      y: finite(legacy.vy),
      z: finite(legacy.vz)
    },
    grounded: legacy.state === 'ground',
    finished: legacy.finished === true
  });
}

function copySimulationState(state) {
  if (!state) return null;
  return {
    ...state,
    position: { ...state.position },
    velocity: { ...state.velocity }
  };
}

function copyRaceProgress(progress) {
  return progress ? { ...progress } : null;
}

function raceProgressFor(room) {
  return room?.mode === GAME_MODE.RACE ? createShadowRaceProgress(room.spec) : null;
}

function neutralInput() {
  return {
    moveX: 0,
    moveZ: 0,
    cameraYaw: 0,
    jumpPressed: false,
    jumpHeld: false,
    divePressed: false
  };
}

function heldInputFromBatch(batch, previous = neutralInput()) {
  if (!batch.length) {
    return {
      ...previous,
      jumpPressed: false,
      divePressed: false
    };
  }

  const latest = batch[batch.length - 1];
  return {
    moveX: latest.moveX,
    moveZ: latest.moveZ,
    cameraYaw: latest.cameraYaw,
    jumpPressed: batch.some(command => command.jumpPressed),
    jumpHeld: latest.jumpHeld,
    divePressed: batch.some(command => command.divePressed)
  };
}

// Collision is still owned by the legacy world layer. Shadow simulation may use that layer's
// current grounded contact, but it never writes anything back into the authoritative player state.
function alignKnownWorldContact(state, legacy = {}) {
  const next = copySimulationState(state);
  if (!next) return null;

  if (legacy.state === 'ground') {
    next.grounded = true;
    next.position.y = finite(legacy.y, next.position.y);
    if (Number.isFinite(legacy.vy)) next.velocity.y = legacy.vy;
    else if (next.velocity.y < 0) next.velocity.y = 0;
  } else if (legacy.state) {
    next.grounded = false;
  }
  return next;
}

// Горизонт измерения свободной траектории, в серверных тиках. Секунда на 30 Гц.
//
// Столько симуляция бежит сама, прежде чем её якорь сбрасывается на текущее состояние клиента.
// Секунда с запасом перекрывает и сетевую задержку, и окно реконсиляции, то есть весь срок, за
// который серверное состояние успевает доехать до экрана. Бесконечный горизонт мерил бы не
// паритет, а расхождение двух траекторий хаотической системы — оно неограниченно у любых двух
// симуляций и ничего не доказывает.
const FREE_TRAJECTORY_HORIZON_TICKS = 30;

// Подшаги свободной траектории: серверный тик 30 Гц считается двумя шагами клиентской частоты.
//
// Полунеявный Эйлер зависит от частоты: два шага по h и один по 2h расходятся на g·h² за шаг. При
// g = 22.5 и h = 1/60 это 0.223 единицы за секунду свободного падения — при полностью одинаковых
// физике, вводе и геометрии. Без подшагов измерение мерило бы не паритет, а разницу частот.
const FREE_TRAJECTORY_SUB_STEPS = 2;
const FREE_TRAJECTORY_SUB_DT = SERVER_SIMULATION_DT / FREE_TRAJECTORY_SUB_STEPS;

// Скачок позиции клиента, который может быть только возвратом на чекпоинт.
//
// Число измерено на прогоне ботов: 8602 сетевых шага, законное перемещение за тик не больше 2
// единиц (p99 = 0.62), самый короткий возврат — 10.83. Между ними нет ни одного шага.
const CLIENT_TELEPORT_DISTANCE = 4;

// Секунды с начала забега — то же число, что клиент держит в `RaceSession.elapsed` и передаёт в
// `Course.update` и `Course.interact`.
//
// `room.startedAt` — момент старта в эпохе (`Date.now() + COUNTDOWN_MS`), поэтому разница с `now`
// и даёт время матча. Пока комната не стартовала или часы неполны, времени матча ещё нет: возврат
// `null` переводит измерение на счётчик тиков, а не подставляет эпоху под синусоиды.
function matchElapsedSeconds(room, now) {
  if (!Number.isFinite(now) || !Number.isFinite(room?.startedAt)) return null;
  return (now - room.startedAt) / 1000;
}

// Сброс якоря переносит позицию и скорость, но НЕ стирает сбивание.
//
// Якорь существует, чтобы ограничить накопленный отрыв позиции, — и только для этого. Состояние
// сбивания к отрыву отношения не имеет: это последствие удара, который симуляция сама наблюдала, и
// клиент его не забывает. Пока якорь обнулял иммунитет, сервер после каждого сброса снова
// становился уязвим, тогда как клиент был неуязвим свои 0.7 с. Замер на ботах: 131 удар у сервера
// против 85 сбиваний у клиента, 51 выдуманный удар. С переносом — 84 против 85 и 3 выдуманных.
//
// Существен именно ТАЙМЕР, а не иммунитет: пока сбивание идёт, `applyKnockdown` отказывает, и
// стирание таймера возвращало серверу уязвимость к тому самому препятствию, на котором он лежит.
// Проверено раздельно — перенос одного лишь иммунитета не даёт ничего (те же 131 удар и 58.8 %).
//
// Цена у переноса есть, и она честная: сервер теперь остаётся сбитым все свои 1.4 с, поэтому там,
// где сбивания разъезжаются по времени, он лежит, пока клиент уже бежит. Согласие по опоре из-за
// этого падает с 96.4 % до 94.6 %. Это настоящее расхождение, а не артефакт, и прятать его,
// возвращая обнуление, значило бы улучшать число ценой правдивости измерения.
//
// Остальная машина состояний намеренно НЕ переносится: подкат, перекат и планирование выводятся из
// ввода заново, и их перенос измерение ухудшал.
function reanchoredState(legacy, previous) {
  const next = stateFromLegacy(legacy);
  if (!previous) return next;
  next.knockdownTimer = previous.knockdownTimer;
  next.knockdownImmunity = previous.knockdownImmunity;
  next.getupTimer = previous.getupTimer;
  return next;
}

class RollingErrorStats {
  constructor(limit = ERROR_SAMPLE_LIMIT) {
    this.limit = limit;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.samples = [];
  }

  record(value) {
    if (!Number.isFinite(value) || value < 0) return false;
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    this.samples.push(value);
    if (this.samples.length > this.limit) this.samples.shift();
    return true;
  }

  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95Index = sorted.length ? Math.max(0, Math.ceil(sorted.length * 0.95) - 1) : -1;
    return {
      count: this.count,
      mean: this.count ? this.sum / this.count : 0,
      p95: p95Index >= 0 ? sorted[p95Index] : 0,
      max: this.max,
      recentSamples: this.samples.length
    };
  }
}

// Допуск при сопоставлении событий, в серверных тиках. Треть секунды на 30 Гц.
//
// Совпадать в один тик события не обязаны и не могут: сервер получает ввод на 30 Гц, а клиент
// действует на 60, поэтому один и тот же удар случается у них с точностью до кадра-двух. Допуск
// должен покрывать этот разброс и при этом не склеивать два РАЗНЫХ удара — выдержка между
// попаданиями по одному препятствию 0.28–0.35 с, так что треть секунды это верхняя граница, за
// которой сопоставление начало бы врать в свою пользу.
const HIT_MATCH_TOLERANCE_TICKS = 10;

// Сопоставление двух потоков событий во времени.
//
// Зачем оно вместо расстояния. Отрыв позиции внутри окна определяется одним попаданием: попал или
// нет решают доли единицы, а после попадания расхождение измеряется метрами. Среднее по такой
// величине не описывает ничего. Вопрос, на который обязаны отвечать ворота, звучит прямо: бьёт ли
// сервер по тем же препятствиям, что и клиент, — и меряется он сопоставлением самих событий.
//
// Событие, не нашедшее пары в пределах допуска, считается односторонним. Просроченные ожидания
// закрываются по времени, а не в конце: иначе последние события забега оставались бы неучтёнными.
class EventPairing {
  constructor(toleranceTicks = HIT_MATCH_TOLERANCE_TICKS) {
    this.tolerance = toleranceTicks;
    this.pendingLeft = [];
    this.pendingRight = [];
    this.left = 0;
    this.right = 0;
    this.matched = 0;
    this.leftOnly = 0;
    this.rightOnly = 0;
  }

  // Оба флага относятся к одному тику. Возвращать ничего не нужно: всё видно в счётчиках.
  observe(tick, leftFired, rightFired) {
    if (leftFired) {
      this.left += 1;
      if (this.pendingRight.length) {
        this.pendingRight.shift();
        this.matched += 1;
      } else this.pendingLeft.push(tick);
    }
    if (rightFired) {
      this.right += 1;
      if (this.pendingLeft.length) {
        this.pendingLeft.shift();
        this.matched += 1;
      } else this.pendingRight.push(tick);
    }
    this.expire(tick);
  }

  expire(tick) {
    while (this.pendingLeft.length && tick - this.pendingLeft[0] > this.tolerance) {
      this.pendingLeft.shift();
      this.leftOnly += 1;
    }
    while (this.pendingRight.length && tick - this.pendingRight[0] > this.tolerance) {
      this.pendingRight.shift();
      this.rightOnly += 1;
    }
  }

  // Ожидания, ещё не закрытые допуском, в итог не входят: они пока ни совпадение, ни промах.
  snapshot() {
    const decided = this.matched + this.leftOnly + this.rightOnly;
    return {
      left: this.left,
      right: this.right,
      matched: this.matched,
      leftOnly: this.leftOnly,
      rightOnly: this.rightOnly,
      pending: this.pendingLeft.length + this.pendingRight.length,
      matchRate: decided ? this.matched / decided : 0
    };
  }
}

function rejectionBucket(reason) {
  if (reason === 'stale-sequence') return 'staleSequence';
  if (reason === 'stale-client-tick') return 'staleClientTick';
  if (reason === 'queue-full') return 'queueFull';
  if (reason === 'match-mismatch') return 'matchMismatch';
  return 'invalidOrdering';
}

class ShadowInputRuntime {
  constructor({ step = stepPlayerMotion } = {}) {
    this.step = step;
    this.controllers = new WeakMap();
    this.serverTick = 0;
    this.accepted = 0;
    this.processed = 0;
    this.simulatedSteps = 0;
    this.rejected = {
      staleSequence: 0,
      staleClientTick: 0,
      queueFull: 0,
      matchMismatch: 0,
      invalidOrdering: 0
    };
    this.positionError = new RollingErrorStats();
    this.horizontalError = new RollingErrorStats();
    // Расхождение по опоре измеряется, но ни на что не влияет: авторитетное shadow-состояние
    // по-прежнему берёт контакт с землёй у клиента. Сначала доказательства, потом переключение.
    this.groundDiagnostics = {
      samples: 0,
      worldMissing: 0,
      agreements: 0,
      groundedMismatch: 0,
      shadowGroundedOnly: 0,
      clientGroundedOnly: 0,
      // Тики, где ярлык состояния клиента не сообщает об опоре (dive, slam, knockdown, downed).
      groundStateUnknown: 0
    };
    this.groundHeightError = new RollingErrorStats();
    this.freeTrajectoryError = new RollingErrorStats();
    this.worldDiagnostics = { wallBounces: 0, impulses: 0, reanchors: 0, clientTeleports: 0 };
    // Паритет попаданий: сбивающие удары сервера против сбиваний, видимых у клиента.
    //
    // Слева сервер, справа клиент — порядок важен для чтения: `leftOnly` это удар, который сервер
    // выдумал, `rightOnly` — удар, который сервер прозевал. Первое опаснее: так игрока сбивало бы
    // на ровном месте.
    this.hitPairing = new EventPairing();
    this.progressDiagnostics = {
      checkpointEvents: 0,
      finishEvents: 0,
      comparisons: 0,
      checkpointMismatchSamples: 0,
      finishMismatchSamples: 0,
      shadowAheadSamples: 0,
      legacyAheadSamples: 0
    };
  }

  controllerFor(player, room) {
    let controller = this.controllers.get(player);
    if (!controller || controller.matchId !== room.matchId) {
      controller = {
        matchId: room.matchId,
        queue: new ClientInputQueue(),
        state: stateFromLegacy(player.last),
        input: neutralInput(),
        progress: raceProgressFor(room),
        world: shadowCourseWorldFor(room),
        // Своя траектория и свои перезарядки ударов: у клиента они собственные, и делить их
        // означало бы, что измерение подглядывает в измеряемое.
        freeState: null,
        hitTimes: new Map(),
        finishServerTime: null,
        legacyFinishedObserved: false,
        lastProcessedInput: -1,
        lastServerTick: -1
      };
      this.controllers.set(player, controller);
    }
    return controller;
  }

  accept({ player, room, message }) {
    if (!player || !room || !message || !room.matchId || message.matchId !== room.matchId) {
      this.rejected.matchMismatch += 1;
      return { accepted: false, reason: 'match-mismatch' };
    }

    const controller = this.controllerFor(player, room);
    const result = controller.queue.accept(message);
    if (result.accepted) {
      this.accepted += 1;
      return result;
    }

    this.rejected[rejectionBucket(result.reason)] += 1;
    return result;
  }

  // Сколько бы серверная симуляция расходилась с клиентом, если бы искала пол сама.
  //
  // Ничего не меняет: результат только записывается. Это тот же порядок, которым переводился
  // авторитет прогресса гонки, — сначала измерение на живом трафике, потом ворота готовности, и
  // только потом переключение. Разница здесь и есть то доказательство паритета, которого ждёт
  // guard движения: сегодня его провайдер отдаёт константу, потому что мерить было нечего.
  // Своя, ничем не подправляемая траектория.
  //
  // Авторитетное shadow-состояние каждый тик берёт контакт с землёй у клиента, поэтому расхождение
  // по нему не копится и мерить по нему нечего. Здесь идёт вторая траектория: тот же ввод, но мир
  // целиком свой — стены, пол и импульсы по общим правилам. Именно её отрыв от клиента и есть
  // доказательство паритета, которого ждёт guard движения.
  //
  // На игру не влияет ничем: результат только записывается.
  measureFreeTrajectory(controller, player, elapsedSeconds) {
    const world = controller.world;
    if (!world) {
      this.groundDiagnostics.worldMissing += 1;
      return false;
    }
    // Время матча, а не число тиков: пропуск тика не должен сдвигать трассу.
    //
    // Именно ВРЕМЯ МАТЧА, а не значение часов. Клиент считает фазы подвижных опор и препятствий от
    // `elapsed` — секунд с начала забега, — и здесь обязано быть то же самое число. Подстановка
    // `Date.now()` расставляла опоры по произвольным точкам их размаха (замерено: до 4.7 единицы
    // при размахе 3.4), и расхождение читалось бы как несовпадение геометрии, хотя не совпадали
    // часы.
    const matchTime = Number.isFinite(elapsedSeconds)
      ? elapsedSeconds
      : this.serverTick * SERVER_SIMULATION_DT;
    world.advance(matchTime);

    // Траектория меряется НА ОГРАНИЧЕННОМ ГОРИЗОНТЕ, и это не смягчение проверки, а условие того,
    // чтобы она вообще что-то значила.
    //
    // Свободно бегущая симуляция сравнивалась с клиентом от первого тика и до конца забега. На
    // прогоне ботов это дало среднее расхождение 1123 единицы при пороге 0.3 — не потому, что
    // геометрия разошлась (высота стояния совпадала до 0.0002), а потому, что клиент один раз
    // упал и вернулся на чекпоинт, а свободная траектория продолжила падать в пустоту. Дальше
    // сравнивались бегущий по трассе игрок и точка где-то под миром.
    //
    // Вопрос, на который обязаны ответить ворота, звучит иначе: расходится ли серверная симуляция
    // с клиентской ЗА ТО ВРЕМЯ, пока она успевает доехать до экрана. Это вопрос о коротком
    // горизонте, и меряется он сбросом якоря раз в секунду.
    if (!controller.freeState) {
      controller.freeState = stateFromLegacy(player.last);
      controller.freeTicks = 0;
    }

    // Возврат на чекпоинт — не расхождение симуляций, а разрыв в клиенте, которого серверная
    // симуляция не переживала: она не падала. Считать такой скачок ошибкой паритета значило бы
    // мерить respawn вместо физики.
    //
    // Порог измерен, а не назначен: на 8602 сетевых шагах ботов законное перемещение за тик не
    // превышало 2 единиц (p99 = 0.62), а самый короткий возврат на чекпоинт составил 10.83. Между
    // 2 и 10.83 нет ни одного шага, и 4 лежит посреди этого разрыва.
    const clientJump = controller.lastClientPosition
      ? Math.hypot(
          finite(player.last?.x) - controller.lastClientPosition.x,
          finite(player.last?.y) - controller.lastClientPosition.y,
          finite(player.last?.z) - controller.lastClientPosition.z
        )
      : 0;
    controller.lastClientPosition = {
      x: finite(player.last?.x),
      y: finite(player.last?.y),
      z: finite(player.last?.z)
    };
    if (clientJump > CLIENT_TELEPORT_DISTANCE) {
      this.worldDiagnostics.clientTeleports += 1;
      controller.freeState = reanchoredState(player.last, controller.freeState);
      controller.freeTicks = 0;
      // Этот тик не измеряем вовсе: сравнивать было бы нечего.
      return true;
    }

    if (controller.freeTicks >= FREE_TRAJECTORY_HORIZON_TICKS) {
      this.worldDiagnostics.reanchors += 1;
      controller.freeState = reanchoredState(player.last, controller.freeState);
      controller.freeTicks = 0;
    }
    controller.freeTicks += 1;

    // Серверный тик считается ПОДШАГАМИ клиентской частоты, а не одним шагом своей.
    //
    // Полушаг здесь не оптимизация и не сглаживание. Полунеявный Эйлер даёт разный ответ на разной
    // частоте: два шага по 1/60 и один по 1/30 расходятся на g·h² за шаг, и на секунде свободного
    // падения это 0.223 единицы — при одинаковой физике, одинаковом вводе и одинаковой геометрии.
    // То есть порог в 0.3 по среднему был недостижим не из-за расхождения физики, а из-за того,
    // что сервер интегрировал не с той частотой, что клиент.
    //
    // Клиент крутит фиксированный цикл 1/60 (`client/main.js`), и каждый его кадр — это движение,
    // отскок, опора и импульсы. Здесь тот же цикл, дважды за тик: сравнивается одинаковое с
    // одинаковым. Замерено: 0.93 мкс на подшаг, то есть 0.17 % ядра на шестьдесят игроков.
    let impulses = null;
    let serverKnockdown = false;
    for (let sub = 0; sub < FREE_TRAJECTORY_SUB_STEPS; sub++) {
      // Мир доводится до времени каждого подшага: перенос движущейся опорой считается по её сдвигу
      // за подшаг, ровно как у клиента за кадр.
      world.advance(matchTime - SERVER_SIMULATION_DT + (sub + 1) * FREE_TRAJECTORY_SUB_DT);

      const before = copySimulationState(controller.freeState);
      const stepped = this.step(controller.freeState, controller.input, {}, FREE_TRAJECTORY_SUB_DT).state;

      const normal = wallBounceNormalAt(
        world.walls,
        stepped.position,
        before.position,
        stepped.velocity,
        PLAYER_BODY_RADIUS
      );
      if (normal && !before.grounded && before.jumpBuffer > 0) {
        applyWallBounce(stepped, normal, before.position, { jumpSpeed: JUMP_SPEED });
        this.worldDiagnostics.wallBounces += 1;
      }

      const settled = resolveGroundContact(stepped, {
        colliders: world.colliders,
        previousY: before.position.y,
        footOffset: PLAYER_FOOT,
        intent: movementIntent(controller.input),
        wasGrounded: before.grounded
      }).state;

      impulses = applyObstacleImpulses(settled, {
        obstacles: world.obstacles,
        // Тот же счётчик времени матча: от него зависят и фаза поршня, и выдержка между попаданиями.
        now: matchTime - SERVER_SIMULATION_DT + (sub + 1) * FREE_TRAJECTORY_SUB_DT,
        hitTimes: controller.hitTimes,
        playerRadius: PLAYER_OBSTACLE_RADIUS,
        footOffset: PLAYER_FOOT,
        knockback: 1,
        limpHitCooldown: 0
      });
      this.worldDiagnostics.impulses += impulses.events.length;
      // Импульс препятствия несёт не только толчок, но и сбивание, и второе клиент применяет
      // (`Course.interact` → `player.knockDown`). Пока здесь считались только толчки, каждое
      // попадание разводило траектории на полторы секунды: клиент терял управление, а свободная
      // симуляция бежала дальше. Замерено на ботах — расхождение начиналось ровно на первом
      // попадании, с knockdownTimer 1.383 у клиента против нуля у сервера.
      for (const event of impulses.events) {
        // Сбивание засчитывается в событие только если оно СОСТОЯЛОСЬ: иммунитет и уже идущее
        // сбивание отменяют его и у клиента тоже, поэтому сравнивать надо результат, а не намерение.
        if (event.knockdown && applyKnockdown(impulses.state, event.knockdown)) serverKnockdown = true;
      }
      controller.freeState = impulses.state;
    }

    // Сбивание у клиента наблюдаемо прямо в снапшоте: ярлык состояния встаёт в `knockdown`.
    // Считается ПЕРЕХОД, а не само состояние, — иначе одно сбивание длиной в полторы секунды
    // насчитало бы себе полсотни событий.
    const clientKnockdown = player.last?.state === 'knockdown';
    const clientKnockdownStarted = clientKnockdown && !controller.clientWasKnockedDown;
    controller.clientWasKnockedDown = clientKnockdown;
    this.hitPairing.observe(this.serverTick, serverKnockdown, clientKnockdownStarted);

    // Опору клиента видно НЕ ВСЕГДА, и это не то же самое, что «опоры нет».
    //
    // `state` в снапшоте — ярлык подачи с приоритетом, а не флаг опоры: сбитый игрок лежит НА полу,
    // но помечен `knockdown`, а скользящий в подкате — `dive`. Сравнение с `=== 'ground'` считало
    // такие тики расхождением. Замер на ботах: из 1352 случаев «сервер дал пол» 748 приходились на
    // knockdown и 245 на dive — 73 % несуществующих расхождений.
    //
    // Поэтому тики, где опора клиента не наблюдаема, из статистики согласия исключаются и считаются
    // отдельно. Неизвестное — не согласие и не расхождение; записать его в согласия значило бы
    // выдумать доказательство.
    const clientState = player.last?.state;
    const clientGroundKnown = clientState === 'ground' || clientState === 'air';
    const clientGrounded = clientState === 'ground';
    if (!clientGroundKnown) this.groundDiagnostics.groundStateUnknown += 1;
    else {
      this.groundDiagnostics.samples += 1;
      if (controller.freeState.grounded === clientGrounded) this.groundDiagnostics.agreements += 1;
      else {
        this.groundDiagnostics.groundedMismatch += 1;
        if (controller.freeState.grounded) this.groundDiagnostics.shadowGroundedOnly += 1;
        else this.groundDiagnostics.clientGroundedOnly += 1;
      }
    }

    const legacy = player.last;
    if (legacy && Number.isFinite(legacy.x) && Number.isFinite(legacy.y) && Number.isFinite(legacy.z)) {
      const dx = controller.freeState.position.x - legacy.x;
      const dy = controller.freeState.position.y - legacy.y;
      const dz = controller.freeState.position.z - legacy.z;
      // Расхождение по позиции наблюдаемо всегда: ярлык состояния на него не влияет.
      this.freeTrajectoryError.record(Math.hypot(dx, dy, dz));
      if (clientGrounded && controller.freeState.grounded) this.groundHeightError.record(Math.abs(dy));
    }
    return true;
  }

  recordProgressComparison(controller, player) {
    if (!controller.progress) return false;
    const legacyCheckpoint = Number.isSafeInteger(player.checkpoint) ? Math.max(0, player.checkpoint) : 0;
    const shadowCheckpoint = controller.progress.checkpoint;
    const legacyFinished = player.finished === true;
    const shadowFinished = controller.progress.finished === true;

    this.progressDiagnostics.comparisons += 1;
    if (shadowCheckpoint !== legacyCheckpoint) this.progressDiagnostics.checkpointMismatchSamples += 1;
    if (shadowFinished !== legacyFinished) this.progressDiagnostics.finishMismatchSamples += 1;
    if (shadowCheckpoint > legacyCheckpoint) this.progressDiagnostics.shadowAheadSamples += 1;
    if (legacyCheckpoint > shadowCheckpoint) this.progressDiagnostics.legacyAheadSamples += 1;
    return true;
  }

  advanceProgress(controller, player, room, previousState, currentState, now) {
    if (!controller.progress) return false;
    const result = advanceShadowRaceProgress(
      controller.progress,
      previousState,
      currentState,
      room.spec,
      this.serverTick
    );
    controller.progress = result.progress;
    for (const event of result.events) {
      if (event.type === 'checkpoint') this.progressDiagnostics.checkpointEvents += 1;
      if (event.type === 'finish') {
        this.progressDiagnostics.finishEvents += 1;
        if (controller.finishServerTime === null && Number.isSafeInteger(now) && now >= 0) {
          controller.finishServerTime = now;
        }
      }
    }
    this.recordProgressComparison(controller, player);
    return result.events.length > 0;
  }

  consume(controller, player, room, { advance, now }) {
    const batch = controller.queue.drain();
    controller.input = heldInputFromBatch(batch, controller.input);
    if (batch.length) {
      controller.lastProcessedInput = batch[batch.length - 1].sequence;
      this.processed += batch.length;
    }

    if (!advance) {
      // Countdown input may establish held movement, but old jump/dive edges must not fire when the
      // start gate opens seconds later.
      controller.input.jumpPressed = false;
      controller.input.divePressed = false;
      controller.state = stateFromLegacy(player.last);
      return;
    }

    const aligned = alignKnownWorldContact(controller.state, player.last);
    const previousState = copySimulationState(aligned);
    const result = this.step(aligned, controller.input, {}, SERVER_SIMULATION_DT);
    this.measureFreeTrajectory(controller, player, matchElapsedSeconds(room, now));
    controller.state = result.state;
    controller.lastServerTick = this.serverTick;
    this.simulatedSteps += 1;
    this.advanceProgress(controller, player, room, previousState, controller.state, now);

    const legacy = player.last;
    if (legacy && Number.isFinite(legacy.x) && Number.isFinite(legacy.y) && Number.isFinite(legacy.z)) {
      const dx = controller.state.position.x - legacy.x;
      const dy = controller.state.position.y - legacy.y;
      const dz = controller.state.position.z - legacy.z;
      this.horizontalError.record(Math.hypot(dx, dz));
      this.positionError.record(Math.hypot(dx, dy, dz));
    }

    // Pressed is an edge. Held axes/buttons survive until a newer command arrives; edges do not.
    controller.input.jumpPressed = false;
    controller.input.divePressed = false;
  }

  tick(rooms, now = Date.now()) {
    this.serverTick += 1;
    for (const room of rooms.values()) {
      if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) continue;
      const advance = room.state === ROOM_STATE.PLAYING || (room.startedAt && now >= room.startedAt);
      for (const player of room.players.values()) {
        const controller = this.controllers.get(player);
        if (!controller || controller.matchId !== room.matchId || player.bot) continue;
        if (player.finished) {
          if (!controller.legacyFinishedObserved) {
            controller.legacyFinishedObserved = true;
            this.recordProgressComparison(controller, player);
          }
          continue;
        }
        this.consume(controller, player, room, { advance, now });
      }
    }
    return this.serverTick;
  }

  snapshot(player) {
    const controller = this.controllers.get(player);
    if (!controller) return null;
    return {
      matchId: controller.matchId,
      pending: controller.queue.size,
      lastProcessedInput: controller.lastProcessedInput,
      lastServerTick: controller.lastServerTick,
      state: copySimulationState(controller.state),
      progress: copyRaceProgress(controller.progress),
      finishServerTime: controller.finishServerTime
    };
  }

  metrics() {
    const comparisons = this.progressDiagnostics.comparisons;
    return {
      serverHz: SERVER_SIMULATION_HZ,
      serverTick: this.serverTick,
      accepted: this.accepted,
      processed: this.processed,
      simulatedSteps: this.simulatedSteps,
      rejected: { ...this.rejected },
      legacyPositionError: this.positionError.snapshot(),
      legacyHorizontalError: this.horizontalError.snapshot(),
      shadowRaceProgress: {
        ...this.progressDiagnostics,
        checkpointMismatchRate: comparisons
          ? this.progressDiagnostics.checkpointMismatchSamples / comparisons
          : 0,
        finishMismatchRate: comparisons ? this.progressDiagnostics.finishMismatchSamples / comparisons : 0
      },
      shadowGroundContact: {
        ...this.groundDiagnostics,
        ...this.worldDiagnostics,
        freeTrajectoryError: this.freeTrajectoryError.snapshot(),
        agreementRate: this.groundDiagnostics.samples
          ? this.groundDiagnostics.agreements / this.groundDiagnostics.samples
          : 0,
        heightError: this.groundHeightError.snapshot(),
        // Паритет попаданий. `serverOnly` — удар, которого у клиента не было; `clientOnly` —
        // пропущенный сервером.
        hitParity: (() => {
          const pairing = this.hitPairing.snapshot();
          return {
            serverHits: pairing.left,
            clientHits: pairing.right,
            matched: pairing.matched,
            serverOnly: pairing.leftOnly,
            clientOnly: pairing.rightOnly,
            pending: pairing.pending,
            matchRate: pairing.matchRate
          };
        })()
      }
    };
  }
}

module.exports = {
  ERROR_SAMPLE_LIMIT,
  SERVER_SIMULATION_DT,
  SERVER_SIMULATION_HZ,
  SERVER_SIMULATION_INTERVAL_MS,
  RollingErrorStats,
  ShadowInputRuntime,
  alignKnownWorldContact,
  heldInputFromBatch,
  raceProgressFor,
  stateFromLegacy
};
