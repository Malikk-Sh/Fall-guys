import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../client/game/Player.js';
import { Effects } from '../client/game/Effects.js';
import {
  createPlayerSimulationState,
  movementIntent,
  resolveGroundContact,
  stepPlayerMotion
} from '../shared/playerSimulation.js';
import { PLAYER_FOOT } from '../client/game/PlayerDimensions.js';

// Движение игрока написано дважды: в client/game/Player.js — тот путь, по которому реально играют,
// и в shared/playerSimulation.js — тот, которым считает сервер и по которому клиент переигрывает
// неподтверждённый ввод. Числа у них общие, но сами формулы отдельные.
//
// Пока это так, паритет движения не доказывается, а поддерживается руками: правка в одном месте
// молча разводит клиент и сервер, и ни один тест этого не заметит. Здесь обе реализации гоняются
// по одному сценарию и сверяются на каждом шаге — до последнего разряда.
//
// Часть сценариев идёт над пустотой, часть — над полом: постановка на опору уже общая, а стены и
// импульсы препятствий ещё нет, поэтому сравнивается ровно то, что реализовано в обеих версиях.
function emptyCourse() {
  return {
    platforms: [],
    obstacles: [],
    dynamic: [],
    spec: {},
    surfaceAt: () => null,
    wallBounceAt: () => null,
    interact: () => {},
    update: () => {},
    checkpointFor: (_previous, _position, current) => current,
    // Высоко над трассой: падение не должно упереться в порог возрождения и подменить сравнение.
    spawnFor: () => new THREE.Vector3(0, 5000, 0),
    progress: () => 0
  };
}

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

// Ввод собирается ровно так, как его отдаёт `InputManager.movement()`.
//
// Раньше магнитуда бралась из кадра (`frame.magnitude ?? 1`), а общее ядро выводило её само —
// `min(1, hypot(moveX, moveZ))`. То есть две реализации получали РАЗНУЮ магнитуду, и сравнение
// держалось на том, что `movementIntent` всё равно нормирует направление, а единственная ветка, где
// магнитуда решает сама по себе (торможение на опоре), при нуле скорости ничего не меняла.
//
// Здесь она выводится тем же выражением, что и у настоящего ввода. Протокол это же и требует:
// `CLIENT_INPUT` несёт moveX и moveZ, но не магнитуду, поэтому сервер обязан её вывести — и вывести
// так же.
function harnessMovement(frame) {
  const moveX = frame.moveX ?? 0;
  const moveZ = frame.moveZ ?? 0;
  const length = Math.hypot(moveX, moveZ);
  return {
    x: length > 1 ? moveX / length : moveX,
    forward: length > 1 ? moveZ / length : moveZ,
    magnitude: Math.min(1, length)
  };
}

// Один шаг подаётся обеим реализациям в одном виде: клиент читает ввод через объект, общее ядро —
// через плоскую запись, и это единственная разница между вызовами.
function runScript(script, { dt = 1 / 30, cameraYaw = 0, start = { x: 0, y: 5000, z: 0 } } = {}) {
  const scene = new THREE.Scene();
  const player = new Player(scene, emptyCourse(), new Effects(scene));
  player.teleport(new THREE.Vector3(start.x, start.y, start.z));
  let state = createPlayerSimulationState({ position: { ...start } });

  script.forEach((frame, tick) => {
    const move = harnessMovement(frame);
    const input = {
      movement: () => move,
      consume: action => (action === 'jump' ? frame.jump === true : frame.dive === true),
      isHeld: action => action === 'jump' && frame.jumpHeld === true
    };
    // Сбивание приходит извне: клиент получает его вызовом до шага, поэтому в общее ядро оно
    // вносится тем же моментом — иначе сравнивались бы разные шаги, а не разные реализации.
    if (frame.knockDown) {
      player.knockDown(frame.knockDown);
      state = createPlayerSimulationState({
        ...state,
        knockdownTimer: player.knockdownTimer,
        getupTimer: player.getupTimer,
        jumpBuffer: player.jumpBuffer,
        diveTimer: player.diveTimer,
        rollTimer: player.rollTimer,
        recoveryWindow: player.recoveryWindow,
        slamming: player.slamming,
        gliding: player.gliding
      });
    }

    player.step(dt, input, cameraYaw, tick * dt);
    state = stepPlayerMotion(
      state,
      {
        moveX: move.x,
        moveZ: move.forward,
        cameraYaw,
        jumpPressed: frame.jump === true,
        jumpHeld: frame.jumpHeld === true,
        divePressed: frame.dive === true
      },
      {
        // Сбивание приходит извне и в обеих версиях лишь заводит таймеры, поэтому клиенту оно
        // подаётся вызовом, а ядру — состоянием: сравнивать нужно то, что идёт после него.
        knockdownControl: 0
      },
      dt
    ).state;
    assertSameState(player, state, `на шаге ${tick}`);
  });
  return { player, state };
}

