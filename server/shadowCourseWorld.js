'use strict';

const { GAME_MODE } = require('../shared/protocol.js');
const { recordRaceCourse } = require('../shared/courseColliderRecorder.js');

// Мир трассы для серверной симуляции.
//
// До сих пор shadow-симуляция не знала, где пол: она заимствовала контакт с землёй у клиента,
// потому что своей геометрии у сервера не было. Теперь геометрия строится безголово по той же
// спецификации, что и у клиента, и живёт здесь — по одному миру на матч.
//
// Подвижные опоры считаются от времени той же формулой, что и у клиента: ось, центр, размах,
// скорость и фаза. Никакой истории — положение любой опоры в любой момент считается заново.
function createShadowCourseWorld(spec) {
  const recorded = recordRaceCourse(spec);
  const colliders = recorded.platforms;
  const dynamic = recorded.dynamic;
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
    return true;
  }

  return {
    colliders,
    dynamic,
    obstacles: recorded.obstacles,
    advance
  };
}

// Мир нужен только гонке: кооперативные главы рукотворные, их геометрия безголово ещё не строится.
function shadowCourseWorldFor(room) {
  if (room?.mode !== GAME_MODE.RACE || !room?.spec) return null;
  try {
    return createShadowCourseWorld(room.spec);
  } catch {
    // Без мира симуляция просто остаётся без пола, как была: диагностика не должна ронять матч.
    return null;
  }
}

module.exports = Object.freeze({ createShadowCourseWorld, shadowCourseWorldFor });
