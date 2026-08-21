import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
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
