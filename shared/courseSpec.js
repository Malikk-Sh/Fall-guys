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
