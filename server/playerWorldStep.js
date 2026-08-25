'use strict';

// Один шаг игрока ЧЕРЕЗ ТРАССУ: движение, отскок от стены, опора, импульсы препятствий.
//
// Ядро движения (`stepPlayerMotion`), опора, отскок и импульсы давно живут в общем коде, и каждое
// из них по отдельности сверено с клиентом. А вот ПОРЯДОК их применения и то, какое состояние
// читает каждая проверка, до сих пор существовали в двух местах порознь: у клиента внутри
// `Player.step`, у сервера — внутри цикла подшагов shadow-симуляции. Ровно там они и разошлись:
//
//   1. Калитка отскока. Клиент спрашивает про стену ПОСЛЕ шага движения, то есть по уже
//      обновлённому буферу прыжка. Сервер спрашивал по состоянию ДО шага — и прыжок, нажатый в тот
//      самый кадр, когда игрок коснулся стены, для него не существовал. Это не край: подсказка к
//      приёму так и звучит — «jump у самой поверхности превращает рывок в управляемый отскок», то
//      есть основной способ им пользоваться сервер не видел вовсе.
//   2. Намерение при постановке на опору. Клиент передаёт его домноженным на `knockdownControl`
//      (у живого клиента это ноль), сервер — сырым. Сбитый игрок, приземляющийся по ходу движения,
//      получал на сервере удержание темпа, которого у клиента нет.
//
// Поэтому сборка теперь одна и лежит здесь. Клиент по-прежнему исполняет свой `Player.step` — там
// вокруг тех же вызовов висит подача, — но обязан давать шаг в шаг тот же ответ, и это проверяется
// на настоящей геометрии (`server/clientWorldMotionParity.test.mjs`).

const {
  PLAYER_SIMULATION_CONSTANTS,
  applyKnockdown,
  resolveGroundContact,
  stepPlayerMotion
} = require('../shared/playerSimulation.js');
const { PLAYER_BODY_RADIUS, PLAYER_FOOT, PLAYER_OBSTACLE_RADIUS } = require('../shared/playerDimensions.js');
const { applyObstacleImpulses } = require('../shared/courseImpulses.js');
const { applyWallBounce, wallBounceNormalAt } = require('../shared/courseWalls.js');

const { JUMP_SPEED } = PLAYER_SIMULATION_CONSTANTS;

// Шаг игрока через мир трассы.
//
// `world` — это `{ colliders, obstacles, walls }`: ровно то, что отдаёт `shadowCourseWorld`, и то
// же самое, что клиент держит в `course.platforms`, `course.obstacles` и `course.skillWalls`. Мир
// обязан быть УЖЕ доведён до `now`: положение подвижных опор и фаза вертушек считаются снаружи, а
// здесь только читаются.
//
// `step` подменяем ради тестов рантайма; по умолчанию это общее ядро движения.
function stepPlayerThroughWorld(
  state,
  rawInput,
  world,
  {
    dt,
    now = 0,
    hitTimes,
    knockback = 1,
    knockdownControl = 0,
    characterYaw = 0,
    modifier = null,
    step = stepPlayerMotion
  } = {}
) {
  const from = { x: state.position.x, y: state.position.y, z: state.position.z };
  const motion = step(state, rawInput, { knockdownControl, characterYaw, modifier }, dt);
  let next = motion.state;

  // Калитка читается ПОСЛЕ шага — как у клиента. Про стену спрашиваем только при открытой калитке,
  // и это тоже клиентский порядок: у стены без прыжка приёма нет.
  const open = !next.grounded && next.jumpBuffer > 0;
  const normal = open
    ? wallBounceNormalAt(world.walls, next.position, from, next.velocity, PLAYER_BODY_RADIUS)
    : null;
  if (normal) applyWallBounce(next, normal, from, { jumpSpeed: JUMP_SPEED });

  // Намерение берётся у самого шага: там оно уже ослаблено сбиванием. Подменённый шаг его не
  // возвращает — тогда честнее считать направление неизвестным, чем подставить сырой ввод: сырой
  // ввод и есть та самая ошибка, ради которой сборка сюда переехала.
  const contact = resolveGroundContact(next, {
    colliders: world.colliders,
    previousY: from.y,
    footOffset: PLAYER_FOOT,
    intent: motion.intent || null,
    wasGrounded: next.grounded
  });
  next = contact.state;

  const impulses = applyObstacleImpulses(next, {
    obstacles: world.obstacles,
    now,
    hitTimes,
    playerRadius: PLAYER_OBSTACLE_RADIUS,
    footOffset: PLAYER_FOOT,
    knockback
  });

  // Импульс несёт не только толчок, но и сбивание, и клиент его применяет (`Course.interact` →
  // `player.knockDown`). Засчитываем только СОСТОЯВШЕЕСЯ: иммунитет и уже идущее сбивание отменяют
  // его и у клиента тоже.
  let knockedDown = false;
  for (const event of impulses.events) {
    if (event.knockdown && applyKnockdown(impulses.state, event.knockdown)) knockedDown = true;
  }

  // Наружу отдаётся состояние и то, ЧТО с игроком случилось. Подача (частицы, звук, тряска) на
  // сервере не нужна, но события приземления пригодятся тому, кто соберёт по этой сборке полный
  // серверный шаг, — поэтому они не выбрасываются.
  return {
    state: impulses.state,
    bounced: !!normal,
    knockedDown,
    landings: contact.events,
    hits: impulses.events
  };
}

module.exports = { stepPlayerThroughWorld };
