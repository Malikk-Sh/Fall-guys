'use strict';

const { ClientInputQueue } = require('./clientInputQueue');
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const {
  GROUND_CONTACT_MAX_UPWARD_SPEED,
  createPlayerSimulationState,
  stepPlayerMotion
} = require('../shared/playerSimulation.js');

const { PLAYER_FOOT } = require('../shared/playerDimensions.js');
const { supportIndexAt, supportTop } = require('../shared/courseCollision.js');
const { stepPlayerThroughWorld } = require('./playerWorldStep');
const { WORLD_SUPPORT, shadowCourseWorldFor, shadowWorldSupport } = require('./shadowCourseWorld');
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

// Сколько снимков подряд можно отложить как «поставлен, но ещё не просимулирован».
//
// Постановка распознаётся по скачку позиции, а скачок не отличает возрождение от обычного бега,
// потерявшего несколько пакетов состояния. Если после такого разрыва игрок остановится, его
// округлённая позиция может совпадать с точкой «постановки» сколь угодно долго — и доказательства
// молча выбрасывались бы вместо того, чтобы откладываться на кадр. Настоящему возрождению хватает
// одного-двух снимков: следующий шаг физики уже ставит игрока на опору.
const PLACED_SKIP_LIMIT = 2;

// Кадр клиента: его физика крутится фиксированным циклом 1/60 (`client/main.js`).
const CLIENT_FRAME_DT = 1 / 60;

// Насколько время трассы от клиента может расходиться с серверным, чтобы ему ещё верили.
//
// Поле `courseTime` приходит от клиента, а клиент — не источник истины. Само по себе оно безобидно:
// читает его только диагностика, и попадает оно лишь в отдельный мир для сверки опоры. Но метрики
// паритета общие на процесс, и подставленное значение навело бы платформу на чужую фазу — то есть
// испортило бы или, наоборот, приукрасило доказательства, по которым однажды будут открывать
// ворота. Поэтому значение принимается, только если сходится с собственным временем сервера.
//
// Полсекунды с запасом покрывают задержку и интервал рассылки. Внутри этого окна клиент по-прежнему
// волен соврать, и это неустранимо без доверенных часов; за окном — значение просто не берётся, и
// подвижные опоры откладываются, как будто поля нет.
const CLIENT_COURSE_TIME_TOLERANCE = 0.5;

// Полосы коррекции реконсиляции: мягкая правка начинается с 0.3, жёсткая — с 1.5, и жёсткая видна
// игроку рывком (`client/net/ReconciliationPolicy.js`). Доли превышения считаются по ним.
const TRAJECTORY_SOFT_LIMIT = 0.3;
const TRAJECTORY_HARD_LIMIT = 1.5;

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

// Время трассы от клиента, если ему можно верить. Иначе null — и подвижные опоры не сверяются.
function trustedCourseTime(player, matchTime) {
  const reported = player?.lastCourseTime;
  if (!Number.isFinite(reported) || reported < 0) return null;
  if (!Number.isFinite(matchTime)) return null;
  return Math.abs(reported - matchTime) <= CLIENT_COURSE_TIME_TOLERANCE ? reported : null;
}

