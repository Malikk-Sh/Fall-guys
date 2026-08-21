import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { recordRaceCourse } from '../shared/courseColliderRecorder.js';
import { supportIndexAt, supportTop } from '../shared/courseCollision.js';
import { PLAYER_FOOT } from '../client/game/PlayerDimensions.js';

// Здесь и проверяется весь смысл этапа: безголовая запись обязана совпасть с настоящей трассой,
// построенной со сценой. Совпадение по числам — единственное доказательство, что вторая модель
// трассы не появилась; расхождение означает, что сервер и клиент увидят разный пол.
const SPECS = [
  courseSpec(1, 'easy'),
  courseSpec(4242, 'normal'),
  courseSpec(20260821, 'chaos'),
  courseSpec(777, 'chaos'),
  courseSpec(0xffffffff, 'normal')
];

function platformShape(platform) {
  return {
    type: platform.type,
    x: platform.x,
    y: platform.y,
    z: platform.z,
    w: platform.w,
    h: platform.h,
    d: platform.d,
    r: platform.r || 0,
    disabled: platform.disabled === true
  };
}

// Идентификатор в сравнение не входит осознанно. Он нужен только как ключ локальной перезарядки
// удара и по сети не ходит; у клиента счётчик живёт на весь процесс, поэтому его значение зависит
// от того, сколько трасс построили раньше. Паритет — это геометрия и фазы, а не строки ключей.
function obstacleShape(obstacle) {
  return {
    type: obstacle.type,
    x: obstacle.x,
    y: obstacle.y,
    z: obstacle.z,
    radius: obstacle.radius ?? null,
    length: obstacle.length ?? null,
    width: obstacle.width ?? null,
    speed: obstacle.speed ?? null,
    phase: obstacle.phase ?? null,
    originX: obstacle.originX ?? null,
    range: obstacle.range ?? null,
    w: obstacle.w ?? null,
    d: obstacle.d ?? null
  };
}

function withCourse(spec, run) {
  const course = new Course(new THREE.Scene(), spec, { quality: 'low' });
  try {
    return run(course);
  } finally {
    course.dispose();
  }
}

test('безголовая запись даёт те же опоры, что и построенная со сценой трасса', () => {
  for (const spec of SPECS) {
    const recorded = recordRaceCourse(spec);
    const built = withCourse(spec, course => course.platforms.map(platformShape));
    assert.ok(built.length > 0);
    assert.deepEqual(
      recorded.platforms.map(platformShape),
      built,
      `опоры разошлись на seed ${spec.seed} / ${spec.difficulty}`
    );
  }
});

test('безголовая запись даёт те же препятствия с теми же фазами', () => {
  for (const spec of SPECS) {
    const recorded = recordRaceCourse(spec);
    const built = withCourse(spec, course => course.obstacles.map(obstacleShape));
    assert.ok(built.length > 0);
    // Фаза приходит из сидированного генератора, поэтому совпадение фаз доказывает и то, что
    // порядок обращений к нему воспроизведён: бампер и пружина забирают по значению каждый.
    assert.deepEqual(
      recorded.obstacles.map(obstacleShape),
      built,
      `препятствия разошлись на seed ${spec.seed} / ${spec.difficulty}`
    );
  }
});

test('безголовая запись повторяется и не зависит от порядка вызовов', () => {
  const spec = SPECS[2];
  const first = recordRaceCourse(spec).platforms.map(platformShape);
  recordRaceCourse(SPECS[0]);
  const second = recordRaceCourse(spec).platforms.map(platformShape);
  assert.deepEqual(first, second);
});

test('по безголовой записи находится пол там же, где его находит клиент', () => {
  const spec = SPECS[1];
  const recorded = recordRaceCourse(spec);
  withCourse(spec, course => {
    for (let index = 0; index < course.platforms.length; index += 3) {
      const platform = course.platforms[index];
      const y = supportTop(platform) + PLAYER_FOOT;
      const probe = { x: platform.x, y, z: platform.z };
      const clientIndex = supportIndexAt(course.platforms, probe, y, 0, PLAYER_FOOT);
      const serverIndex = supportIndexAt(recorded.platforms, probe, y, 0, PLAYER_FOOT);
      assert.equal(serverIndex, clientIndex, `над опорой ${index} найден разный пол`);
      if (clientIndex < 0) continue;
      assert.equal(supportTop(recorded.platforms[serverIndex]), supportTop(course.platforms[clientIndex]));
    }
  });
});

test('этапы трассы называются одинаково у обеих сборок', () => {
  for (const spec of SPECS) {
    const recorded = recordRaceCourse(spec);
    const built = withCourse(spec, course => [...course.stageNames]);
    assert.deepEqual(recorded.stageNames, built, `названия этапов разошлись на seed ${spec.seed}`);
  }
});
