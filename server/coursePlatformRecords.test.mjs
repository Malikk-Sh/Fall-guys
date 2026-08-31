import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { CoopCourse } from '../client/game/CoopCourse.js';
import { coopSpec } from '../shared/coopChapters.js';
import { supportIndexAt, supportTop } from '../shared/courseCollision.js';
import { PLAYER_FOOT } from '../client/game/PlayerDimensions.js';

// Опора — плоская запись, меш её повторяет. Пока это верно, серверная симуляция сможет спросить
// про пол по тем же числам, не строя сцену. Если хоть одна опора начнёт двигаться мимо записи,
// физика клиента и сервера разъедутся молча, поэтому проверка идёт по всем платформам сразу.
function assertRecordsMatchMeshes(course, when) {
  for (const platform of course.platforms) {
    const mesh = platform.mesh.position;
    assert.equal(platform.x, mesh.x, `x опоры разошёлся с мешем ${when}`);
    assert.equal(platform.y, mesh.y, `y опоры разошёлся с мешем ${when}`);
    assert.equal(platform.z, mesh.z, `z опоры разошёлся с мешем ${when}`);
  }
}

function platformRecord(platform) {
  return {
    type: platform.type,
    x: platform.x,
    y: platform.y,
    z: platform.z,
    w: platform.w,
    h: platform.h,
    d: platform.d,
    r: platform.r,
    disabled: platform.disabled
  };
}

function obstacleRecord(obstacle) {
  return {
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
  };
}

test('каждая опора гоночной трассы описана числами, а не только мешем', () => {
  const course = new Course(new THREE.Scene(), courseSpec(20260821, 'chaos'), { quality: 'low' });
  try {
    assert.ok(course.platforms.length > 0);
    for (const platform of course.platforms) {
      assert.ok(platform.type === 'box' || platform.type === 'cylinder');
      assert.ok(Number.isFinite(platform.x));
      assert.ok(Number.isFinite(platform.y));
      assert.ok(Number.isFinite(platform.z));
      assert.ok(platform.w > 0 && platform.h > 0 && platform.d > 0);
      assert.equal(platform.disabled, false);
      if (platform.type === 'cylinder') assert.ok(platform.r > 0);
    }
    assertRecordsMatchMeshes(course, 'сразу после постройки');
  } finally {
    course.dispose();
  }
});

test('скруглённый visual mesh не меняет box collision и имеет дешёвый low-quality fallback', () => {
  const spec = courseSpec(20260821, 'easy');
  const high = new Course(new THREE.Scene(), spec, { quality: 'high' });
  const low = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    const highStart = high.platforms[0];
    const lowStart = low.platforms[0];

    assert.equal(highStart.type, 'box');
    assert.equal(lowStart.type, 'box');
    assert.deepEqual(
      [highStart.x, highStart.y, highStart.z, highStart.w, highStart.h, highStart.d],
      [lowStart.x, lowStart.y, lowStart.z, lowStart.w, lowStart.h, lowStart.d]
    );
    assert.ok(
      highStart.mesh.geometry instanceof RoundedBoxGeometry,
      'high quality должен скруглять visual mesh'
    );
    assert.equal(
      lowStart.mesh.geometry instanceof RoundedBoxGeometry,
      false,
      'low quality должен оставаться на дешёвой BoxGeometry'
    );
    assert.equal(highStart.mesh.material.roughness, 0.48);
    assert.equal(highStart.mesh.material.metalness, 0.02);
    assertRecordsMatchMeshes(high, 'со скруглённым high-quality mesh');
    assertRecordsMatchMeshes(low, 'с low-quality fallback');
  } finally {
    high.dispose();
    low.dispose();
  }
});