// Тот же сценарий, но над полом: теперь сверяется и постановка на опору. Пол описан плоскими
// опорами — ровно тем, что клиент строит из своей геометрии, а сервер получает безголовой сборкой.
function runOverFloor(script, { dt = 1 / 30, cameraYaw = 0, startY = 6 } = {}) {
  const floor = () => [
    { x: 0, y: -0.5, z: 0, w: 4000, h: 1, d: 4000, r: 0, type: 'box', disabled: false, delta: null }
  ];
  const scene = new THREE.Scene();
  const course = emptyCourse();
  course.platforms = floor();
  const player = new Player(scene, course, new Effects(scene));
  player.teleport(new THREE.Vector3(0, startY, 0));
  let state = createPlayerSimulationState({ position: { x: 0, y: startY, z: 0 } });
  const colliders = floor();

  script.forEach((frame, tick) => {
    const move = harnessMovement(frame);
    const input = {
      movement: () => move,
      consume: action => (action === 'jump' ? frame.jump === true : frame.dive === true),
      isHeld: action => action === 'jump' && frame.jumpHeld === true
    };
    const rawInput = {
      moveX: move.x,
      moveZ: move.forward,
      cameraYaw,
      jumpPressed: frame.jump === true,
      jumpHeld: frame.jumpHeld === true,
      divePressed: frame.dive === true
    };

    // Сбивание вносится так же, как в `runScript`, — и до сих пор здесь этого не было вовсе.
    //
    // Из-за пропуска сценарий со сбиванием над полом проходил ВХОЛОСТУЮ: кадр `knockDown` молча
    // игнорировался, игрок продолжал бежать, и сверялся обычный бег. Ветка торможения лёжа
    // (`magnitude < 0.05 && grounded`) при этом не достигалась ни разу.
    if (frame.knockDown) {
      player.knockDown(frame.knockDown);
      state = createPlayerSimulationState({
        ...state,
        knockdownTimer: player.knockdownTimer,
        getupTimer: player.getupTimer,
        jumpBuffer: player.jumpBuffer,
        diveTimer: player.diveTimer,
        rollTimer: player.rollTimer,
        recoveryWindow: player.recoveryWindow,
        slamming: player.slamming,
        gliding: player.gliding
      });
    }

    player.step(dt, input, cameraYaw, tick * dt);

    const wasGrounded = state.grounded;
    const previousY = state.position.y;
    state = stepPlayerMotion(state, rawInput, { knockdownControl: 0 }, dt).state;
    state = resolveGroundContact(state, {
      colliders,
      previousY,
      footOffset: PLAYER_FOOT,
      intent: movementIntent(rawInput),
      wasGrounded
    }).state;

    assertSameState(player, state, `на шаге ${tick} над полом`);
  });
  return { player, state };
}

const idle = count => Array.from({ length: count }, () => ({}));
const running = (count, extra = {}) =>
  Array.from({ length: count }, () => ({ moveX: 0.6, moveZ: 1, ...extra }));

test('свободный бег считается обеими реализациями одинаково', () => {
  runScript([...idle(3), ...running(60)]);
});

test('прыжок, буфер и coyote time совпадают до разряда', () => {
  runScript([
    ...running(4),
    { moveX: 0.6, moveZ: 1, jump: true },
    ...running(25),
    { moveX: 0.6, moveZ: 1, jump: true },
    ...running(20)
  ]);
});

test('подкат, перекат и его перезарядка совпадают', () => {
  runScript([
    ...running(6),
    { moveX: 0, moveZ: 1, dive: true },
    ...running(40),
    { moveX: 0, moveZ: 1, dive: true },
    ...running(40)
  ]);
});

test('планирование удержанием прыжка совпадает на всём спуске', () => {
  runScript([
    ...running(3),
    { moveX: 0.2, moveZ: 1, jump: true },
    ...running(10, { jumpHeld: true }),
    ...running(45, { jumpHeld: true })
  ]);
});

test('поворот камеры разворачивает намерение одинаково', () => {
  for (const cameraYaw of [0, Math.PI / 4, -1.234, Math.PI]) {
    runScript([...running(30)], { cameraYaw });
  }
});

test('после сбивания обе реализации отсчитывают подъём и иммунитет одинаково', () => {
  runScript([...running(5), { moveX: 0.4, moveZ: 1, knockDown: 0.5 }, ...running(120)]);
});

