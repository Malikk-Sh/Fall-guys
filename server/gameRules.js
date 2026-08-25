const crypto = require('crypto');

// Геометрия трассы описана ровно в одном месте — в общем с клиентом модуле. Node подключает
// ES-модуль через require начиная с версии 20.19, поэтому отдельная сборка не требуется.
const {
  DIFFICULTY_SEGMENTS,
  safeDifficulty,
  createCourseSpec: buildCourseSpec,
  spawnFor,
  segmentTypeAt
} = require('../shared/courseSpec.js');

// Правило чекпоинта — общее с клиентом, ровно по той же причине, что и геометрия трассы выше:
// две реализации одного правила разъезжаются, и разъехавшись, отменяют игроку честно пройденную
// арку. См. подробный разбор в самом модуле.
const { crossedCheckpoint } = require('../shared/courseProgress.js');

// Место появления на чекпоинте у кооператива своё, и оно НЕ выводится из гоночного.
const { coopSpawnFor } = require('../shared/coopChapters.js');

const { e2eSegmentCount } = require('./e2eCourse.js');
const { trackRaceKnockdownState, trackRaceKnockdownRespawn } = require('./raceKnockdownMetrics.js');

const {
  auditMovement,
  budgetFor,
  minSegmentSeconds,
  resetHistory: resetMovementHistory,
  FINISH_TAIL_SECONDS,
  DEFAULT_ANOMALY_BUDGET
} = require('./movementAudit.js');

const DIFFICULTIES = DIFFICULTY_SEGMENTS;
const PLAYER_COLORS = [
  0xff4f91, 0x48dcda, 0xffd94b, 0x55a7ff, 0x58ebb8, 0xff914d, 0x9b6cff, 0xf46b5f, 0x43c5ff, 0xc7ef50,
  0xff73c8, 0x7d82ff, 0x54dba2, 0xffbd59, 0x9867dc, 0x58c9d8
];

function safeName(value) {
  return (
    String(value || 'Wobbler')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N} _-]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 16) || 'Wobbler'
  );
}
// Сид трассы. В обычной работе случайный.
//
// WOBBLE_FIXED_SEED существует ради сквозных тестов: гонка выдаёт случайную трассу, а браузерный
// тест, который проходит её до финиша, на случайной трассе означал бы разное каждый прогон — то
// падал бы, то нет, и красный результат ничего не сообщал бы. Тест, который падает через раз и не
// воспроизводится, хуже отсутствующего.
//
// Это не «режим отладки» и ничего не открывает: переменная задаётся только на сервере, влияет
// исключительно на выбор трассы и никак не ослабляет проверку забега. В боевом окружении её просто
// не задают — см. deploy/wobble.env.example, где её нет.
function randomSeed() {
  const fixed = Number.parseInt(process.env.WOBBLE_FIXED_SEED ?? '', 10);
  if (Number.isSafeInteger(fixed) && fixed >= 0 && fixed <= 0xffffffff) return fixed >>> 0;
  return crypto.randomBytes(4).readUInt32LE(0);
}
// Единственная точка, где сервер собирает трассу гонки. Здесь же — и только здесь — действует
// тестовое укорочение: см. server/e2eCourse.js, где описано, чем оно ограничено и почему.
// Спека едет клиенту целиком в MATCH_START, поэтому короткую трассу он строит по ней, а не
// выводит длину из сложности сам: разойтись им негде.
function createCourseSpec(seed = randomSeed(), difficulty = 'normal') {
  return buildCourseSpec(seed, difficulty, e2eSegmentCount(difficulty));
}
function normalizeState(value) {
  const n = value || {};
  if (![n.x, n.y, n.z, n.ry, n.vx, n.vz].every(Number.isFinite)) return null;
  return {
    x: +n.x,
    y: +n.y,
    z: +n.z,
    ry: +n.ry,
    vx: +n.vx,
    vy: Number.isFinite(n.vy) ? +n.vy : 0,
    vz: +n.vz,
    state: ['ground', 'air', 'dive', 'slam', 'knockdown', 'downed'].includes(n.state) ? n.state : 'air'
  };
}
// Потолок интервала между двумя состояниями, по которому считается допустимый шаг.
//
// Время берётся по часам сервера: клиентское подделывает кто угодно. Потолок нужен потому, что
// между пакетами проходит сколько угодно времени — свернули игру, пропала связь, — и без него
// пауза превращалась бы в разрешение на прыжок вперёд. Было 1.5 с, то есть 3.2 + 27 = 30 единиц
// за один пакет при длине сегмента 18.
//
// Ниже опускать нельзя: падение с потерей пакетов — законный случай большого шага. Секунда
// свободного падения при гравитации 22.5 даёт около 13 единиц по вертикали плюс бег по
// горизонтали; при 0.8 с потолок выходит 17.6 и такой игрок проходит, а телепорт — нет.
const MAX_STEP_DT = 0.8;
const MAX_HORIZONTAL_ACCELERATION = 120;

