import test from 'node:test';
import assert from 'node:assert/strict';
import { WALL_BOUNCE_SPEED, applyWallBounce, wallBounceNormalAt } from '../shared/courseWalls.js';
import { createPlayerSimulationState } from '../shared/playerSimulation.js';
import { PLAYER_BODY_RADIUS } from '../shared/playerDimensions.js';

// Тонкая по X стена: подход к ней идёт вдоль X, нормаль смотрит обратно движению.
const thinX = { x: 0, y: 1, z: 0, w: 0.5, h: 3, d: 8 };
// Тонкая по Z стена: то же самое, но поперёк трассы.
const thinZ = { x: 0, y: 1, z: 0, w: 8, h: 3, d: 0.5 };

const near = (wall, extra = {}) => ({ x: wall.x, y: wall.y, z: wall.z, ...extra });

test('нормаль смотрит в ту сторону, откуда игрок пришёл', () => {
  const normal = wallBounceNormalAt(
    [thinX],
    near(thinX),
    near(thinX, { x: 2 }),
    { x: -6, y: 0, z: 0 },
    PLAYER_BODY_RADIUS
  );
  assert.deepEqual(normal, { x: 1, z: 0 });
});

test('стена поперёк трассы разворачивает по Z', () => {
  const normal = wallBounceNormalAt(
    [thinZ],
    near(thinZ),
    near(thinZ, { z: 2 }),
    { x: 0, y: 0, z: -6 },
    PLAYER_BODY_RADIUS
  );
  assert.deepEqual(normal, { x: 0, z: 1 });
});

test('слишком медленный подход к стене отскока не даёт', () => {
  const slow = wallBounceNormalAt(
    [thinX],
    near(thinX),
    near(thinX, { x: 2 }),
    { x: -1.4, y: 0, z: 0 },
    PLAYER_BODY_RADIUS
  );
  assert.equal(slow, null, 'приём требует осмысленной скорости в стену, а не касания');
});

test('стена не ловит того, кто пролетает заметно выше или ниже', () => {
  const high = wallBounceNormalAt(
    [thinX],
    near(thinX, { y: thinX.y + thinX.h / 2 + 1 }),
    near(thinX, { x: 2, y: thinX.y + thinX.h / 2 + 1 }),
    { x: -6, y: 0, z: 0 },
    PLAYER_BODY_RADIUS
  );
  assert.equal(high, null);
});

test('без стен и без списка отскока не бывает', () => {
  assert.equal(wallBounceNormalAt([], near(thinX), near(thinX), { x: -6, y: 0, z: 0 }), null);
  assert.equal(wallBounceNormalAt(null, near(thinX), near(thinX), { x: -6, y: 0, z: 0 }), null);
});

test('отскок возвращает игрока к позиции до шага и разворачивает скорость', () => {
  const state = createPlayerSimulationState({
    position: { x: -0.2, y: 1, z: 3 },
    velocity: { x: -6, y: -2, z: 4 },
    jumpBuffer: 0.1,
    diveTimer: 0.3,
    rollTimer: 0.2,
    recoveryWindow: 0.1
  });
  const previous = { x: 0.6, y: 1, z: 3 };
  const { bounced } = applyWallBounce(state, { x: 1, z: 0 }, previous, { jumpSpeed: 8.7 });

  assert.equal(bounced, true);
  assert.equal(state.position.x, previous.x, 'по оси стены игрок возвращается к позиции до шага');
  assert.equal(state.position.z, 3, 'вдоль стены позиция не трогается');
  assert.equal(state.velocity.x, WALL_BOUNCE_SPEED, 'по нормали задаётся скорость приёма');
  assert.ok(state.velocity.y >= 8.7 * 0.82, 'отскок подбрасывает');
  // Приём не гасит темп вдоль стены, а разворачивает: часть скорости сохраняется.
  assert.ok(Math.abs(state.velocity.z) > 0 && Math.abs(state.velocity.z) < 4);
  assert.equal(state.jumpBuffer, 0);
  assert.equal(state.diveTimer, 0);
  assert.equal(state.rollTimer, 0);
  assert.equal(state.recoveryWindow, 0);
});

test('без нормали состояние не меняется вовсе', () => {
  const state = createPlayerSimulationState({ position: { x: 1, y: 1, z: 1 }, jumpBuffer: 0.1 });
  const before = JSON.stringify(state);
  const result = applyWallBounce(state, null, { x: 5, y: 1, z: 5 });
  assert.equal(result.bounced, false);
  assert.equal(JSON.stringify(state), before);
});
