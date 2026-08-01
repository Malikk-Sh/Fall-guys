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
function randomSeed() {
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
    vz: +n.vz,
    state: ['ground', 'air', 'dive'].includes(n.state) ? n.state : 'air'
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
    .map(({ id, name, time, color }) => ({ id, name, time, color }));
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
  validateState,
  canFinish,
  leaderboard
};