test('диагональное намерение не даёт скорости больше прямого', () => {
  const straight = runScript([...running(45, { moveX: 0, moveZ: 1 })]);
  const diagonal = runScript([...running(45, { moveX: 1, moveZ: 1 })]);
  const speed = state => Math.hypot(state.velocity.x, state.velocity.z);
  assert.ok(speed(diagonal.state) <= speed(straight.state) + 1e-9);
});

test('падение, приземление и бег по полу совпадают у обеих реализаций', () => {
  runOverFloor([...idle(40), ...running(60)]);
});

test('подкат с приземлением в перекат совпадает над полом', () => {
  runOverFloor([...idle(20), ...running(15), { moveX: 0, moveZ: 1, dive: true }, ...running(60)]);
});

test('прыжок с пола и возвращение на него совпадают', () => {
  runOverFloor([...idle(30), ...running(10), { moveX: 0.6, moveZ: 1, jump: true }, ...running(45)]);
});

// Сбивание НА ПОЛУ — отдельный сценарий, и раньше его не было ни одного.
//
// Сбивание в воздухе сверяется выше, но там не достаётся ветка, которая работает только на опоре:
//
//   if (move.magnitude < 0.05 && grounded) {
//     const stop = (knockedDown ? 3.2 : 12) * groundGrip;
//
// У сбитого игрока намерение домножается на `knockdownControl` (у живого клиента это ноль), поэтому
// магнитуда обращается в ноль, и лежащий на полу игрок тормозит с темпом 3.2. Ветка есть в обеих
// реализациях, написана в них порознь — и до сих пор ни один тест их здесь не сравнивал: над полом
// сбивания не случалось, а в воздухе `grounded` ложный.
function knockdownOnFloor(strength) {
  return [
    ...idle(40),
    ...running(20),
    { moveX: 0.4, moveZ: 1, knockDown: strength },
    // Ввод продолжает поступать: важно, что обе стороны одинаково его ИГНОРИРУЮТ, пока таймер идёт,
    // и одинаково возвращают управление после подъёма.
    ...running(150)
  ];
}

test('сбивание на полу и торможение лёжа совпадают до разряда', () => {
  for (const strength of [0.4, 0.5, 0.55]) {
    runOverFloor(knockdownOnFloor(strength));
  }
});

test('сбитый на полу игрок останавливается, а после подъёма снова разгоняется', () => {
  // Проверка не про паритет, а про то, что сценарий выше вообще проходит через нужные состояния:
  // тест, где игрок не тормозил и не вставал, сравнивал бы одинаковую пустоту.
  const { player } = runOverFloor([...idle(40), ...running(20), { moveX: 0.4, moveZ: 1, knockDown: 0.5 }]);
  assert.ok(player.grounded, 'сбивание должно случиться на опоре, иначе ветка торможения не работает');
  assert.ok(player.knockdownTimer > 0, 'таймер сбивания должен идти');

  const speedAt = frames => {
    const { player: p } = runOverFloor([
      ...idle(40),
      ...running(20),
      { moveX: 0.4, moveZ: 1, knockDown: 0.5 },
      ...running(frames)
    ]);
    return { speed: Math.hypot(p.velocity.x, p.velocity.z), knocked: p.knockdownTimer > 0 };
  };

  const downed = speedAt(30);
  assert.ok(downed.knocked, 'через 30 шагов игрок ещё должен лежать');
  assert.ok(
    downed.speed < 0.5,
    `лёжа игрок обязан почти остановиться, а не ехать со скоростью ${downed.speed}`
  );

  const recovered = speedAt(150);
  assert.ok(!recovered.knocked, 'через 150 шагов сбивание должно кончиться');
  assert.ok(
    recovered.speed > 5,
    `после подъёма игрок обязан разогнаться, а не ползти со скоростью ${recovered.speed}`
  );
});

test('еле отклонённый стик тормозит обе реализации одинаково', () => {
  // Порог `magnitude < 0.05` — единственное место, где магнитуда решает сама по себе, а не через
  // направление. Ни один сценарий выше его не задевал: магнитуда в них либо 1 (бег), либо 0 (стоя
  // или лёжа), и подмена порога на 0.04 не роняла ничего.
  //
  // 0.045 лежит между ними, поэтому расходится ответ на вопрос «тормозить ли»: при 0.05 торможение
  // включается, при 0.04 — нет. Обе реализации обязаны отвечать одинаково.
  runOverFloor([...idle(40), ...running(25), ...Array.from({ length: 40 }, () => ({ moveZ: 0.045 }))]);
});
