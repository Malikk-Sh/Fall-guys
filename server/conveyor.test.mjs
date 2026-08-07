import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import '../client/game/ConveyorMotion.js';
import { CoopCourse } from '../client/game/CoopCourse.js';
import { coopSpec } from '../shared/coopChapters.js';

const EPSILON = 1e-9;

function playerAt(zone, { grounded = true } = {}) {
  return {
    position: new THREE.Vector3(0, grounded ? 1.48 : 3, (zone.zMin + zone.zMax) / 2),
    velocity: new THREE.Vector3(),
    grounded,
    intentX: 0,
    hitTimes: new Map(),
    impact: 0,
    respawn() {
      assert.fail('конвейер не должен сам сбрасывать игрока');
    }
  };
}

test('конвейер переносит стоящего игрока с заданной скоростью, не разгоняя velocity', () => {
  const course = new CoopCourse(new THREE.Scene(), coopSpec('ch2'), { quality: 'low' });
  const zone = course.conveyors[0];
  assert.ok(zone, 'во второй главе должен быть конвейер');

  const player = playerAt(zone);
  const startZ = player.position.z;
  course.interact(player, 0, { burst() {} }, null);

  assert.ok(
    Math.abs(player.position.z - (startZ + zone.force / 60)) < EPSILON,
    `лента должна сдвинуть на ${zone.force / 60}, получено ${player.position.z - startZ}`
  );
  assert.ok(
    Math.abs(player.velocity.z) < EPSILON,
    'лента не должна оставлять импульс, который гасит управление'
  );
  course.dispose();
});

test('конвейер не действует на игрока в прыжке', () => {
  const course = new CoopCourse(new THREE.Scene(), coopSpec('ch2'), { quality: 'low' });
  const zone = course.conveyors[0];
  assert.ok(zone, 'во второй главе должен быть конвейер');

  const player = playerAt(zone, { grounded: false });
  const startZ = player.position.z;
  course.interact(player, 0, { burst() {} }, null);

  assert.equal(player.position.z, startZ);
  assert.equal(player.velocity.z, 0);
  course.dispose();
});
