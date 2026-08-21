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

// Сколько вариантов расстановки есть у каждого типа сегмента.
//
// Число живёт здесь, а не в клиенте, потому что вариант выбирается при построении ПЛАНА, а план
// строит и сервер: разойдись они — сервер вывел бы чекпоинты одной трассы, а клиент построил бы
// другую. Сами расстановки лежат в shared/courseSegments.js, и там же тест следит, чтобы у каждого
// типа их было не меньше объявленного здесь.
export const SEGMENT_VARIANTS = 5;

// Ширина опоры сегмента по типу — единственное место, где она задана.
//
// Клиент по этим числам кладёт пол, сервер по ним же понимает, где пола нет. Раньше сервер о
// геометрии не знал вовсе и мог отличить бег по трассе от бега рядом с ней только по скорости.
export const SEGMENT_WIDTH = Object.freeze({
  sweepers: 12,
  movers: 11,
  bumpers: 12,
  bridge: 3.4,
  punchers: 11,
  bounce: 12,
  crosswind: 9
});

// «Небесные ступени» — единственный тип, где опора уезжает за край посадочных площадок: сами
// площадки шириной 11, но подвижные платформы ходят по X на ±3.8 и при полуширине 1.9 достают
// до 5.7. Коридор считается по дальней точке, иначе игрок на краю платформы выглядел бы стоящим
// в пустоте.
const MOVER_REACH = 5.7;

// Стартовая площадка: клиент строит её по этим же числам.
export const START_PLATFORM = Object.freeze({ z: 5, width: 14, depth: 14 });

// Финишный выкат: ступени и тумба ворот. Самая широкая часть — тумба шириной 11.
const FINISH_HALF_WIDTH = 5.5;
const FINISH_RUNOUT = 3;

// Высота, на которой игрок оказывается, стоя на опоре. Все опоры трассы лежат в узкой полосе: пол
// сегментов даёт 0.98, подвижные платформы — от 0.9, финишная тумба — 1.85. Замер по шестидесяти
// честным прогонам: 0.80 … 1.85.
export const GROUND_Y_MIN = 0.4;
export const GROUND_Y_MAX = 2.4;

// Выше этой отметки не достаёт ни одно препятствие: самый высокий удар — бампер, и тот работает
// лишь до 2.8. Всё, что происходит выше, обязано подчиняться одной гравитации.
export const OBSTACLE_REACH_Y = 3;

// Насколько игрок может выйти за расчётный край опоры. В самой геометрии допуск края 0.12 (см.
// EDGE_TOLERANCE в CourseBuilder), остальное — запас на округление координат до трёх знаков.
export const CORRIDOR_MARGIN = 0.5;

// Зоны трассы: отрезок по Z и допустимое удаление от оси внутри него. Соседние зоны стыкуются
// вплотную, поэтому на границе берётся более широкая из двух — иначе игрок, стоящий на краю
// предыдущего сегмента, считался бы вышедшим за пределы следующего.
export function corridorZones(spec) {
  const zones = [
    {
      min: START_PLATFORM.z - START_PLATFORM.depth / 2,
      max: START_PLATFORM.z + START_PLATFORM.depth / 2,
      half: START_PLATFORM.width / 2
    }
  ];
  for (let i = 0; i < spec.segmentCount; i++) {
    const center = FIRST_SEGMENT_CENTER - SEGMENT_LENGTH * i;
    const type = spec.segments[i]?.type;
    const half = type === 'movers' ? MOVER_REACH : (SEGMENT_WIDTH[type] || 12) / 2;
    zones.push({ min: center - SEGMENT_LENGTH / 2, max: center + SEGMENT_LENGTH / 2, half });
  }
  zones.push({
    min: spec.finishZ - FINISH_RUNOUT,
    max: -SEGMENT_LENGTH * spec.segmentCount,
    half: FINISH_HALF_WIDTH
  });
  return zones;
}

// Максимальное удаление от оси, на котором в этой точке трассы вообще есть опора.
// Вне известных зон ограничения нет: там работает общая проверка границ мира.
export function corridorHalfWidth(zones, z) {
  let half = 0;
  for (const zone of zones) if (z >= zone.min - 0.3 && z <= zone.max + 0.3) half = Math.max(half, zone.half);
  return half || Infinity;
}

// Темп препятствий входит в геометрию: от него зависят фаза и скорость каждой вертушки и молота.
// Поэтому таблица живёт здесь, а не в клиентской подаче сложности.
export const DIFFICULTY_OBSTACLE_SPEED = Object.freeze({ easy: 0.82, normal: 1, chaos: 1.2 });

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

// Один и тот же генератор нужен и планировщику сегментов, и расстановке: разные последовательности
// по одному seed означали бы разные трассы у клиента и сервера.
export function seededRandom(seed) {
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
//
// Длину обычно задаёт сложность. Третий аргумент позволяет назвать её явно — в работающей игре им
// пользуется единственное место, server/gameRules.js, чтобы укоротить трассу сквозного браузерного
// теста. Здесь он намеренно без проверок и без знания о переменных окружения: это сборщик трассы, а
// решение «когда короче можно» живёт в server/e2eCourse.js, где его видно, а не спрятано внутри
// общего с клиентом модуля.
export function createCourseSpec(seed, difficulty = 'normal', segmentCountOverride = null) {
  const key = safeDifficulty(difficulty);
  const segmentCount = Number.isInteger(segmentCountOverride)
    ? segmentCountOverride
    : DIFFICULTY_SEGMENTS[key];
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

// В каком сегменте находится точка. Нужно, чтобы связать событие с местом: упал — на каком
// препятствии, бросил забег — где именно.
//
// Сегменты стыкуются вплотную, поэтому граница относится к дальнему из двух: игрок, пересёкший
// её, уже вошёл в следующий.
export function segmentIndexAt(spec, z) {
  const index = Math.floor(
    (-z - SEGMENT_LENGTH / 2 + FIRST_SEGMENT_CENTER + SEGMENT_LENGTH) / SEGMENT_LENGTH
  );
  if (index < 0) return -1;
  return Math.min(index, spec.segmentCount - 1);
}

// Тип сегмента в точке. До первого сегмента — старт, после последнего — финиш: и то и другое
// осмысленные места, где может случиться событие.
//
// Граница финиша — последняя арка, а не геометрический край последнего сегмента: пол заходит за
// арку ещё на две единицы. Так же считает и corridorZones, где финишный выкат начинается ровно
// от арки, — и расходиться с ней здесь было бы хуже, чем потерять эти две единицы.
export function segmentTypeAt(spec, z) {
  if (z > FIRST_SEGMENT_CENTER + SEGMENT_LENGTH / 2) return 'start';
  if (z < -SEGMENT_LENGTH * spec.segmentCount) return 'finish';
  return spec.segments[segmentIndexAt(spec, z)]?.type || 'start';
}

// Точка возрождения для заданного чекпоинта. Смещение 3.1 ставит игрока сразу за аркой,
// чтобы он не пересекал её повторно и не «перепроходил» чекпоинт.
export function spawnFor(spec, checkpoint = 0) {
  if (checkpoint <= 0) return { ...spec.start };
  const index = Math.min(checkpoint - 1, spec.checkpoints.length - 1);
  return { x: 0, y: 1.15, z: spec.checkpoints[index] + 3.1 };
}
