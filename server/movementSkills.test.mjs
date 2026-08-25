import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Effects } from '../client/game/Effects.js';
import { Player, RUN_SPEED } from '../client/game/Player.js';

const DT = 1 / 60;
const movement = (forward = 1) => ({ x: 0, forward, magnitude: Math.abs(forward) });

function flatCourse({ wall = false } = {}) {
  return {
    spec: { segmentCount: 99, finishZ: -9999 },
    spawnFor: () => new THREE.Vector3(0, 0.48, 0),
    // Пол описан теми же плоскими опорами, что и настоящая трасса: постановку на опору считает
    // общее ядро, и подделывать здесь метод курса больше нечем.
    platforms: [
      { x: 0, y: -0.5, z: 0, w: 4000, h: 1, d: 4000, r: 0, type: 'box', disabled: false, delta: null }
    ],

    surfaceAt(position, previousY, velocityY) {
      const foot = position.y - 0.48;
      return velocityY <= 1.5 && foot <= 0.12 && previousY - 0.48 >= -0.48
        ? { y: 0, delta: new THREE.Vector3() }
        : null;
    },
    wallBounceAt(position, previous, velocity) {
      if (!wall || position.z > -1 || previous.z <= -1 || velocity.z >= 0) return null;
      return { x: 0, z: 1 };
    },
    interact() {},
    checkpointFor: (_, checkpoint) => checkpoint
  };
}

function makePlayer(course = flatCourse()) {
  const scene = new THREE.Scene();
  return new Player(scene, course, new Effects(scene, 'low'));
}

test('dive landing becomes a momentum-preserving roll', () => {
  const player = makePlayer();
  player.grounded = true;
  let dive = true;
  const input = {
    movement: () => movement(),
    consume: action => action === 'dive' && dive && ((dive = false), true)
  };

  for (let step = 0; step < 70 && player.rollTimer <= 0; step++) player.step(DT, input, 0, step * DT);

  assert.ok(player.rollTimer > 0, 'рывок должен перейти в перекат при быстром приземлении');
  assert.ok(Math.hypot(player.velocity.x, player.velocity.z) > RUN_SPEED);
  assert.equal(player.snapshot().state, 'dive', 'сетевые клиенты должны видеть анимацию переката');
});

test('well-timed jump exits a roll immediately without a new action', () => {
  const player = makePlayer();
  player.grounded = true;
  player.rollTimer = 0.3;
  player.recoveryWindow = 0.15;
  player.velocity.z = -9;
  let jump = true;
  player.step(
    DT,
    {
      movement: () => movement(),
      consume: action => action === 'jump' && jump && ((jump = false), true)
    },
    0,
    0
  );

  assert.equal(player.rollTimer, 0);
  assert.ok(player.velocity.y > 7);
  assert.ok(player.landingRetention > 0);
});

test('jump buffer bounces only from an explicitly supported wall', () => {
  const supported = makePlayer(flatCourse({ wall: true }));
  supported.teleport(new THREE.Vector3(0, 1.4, -0.85));
  supported.velocity.z = -10;
  let jump = true;
  supported.step(
    DT,
    {
      movement: () => movement(),
      consume: action => action === 'jump' && jump && ((jump = false), true)
    },
    0,
    0
  );
  assert.ok(supported.velocity.z > 8);
  assert.ok(supported.velocity.y > 6);
  assert.ok(supported.character.wallBouncePulse > 0, 'подтверждённый wall-bounce должен дать visual pulse');
  assert.ok(supported.impact > 0, 'подтверждённый wall-bounce должен дать bounded camera impact');

  const ordinary = makePlayer(flatCourse());
  ordinary.teleport(new THREE.Vector3(0, 1.4, -0.85));
  ordinary.velocity.z = -10;
  jump = true;
  ordinary.step(
    DT,
    {
      movement: () => movement(),
      consume: action => action === 'jump' && jump && ((jump = false), true)
    },
    0,
    0
  );
  assert.ok(ordinary.velocity.z < 0, 'обычная поверхность не должна давать скрытый отскок');
  assert.equal(
    ordinary.character.wallBouncePulse,
    0,
    'обычная поверхность не должна запускать wall-bounce pose'
  );
  assert.equal(ordinary.impact, 0, 'обычная поверхность не должна трясти камеру как wall-bounce');
});
