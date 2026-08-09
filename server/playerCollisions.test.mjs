import test from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlayerCrowd, PLAYER_RADIUS } from '../client/game/PlayerCollisions.js';

const actor = (x, z, extra = {}) => ({
  position: { x, y: 1, z },
  velocity: { x: 0, y: 0, z: 0 },
  finished: false,
  downed: false,
  ...extra
});

test('soft crowd collision separates overlapping racers without moving the remote', () => {
  const local = actor(0, 0);
  const remote = actor(PLAYER_RADIUS, 0);
  const before = { ...remote.position };
  assert.equal(resolvePlayerCrowd(local, [remote], 1 / 60), 1);
  assert.ok(local.position.x < 0);
  assert.deepEqual(remote.position, before);
});

test('crowd collision ignores other floors and finished racers', () => {
  const local = actor(0, 0);
  assert.equal(resolvePlayerCrowd(local, [actor(0, 0, { position: { x: 0, y: 4, z: 0 } })], 1 / 60), 0);
  assert.equal(resolvePlayerCrowd(local, [actor(0, 0, { finished: true })], 1 / 60), 0);
});

test('crowd impulse transfer is deliberately small', () => {
  const local = actor(0, 0);
  const remote = actor(-0.5, 0, { velocity: { x: 10, y: 0, z: 0 } });
  resolvePlayerCrowd(local, [remote], 1 / 60);
  assert.ok(local.velocity.x > 0);
  assert.ok(local.velocity.x < remote.velocity.x / 4);
});

test('crowd uses interpolated remote velocity and caps a dense pack displacement', () => {
  const local = actor(0, 0);
  const pack = Array.from({ length: 12 }, (_, index) =>
    actor(-0.2, index * 0.01, { target: { vx: 8, vz: 0 } })
  );
  resolvePlayerCrowd(local, pack, 1 / 30);
  assert.ok(local.velocity.x > 0, 'скорость читается из сетевого target');
  assert.ok(Math.hypot(local.position.x, local.position.z) <= 0.0551, 'толпа не телепортирует за шаг');
});