// Проверка движения делится на два уровня, и это главное здесь.
//
// Жёсткий уровень — validateState: он ограничивает шаг между двумя положениями и НЕ ПРИМЕНЯЕТ
// состояние, которое в него не уложилось. Телепорт через полтрассы отбивается там, сразу и без
// оговорок.
//
// Мягкий уровень — verifyMovement. Он смотрит на признаки, которые у честного игрока тоже
// случаются: препятствие задаёт скорость напрямую И выталкивает игрока из своей геометрии, то есть
// за один пакет законно меняются и скорость, и положение. Раньше хватало одного такого пакета,
// чтобы снять зачёт со всего забега, — честный забег с попаданием в бампер не попадал в таблицу
// рекордов почти никогда. Поэтому у каждого признака есть запас отклонений за матч.
//
// Сам разбор живёт в movementAudit.js: там же лежат пороги, история пакетов и знание геометрии
// трассы. Здесь остаётся только ускорение — единственный признак, который считается по паре
// соседних пакетов и ни от чего больше не зависит.
//
// Запас ускорения взят замером: за полный забег на двоих — 3 пакета выше потолка на «легко» и до 5
// на «хаосе». Поднять сам потолок вместо запаса нельзя: при заявленной скорости до 17 предельное
// изменение равно 34, и порог, не срабатывающий на честных ударах, не срабатывал бы ни на чём.
const MAX_MOVEMENT_ANOMALIES = DEFAULT_ANOMALY_BUDGET;

function resetHistory(player) {
  trackRaceKnockdownRespawn({ player });
  return resetMovementHistory(player);
}

function verifyMovement(player, value, now = Date.now(), spec = null) {
  const state = normalizeState(value);
  if (!state) return [];
  trackRaceKnockdownState({ player, spec, state, previousState: player.last, now });
  if (!player.last || !player.lastAt) return [];
  const dt = Math.max(0.04, (now - player.lastAt) / 1000);
  const acceleration = Math.hypot(state.vx - (player.last.vx || 0), state.vz - (player.last.vz || 0)) / dt;
  const accelerationLimit = ['dive', 'slam', 'knockdown'].includes(state.state)
    ? 240
    : MAX_HORIZONTAL_ACCELERATION;

  const findings = auditMovement(player, state, spec, now, dt);
  if (acceleration > accelerationLimit) {
    const anomalies = player.movementAnomalies || (player.movementAnomalies = {});
    anomalies['horizontal-acceleration'] = (anomalies['horizontal-acceleration'] || 0) + 1;
    if (anomalies['horizontal-acceleration'] > budgetFor('horizontal-acceleration'))
      findings.push('horizontal-acceleration');
  }
  return findings;
}

// Минимальное время участка. В отличие от verifyMovement это ЖЁСТКИЙ признак без запаса: пройти
// сегмент быстрее физического предела нельзя ни разу, и единичного случая достаточно.
function verifyCheckpointTime(player, checkpoint, now = Date.now(), spec = null) {
  if (checkpoint <= (player.checkpoint || 0)) return null;
  const previousAt = player.checkpointAt || player.matchStartedAt || now;
  const elapsed = now - previousAt;
  player.checkpointAt = now;
  const minimum = Math.round(minSegmentSeconds(spec, checkpoint) * 1000);
  if (elapsed < minimum) {
    return { reason: 'segment-too-fast', checkpoint, elapsed, minimum };
  }
  return null;
}

