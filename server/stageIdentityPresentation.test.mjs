import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { FIRST_SEGMENT_CENTER, SEGMENT_LENGTH } from '../shared/courseSpec.js';

const platformRecord = platform => ({
  type: platform.type,
  x: platform.x,
  y: platform.y,
  z: platform.z,
  w: platform.w,
  h: platform.h,
  d: platform.d,
  r: platform.r,
  disabled: platform.disabled
});

const obstacleRecord = obstacle => ({
  type: obstacle.type,
  x: obstacle.x,
  y: obstacle.y,
  z: obstacle.z,
  radius: obstacle.radius,
  length: obstacle.length,
  width: obstacle.width,
  range: obstacle.range,
  speed: obstacle.speed,
  phase: obstacle.phase
});

test('stage landmarks читают planner, не меняя gameplay records', () => {
  class BareCourse extends Course {
    addStageIdentity() {}
  }

  const spec = courseSpec(20260821, 'chaos');
  const bare = new BareCourse(new THREE.Scene(), spec, { quality: 'high' });
  const high = new Course(new THREE.Scene(), spec, { quality: 'high' });
  const low = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    assert.deepEqual(high.platforms.map(platformRecord), bare.platforms.map(platformRecord));
    assert.deepEqual(high.obstacles.map(obstacleRecord), bare.obstacles.map(obstacleRecord));
    assert.equal(high.dynamic.length, bare.dynamic.length);
    assert.equal(high.cameraMeshes.length, bare.cameraMeshes.length);

    assert.equal(high.stageIdentity.length, spec.segments.length);
    assert.equal(low.stageIdentity.length, spec.segments.length);
    for (let index = 0; index < spec.segments.length; index++) {
      const type = spec.segments[index].type;
      const highLandmark = high.stageIdentity[index];
      const lowLandmark = low.stageIdentity[index];
      const expectedZ = FIRST_SEGMENT_CENTER - index * SEGMENT_LENGTH;

      assert.equal(highLandmark.userData.sceneryOnly, true);
      assert.equal(lowLandmark.userData.sceneryOnly, true);
      assert.equal(highLandmark.userData.stageType, type);
      assert.equal(lowLandmark.userData.stageType, type);
      assert.equal(highLandmark.position.z, expectedZ);
      assert.equal(lowLandmark.position.z, expectedZ);
      assert.ok(Math.abs(highLandmark.position.x) > 6, 'landmark должен оставаться вне игровой полосы');
      assert.ok(highLandmark.children.length > lowLandmark.children.length, 'low должен убирать type icon');
      assert.ok(high.group.getObjectByName(`stage-landmark-${index}-${type}`));

      const highMast = highLandmark.getObjectByName(`stage-landmark-mast-${index}`);
      const lowMast = lowLandmark.getObjectByName(`stage-landmark-mast-${index}`);
      const highBeacon = highLandmark.getObjectByName(`stage-landmark-beacon-${index}`);
      const lowBeacon = lowLandmark.getObjectByName(`stage-landmark-beacon-${index}`);
      assert.deepEqual(highMast.geometry.parameters, lowMast.geometry.parameters);
      assert.deepEqual(highBeacon.geometry.parameters, lowBeacon.geometry.parameters);

      const icon = highLandmark.getObjectByName(`stage-landmark-icon-${index}`);
      assert.ok(icon, 'high quality должен иметь type icon');
      assert.equal(icon.rotation.y, 0, 'иконка должна смотреть вдоль направления подхода, а не ребром');
      assert.equal(lowLandmark.getObjectByName(`stage-landmark-icon-${index}`), undefined);
    }
  } finally {
    bare.dispose();
    high.dispose();
    low.dispose();
  }
});
