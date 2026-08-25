// Паритет движения НА НАСТОЯЩЕЙ ГЕОМЕТРИИ.
//
// `clientSharedMotionParity` сверяет клиент и общее ядро над пустотой и над ровным полом. Всё, что
// делает трассу трассой, туда не входит вовсе: бампер, вертушка, поршень, пружина, стена отскока,
// подвижная опора. А ведь именно там расхождение и опасно — не в чистом беге по прямой.
//
// Здесь клиентский `Player` бежит по настоящей трассе, собранной со сценой, а рядом то же самое
// считает сборка сервера (`stepPlayerThroughWorld`) по безголовой записи той же трассы. Сверяется
// каждый шаг, до последнего разряда.
//
// Найдено этим тестом (и починено вместе с ним):
//
//   1. Калитка отскока от стены. Сервер читал буфер прыжка ДО шага движения, поэтому прыжок,
//      нажатый в тот самый кадр, когда игрок коснулся стены, для него не существовал, — то есть
//      основной способ пользоваться приёмом сервер не видел. Сценарий «прыжок у самой стены» ниже
//      воспроизводит ровно это.
//   2. Намерение при постановке на опору сервер брал сырым, а клиент — ослабленным сбиванием.
//      Сбитый игрок, приземляющийся по ходу движения, получал на сервере удержание темпа, которого
//      у клиента нет. Этот случай проверяется в `clientSharedMotionParity` над ровным полом, где
//      его можно поставить точно.
//
// Само ядро движения на настоящей геометрии разошлось НИ РАЗУ — ни на одном из шести забегов ниже,
// с попаданиями, сбиваниями, возвращениями на чекпоинт и подвижными опорами. Расходилась сборка.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as THREE from 'three';

import { Player } from '../client/game/Player.js';
import { Course } from '../client/game/Course.js';
import { courseSpec } from '../client/core/Config.js';
import { PLAYER_FOOT } from '../client/game/PlayerDimensions.js';
import { createPlayerSimulationState } from '../shared/playerSimulation.js';
import { supportTop } from '../shared/courseCollision.js';

const require = createRequire(import.meta.url);
const { stepPlayerThroughWorld } = require('./playerWorldStep');
const { createShadowCourseWorld } = require('./shadowCourseWorld');

// Тот же шаг, что крутит клиент (`client/main.js`), — не серверный тик: сравнивать надо то, что
// исполняется, а полушаг на другой частоте даёт другой ответ сам по себе.
const DT = 1 / 60;

// Частицы и звук на физику не влияют, а сцены под них здесь нет.
const NO_EFFECTS = { burst() {}, trail() {}, ring() {} };

const FIELDS = [
  ['grounded', 'grounded'],
  ['coyote', 'coyoteTime'],
  ['jumpBuffer', 'jumpBuffer'],
  ['diveTimer', 'diveTimer'],
  ['diveCooldown', 'diveCooldown'],
  ['rollTimer', 'rollTimer'],
  ['landingRetention', 'landingRetention'],
  ['recoveryWindow', 'recoveryWindow'],
  ['knockdownTimer', 'knockdownTimer'],
  ['knockdownImmunityTimer', 'knockdownImmunity'],
  ['getupTimer', 'getupTimer'],
  ['slamming', 'slamming'],
  ['gliding', 'gliding']
];

function assertSameState(player, state, when) {
  assert.equal(player.physics.x, state.position.x, `x разошёлся ${when}`);
  assert.equal(player.physics.y, state.position.y, `y разошёлся ${when}`);
  assert.equal(player.physics.z, state.position.z, `z разошёлся ${when}`);
  assert.equal(player.velocity.x, state.velocity.x, `vx разошёлся ${when}`);
  assert.equal(player.velocity.y, state.velocity.y, `vy разошёлся ${when}`);
  assert.equal(player.velocity.z, state.velocity.z, `vz разошёлся ${when}`);
  for (const [clientField, sharedField] of FIELDS) {
    assert.equal(player[clientField], state[sharedField], `${clientField} разошёлся ${when}`);
  }
}

