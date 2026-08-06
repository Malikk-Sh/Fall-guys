const crypto = require('crypto');

// Геометрия трассы описана ровно в одном месте — в общем с клиентом модуле. Node подключает
// ES-модуль через require начиная с версии 20.19, поэтому отдельная сборка не требуется.
const {
  DIFFICULTY_SEGMENTS,
  safeDifficulty,
  createCourseSpec: buildCourseSpec,
  spawnFor
} = require('../shared/courseSpec.js');

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
function createCourseSpec(seed = randomSeed(), difficulty = 'normal') {
  return buildCourseSpec(seed, difficulty);
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
    state: ['ground', 'air', 'dive', 'slam', 'downed'].includes(n.state) ? n.state : 'air'
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
const MIN_CHECKPOINT_INTERVAL_MS = 300;
const MAX_REPORTED_HORIZONTAL_SPEED = 14;
const MAX_OBSERVED_HORIZONTAL_SPEED = 22;
const MAX_HORIZONTAL_ACCELERATION = 120;

// Сколько одиночных отклонений по каждому признаку допустимо за матч.
//
// Проверка движения делится на два уровня, и это главное здесь.
//
// Жёсткий уровень — validateState: он ограничивает шаг между двумя положениями и НЕ ПРИМЕНЯЕТ
// состояние, которое в него не уложилось. Телепорт через полтрассы отбивается там, сразу и без
// оговорок.
//
// Мягкий уровень — эта функция. Она смотрит на признаки, которые у честного игрока тоже случаются:
// препятствие задаёт скорость напрямую И выталкивает игрока из своей геометрии, то есть за один
// пакет законно меняются и скорость, и положение. Сервер про расположение препятствий ничего не
// знает — их геометрия рождается на клиенте из сида, — поэтому отличить удар бампера от подделки
// по ОДНОМУ пакету он не может в принципе.
//
// Раньше хватало одного такого пакета, чтобы снять зачёт со всего забега. На практике это означало,
// что честный забег с попаданием в бампер не попадал в таблицу рекордов почти никогда. Найдено
// сквозным тестом: бот проходил трассу честно, а итог выходил без зачёта.
//
// Размеры взяты замерами на живых забегах, а не назначены. За полный забег на двоих:
//   • ускорение выше потолка — 3 пакета на «легко», до 5 на «хаосе»;
//   • наблюдаемая скорость выше потолка — 1 пакет из 557 (24.1 при потолке 22);
//   • заявленная скорость выше потолка — ни разу (максимум 11.1 при потолке 14).
// Пятнадцать на признак — заведомо выше честной игры и заведомо ниже клиента, который подделывает
// движение систематически: такой исчерпает запас за секунду.
//
// Поднять сами потолки вместо этого нельзя. Для ускорения: при потолке заявленной скорости 14
// максимальное изменение скорости равно 28, и порог, не срабатывающий на честных ударах, не
// срабатывал бы уже вообще ни на чём.
//
// Это не окончательное решение, а честная граница возможного без знания геометрии. Настоящее —
// серверная симуляция упрощённой физики по вводу игрока, и тогда препятствия станут известны.
const MAX_MOVEMENT_ANOMALIES = 15;

function verifyMovement(player, value, now = Date.now()) {
  const state = normalizeState(value);
  if (!state || !player.last || !player.lastAt) return [];
  const dt = Math.max(0.04, (now - player.lastAt) / 1000);
  const reportedSpeed = Math.hypot(state.vx, state.vz);
  const observedSpeed = Math.hypot(state.x - player.last.x, state.z - player.last.z) / dt;
  const acceleration = Math.hypot(state.vx - (player.last.vx || 0), state.vz - (player.last.vz || 0)) / dt;
  const accelerationLimit = ['dive', 'slam'].includes(state.state) ? 240 : MAX_HORIZONTAL_ACCELERATION;

  const findings = [];
  const anomalies = player.movementAnomalies || (player.movementAnomalies = {});
  // Отклонение засчитывается всегда, а нарушением становится только по исчерпании запаса.
  const note = reason => {
    anomalies[reason] = (anomalies[reason] || 0) + 1;
    if (anomalies[reason] > MAX_MOVEMENT_ANOMALIES) findings.push(reason);
  };

  if (reportedSpeed > MAX_REPORTED_HORIZONTAL_SPEED) note('reported-speed');
  if (observedSpeed > MAX_OBSERVED_HORIZONTAL_SPEED) note('observed-speed');
  if (acceleration > accelerationLimit) note('horizontal-acceleration');
  return findings;
}

function verifyCheckpointTime(player, checkpoint, now = Date.now()) {
  if (checkpoint <= (player.checkpoint || 0)) return null;
  const previousAt = player.checkpointAt || player.matchStartedAt || now;
  const elapsed = now - previousAt;
  player.checkpointAt = now;
  if (elapsed < MIN_CHECKPOINT_INTERVAL_MS) {
    return { reason: 'segment-too-fast', checkpoint, elapsed, minimum: MIN_CHECKPOINT_INTERVAL_MS };
  }
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
  // Теперь требуется, чтобы ПРЕДЫДУЩЕЕ состояние было перед аркой, а новое — за ней. Появиться
  // сразу за чертой не выйдет даже крошечным шагом: сервер не видел, как игрок к ней подходил.
  // Потерянные по дороге пакеты этому не мешают — важны не все промежуточные точки, а то, что
  // отрезок между двумя известными серверу положениями пересекает арку.
  let checkpoint = player.checkpoint || 0;
  const line = spec.checkpoints[checkpoint];
  if (
    checkpoint < spec.checkpoints.length &&
    previous.z >= line &&
    state.z < line &&
    state.y > -3 &&
    Math.abs(state.x) < 11
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
function leaderboard(room) {
  return [...room.players.values()]
    .filter(player => player.finished)
    .sort((a, b) => a.time - b.time)
    .map(({ id, name, time, color, verificationReasons, unverifiedReason }) => {
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
  normalizeState,
  verifyCheckpointTime,
  verifyMovement,
  MIN_CHECKPOINT_INTERVAL_MS,
  MAX_REPORTED_HORIZONTAL_SPEED,
  MAX_MOVEMENT_ANOMALIES,
  validateState,
  canFinish,
  leaderboard
};