test('sky playground scenery остаётся presentation-only и сохраняет low-quality budget', () => {
  class BareCourse extends Course {
    addScenery() {}
  }

  const spec = courseSpec(20260821, 'normal');
  const bare = new BareCourse(new THREE.Scene(), spec, { quality: 'high' });
  const high = new Course(new THREE.Scene(), spec, { quality: 'high' });
  const low = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    assert.deepEqual(high.platforms.map(platformRecord), bare.platforms.map(platformRecord));
    assert.deepEqual(high.obstacles.map(obstacleRecord), bare.obstacles.map(obstacleRecord));
    assert.equal(high.dynamic.length, bare.dynamic.length);
    assert.equal(high.cameraMeshes.length, bare.cameraMeshes.length);

    assert.ok(high.scenery.length > low.scenery.length, 'high quality должен иметь более богатый scenery');
    assert.ok(high.group.getObjectByName('scenery-island-0'), 'high quality должен иметь floating island');
    assert.ok(low.group.getObjectByName('scenery-island-0'), 'low quality сохраняет дешёвый floating island');
    assert.ok(high.group.getObjectByName('course-landmark-1'), 'трасса должна иметь промежуточный landmark');
    assert.ok(high.group.getObjectByName('finish-landmark'), 'финиш должен быть видимым издалека landmark');
    assert.ok(low.group.getObjectByName('finish-landmark'), 'финишный landmark не исчезает на low quality');
  } finally {
    bare.dispose();
    high.dispose();
    low.dispose();
  }
});

test('moving-platform cues остаются presentation-only и имеют дешёвый low-quality вариант', () => {
  class BareCourse extends Course {
    addMovingPlatformTelegraphs() {}
  }

  const spec = courseSpec(777, 'chaos');
  const bare = new BareCourse(new THREE.Scene(), spec, { quality: 'high' });
  const high = new Course(new THREE.Scene(), spec, { quality: 'high' });
  const low = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    assert.ok(high.dynamic.length > 0, 'seed должен содержать moving platforms');
    assert.deepEqual(high.platforms.map(platformRecord), bare.platforms.map(platformRecord));
    assert.deepEqual(high.obstacles.map(obstacleRecord), bare.obstacles.map(obstacleRecord));
    assert.equal(high.dynamic.length, bare.dynamic.length);
    assert.equal(high.cameraMeshes.length, bare.cameraMeshes.length);
    assert.equal(high.movingPlatformTelegraphs.length, high.dynamic.length);
    assert.equal(low.movingPlatformTelegraphs.length, low.dynamic.length);

    for (let index = 0; index < high.dynamic.length; index++) {
      const highCue = high.movingPlatformTelegraphs[index];
      const lowCue = low.movingPlatformTelegraphs[index];
      assert.equal(highCue.parent, high.dynamic[index].mesh);
      assert.equal(lowCue.parent, low.dynamic[index].mesh);
      assert.equal(highCue.userData.motionAxis, high.dynamic[index].motion.axis);
      assert.equal(lowCue.userData.motionAxis, low.dynamic[index].motion.axis);
      assert.ok(highCue.children.length > lowCue.children.length);
    }

    high.update(1 / 60, 2.4);
    for (let index = 0; index < high.dynamic.length; index++) {
      assert.equal(high.movingPlatformTelegraphs[index].parent, high.dynamic[index].mesh);
    }
    assertRecordsMatchMeshes(high, 'после движения с presentation cue');
  } finally {
    bare.dispose();
    high.dispose();
    low.dispose();
  }
});

test('подвижные опоры сдвигают запись и меш вместе на всём ходе', () => {
  const course = new Course(new THREE.Scene(), courseSpec(4242, 'normal'), { quality: 'low' });
  try {
    for (let step = 0; step < 240; step++) {
      course.update(1 / 60, step / 60);
      assertRecordsMatchMeshes(course, `на шаге ${step}`);
    }
  } finally {
    course.dispose();
  }
});

test('ход подвижной опоры считается от данных, а не от истории', () => {
  const spec = courseSpec(777, 'chaos');
  const first = new Course(new THREE.Scene(), spec, { quality: 'low' });
  const second = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    assert.ok(first.dynamic.length > 0, 'на этой трассе обязаны быть подвижные опоры');
    // Первую трассу прогоняем по шагам, вторую переносим в тот же момент одним вызовом.
    for (let step = 0; step <= 180; step++) first.update(1 / 60, step / 60);
    second.update(1 / 60, 180 / 60);
    for (let index = 0; index < first.dynamic.length; index++) {
      const axis = first.dynamic[index].motion.axis;
      assert.equal(first.dynamic[index][axis], second.dynamic[index][axis]);
    }
  } finally {
    first.dispose();
    second.dispose();
  }
});