// Возвращение на чекпоинт — решение КЛИЕНТА, а не результат движения: счётчик чекпоинтов и точка
// возрождения живут только у него. Поэтому серверной стороне тот же сброс вносится вручную, ровно
// теми полями, которые трогает `Player.respawn`, — и ни одним больше.
//
// Позиция берётся у клиента, и это не подгонка: до самого падения позиции сверялись покадрово, и
// расхождение не дожило бы до возрождения — тест падает на том шаге, где оно появилось. А вот
// буфер прыжка, coyote, перезарядка подката и slamming возрождением НЕ сбрасываются, поэтому
// остаются под сравнением и после него.
function mirrorRespawn(state, player) {
  return createPlayerSimulationState({
    ...state,
    position: { x: player.physics.x, y: player.physics.y, z: player.physics.z },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: false,
    diveTimer: 0,
    rollTimer: 0,
    landingRetention: 0,
    recoveryWindow: 0,
    knockdownTimer: 0,
    knockdownImmunity: 0,
    getupTimer: 0
  });
}

// Один прогон по настоящей трассе.
//
// `drive` получает состояние клиента и возвращает ввод кадра — тот же ввод уходит обеим сторонам,
// как и по сети: клиент шлёт нажатия, а не результат.
function runCourse(spec, drive, { frames = 4000, start = null, velocity = null, observe = null } = {}) {
  const scene = new THREE.Scene();
  const course = new Course(scene, spec, { quality: 'low' });
  const player = new Player(scene, course, NO_EFFECTS);
  const world = createShadowCourseWorld(spec);
  const hitTimes = new Map();
  const knockback = spec.modifier?.knockback || 1;

  if (start) player.teleport(new THREE.Vector3(start.x, start.y, start.z));
  if (velocity) player.velocity.set(velocity.x, velocity.y, velocity.z);
  let state = createPlayerSimulationState({
    position: { x: player.physics.x, y: player.physics.y, z: player.physics.z },
    velocity: { x: player.velocity.x, y: player.velocity.y, z: player.velocity.z }
  });

  const seen = { frames: 0, hits: 0, knockdowns: 0, bounces: 0, respawns: 0, carried: 0 };
  let elapsed = 0;

  try {
    for (let frame = 0; frame < frames && !player.finished; frame++) {
      elapsed += DT;
      const frameInput = drive({ player, frame, elapsed, course });
      const move = frameInput.movement();
      const raw = {
        moveX: move.x,
        moveZ: move.forward,
        cameraYaw: 0,
        jumpPressed: frameInput.jumpPressed === true,
        jumpHeld: frameInput.jumpHeld === true,
        divePressed: frameInput.divePressed === true
      };
      // Направление персонажа читается ДО шага: подкат без явного намерения уходит именно туда,
      // и у клиента поворот пересчитывается уже после физики.
      const characterYaw = player.character.group.rotation.y;
      const respawnsBefore = player.respawns;
      const groundedBefore = player.grounded;

      // Порядок кадра — тот же, что в `Game.fixedStep`: сперва трасса доводится до времени матча,
      // потом по ней идёт шаг игрока.
      course.update(DT, elapsed);
      world.advance(elapsed);
      player.step(DT, frameInput.input, 0, elapsed);

      const advanced = stepPlayerThroughWorld(state, raw, world, {
        dt: DT,
        now: elapsed,
        hitTimes,
        knockback,
        characterYaw
      });
      state = advanced.state;

      seen.frames += 1;
      seen.hits += advanced.hits.length;
      if (advanced.knockedDown) seen.knockdowns += 1;
      if (advanced.bounced) seen.bounces += 1;
      if (groundedBefore && player.grounded && move.magnitude === 0) seen.carried += 1;

      if (player.respawns !== respawnsBefore) {
        seen.respawns += 1;
        state = mirrorRespawn(state, player);
      }
      assertSameState(player, state, `на шаге ${frame} (seed ${spec.seed}/${spec.difficulty})`);
      observe?.({ frame, player, state, advanced });
    }
  } finally {
    course.dispose();
  }
  return { player, state, seen, world };
}

