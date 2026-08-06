// Единственный источник правды о геометрии трассы.
//
// Раньше эти константы и формулы были продублированы в client/core/Config.js и server/gameRules.js:
// числа -18, -13 и стартовая точка {x:0,y:1.2,z:7} были вписаны руками в обоих файлах. Сервер по этим
// числам выводит чекпоинты и проверяет финиш, клиент по ним же строит геометрию — то есть расхождение
// на одну цифру означало бы, что сервер не засчитывает игроку финиш, до которого тот честно добежал.
//
// Модуль написан на ES-модулях: браузер получает его напрямую по адресу /shared/courseSpec.js, а
// сервер подключает тем же require (Node поддерживает require для ES-модулей начиная с 20.19).
// Сборщик для этого не нужен.

// Длина одного сегмента трассы по оси Z.
export const SEGMENT_LENGTH = 18;

// Центр первого сегмента. Старт находится в положительной зоне Z, трасса уходит в минус.
export const FIRST_SEGMENT_CENTER = -11;

// Насколько финишная черта отстоит за последним чекпоинтом.
export const FINISH_TAIL = 13;

// Стартовая позиция игрока.
export const START = Object.freeze({ x: 0, y: 1.2, z: 7 });

// Сколько сегментов в трассе каждой сложности. Всё остальное в настройках сложности
// (скорость препятствий, целевое время) — вопрос клиентской подачи и сервера не касается.
export const DIFFICULTY_SEGMENTS = Object.freeze({ easy: 5, normal: 6, chaos: 7 });

export const SEGMENT_TYPES = Object.freeze([
  'sweepers',
  'movers',
  'bumpers',
  'bridge',
  'punchers',
  'bounce',
  'crosswind'
]);

const SEGMENT_VARIANTS = 3;

export const SEGMENT_ROLE = Object.freeze({
  WARMUP: 'warmup',
  SKILL: 'skill',
  CHALLENGE: 'challenge',
  RECOVERY: 'recovery',
  FINALE: 'finale'
});

const ROLE_TYPES = Object.freeze({
  [SEGMENT_ROLE.WARMUP]: ['bumpers', 'bounce', 'movers'],
  [SEGMENT_ROLE.SKILL]: ['sweepers', 'movers', 'bumpers', 'bounce'],
  [SEGMENT_ROLE.CHALLENGE]: ['bridge', 'punchers', 'crosswind'],
  [SEGMENT_ROLE.RECOVERY]: ['bounce', 'bumpers', 'movers'],
  [SEGMENT_ROLE.FINALE]: ['bridge', 'punchers', 'crosswind', 'sweepers']
});

function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// План является частью общей спеки: клиент не должен сам решать, зеркальная ли перед ним версия,
// иначе после изменения генератора старый и новый клиент построят разные препятствия по одному seed.
export function createSegmentPlan(seed, segmentCount) {
  const rng = seededRandom(seed);
  const priority = [...SEGMENT_TYPES];
  for (let i = priority.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [priority[i], priority[j]] = [priority[j], priority[i]];
  }
  const roles = createSegmentRoles(segmentCount);
  const types = assignUniqueTypes(roles, priority) || roles.map(role => ROLE_TYPES[role][0]);
  return types.map((type, index) => ({
    type,
    role: roles[index],
    variant: Math.floor(rng() * SEGMENT_VARIANTS)
  }));
}

export function createSegmentRoles(segmentCount) {
  if (segmentCount <= 1) return [SEGMENT_ROLE.FINALE].slice(0, segmentCount);
  const roles = [SEGMENT_ROLE.WARMUP];
  const middle = segmentCount - 3;
  for (let i = 0; i < middle; i++) roles.push(i % 2 === 0 ? SEGMENT_ROLE.SKILL : SEGMENT_ROLE.CHALLENGE);
  roles.push(SEGMENT_ROLE.RECOVERY, SEGMENT_ROLE.FINALE);
  return roles;
}

// Небольшой backtracking вместо набора локальных перестановок: он гарантирует, что на трассе до
// семи сегментов типы не повторятся, но при этом каждый займёт подходящее место в кривой сложности.
function assignUniqueTypes(roles, priority, index = 0, used = new Set(), result = []) {
  if (index === roles.length) return result;
  for (const type of priority) {
    if (used.has(type) || !ROLE_TYPES[roles[index]].includes(type)) continue;
    used.add(type);
    result.push(type);
    const complete = assignUniqueTypes(roles, priority, index + 1, used, result);
    if (complete) return complete;
    result.pop();
    used.delete(type);
  }
  return null;
}

export function safeDifficulty(value) {
  return Object.hasOwn(DIFFICULTY_SEGMENTS, value) ? value : 'normal';
}

// Полное описание трассы, восстанавливаемое из одного числа. Именно поэтому серверу достаточно
// разослать сид: все клиенты соберут идентичную геометрию, не передавая ни байта уровня.
export function createCourseSpec(seed, difficulty = 'normal') {
  const key = safeDifficulty(difficulty);
  const segmentCount = DIFFICULTY_SEGMENTS[key];
  return {
    seed: seed >>> 0,
    difficulty: key,
    segmentCount,
    segments: createSegmentPlan(seed, segmentCount),
    checkpoints: Array.from({ length: segmentCount }, (_, i) => -SEGMENT_LENGTH * (i + 1)),
    finishZ: -SEGMENT_LENGTH * segmentCount - FINISH_TAIL,
    start: { ...START }
  };
}

// Точка возрождения для заданного чекпоинта. Смещение 3.1 ставит игрока сразу за аркой,
// чтобы он не пересекал её повторно и не «перепроходил» чекпоинт.
export function spawnFor(spec, checkpoint = 0) {
  if (checkpoint <= 0) return { ...spec.start };
  const index = Math.min(checkpoint - 1, spec.checkpoints.length - 1);
  return { x: 0, y: 1.15, z: spec.checkpoints[index] + 3.1 };
}