// Тот же счёт для последнего отрезка: от последней арки до ленты 13 единиц, и мгновенно они не
// проходятся. Без этой проверки финиш был последним участком трассы, время которого не проверял
// никто: паузы хватало, чтобы одним допустимым шагом дотянуться от арки до ленты.
function verifyFinishTime(player, now = Date.now()) {
  const previousAt = player.checkpointAt || player.matchStartedAt;
  if (!previousAt) return null;
  const elapsed = now - previousAt;
  const minimum = Math.round(FINISH_TAIL_SECONDS * 1000);
  if (elapsed < minimum) return { reason: 'segment-too-fast', checkpoint: 'finish', elapsed, minimum };
  return null;
}

function validateState(player, value, spec, now = Date.now()) {
  const state = normalizeState(value);
  if (!state) return { ok: false, reason: 'invalid' };
  if (Math.abs(state.x) > 24 || state.y > 35 || state.y < -16 || state.z > 18 || state.z < spec.finishZ - 18)
    return { ok: false, reason: 'bounds' };
  const previous = player.last || spawnFor(spec, player.checkpoint || 0),
    dt = Math.max(0.04, Math.min(MAX_STEP_DT, (now - (player.lastAt || now - 100)) / 1000)),
    distance = Math.hypot(state.x - previous.x, state.y - previous.y, state.z - previous.z),
    maxDistance = 3.2 + dt * 18;
  if (distance > maxDistance) return { ok: false, reason: 'speed', position: previous };

  // Чекпоинт засчитывается по факту ПЕРЕСЕЧЕНИЯ арки и не больше одного за пакет.
  //
  // Раньше здесь стоял цикл, а условием было «оказался за чертой». Вместе оба недостатка давали
  // готовый способ срезать трассу: подождать (пауза поднимала потолок шага до тридцати единиц при
  // длине сегмента восемнадцать), прислать одно формально допустимое состояние — и цикл засчитывал
  // сразу два чекпоинта.
  //
  // Требуется, чтобы ПРЕДЫДУЩЕЕ состояние было перед аркой, а новое — за ней. Появиться сразу за
  // чертой не выйдет даже крошечным шагом: сервер не видел, как игрок к ней подходил. Потерянные по
  // дороге пакеты этому не мешают — важны не все промежуточные точки, а то, что отрезок между двумя
  // известными серверу положениями пересекает арку.
  //
  // Само пересечение и рамки считает общий с клиентом модуль. Раньше рамки проверялись на
  // состоянии, пришедшем ПОСЛЕ черты, и это отменяло арку игроку, который честно прошёл её и тут же
  // упал: в плоскости арки он был выше отметки, а в следующей выборке — уже нет.
  let checkpoint = player.checkpoint || 0;
  if (
    checkpoint < spec.checkpoints.length &&
    crossedCheckpoint(previous, state, spec.checkpoints[checkpoint])
  )
    checkpoint++;
  return { ok: true, state: { ...state, checkpoint }, checkpoint };
}
function canFinish(player, spec) {
  return (
    !player.finished &&
    player.checkpoint === spec.segmentCount &&
    player.last &&
    player.last.z < spec.finishZ + 1 &&
    player.last.y > -4
  );
}
// Куда вернуть игрока, чей финиш не принят.
//
// Отказ обязан оставить игрока там, откуда повтор МОЖЕТ удаться. Раньше отказ всегда возвращал его
// в `player.last` — «туда, где сервер его видит». Для единственной причины, которую повтор лечит,
// это верно: последнее состояние до ленты не дошло, добеги ещё раз.
//
// Для второй причины — не пройден последний чекпоинт — это замкнутая петля. Точка, из которой финиш
// отклонили, снова удовлетворяет условию финиша на клиенте (`z < finishZ`, `y > -3`): клиент шлёт
// финиш ещё раз, получает тот же отказ, снова оказывается в той же точке. Кадр за кадром, без конца.
// Игрок, пролетевший СБОКУ от финишной арки над пустотой, попадал в неё всегда: клиент засчитывал
// последний чекпоинт (он проверяет «за чертой ли я», и засчитывает, когда игрок сносится обратно к
// оси уже за аркой), сервер не засчитывал (он проверяет ПЕРЕСЕЧЕНИЕ, и в момент пересечения игрок
// был вне рамок). Забег не заканчивался вовсе — экран так и оставался в «Подтверждаем результат…».
//
// Пропущенный чекпоинт повтором с того же места не лечится: арку надо пересечь. Поэтому здесь
// игрок возвращается на свой чекпоинт — единственное место, откуда он до арки дойдёт.
//
// Геометрия возврата у режимов РАЗНАЯ, и брать гоночную для кооператива нельзя — см.
// `checkpointReturn`.
function finishRejection(player, spec) {
  const checkpoint = player.checkpoint || 0;
  if (checkpoint < spec.segmentCount) {
    return { reason: 'checkpoint-missing', position: checkpointReturn(player, spec, checkpoint) };
  }
  return { reason: 'finish-validation', position: player.last || checkpointReturn(player, spec, checkpoint) };
}

