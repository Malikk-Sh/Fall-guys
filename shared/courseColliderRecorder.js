// Безголовый билдер трассы.
//
// Отвечает на те же вызовы, что и клиентский CourseBuilder, но вместо мешей записывает плоские
// опоры и препятствия. Благодаря этому сервер строит ту же геометрию тем же кодом расстановки —
// второй, расходящейся модели трассы в проекте не появляется.
//
// Декорации отвечают заглушкой: расстановке случается подкрутить масштаб или поворот декоративного
// куска, и это не должно падать только оттого, что сцены нет.

import { seededRandom } from './courseSpec.js';
import { addBumper, addRail, addSpinner, addSpring } from './courseObstacles.js';
import { buildRaceGeometry } from './raceCourseGeometry.js';

function decorStub(x = 0, y = 0, z = 0) {
  return {
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1, set() {}, setScalar() {} }
  };
}

export function createCourseColliderRecorder({ rng = () => 0 } = {}) {
  const platforms = [];
  const obstacles = [];
  const dynamic = [];
  const stageNames = [];
  let nextObstacleId = 0;

  function support(record) {
    platforms.push(record);
    return record;
  }

  const recorder = {
    platforms,
    obstacles,
    dynamic,
    stageNames,
    // Билдер клиента держит эти списки ради отрисовки и камеры; здесь они существуют лишь для того,
    // чтобы расстановка могла в них писать, не зная, кто её исполняет.
    cameraMeshes: [],
    skillWalls: [],
    rng,

    box({ x = 0, y = 0, z = 0, w = 1, h = 1, d = 1, collider = true } = {}) {
      const mesh = decorStub(x, y, z);
      if (!collider) return { mesh, w, h, d, type: 'decor' };
      return support({
        mesh,
        x,
        y,
        z,
        w,
        h,
        d,
        r: 0,
        type: 'box',
        disabled: false,
        delta: { x: 0, y: 0, z: 0 }
      });
    },

    cylinder({ x = 0, y = 0, z = 0, r = 1, h = 0.5, collider = false } = {}) {
      const mesh = decorStub(x, y, z);
      if (!collider) return mesh;
      return support({
        mesh,
        x,
        y,
        z,
        w: r * 1.7,
        h,
        d: r * 1.7,
        r,
        type: 'cylinder',
        disabled: false,
        delta: { x: 0, y: 0, z: 0 }
      });
    },

    spinnerBeam({ x = 0, y = 0, z = 0 } = {}) {
      return decorStub(x, y, z);
    },

    ringDecor({ x = 0, y = 0, z = 0 } = {}) {
      return decorStub(x, y, z);
    },

    // Расстановка зовёт эти примитивы по именам, как у клиентского билдера. Тела общие, поэтому
    // безголовая сборка получает те же препятствия, а не их пересказ.
    addRail(x, z, length) {
      addRail(recorder, x, z, length);
    },
    addSpinner(x, y, z, length, width, speed, phase) {
      addSpinner(recorder, x, y, z, length, width, speed, phase);
    },
    addBumper(x, y, z, radius, color) {
      addBumper(recorder, x, y, z, radius, color);
    },
    addSpring(x, y, z, radius) {
      addSpring(recorder, x, y, z, radius);
    },

    registerObstacle(record) {
      const obstacle = { id: `obstacle-${nextObstacleId++}`, ...record };
      obstacles.push(obstacle);
      return obstacle;
    },

    stageName(name) {
      stageNames.push(name);
    }
  };
  return recorder;
}

// Опоры и препятствия трассы по её спецификации — без Three.js и без сцены.
export function recordRaceCourse(spec) {
  const recorder = createCourseColliderRecorder({ rng: seededRandom(spec.seed) });
  buildRaceGeometry(recorder, spec);
  return recorder;
}