test('общая проверка опоры находит пол по записям стартовой площадки', () => {
  const course = new Course(new THREE.Scene(), courseSpec(2024, 'easy'), { quality: 'low' });
  try {
    const start = course.platforms[0];
    const y = supportTop(start) + PLAYER_FOOT;
    const index = supportIndexAt(course.platforms, { x: start.x, y, z: start.z }, y, 0, PLAYER_FOOT);
    assert.ok(index >= 0, 'на стартовой площадке обязан быть пол');
    assert.equal(supportTop(course.platforms[index]), supportTop(start));

    const surface = course.surfaceAt({ x: start.x, y, z: start.z }, y, 0);
    assert.ok(surface);
    assert.equal(surface.y, supportTop(start));
  } finally {
    course.dispose();
  }
});

test('каждое препятствие описано числами и опознаётся без меша', () => {
  const course = new Course(new THREE.Scene(), courseSpec(20260821, 'chaos'), { quality: 'low' });
  try {
    assert.ok(course.obstacles.length > 0);
    const ids = new Set();
    for (const obstacle of course.obstacles) {
      assert.ok(['spinner', 'bumper', 'spring', 'puncher'].includes(obstacle.type));
      assert.equal(typeof obstacle.id, 'string');
      assert.equal(ids.has(obstacle.id), false, 'перезарядка удара держится на уникальном ключе');
      ids.add(obstacle.id);
      assert.ok(Number.isFinite(obstacle.x));
      assert.ok(Number.isFinite(obstacle.y));
      assert.ok(Number.isFinite(obstacle.z));
      assert.ok(Number.isFinite(obstacle.radius) || Number.isFinite(obstacle.length));
    }
  } finally {
    course.dispose();
  }
});

test('молот и вертушка живут по данным, а меш лишь повторяет их', () => {
  const course = new Course(new THREE.Scene(), courseSpec(31337, 'chaos'), { quality: 'low' });
  try {
    for (let step = 0; step < 180; step++) {
      const elapsed = step / 60;
      course.update(1 / 60, elapsed);
      for (const obstacle of course.obstacles) {
        if (obstacle.type === 'puncher') {
          assert.equal(obstacle.x, obstacle.mesh.position.x, `молот разошёлся с мешем на шаге ${step}`);
          assert.equal(
            obstacle.x,
            obstacle.originX + Math.sin(elapsed * obstacle.speed + obstacle.phase) * obstacle.range
          );
        }
        if (obstacle.type === 'spinner') {
          assert.equal(obstacle.angle, elapsed * obstacle.speed + obstacle.phase);
          assert.equal(obstacle.mesh.rotation.y, obstacle.angle);
        }
      }
    }
  } finally {
    course.dispose();
  }
});

test('осыпающаяся плитка кооператива дрожит, падает и возвращается вместе со своей записью', () => {
  const course = new CoopCourse(new THREE.Scene(), coopSpec('ch4'), { quality: 'low' });
  try {
    assert.ok(course.tiles.length > 0, 'глава обязана содержать осыпающиеся плитки');
    assertRecordsMatchMeshes(course, 'сразу после постройки главы');

    // Обычно таймер заводит касание игрока. Здесь он заводится напрямую: проверяется не механика
    // обрушения, а то, что запись опоры не отстаёт от меша ни в дрожании, ни в падении.
    const tile = course.tiles[0];
    tile.timer = tile.delay;
    let shook = false;
    let fell = false;
    for (let step = 0; step < 900; step++) {
      course.update(1 / 60, step / 60);
      assertRecordsMatchMeshes(course, `на шаге главы ${step}`);
      if (!tile.fallen && tile.timer > 0 && tile.platform.y !== tile.baseY) shook = true;
      if (tile.platform.disabled) fell = true;
    }
    assert.ok(shook, 'плитка обязана дрожать перед обрушением');
    assert.ok(fell, 'плитка обязана обрушиться');
    assert.equal(tile.platform.disabled, false, 'и вернуться, иначе второй игрок остался бы без пола');
  } finally {
    course.dispose();
  }
});