// Куда возвращают игрока на его чекпоинт. Режим виден по самой спеке: у кооперативной главы есть
// `chapterId`, у гоночной трассы его нет.
//
// Геометрия у режимов разная по трём осям сразу. Гонка ставит игрока ПЕРЕД аркой (`+3.1` по Z,
// прогресс идёт в минус), на оси и на высоте 1.15. Кооператив — сразу ЗА неё (`-3.1`), на своей
// половине дорожки (x = ±2.2) и на 1.35. Причём «за аркой» там не мелочь, а прямо заявленное
// правило: «чтобы игрок не пересекал её повторно» (см. `coopSpawnFor`).
//
// Чем это оборачивалось. Оба напарника, получив отказ разом, оказывались в ОДНОЙ точке на оси и
// расталкивали друг друга. Пара откатывалась на 6.2 единицы назад, за арку, которую уже прошла, и
// проходила её заново. А на 2 чекпоинтах из 32 (все главы, все арки) гоночная точка попадает не на
// тот же кусок главы, что кооперативная, а на осыпающийся пол — тот самый, который под ногами
// пропадает.
//
// Обработчик возрождения это различие соблюдает и всегда считает точку по слоту
// (`C2S.RESPAWN` → `coopSpawnFor`). Отказ в финише — не соблюдал: он появился как гоночная починка
// и достался кооперативу вместе с общим обработчиком финиша.
function checkpointReturn(player, spec, checkpoint) {
  if (!spec?.chapterId) return spawnFor(spec, checkpoint);
  // Слот — порядковый номер игрока в комнате. Без него берём первую половину дорожки: она такой же
  // законный пол, а вот гоночная точка кооперативу не подходит ничем.
  return coopSpawnFor(spec, checkpoint, player?.slot || 0);
}

function leaderboard(room) {
  return [...room.players.values()]
    .filter(player => player.finished)
    .sort((a, b) => a.time - b.time)
    .map(({ id, name, time, color, bot, verificationReasons, unverifiedReason }) => {
      const reasons = verificationReasons?.length
        ? [...verificationReasons]
        : unverifiedReason
          ? [unverifiedReason]
          : [];
      return {
        id,
        name,
        time,
        color,
        // Признак доезжает и до экрана итогов: увидеть, кого ты обогнал, важнее всего именно там.
        bot: !!bot,
        verified: reasons.length === 0,
        verificationReason: reasons[0] || null,
        verificationReasons: reasons
      };
    });
}

module.exports = {
  DIFFICULTIES,
  PLAYER_COLORS,
  safeName,
  safeDifficulty,
  randomSeed,
  createCourseSpec,
  spawnFor,
  segmentTypeAt,
  normalizeState,
  verifyCheckpointTime,
  verifyFinishTime,
  verifyMovement,
  resetHistory,
  minSegmentSeconds,
  budgetFor,
  MAX_MOVEMENT_ANOMALIES,
  validateState,
  canFinish,
  finishRejection,
  leaderboard
};
