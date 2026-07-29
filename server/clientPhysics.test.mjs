import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { Effects } from '../client/game/Effects.js';
import { Player } from '../client/game/Player.js';
import { CameraController } from '../client/game/CameraController.js';

const idleInput = () => ({ movement: () => ({ x: 0, forward: 0, magnitude: 0 }), consume: () => false });

test('procedural course is deterministic for a shared seed', () => {
  const a = new Course(new THREE.Scene(), courseSpec(123456, 'normal'), { quality: 'low' }),
    b = new Course(new THREE.Scene(), courseSpec(123456, 'normal'), { quality: 'low' });
  assert.deepEqual(a.stageNames, b.stageNames);
  assert.equal(a.spec.checkpoints.length, 6);
  assert.equal(a.stageNames.at(-1), 'VICTORY GATE');
  a.dispose();
  b.dispose();
});

test('player settles on a platform, runs camera-relative, and jumps with buffering', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    course = new Course(scene, courseSpec(99, 'easy'), { quality: 'low' }),
    player = new Player(scene, course, effects);
  const idle = idleInput();
  for (let i = 0; i < 40; i++) {
    course.update(0.016, i * 0.016);
    player.update(0.016, idle, 0, i * 0.016);
  }
  assert.equal(player.grounded, true);
  const startZ = player.position.z,
    forward = { movement: () => ({ x: 0, forward: 1, magnitude: 1 }), consume: () => false };
  for (let i = 0; i < 35; i++) {
    course.update(0.016, 0.7 + i * 0.016);
    player.update(0.016, forward, 0, 0.7 + i * 0.016);
  }
  assert.ok(player.position.z < startZ - 1.5);
  let jump = true;
  const jumping = {
    movement: () => ({ x: 0, forward: 0, magnitude: 0 }),
    consume: action => (action === 'jump' && jump ? ((jump = false), true) : false)
  };
  player.update(0.016, jumping, 0, 1.4);
  assert.ok(player.velocity.y > 7);
  player.dispose();
  course.dispose();
});

test('camera orbit and recenter math stays finite without a renderer', () => {
  const scene = new THREE.Scene(),
    effects = new Effects(scene, 'low'),
    course = new Course(scene, courseSpec(7, 'easy'), { quality: 'low' }),
    player = new Player(scene, course, effects),
    camera = new THREE.PerspectiveCamera(),
    controller = new CameraController(camera);
  const input = { consumeCamera: () => ({ x: 42, y: -18 }), consume: () => false };
  controller.update(0.016, player, input, course);
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.ok(Number.isFinite(controller.yaw));
  player.dispose();
  course.dispose();
});
