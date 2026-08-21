import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../client/game/Player.js';
import { Effects } from '../client/game/Effects.js';
import { createPlayerSimulationState, stepPlayerMotion } from '../shared/playerSimulation.js';

// Движение игрока написано дважды: в client/game/Player.js — тот путь, по которому реально играют,
// и в shared/playerSimulation.js — тот, которым считает сервер и по которому клиент переигрывает
// неподтверждённый ввод. Числа у них общие, но сами формулы отдельные.
//
// Пока это так, паритет движения не доказывается, а поддерживается руками: правка в одном месте
// молча разводит клиент и сервер, и ни один тест этого не заметит. Здесь обе реализации гоняются
// по одному сценарию и сверяются на каждом шаге — до последнего разряда.
//
// Курс пустой намеренно: опоры, стены и препятствия в общее ядро ещё не перенесены, и сравнивать
// нужно ровно то, что реализовано в обеих версиях, — само движение.
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
    checkpointFor: (_position, current) => current,
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

// Один шаг подаётся обеим реализациям в одном виде: клиент читает ввод через объект, общее ядро —
// через плоскую запись, и это единственная разница между вызовами.
function runScript(script, { dt = 1 / 30, cameraYaw = 0, start = { x: 0, y: 5000, z: 0 } } = {}) {
  const scene = new THREE.Scene();
  const player = new Player(scene, emptyCourse(), new Effects(scene));
  player.teleport(new THREE.Vector3(start.x, start.y, start.z));
  let state = createPlayerSimulationState({ position: { ...start } });

  script.forEach((frame, tick) => {
    const move = { x: frame.moveX ?? 0, forward: frame.moveZ ?? 0, magnitude: frame.magnitude ?? 1 };
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
