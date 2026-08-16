import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Course } from '../client/game/Course.js';
import { PLAYER_OBSTACLE_RADIUS } from '../client/game/PlayerDimensions.js';
import { FIRST_SEGMENT_CENTER, SEGMENT_LENGTH, SEGMENT_WIDTH } from '../shared/courseSpec.js';

const specFor = (type, variant) => ({
  seed: 41,
  difficulty: 'normal',
  segmentCount: 1,
  segments: [{ type, role: 'skill', variant }],
  checkpoints: [-SEGMENT_LENGTH],
  finishZ: -SEGMENT_LENGTH - 13,
  start: { x: 0, y: 1.2, z: 7 }
});

test('увеличенные бамперы не слипаются и сохраняют безопасный край', () => {
  for (let variant = 0; variant < 5; variant++) {
    const course = new Course(new THREE.Scene(), specFor('bumpers', variant), { quality: 'low' });
    const bumpers = course.obstacles.filter(item => item.type === 'bumper');
    const half = SEGMENT_WIDTH.bumpers / 2;
    for (const bumper of bumpers) {
      const x = Math.abs(bumper.mesh.position.x);
      assert.ok(
        x + bumper.radius + PLAYER_OBSTACLE_RADIUS <= half - 0.2,
        `variant ${variant}: bumper слишком близко к краю`
      );
      const localZ = Math.abs(bumper.mesh.position.z - FIRST_SEGMENT_CENTER);
      assert.ok(
        localZ + bumper.radius + PLAYER_OBSTACLE_RADIUS <= SEGMENT_LENGTH / 2 - 0.15,
        `variant ${variant}: bumper перекрывает вход/выход сегмента`
      );
    }
    for (let i = 0; i < bumpers.length; i++) {
      for (let j = i + 1; j < bumpers.length; j++) {
        const a = bumpers[i];
        const b = bumpers[j];
        const distance = Math.hypot(
          a.mesh.position.x - b.mesh.position.x,
          a.mesh.position.z - b.mesh.position.z
        );
        assert.ok(
          distance >= a.radius + b.radius + 0.2,
          `variant ${variant}: бамперы ${i}/${j} визуально слипаются`
        );
      }
    }
    course.dispose();
  }
});

test('основные опасности действительно стали массивнее', () => {
  const sweepers = new Course(new THREE.Scene(), specFor('sweepers', 0), { quality: 'low' });
  assert.ok(sweepers.obstacles.find(item => item.type === 'spinner').width > 0.42);
  sweepers.dispose();

  const punchers = new Course(new THREE.Scene(), specFor('punchers', 0), { quality: 'low' });
  assert.ok(punchers.obstacles.find(item => item.type === 'puncher').w > 2.7);
  assert.ok(punchers.obstacles.find(item => item.type === 'puncher').d > 1.2);
  punchers.dispose();
});