// Похоже ли состояние на игрока, которого только что ПОСТАВИЛИ, а не просимулировали.
//
// Подпись механическая, а не подогнанная: `Player.respawn` и `Player.teleport` обнуляют скорость
// целиком (`velocity.set(0, 0, 0)`) и не пересчитывают `grounded` — это сделает следующий кадр.
// Значит нулевая скорость по всем трём осям вместе с пометкой «воздух» и есть тот единственный кадр,
// в котором ярлык опоры ничего не сообщает.
//
// Просимулированный игрок в воздухе так выглядеть не может: после любого шага гравитация делает
// `vy` ненулевым. А стоящий на месте помечен `ground`, а не `air`, и под подпись не попадает.
function looksPlaced(legacy) {
  return (
    legacy?.state === 'air' && finite(legacy.vx) === 0 && finite(legacy.vy) === 0 && finite(legacy.vz) === 0
  );
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

// Откуда клиент пришёл за ОДИН СВОЙ кадр, а не за один серверный тик.
//
// Свип-тест спрашивает «не прошёл ли игрок сквозь поверхность с прошлой проверки». Клиент проверяет
// каждые 1/60, а сервер видит его раз в 1/30, и подстановка прошлого сетевого отсчёта растягивала
// свип вдвое: на падении со скоростью 8.9 он покрывал 0.30 вместо 0.15 и ловил опору, мимо которой
// клиент пролетел. Поэтому исходная точка восстанавливается по скорости на один клиентский кадр —
// единственное, что тут можно сделать честно: промежуточной позиции сервер не видит вовсе.
//
// Восстановление СИММЕТРИЧНО, и это не мелочь. Сначала здесь стояло «продлевать только при
// падении», в расчёте на то, что подъём отсекут пороги по скорости. Они отсекают лишь БЫСТРЫЙ
// подъём: игрок, поднимающийся медленнее 1.5, проходит guard, и подстановка текущей высоты вместо
// прошлой превращала подход снизу в приземление сверху. При верхе опоры 0, y = 0.01 и vy = 1
// клиент был на -0.0067 и контакт отвергает, а замер отвечал «пол» — и записывал несуществующее
// расхождение.
function clientFramePreviousY(legacy) {
  return finite(legacy?.y) - finite(legacy?.vy) * CLIENT_FRAME_DT;
}

class RollingErrorStats {
  // `thresholds` — значения, доли превышения которых считаются по ВСЕЙ популяции, а не по окну.
  //
  // Квантили здесь живут в кольце последних 512 значений, и как справка это нормально. Но решение
  // по ним принимать нельзя: 2488 плохих выборок, за которыми идут 512 хороших, дали бы проходящие
  // p50 и p95 при том, что почти вся накопленная статистика провалена. Доля превышения порога
  // считается двумя счётчиками и от длины окна не зависит вовсе.
  constructor(limit = ERROR_SAMPLE_LIMIT, thresholds = null) {
    this.limit = limit;
    this.count = 0;
    this.sum = 0;
    this.max = 0;
    this.samples = [];
    this.thresholds = thresholds;
    this.overSoft = 0;
    this.overHard = 0;
  }

  record(value) {
    if (!Number.isFinite(value) || value < 0) return false;
    this.count += 1;
    this.sum += value;
    this.max = Math.max(this.max, value);
    if (this.thresholds) {
      if (value > this.thresholds.soft) this.overSoft += 1;
      if (value > this.thresholds.hard) this.overHard += 1;
    }
    this.samples.push(value);
    if (this.samples.length > this.limit) this.samples.shift();
    return true;
  }

  snapshot() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const quantile = share => (sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * share) - 1)] : 0);
    return {
      count: this.count,
      mean: this.count ? this.sum / this.count : 0,
      // Медиана нужна отдельно от среднего: у отрыва траектории тяжёлый хвост, и среднее по нему
      // задают редкие выбросы, а не типичное поведение.
      p50: quantile(0.5),
      p95: quantile(0.95),
      max: this.max,
      recentSamples: this.samples.length,
      // Превышения отдаются СЧЁТЧИКАМИ, а доли — производными от них.
      //
      // Наружу шли только доли, и это ломало ровно то свойство, ради которого всё построено:
      // оценщик обязан пересчитывать долю сам, иначе испорченный снимок с `overHardRate: 0` при
      // пятистах превышениях прошёл бы проверку. Для согласия по опоре счётчики отдавались всегда,
      // и здесь тот же порядок. Заодно складывать замеры по забегам можно точно, а не через
      // округление доли обратно в счётчик.
      overSoft: this.overSoft,
      overHard: this.overHard,
      overSoftRate: this.count ? this.overSoft / this.count : 0,
      overHardRate: this.count ? this.overHard / this.count : 0
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
// Событие, не нашедшее пары в пределах допуска, считается односторонним.
//
// Сопоставление ведётся ПОИГРОКОВО, а счётчики общие, и разделение это не косметическое. Ожидания
// жили одним набором на весь runtime, тогда как измерение вызывается на каждого игрока отдельно, —
// то есть удар сервера по игроку A мог закрыться сбиванием игрока B, оказавшимся рядом по времени.
// Складывать статистику между игроками можно, сопоставлять события — нельзя, и ошибка эта
// приукрашивающая: чужая пара повышает долю совпадений и снижает число выдуманных ударов, то есть
// двигает доказательства в сторону открытия ворот. На одном игроке (замер на ботах) её не видно
// вовсе.
//
// Поэтому здесь остаются только ОЖИДАНИЯ, а решённое отдаётся наружу и складывается вызывающим.
class EventPairing {
  constructor(toleranceTicks = HIT_MATCH_TOLERANCE_TICKS) {
    this.tolerance = toleranceTicks;
    this.pendingLeft = [];
    this.pendingRight = [];
  }

  get pending() {
    return this.pendingLeft.length + this.pendingRight.length;
  }

  // Возвращается то, что решилось ИМЕННО НА ЭТОМ шаге.
  //
  // `tick` — часы: по ним и только по ним закрывается просрочка. `rightTick` — собственная отметка
  // клиентского события, и она может быть СТАРШЕ часов. Разделены они потому, что стороны попадают
  // сюда по-разному: серверное событие рождается в текущем тике, а клиентское лишь НАБЛЮДАЕТСЯ в
  // нём — приезжает в снимке, который старше на интервал рассылки плюс задержку сети. Пока обе
  // стороны штамповались часами, замер видел эту задержку как расхождение симуляций.
  //
  // `rightAligned` — удалось ли отметить клиентское событие его собственным временем. Признак едет
  // вместе с ожиданием и всплывает при выдаче задержки: доля выровненных имеет смысл считать только
  // по тем событиям, что ПОПАЛИ В ГИСТОГРАММУ, а не по всем подряд.
  observe(tick, leftFired, rightFired, rightTick = tick, rightAligned = false) {
    // Просрочка закрывается ДО сопоставления, а не после.
    //
    // Обратный порядок расширял окно на тик: ожидание возраста 11 успевало найти пару прежде, чем
    // его удаляли, и заявленная треть секунды на деле была 0.367 с. Допуск обязан значить ровно то,
    // что написано, — иначе он не граница, а пожелание.
    const decided = this.expire(tick);
    if (leftFired) {
      decided.left += 1;
      const candidate = this.pendingRight[0];
      if (candidate && this.withinTolerance(tick, candidate.tick)) {
        this.pendingRight.shift();
        decided.matched += 1;
        // Сервер сработал ПОЗЖЕ клиента — знак положительный.
        noteMatchDelay(decided, tick - candidate.tick, candidate.aligned);
      } else this.pendingLeft.push(tick);
    }
    if (rightFired) {
      decided.right += 1;
      const candidate = this.pendingLeft[0];
      if (candidate !== undefined && this.withinTolerance(candidate, rightTick)) {
        this.pendingLeft.shift();
        decided.matched += 1;
        // Сервер сработал РАНЬШЕ клиента — знак отрицательный. Знак один на оба случая:
        // serverTick − clientTick, и одновременность даёт ноль.
        noteMatchDelay(decided, candidate - rightTick, rightAligned);
      } else this.pendingRight.push({ tick: rightTick, aligned: rightAligned });
    }
    return decided;
  }

  // Допуск проверяется по САМИМ ОТМЕТКАМ, а не только просрочкой по часам.
  //
  // Просрочки мало, и это стоило отдельного разбора. Клиентская отметка едет назад на возраст
  // снимка, а серверное ожидание живёт по часам — поэтому снимок возрастом 15, принятый на тике 23,
  // заставал в ожидании серверный удар с тика 20 и «совпадал» с ним, хотя отметки расходятся на 12
  // при допуске 10. Гистограмма такую пару прижимала к крайней корзине — то есть подделывала ровно
  // тот признак обрезанного хвоста, по которому этот случай и распознают.
  //
  // Отказ в паре не теряет событие: оно уходит в ожидание и закроется как одностороннее.
  withinTolerance(left, right) {
    return Math.abs(left - right) <= this.tolerance;
  }

  expire(tick) {
    const decided = noHitDecisions();
    while (this.pendingLeft.length && tick - this.pendingLeft[0] > this.tolerance) {
      this.pendingLeft.shift();
      decided.leftOnly += 1;
    }
    while (this.pendingRight.length && tick - this.pendingRight[0].tick > this.tolerance) {
      this.pendingRight.shift();
      decided.rightOnly += 1;
    }
    return decided;
  }

  // Забег кончился — пары уже не будет.
  //
  // Пока матч идёт, незакрытое ожидание правильно не считать ни совпадением, ни промахом: пара ещё
  // может прийти. Но после финиша тиков по этому игроку больше нет, и без явного закрытия хвостовые
  // события просто исчезали — в том числе выдуманный сервером удар за пару тиков до финиша, то есть
  // ровно тот случай, который порог `maxServerOnlyHits: 0` обязан ловить.
  finalize() {
    const decided = noHitDecisions();
    decided.leftOnly = this.pendingLeft.length;
    decided.rightOnly = this.pendingRight.length;
    this.pendingLeft = [];
    this.pendingRight = [];
    return decided;
  }
}

function noHitDecisions() {
  return { left: 0, right: 0, matched: 0, leftOnly: 0, rightOnly: 0 };
}

// Задержки приписываются к решению ЛЕНИВО и только при совпадении.
//
// Поля в `noHitDecisions` намеренно нет: `expire` и `finalize` совпадений не дают вовсе, и форма их
// ответа — часть контракта сопоставления, на который смотрят соседние тесты. Замер не имеет права
// её менять; вызывающий читает `decided.delays || []`.
// Вместе с задержкой едет и признак выравнивания клиентской стороны: доля выровненных имеет смысл
// только по тем событиям, что попали в гистограмму. Считать её по всем клиентским ударам подряд —
// значит мерить не то: односторонние в гистограмму не попадают вовсе, и знаменатель разъезжается с
// числителем.
function noteMatchDelay(decided, ticks, aligned = false) {
  (decided.delays || (decided.delays = [])).push({ ticks, aligned: aligned === true });
}

// Распределение задержки между парой событий одного удара, в серверных тиках, со знаком
// `serverTick − clientTick`.
//
// Зачем оно. Паритет ударов на проде — 66.5 %: совпало 161 из 242, 34 удара видит только сервер, 47
// только клиент. Причин ровно две, и по нынешним метрикам они неразличимы, потому что записывается
// только ИТОГ сопоставления:
//
//   * постоянный сдвиг по времени. Тогда события те же самые, просто одно систематически позже, и
//     часть пар выходит за допуск: `expire()` закрывает серверное как `serverOnly`, а пришедшее
//     позже клиентское как `clientOnly`. Один настоящий удар даёт по единице в каждую сторону —
//     наблюдаемая «симметрия» это и есть, а вовсе не улика против сдвига.
//   * разная геометрия препятствий. Тогда удары действительно разные.
//
// Различает их форма распределения, и читается она так:
//
//   * центр около нуля, спад к краям, обе стороны примерно поровну — сдвига нет, допуск ничего не
//     срезает, и односторонние события это настоящая разница геометрии;
//   * центр смещён (ненулевое среднее, одна сторона ведёт) — сдвиг есть;
//   * счётчики РАСТУТ к краям ±допуск — видна лишь часть распределения, хвост обрезан допуском, и
//     односторонние события скорее продолжение того же сдвига, чем разная геометрия.
//
// Ограничение честное и существенное: задержка известна только для СОВПАВШИХ пар. Сдвиг больше
// допуска в гистограмму не попадает вовсе — о нём говорят края, а не тело.
function createMatchDelayHistogram(tolerance = HIT_MATCH_TOLERANCE_TICKS) {
  const buckets = new Array(2 * tolerance + 1).fill(0);
  let samples = 0;
  let total = 0;
  let serverLeads = 0;
  let clientLeads = 0;
  let simultaneous = 0;

  return {
    add(ticks) {
      if (!Number.isFinite(ticks)) return false;
      const clamped = Math.max(-tolerance, Math.min(tolerance, Math.round(ticks)));
      buckets[clamped + tolerance] += 1;
      samples += 1;
      total += clamped;
      if (clamped < 0) serverLeads += 1;
      else if (clamped > 0) clientLeads += 1;
      else simultaneous += 1;
      return true;
    },
    snapshot() {
      return {
        samples,
        // Ненулевое среднее — это и есть постоянный сдвиг. Знак говорит, кто опаздывает.
        meanTicks: samples ? total / samples : 0,
        serverLeads,
        clientLeads,
        simultaneous,
        // От -tolerance до +tolerance включительно. Крайние корзины важнее прочих: их рост означает,
        // что распределение обрезано допуском.
        toleranceTicks: tolerance,
        buckets: [...buckets]
      };
    }
  };
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
      // Тики режимов, для которых геометрия не строится по устройству. Не отказ, а неприменимость.
      worldUnsupportedMode: 0,
      agreements: 0,
      groundedMismatch: 0,
      shadowGroundedOnly: 0,
      clientGroundedOnly: 0,
      // Тики, где ярлык состояния клиента не сообщает об опоре (dive, slam, knockdown, downed).
      groundStateUnknown: 0
    };
    // Согласие о ПОЛЕ, проверенное в точке клиента. Отдельная величина, и это принципиально.
    //
    // `groundDiagnostics` выше спрашивает про опору там, куда пришла свободная траектория, и потому
    // отвечает сразу на два вопроса: сходится ли модель мира и не уехала ли траектория. Второе
    // забивает первое. Здесь задаётся только первый вопрос: нашёл бы сервер тот же пол ТАМ, ГДЕ
    // СЕЙЧАС КЛИЕНТ.
    this.groundModelDiagnostics = {
      samples: 0,
      agreements: 0,
      serverGroundedOnly: 0,
      clientGroundedOnly: 0,
      // Выборки на подвижных опорах: сверить их нечем, пока в снимке нет клиентского времени.
      dynamicSkipped: 0,
      // Выборки сразу после постановки: шага физики ещё не было, ярлык опоры бессмыслен.
      placedSkipped: 0
    };
    this.groundHeightError = new RollingErrorStats();
    // Пороги те же, по которым живёт реконсиляция: мягкая коррекция с 0.3, жёсткая с 1.5.
    this.freeTrajectoryError = new RollingErrorStats(ERROR_SAMPLE_LIMIT, {
      soft: TRAJECTORY_SOFT_LIMIT,
      hard: TRAJECTORY_HARD_LIMIT
    });
    this.worldDiagnostics = { wallBounces: 0, impulses: 0, reanchors: 0, clientTeleports: 0 };
    // Паритет попаданий: сбивающие удары сервера против сбиваний, видимых у клиента.
    //
    // Слева сервер, справа клиент — порядок важен для чтения: `leftOnly` это удар, который сервер
    // выдумал, `rightOnly` — удар, который сервер прозевал. Первое опаснее: так игрока сбивало бы
    // на ровном месте.
    // Счётчики попаданий общие на процесс, а ОЖИДАНИЯ живут у каждого игрока (см. EventPairing).
    this.hitTotals = noHitDecisions();
    this.hitMatchDelay = createMatchDelayHistogram();
    // Чем отмечены удары, ПОПАВШИЕ В ГИСТОГРАММУ: своим временем клиента или временем приёма.
    // Смешивать их нельзя молча — у неотмеченных задержка завышена на возраст снимка, и вместе они
    // дают двугорбое распределение, читающееся как шум.
    //
    // Считается на выдаче задержки, а не на каждом клиентском ударе. Знаменатель обязан совпадать с
    // содержимым гистограммы: односторонние удары в неё не попадают, и включать их значило бы
    // получить долю, по которой о гистограмме ничего не скажешь.
    this.hitClientStamp = { aligned: 0, unaligned: 0 };
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

  // Закрывает сопоставление ударов игрока, учтя его ПОСЛЕДНЕЕ наблюдаемое состояние.
  //
  // Наблюдение обязано идти до закрытия. Финишный пакет вполне может быть первым снимком со
  // сбиванием: проверка финиша у клиента (`client/game/Player.js`) сбитого не исключает, и игрока
  // может занести за финишную плоскость лёжа. Ветка финиша не вызывает `consume`, поэтому без
  // отдельного наблюдения такое сбивание не засчиталось бы вовсе — а ждущий пары удар сервера
  // закрылся бы как выдуманный, хотя пара у него была.
  finalizeHits(controller, player) {
    const clientKnockdown = player?.last?.state === 'knockdown';
    if (clientKnockdown && !controller.clientWasKnockedDown) {
      controller.clientWasKnockedDown = true;
      // Этот путь отметить своим временем нечем: игрок уже уходит, времени матча здесь нет, и
      // сверить с ним клиентское некому. Штамп остаётся временем приёма, и `rightAligned` по
      // умолчанию ложь — если такой удар всё же составит пару, он попадёт в гистограмму помеченным
      // как невыровненный. Иначе `clientStamp` показывал бы «выровнено почти всё», пока подобные
      // удары молча подмешивают в неё возраст снимка.
      this.recordHitDecisions(controller.hitPairing.observe(this.serverTick, false, true));
    }
    this.recordHitDecisions(controller.hitPairing.finalize());
  }

  // Игрок уходит из комнаты. Вызывается снаружи: `dropPlayer` удаляет его из списка немедленно, и
  // тик его больше не увидит — а контроллер лежит в WeakMap, откуда закрыть его уже нельзя.
  release(player) {
    const controller = this.controllers.get(player);
    if (!controller) return false;
    this.finalizeHits(controller, player);
    this.controllers.delete(player);
    return true;
  }

  recordHitDecisions(decided) {
    this.hitTotals.left += decided.left;
    this.hitTotals.right += decided.right;
    this.hitTotals.matched += decided.matched;
    this.hitTotals.leftOnly += decided.leftOnly;
    this.hitTotals.rightOnly += decided.rightOnly;
    for (const { ticks, aligned } of decided.delays || []) {
      this.hitMatchDelay.add(ticks);
      if (aligned) this.hitClientStamp.aligned += 1;
      else this.hitClientStamp.unaligned += 1;
    }
  }

  controllerFor(player, room) {
    let controller = this.controllers.get(player);
    if (!controller || controller.matchId !== room.matchId) {
      // Матч сменился — ожидания прошлого забега пары уже не дождутся.
      if (controller) this.recordHitDecisions(controller.hitPairing.finalize());
      controller = {
        matchId: room.matchId,
        queue: new ClientInputQueue(),
        state: stateFromLegacy(player.last),
        input: neutralInput(),
        progress: raceProgressFor(room),
        world: shadowCourseWorldFor(room),
        // Ожидается ли геометрия для этого режима вообще — см. `shadowWorldSupport`.
        worldSupport: shadowWorldSupport(room),
        // Второй мир — только для замера в точке клиента. Он доводится до ВРЕМЕНИ СНАПШОТА, а не
        // до текущего тика, поэтому не может быть тем же объектом: свободная траектория считает
        // перенос движущейся опорой по её сдвигу за подшаг, и подмотка мира назад испортила бы его.
        probeWorld: shadowCourseWorldFor(room),
        // Своя траектория и свои перезарядки ударов: у клиента они собственные, и делить их
        // означало бы, что измерение подглядывает в измеряемое.
        freeState: null,
        hitTimes: new Map(),
        // Своё сопоставление ударов: события одного игрока не должны закрываться событиями другого.
        hitPairing: new EventPairing(),
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
  measureFreeTrajectory(controller, player, elapsedSeconds, snapshotSeconds) {
    const world = controller.world;
    if (!world) {
      // Отсутствие мира по ошибке и отсутствие по устройству режима — разные вещи.
      //
      // `maxWorldMissingSamples` требует строгий ноль и означает «матч, у которого геометрия не
      // построилась, доказательством быть не может». Кооператив не сломанная сборка: у него
      // безголовой геометрии нет вовсе. Пока оба случая шли в один счётчик, любой кооперативный
      // матч на том же процессе закрывал паритет столкновений навсегда — замерено: 20 тиков
      // кооператива дают `worldMissing: 20` при пороге ноль.
      // Неприменимостью считается ТОЛЬКО явно перечисленный режим без геометрии. Неизвестный режим
      // идёт в отказ: не зная, положена ли ему геометрия, ослаблять доказательства нельзя.
      if (controller.worldSupport === WORLD_SUPPORT.UNSUPPORTED) {
        this.groundDiagnostics.worldUnsupportedMode += 1;
      } else this.groundDiagnostics.worldMissing += 1;
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
    // Первое наблюдение за игроком — тоже постановка, а не результат симуляции.
    //
    // Скачку в этот момент взяться неоткуда: предыдущей позиции ещё нет. Но игрок на старте так же
    // ПОСТАВЛЕН на площадку, а не пришёл на неё шагом, и `grounded` у него пересчитает лишь
    // следующий кадр. Замер на ботах показывал это ровно один раз на забег, на первом же тике.
    const firstObservation = !controller.lastClientPosition;
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
      // Пока по этой точке не прошёл шаг физики, ярлык опоры у клиента ничего не сообщает: см.
      // `placedNotSimulated`. Латч ограничен по числу снимков — распознавание идёт по расстоянию, а
      // расстояние не отличает возрождение от потери пакетов.
      controller.placedAt = { ...controller.lastClientPosition };
      controller.placedSkipsLeft = PLACED_SKIP_LIMIT;
      // Этот тик не измеряем вовсе: сравнивать было бы нечего.
      return true;
    }

    // Первое наблюдение взводит латч постановки, но тик НЕ прерывает: свободная траектория и удары
    // считаются как обычно, а под сомнением здесь только ярлык опоры.
    //
    // И взводит его не всякое первое наблюдение, а только похожее на постановку. Контроллер
    // заводится по первому `CLIENT_INPUT`, а не в начале матча: клиент успевает шагнуть раньше, и
    // первый снимок вполне может быть законным состоянием на опоре. Считать его непригодным значило
    // бы выбрасывать настоящее доказательство — а у стоящего игрока ещё и следующее вместе с ним.
    if (firstObservation && looksPlaced(player.last)) {
      controller.placedAt = { ...controller.lastClientPosition };
      controller.placedSkipsLeft = PLACED_SKIP_LIMIT;
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
    let serverKnockdown = false;
    for (let sub = 0; sub < FREE_TRAJECTORY_SUB_STEPS; sub++) {
      // Мир доводится до времени каждого подшага: перенос движущейся опорой считается по её сдвигу
      // за подшаг, ровно как у клиента за кадр.
      const at = matchTime - SERVER_SIMULATION_DT + (sub + 1) * FREE_TRAJECTORY_SUB_DT;
      world.advance(at);

      // Сама сборка шага — движение, стена, опора, импульсы — живёт в `playerWorldStep`: порядок и
      // то, какое состояние читает каждая проверка, обязаны совпадать с `Player.step` до разряда, и
      // держать это в двух местах уже однажды не получилось. Здесь остаётся только учёт.
      const advanced = stepPlayerThroughWorld(controller.freeState, controller.input, world, {
        dt: FREE_TRAJECTORY_SUB_DT,
        // Тот же счётчик времени матча: от него зависят и фаза поршня, и выдержка между попаданиями.
        now: at,
        hitTimes: controller.hitTimes,
        knockback: 1,
        step: this.step
      });

      if (advanced.bounced) this.worldDiagnostics.wallBounces += 1;
      this.worldDiagnostics.impulses += advanced.hits.length;
      // Сбивание от импульса клиент применяет (`Course.interact` → `player.knockDown`). Пока здесь
      // считались только толчки, каждое попадание разводило траектории на полторы секунды: клиент
      // терял управление, а свободная симуляция бежала дальше. Замерено на ботах — расхождение
      // начиналось ровно на первом попадании, с knockdownTimer 1.383 у клиента против нуля у сервера.
      if (advanced.knockedDown) serverKnockdown = true;
      controller.freeState = advanced.state;
    }

    // Сбивание у клиента наблюдаемо прямо в снапшоте: ярлык состояния встаёт в `knockdown`.
    // Считается ПЕРЕХОД, а не само состояние, — иначе одно сбивание длиной в полторы секунды
    // насчитало бы себе полсотни событий.
    const clientKnockdown = player.last?.state === 'knockdown';
    const clientKnockdownStarted = clientKnockdown && !controller.clientWasKnockedDown;
    controller.clientWasKnockedDown = clientKnockdown;

    // Клиентский удар отмечается СВОИМ временем, а не временем приёма.
    //
    // Серверное сбивание рождается в текущем тике, а клиентское лишь наблюдается в нём: оно
    // приезжает в снимке, который старше на интервал рассылки (66 мс) плюс задержку сети. Пока обе
    // стороны штамповались часами сервера, замер видел эту задержку как расхождение симуляций — и
    // видел ровно её: на проде среднее вышло −2.07 тика (69 мс), сервер вёл в 19 случаях из 28.
    // Половина интервала рассылки плюс типичная задержка — это и есть 69 мс.
    //
    // Тем же полем и по тем же правилам доверия уже пользуется сверка опоры (`trustedCourseTime`):
    // значение принимается, только если сходится с часами сервера. Соврать внутри окна клиент
    // по-прежнему может, но это диагностика в режиме отчёта, а не авторитет.
    //
    // ОСТАТОК СМЕЩЕНИЯ ЗДЕСЬ НЕ УБИРАЕТСЯ, и это надо знать, читая `matchDelay`. `courseTime`
    // снимается клиентом в момент ОТПРАВКИ пакета, а сбивание случилось раньше — где-то внутри
    // предыдущего интервала рассылки (66 мс, два тика). То есть отметка завышена в среднем на тик,
    // и ожидаемый центр после этой починки не ноль, а около −1. Убрать остаток можно только одним
    // способом — записывать время самого перехода на клиенте и слать его вместе с ударом; это
    // изменение протокола, и делать его вслепую, до того как остаток увидят в данных, незачем.
    // Подгонять же центр вычитанием половины интервала нельзя: это выдуманная точность.
    //
    // Отметка не уезжает вперёд часов: расхождение в другую сторону сломало бы просрочку, которая
    // держится на монотонности часов.
    // Клиентское время ВПЕРЕДИ серверного выравниванием не считается. `trustedCourseTime` пускает
    // расхождение в обе стороны на полсекунды, а отрицательный возраст означает разъехавшиеся часы,
    // а не свежий снимок: прижать его к нулю и объявить выровненным значило бы мерить по приёму и
    // одновременно уверять, что мерили по клиенту.
    const snapshotAgeTicks = Number.isFinite(snapshotSeconds)
      ? (matchTime - snapshotSeconds) / SERVER_SIMULATION_DT
      : null;
    const clientAligned = snapshotAgeTicks !== null && snapshotAgeTicks >= 0;
    this.recordHitDecisions(
      controller.hitPairing.observe(
        this.serverTick,
        serverKnockdown,
        clientKnockdownStarted,
        clientAligned ? this.serverTick - Math.round(snapshotAgeTicks) : this.serverTick,
        clientAligned
      )
    );

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

    // Модель мира, проверенная в точке клиента.
    //
    // Поиск опоры у клиента и у сервера — буквально один код (`supportIndexAt`) на численно
    // одинаковых записях: совпадение записей доказывает `raceCourseRecorder.test.mjs`. Поэтому
    // разойтись они могут только из-за разных позиций, и спрашивать надо в одной точке.
    // Снапшот клиента СТАРШЕ текущего тика, и на подвижной опоре это принципиально.
    //
    // Позиции игроков рассылаются раз в 66 мс, тик идёт на 30 Гц, сверху ложится сетевая задержка —
    // а `world` к этому моменту уже доведён до текущего времени. Спрашивать про опору в старой
    // точке у новой платформы значит сравнивать разные моменты и получать расхождения из ничего.
    // Поэтому замер идёт по своему миру, доведённому до времени того самого снапшота.
    //
    // Тот же снапшот приходит в несколько тиков подряд (66 мс против 33), и повторно он не
    // засчитывается: иначе одно расхождение считалось бы дважды, а выборка была бы дутой.
    const probeWorld = controller.probeWorld || world;
    const snapshotAt = Number.isFinite(snapshotSeconds) ? snapshotSeconds : matchTime;
    // Свежесть считается по КЛИЕНТСКОЙ последовательности, а не по времени приёма, и это закрывает
    // сразу две дыры.
    //
    // Первая: возрождение. Сервер пишет `player.last` САМ — ставит игрока на чекпоинт с `state:
    // 'air'` и нулевой скоростью, — и раньше, чем исправленный клиент пришлёт свой снимок. Такое
    // состояние не наблюдение, а решение сервера: опора под чекпоинтом находится, у «клиента»
    // помечен воздух, и выходит расхождение из ничего. При пороге в строгий ноль одно возрождение
    // навсегда закрыло бы паритет столкновений. `lastSequence` сервер при возрождении не трогает,
    // поэтому такие состояния сюда просто не попадают.
    //
    // Вторая: один и тот же снимок приходит в несколько тиков подряд — 66 мс рассылки против 33 мс
    // тика. Повторно он не засчитывается.
    const snapshotSequence = player.lastSequence;
    const freshSnapshot =
      Number.isSafeInteger(snapshotSequence) && controller.measuredSnapshotSequence !== snapshotSequence;
    if (Number.isSafeInteger(snapshotSequence)) controller.measuredSnapshotSequence = snapshotSequence;
    // Игрок, ТОЛЬКО ЧТО ПОСТАВЛЕННЫЙ на место, про опору не свидетельствует.
    //
    // `Player.respawn` и `Player.teleport` переносят позицию и обнуляют скорость, но `grounded` не
    // пересчитывают — его посчитает следующий шаг физики. Один кадр игрок помечен воздухом, стоя
    // над самым полом. Замер это видел как расхождение геометрии, хотя геометрия ни при чём:
    // собственный поиск опоры клиента в той же точке находит ту же самую опору. Подпись
    // однозначна — 51 случай из 51 с `vy = 0` и неподвижной позицией на высоте чекпоинта 1.15.
    //
    // Признак не гадательный: возврат уже распознан по скачку позиции выше, и выборки пропускаются,
    // пока клиент не сдвинется с точки постановки, то есть пока шаг физики действительно не пройдёт.
    const stillAtPlacement =
      !!controller.placedAt &&
      finite(player.last?.x) === controller.placedAt.x &&
      finite(player.last?.y) === controller.placedAt.y &&
      finite(player.last?.z) === controller.placedAt.z;
    // Счётчик тратится ТОЛЬКО на свежих снимках: тик идёт на 30 Гц, состояние приходит на 15, и
    // считать один и тот же снимок дважды значило бы и запас исчерпать вдвое быстрее, и счётчик
    // сделать несопоставимым с `samples` и `dynamicSkipped`.
    const placedNotSimulated = stillAtPlacement && controller.placedSkipsLeft > 0;
    if (!stillAtPlacement) {
      controller.placedAt = null;
      controller.placedSkipsLeft = 0;
    } else if (freshSnapshot) {
      if (placedNotSimulated) {
        this.groundModelDiagnostics.placedSkipped += 1;
        controller.placedSkipsLeft -= 1;
      }
    }

    if (clientGroundKnown && freshSnapshot && !placedNotSimulated) {
      probeWorld.advance(snapshotAt);
      const index = supportIndexAt(
        probeWorld.colliders,
        { x: finite(player.last.x), y: finite(player.last.y), z: finite(player.last.z) },
        clientFramePreviousY(player.last),
        finite(player.last.vy),
        PLAYER_FOOT
      );
      // Порогов по скорости вверх ДВА, и здесь обязан действовать тот же, что у клиента.
      //
      // `supportIndexAt` пропускает подъём до 2.2, но `resolveGroundContact` поверх него требует
      // не быстрее 1.5, и клиент живёт по второму. Замер, звавший только первый, считал полом всё,
      // что летело вверх со скоростью между 1.5 и 2.2, — то есть мерил более слабым правилом, чем
      // то, которое проверяет. На прогоне ботов это давало 6 расхождений из 8.
      // Подвижная опора идёт в доказательства только тогда, когда её фазу есть на что навести.
      //
      // Клиент присылает `courseTime` — то самое время трассы, на котором он снял состояние. Есть
      // оно — мир доведён ровно до этого момента, и подвижная опора сверяется наравне с полом. Нет
      // (старый клиент, пакет без поля) — сверять нечем: момент приёма для этого не годится, за
      // задержку платформа уезжает. Тогда выборка откладывается в свой счётчик, а не молча
      // растворяется. Неподвижного пола это не касается вовсе — он и через секунду там же.
      if (index >= 0 && probeWorld.colliders[index]?.motion && !Number.isFinite(snapshotSeconds)) {
        this.groundModelDiagnostics.dynamicSkipped += 1;
        controller.clientPreviousY = finite(player.last?.y);
        return true;
      }

      const serverFindsGround = index >= 0 && finite(player.last.vy) <= GROUND_CONTACT_MAX_UPWARD_SPEED;
      this.groundModelDiagnostics.samples += 1;
      if (serverFindsGround === clientGrounded) this.groundModelDiagnostics.agreements += 1;
      else if (serverFindsGround) this.groundModelDiagnostics.serverGroundedOnly += 1;
      else this.groundModelDiagnostics.clientGroundedOnly += 1;

      // Высота стояния меряется здесь же и по той же причине: у клиента она взята из его опоры, и
      // сравнивать её надо с опорой, найденной В ЕГО ТОЧКЕ. Прежний замер брал высоту уехавшей
      // траектории и потому показывал не разницу геометрии, а накопленный дрейф.
      if (serverFindsGround && clientGrounded) {
        this.groundHeightError.record(
          Math.abs(supportTop(probeWorld.colliders[index]) + PLAYER_FOOT - finite(player.last.y))
        );
      }
    }
    controller.clientPreviousY = finite(player.last?.y);
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
      // Отрыв записывается ТОЛЬКО на свежем клиентском снимке.
      //
      // `freeState` шагает каждые 33 мс, а `player.last` обновляется раз в 66 мс и приходит с
      // задержкой. Замер на каждом тике поэтому пилообразный: даже у совпадающей симуляции набегало
      // бы около 0.26 единицы за тик на беговой скорости 7.7, и порог, взятый из полос
      // реконсиляции, оказался бы недостижим на живом трафике по построению. На свежем снимке фаза
      // одна и та же, а постоянная часть задержки взаимно уничтожается: якорь тоже ставится по
      // запоздавшему снимку.
      // Кадр постановки исключается и отсюда. Он объявлен непригодным как свидетельство об опоре,
      // а доли превышения отрыва — такая же часть ворот: пустить его сюда значило бы выбросить его
      // из одной решающей метрики и оставить в другой.
      if (freshSnapshot && !placedNotSimulated) {
        this.freeTrajectoryError.record(Math.hypot(dx, dy, dz));
      }
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
    // Время снимка берётся у КЛИЕНТА, а не по моменту приёма: за сетевую задержку подвижная опора
    // уезжает, и сверка старой позиции игрока с новой позицией платформы дала бы расхождение из
    // ничего. Но верят ему только в пределах допуска — см. CLIENT_COURSE_TIME_TOLERANCE. Не сошлось
    // или поля нет — подвижные опоры в доказательства не идут.
    const matchTime = matchElapsedSeconds(room, now);
    this.measureFreeTrajectory(controller, player, matchTime, trustedCourseTime(player, matchTime));
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
      if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) {
        // Матч кончился — и кончился он синхронно: когда финиширует последний, ядро переводит
        // комнату в RESULTS сразу (`checkMatchEnd` → `finishMatch`), поэтому ветка финиша игрока в
        // следующем тике уже недостижима. Ожидания, оставшиеся в этот момент, висели бы вечно, а
        // незакрытые в знаменатель доли совпадений не входят — то есть паритет выглядел бы лучше,
        // чем он есть. Закрытие идемпотентно: на пустых очередях оно ничего не добавляет.
        for (const player of room.players.values()) {
          const controller = this.controllers.get(player);
          if (controller && controller.matchId === room.matchId) this.finalizeHits(controller, player);
        }
        continue;
      }
      const advance = room.state === ROOM_STATE.PLAYING || (room.startedAt && now >= room.startedAt);
      for (const player of room.players.values()) {
        const controller = this.controllers.get(player);
        if (!controller || controller.matchId !== room.matchId || player.bot) continue;
        if (player.finished) {
          if (!controller.legacyFinishedObserved) {
            controller.legacyFinishedObserved = true;
            this.recordProgressComparison(controller, player);
            // Тиков по этому игроку больше не будет, значит и пары ожиданиям взяться неоткуда.
            this.finalizeHits(controller, player);
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
        // Модель мира: тот же поиск опоры, но в точке клиента. Дрейф траектории сюда не входит.
        groundModel: {
          ...this.groundModelDiagnostics,
          agreementRate: this.groundModelDiagnostics.samples
            ? this.groundModelDiagnostics.agreements / this.groundModelDiagnostics.samples
            : 0
        },
        // Паритет попаданий. `serverOnly` — удар, которого у клиента не было; `clientOnly` —
        // пропущенный сервером.
        hitParity: (() => {
          const totals = this.hitTotals;
          const decided = totals.matched + totals.leftOnly + totals.rightOnly;
          return {
            serverHits: totals.left,
            clientHits: totals.right,
            matched: totals.matched,
            serverOnly: totals.leftOnly,
            clientOnly: totals.rightOnly,
            // Ожидания разложены по игрокам, и обойти их нельзя: контроллеры лежат в WeakMap.
            // Но каждое событие ровно один раз становится либо половиной пары, либо односторонним,
            // поэтому незакрытых ровно столько, сколько ещё не разошлось по этим двум исходам.
            pending: totals.left + totals.right - 2 * totals.matched - totals.leftOnly - totals.rightOnly,
            matchRate: decided ? totals.matched / decided : 0,
            // Распределение задержки внутри совпавших пар — см. createMatchDelayHistogram.
            // Отвечает на вопрос, который `matchRate` задать не может: сдвиг по времени или
            // разная геометрия.
            matchDelay: this.hitMatchDelay.snapshot(),
            // Чем отмечены САМИ ОБРАЗЦЫ гистограммы: `aligned + unaligned` равно `matchDelay.samples`.
            // Пока доля выровненных не близка к единице, `matchDelay` мерит в том числе возраст
            // снимка, а не только расхождение.
            clientStamp: { ...this.hitClientStamp }
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
  EventPairing,
  HIT_MATCH_TOLERANCE_TICKS,
  createMatchDelayHistogram,
  RollingErrorStats,
  ShadowInputRuntime,
  alignKnownWorldContact,
  heldInputFromBatch,
  raceProgressFor,
  stateFromLegacy
};