// Бот из `server/bots.mjs`: держится середины, прыгает перед пропастью и ритмично поверх
// препятствий, планирует на спуске, изредка подкатывается. Сюда он скопирован не целиком, а только
// как ВВОД: сам забег здесь считают обе сверяемые стороны, а не одна.
function botDriver({ wander = 0 } = {}) {
  return ({ player, frame, elapsed, course }) => {
    const lane = wander ? Math.sin(elapsed * wander) * 9 : 0;
    const dx = lane - player.position.x;
    const dz = -6;
    const length = Math.hypot(dx, dz);
    const moveX = dx / length;
    const moveForward = -(dz / length);

    const probe = player.position.clone();
    probe.z -= 2;
    const jumpPressed =
      player.grounded && (!course.surfaceAt(probe, probe.y + 0.1, -0.1) || frame % 42 === 0);
    const jumpHeld = !player.grounded && player.velocity.y < 0;
    const divePressed = player.grounded && frame % 90 === 0;
    return frameInput({ moveX, moveForward, jumpPressed, jumpHeld, divePressed });
  };
}

// Ввод кадра в двух видах сразу: объектом — как его читает клиент, полями — как он уходит по сети.
// Магнитуда выводится тем же выражением, что и в `InputManager.movement()`: протокол несёт moveX и
// moveZ, но не магнитуду, поэтому вывести её обязаны обе стороны и одинаково.
function frameInput({
  moveX = 0,
  moveForward = 0,
  jumpPressed = false,
  jumpHeld = false,
  divePressed = false
}) {
  const length = Math.hypot(moveX, moveForward);
  const move = {
    x: length > 1 ? moveX / length : moveX,
    forward: length > 1 ? moveForward / length : moveForward,
    magnitude: Math.min(1, length)
  };
  return {
    jumpPressed,
    jumpHeld,
    divePressed,
    movement: () => move,
    input: {
      movement: () => move,
      consume: action => (action === 'jump' ? jumpPressed : divePressed),
      isHeld: action => action === 'jump' && jumpHeld
    }
  };
}

const RUNS = [
  { seed: 1, difficulty: 'easy', wander: 0 },
  { seed: 4242, difficulty: 'normal', wander: 0 },
  { seed: 4242, difficulty: 'normal', wander: 0.7 },
  { seed: 20260821, difficulty: 'chaos', wander: 0.9 },
  { seed: 777, difficulty: 'chaos', wander: 0.4 },
  { seed: 0xffffffff, difficulty: 'normal', wander: 1.3 }
];

test('забег по настоящей трассе считается обеими сторонами одинаково', () => {
  const total = { hits: 0, knockdowns: 0, respawns: 0, frames: 0 };
  for (const { seed, difficulty, wander } of RUNS) {
    const { seen } = runCourse(courseSpec(seed, difficulty), botDriver({ wander }));
    total.frames += seen.frames;
    total.hits += seen.hits;
    total.knockdowns += seen.knockdowns;
    total.respawns += seen.respawns;
  }

  // Забег, в котором игрока ни разу не задело и ни разу не сбило, сверял бы обычный бег по прямой —
  // то есть ровно то, что и так проверено над пустым полом. Покрытие поэтому утверждается, а не
  // подразумевается: без этих чисел тест мог бы «зеленеть» на пустой трассе.
  assert.ok(total.frames > 20000, `забеги обязаны быть длинными, а не ${total.frames} шагов`);
  assert.ok(total.hits > 100, `препятствия обязаны задевать игрока, а не ${total.hits} раз`);
  assert.ok(total.knockdowns > 40, `сбивания обязаны случаться, а не ${total.knockdowns} раз`);
  assert.ok(total.respawns > 20, `падения и возвращения обязаны случаться, а не ${total.respawns} раз`);
});

// Стена отскока — единственный приём, который живёт вне ядра движения, и на трассах он редок: две
// стены на каждой восьмой трассе, в стороне от прямой линии. Бот к ним не подходит, поэтому
// сценарий ставится руками.
function courseWithWalls() {
  const spec = courseSpec(3, 'normal');
  const walls = createShadowCourseWorld(spec).walls;
  assert.ok(walls.length > 0, 'сценарию нужна трасса со стенами отскока');
  return { spec, wall: walls.at(-1) };
}

