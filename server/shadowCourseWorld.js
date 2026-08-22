'use strict';

const { GAME_MODE } = require('../shared/protocol.js');
const { recordRaceCourse } = require('../shared/courseColliderRecorder.js');

// Мир трассы для серверной симуляции.
//
// До сих пор shadow-симуляция не знала, где пол: она заимствовала контакт с землёй у клиента,
// потому что своей геометрии у сервера не было. Теперь геометрия строится безголово по той же
// спецификации, что и у клиента, и живёт здесь — по одному миру на матч.
//
// Подвижные опоры и препятствия считаются от времени теми же формулами, что и у клиента: ось,
// центр, размах, скорость и фаза. Никакой истории — положение любого объекта в любой момент
// считается заново.
//
// `elapsedSeconds` — это время ОТ НАЧАЛА МАТЧА, ровно то же, что клиент передаёт в `Course.update`
// и `Course.interact`. Не «сколько сейчас на часах»: фазы синусоид считаются от него напрямую, и
// подстановка эпохи Unix увела бы каждую подвижную опору на произвольную точку её размаха.
function createShadowCourseWorld(spec) {
  const recorded = recordRaceCourse(spec);
  const colliders = recorded.platforms;
  const dynamic = recorded.dynamic;
  const obstacles = recorded.obstacles;
  let advancedTo = null;

  function advance(elapsedSeconds) {
    if (!Number.isFinite(elapsedSeconds)) return false;
    if (advancedTo === elapsedSeconds) return false;
    advancedTo = elapsedSeconds;
    for (const platform of dynamic) {
      const motion = platform.motion;
      if (!motion) continue;
      const previous = platform[motion.axis];
      const value = motion.origin + Math.sin(elapsedSeconds * motion.speed + motion.phase) * motion.range;
      platform[motion.axis] = value;
      // Перенос стоящего игрока считается по тому же сдвигу за шаг, что и у клиента.
      platform.delta.x = 0;
      platform.delta.y = 0;
      platform.delta.z = 0;
      platform.delta[motion.axis] = value - previous;
    }
    // Препятствия двигаются здесь же, и это не мелочь: геометрия удара вертушки берётся из
    // `o.angle`, а поршня — из `o.x`. Оставленные на записанных значениях, они дали бы застывшую
    // трассу, по которой импульсы считались бы не там, где они происходят у клиента.
    // Формулы — те же, что в `Course.update`.
    for (const obstacle of obstacles) {
      if (obstacle.type === 'spinner') {
        obstacle.angle = elapsedSeconds * obstacle.speed + obstacle.phase;
      } else if (obstacle.type === 'puncher') {
        obstacle.x =
          obstacle.originX + Math.sin(elapsedSeconds * obstacle.speed + obstacle.phase) * obstacle.range;
      }
      // Бампер и пружина у клиента только дышат масштабом — на столкновения это не влияет.
    }
    return true;
  }

  return {
    colliders,
    dynamic,
    obstacles,
    walls: recorded.skillWalls,
    advance
  };
}

// Строится ли безголовая геометрия для этого режима ВООБЩЕ.
//
// Вопрос отдельный от «построилась ли»: у гоночной комнаты со сломанной спекой мира нет по ошибке, а
// у кооперативной — по устройству, потому что главы рукотворные и рекордера у них пока нет. Для
// доказательств это разные вещи, и мерить их одним счётчиком нельзя: порог `maxWorldMissingSamples`
// требует строгий ноль, метрики общие на процесс, и один кооперативный матч на том же сервере
// закрывал бы паритет столкновений навсегда — по причине, к паритету отношения не имеющей.
function shadowWorldSupported(room) {
  return room?.mode === GAME_MODE.RACE;
}

// Мир нужен только гонке: кооперативные главы рукотворные, их геометрия безголово ещё не строится.
function shadowCourseWorldFor(room) {
  if (!shadowWorldSupported(room) || !room?.spec) return null;
  try {
    return createShadowCourseWorld(room.spec);
  } catch {
    // Без мира симуляция просто остаётся без пола, как была: диагностика не должна ронять матч.
    return null;
  }
}

module.exports = Object.freeze({ createShadowCourseWorld, shadowCourseWorldFor, shadowWorldSupported });
