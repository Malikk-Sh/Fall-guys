// Геометрия гоночной трассы: стартовая площадка, сегменты и финишный выкат.
//
// Это единственное описание трассы в проекте. Клиент строит по нему меши, безголовый билдер — те же
// опоры и препятствия без сцены. Порядок вызовов значим: он задаёт и порядок опор, и порядок
// обращений к сидированному генератору, поэтому переставлять их нельзя даже ради читаемости.

import { buildSegment } from './courseSegments.js';
import { addRail } from './courseObstacles.js';
import { COLORS, COURSE_PALETTE } from './palette.js';
import {
  DIFFICULTY_OBSTACLE_SPEED,
  FIRST_SEGMENT_CENTER,
  SEGMENT_LENGTH,
  SEGMENT_WIDTH,
  START_PLATFORM,
  safeDifficulty
} from './courseSpec.js';

const STAGE_NAMES = Object.freeze({
  sweepers: 'ПЛОЩАДЬ ВРАЩЕНИЯ',
  movers: 'НЕБЕСНЫЕ СТУПЕНИ',
  bumpers: 'БУЛЬВАР БАМПЕРОВ',
  bridge: 'УЗКИЙ ПОВОРОТ',
  punchers: 'ПАРАД МОЛОТОВ',
  bounce: 'САД ПРЫЖКОВ',
  crosswind: 'ДОРОГА ВЕТРОВ'
});

export function addStart(course) {
  course.box({
    x: 0,
    y: 0,
    z: START_PLATFORM.z,
    w: START_PLATFORM.width,
    h: 1,
    d: START_PLATFORM.depth,
    color: COLORS.purple,
    bevel: true
  });
  for (const x of [-6.4, 6.4]) addRail(course, x, 5, 12);
  course.box({
    x: 0,
    y: 0.515,
    z: -0.8,
    w: 13,
    h: 0.035,
    d: 0.85,
    color: COLORS.yellow,
    collider: false,
    emissive: COLORS.yellow,
    emissiveIntensity: 1.1
  });
  for (let i = 0; i < 6; i++) {
    const pad = course.cylinder({
      x: -4.5 + i * 1.8,
      y: 0.57,
      z: 7.4,
      r: 0.62,
      h: 0.13,
      color: [COLORS.pink, COLORS.cyan, COLORS.yellow][i % 3]
    });
    pad.scale.z = 0.68;
  }
}

export function addSegment(course, spec, segment, index, z) {
  const { type, variant = 0 } = segment;
  const color = COURSE_PALETTE[(index + spec.seed) % COURSE_PALETTE.length],
    // Направление входит множителем в ту же скорость, что и темп: отрицательная скорость
    // разворачивает и вращение вертушек, и качание молотов, и ход подвижных платформ — то есть
    // ровно всё, что от неё зависит, без отдельной ветки на каждый тип препятствия.
    speed =
      DIFFICULTY_OBSTACLE_SPEED[safeDifficulty(spec.difficulty)] *
      (spec.modifier?.obstacleSpeed || 1) *
      (spec.modifier?.obstacleDirection || 1);
  course.stageName(STAGE_NAMES[type]);
  // Сама расстановка живёт в shared/courseSegments.js: там у каждого типа несколько структурно разных
  // вариантов, и добавление нового не требует трогать ни Course, ни генератор плана.
  //
  // Зеркало оставлено как множитель для тех вариантов, где оно осмысленно: несимметричную
  // расстановку оно честно отражает, а симметричную не трогает.
  buildSegment(course, type, variant, {
    z,
    index,
    speed,
    color,
    palette: COURSE_PALETTE,
    rng: course.rng,
    width: SEGMENT_WIDTH[type],
    mirror: variant % 2 === 1 ? -1 : 1
  });
  const endZ = -18 * (index + 1);
  course.box({
    x: 0,
    y: 0.53,
    z: endZ,
    w: type === 'bridge' ? 3.25 : Math.min(10, type === 'movers' ? 10 : 11),
    h: 0.055,
    d: 0.48,
    color: COLORS.mint,
    collider: false,
    emissive: COLORS.mint,
    emissiveIntensity: 1.4
  });
}

export function addFinish(course, spec) {
  const end = -18 * spec.segmentCount;
  for (let j = 0; j < 4; j++)
    course.box({
      x: 0,
      y: j * 0.32,
      z: end - 2.4 - j * 2.2,
      w: 8 + j * 0.35,
      h: 0.65,
      d: 2.45,
      color: COURSE_PALETTE[(spec.segmentCount + j) % COURSE_PALETTE.length],
      bevel: true
    });
  const finishCenter = spec.finishZ + 1.5;
  course.box({ x: 0, y: 1.02, z: finishCenter, w: 11, h: 0.7, d: 6, color: COLORS.yellow, bevel: true });
  for (const x of [-5, 5])
    course.box({
      x,
      y: 3.15,
      z: spec.finishZ,
      w: 0.42,
      h: 4.3,
      d: 0.52,
      color: 0xffffff,
      collider: false
    });
  course.box({
    x: 0,
    y: 5.05,
    z: spec.finishZ,
    w: 10.4,
    h: 0.48,
    d: 0.55,
    color: 0xffffff,
    collider: false
  });
  course.box({
    x: 0,
    y: 1.42,
    z: spec.finishZ,
    w: 10,
    h: 0.08,
    d: 0.7,
    color: COLORS.pink,
    collider: false,
    emissive: COLORS.pink,
    emissiveIntensity: 2.2
  });
  course.stageName('ВОРОТА ПОБЕДЫ');
}

// Всё, что даёт опоры и препятствия. Декорации трассы — арки чекпоинтов и пейзаж — остаются у
// клиента: коллайдеров они не создают, а генератор трогают уже после того, как геометрия готова.
export function buildRaceGeometry(course, spec) {
  addStart(course);
  for (let i = 0; i < spec.segmentCount; i++)
    addSegment(course, spec, spec.segments[i], i, FIRST_SEGMENT_CENTER - i * SEGMENT_LENGTH);
  addFinish(course, spec);
}