test('прыжок у самой стены отскакивает одинаково — и у клиента, и у сервера', () => {
  const { spec, wall } = courseWithWalls();
  const side = Math.sign(wall.x) || 1;
  // Игрок летит в стену сбоку, а прыжок нажимает НА ПОДЛЁТЕ — так этим приёмом и пользуются.
  // Сервер такого прыжка не видел: он читал буфер прыжка до шага движения, то есть до нажатия.
  const start = { x: wall.x - side * 1.2, y: wall.y + 0.4, z: wall.z };
  const pressAt = 8;
  let bufferBeforePress = null;
  let atBounce = null;

  const { seen } = runCourse(
    spec,
    ({ player: p, frame }) => {
      if (frame === pressAt) bufferBeforePress = p.jumpBuffer;
      return frameInput({ moveX: side, jumpPressed: frame === pressAt });
    },
    {
      frames: 20,
      start,
      velocity: { x: side * 6.5, y: 1.2, z: 0 },
      observe: ({ frame, player, advanced }) => {
        if (advanced.bounced) atBounce = { frame, vx: player.velocity.x, vy: player.velocity.y };
      }
    }
  );

  assert.equal(bufferBeforePress, 0, 'подготовка: до нажатия буфер прыжка пуст — иначе случай не тот');
  assert.equal(seen.bounces, 1, 'отскок обязан состояться ровно один раз');
  assert.equal(atBounce.frame, pressAt, 'отскок обязан случиться в кадр нажатия, а не позже');
  // Отскок разворачивает движение по нормали и подбрасывает: до него игрок летел в стену, после —
  // от неё. Смотреть надо на сам кадр отскока: ввод по-прежнему давит в стену и через полсекунды
  // снова развернёт игрока к ней.
  assert.ok(
    atBounce.vx * side < 0,
    `после отскока игрока обязано нести от стены, а не в неё (vx ${atBounce.vx})`
  );
  assert.ok(atBounce.vy > 0, `отскок обязан подбрасывать (vy ${atBounce.vy})`);
});

test('без прыжка стена не отскакивает вовсе', () => {
  // Обратная сторона того же: калитка обязана оставаться закрытой. Иначе «починка» свелась бы к
  // тому, что отскакивает всё подряд, и обе стороны сходились бы на неверном ответе.
  const { spec, wall } = courseWithWalls();
  const side = Math.sign(wall.x) || 1;
  const { seen } = runCourse(spec, () => frameInput({ moveX: side }), {
    frames: 20,
    start: { x: wall.x - side * 1.2, y: wall.y + 0.4, z: wall.z },
    velocity: { x: side * 6.5, y: 1.2, z: 0 }
  });
  assert.equal(seen.bounces, 0, 'без нажатия прыжка приёма нет');
});

// Подвижная опора переносит стоящего на ней игрока, и перенос считается по сдвигу опоры за шаг.
// Бот по таким опорам пробегает, не задерживаясь, поэтому «стоять и ехать» ставится отдельно.
test('стоящего на подвижной опоре везёт одинаково у обеих сторон', () => {
  const spec = courseSpec(4242, 'normal');
  const world = createShadowCourseWorld(spec);
  const platform = world.dynamic[0];
  assert.ok(platform, 'сценарию нужна трасса с подвижной опорой');

  const axis = platform.motion.axis;
  const origin = platform.motion.origin;
  const { seen, player } = runCourse(spec, () => frameInput({}), {
    frames: 240,
    start: {
      x: axis === 'x' ? origin : platform.x,
      y: supportTop(platform) + PLAYER_FOOT + 0.05,
      z: axis === 'z' ? origin : platform.z
    }
  });

  assert.ok(seen.carried > 100, `игрок обязан простоять на опоре, а не ${seen.carried} шагов`);
  // Опора действительно ездила: без этого сравнивалось бы стояние на месте.
  const travelled = Math.abs(player.physics[axis] - origin);
  assert.ok(travelled > 0.5, `опора обязана возить игрока, а сдвинула на ${travelled}`);
});
