// Расстановка препятствий гонки.
//
// Живёт в общем коде по той же причине, что и расстановка сегментов: сервер обязан получить те же
// препятствия с теми же фазами, не строя сцену. Всё, что нужно от билдера, — примитивы: коробка,
// цилиндр, балка вертушки и кольцо бампера. Первые два дают коллайдеры, вторые два чистая
// декорация, и безголовый билдер отвечает на них заглушками.
//
// Порядок обращений к сидированному генератору здесь значим: бампер и пружина забирают по одному
// значению каждый, и любая перестановка вызовов сдвинула бы фазы всех последующих препятствий.

import { COLORS } from './palette.js';

// Перила. Чистая декорация: ни один борт трассы не участвует ни в опоре, ни в ударе.
export function addRail(course, x, z, length) {
  course.box({
    x,
    y: 1.25,
    z,
    w: 0.16,
    h: 1.1,
    d: length,
    color: 0xffffff,
    collider: false,
    opacity: 0.48
  });
  const posts = Math.ceil(length / 4);
  for (let i = 0; i <= posts; i++)
    course.box({
      x,
      y: 0.9,
      z: z - length / 2 + i * (length / posts),
      w: 0.22,
      h: 1.3,
      d: 0.22,
      color: 0xffffff,
      collider: false
    });
}

export function addSpinner(course, x, y, z, length, width, speed, phase) {
  const beamWidth = width * 1.18;
  const beam = course.spinnerBeam({ x, y, z, length, width: beamWidth });
  // Ступица — чистая декорация, коллайдера у неё нет: столкновение считается по самой балке.
  course.cylinder({ x, y: y + 0.2, z, r: 0.62, h: 0.9, color: COLORS.purpleDark });
  course.registerObstacle({
    type: 'spinner',
    mesh: beam,
    x,
    y,
    z,
    length,
    width: beamWidth,
    speed,
    phase,
    angle: 0,
    height: 0.7
  });
}

export function addBumper(course, x, y, z, radius, color) {
  const visualRadius = radius * 1.16;
  const hitRadius = radius * 1.08;
  // Подставка — декорация; отталкивание считается по слегка меньшему hitRadius.
  course.cylinder({ x, y: 0.58, z, r: visualRadius * 1.12, h: 0.16, color: COLORS.yellow });
  const mesh = course.cylinder({ x, y, z, r: visualRadius, h: 1.55, color });
  course.ringDecor({ x, y: y + 0.2, z, radius: visualRadius * 0.82 });
  course.registerObstacle({
    type: 'bumper',
    mesh,
    x,
    y,
    z,
    radius: hitRadius,
    color,
    phase: course.rng() * 6.28
  });
}

export function addSpring(course, x, y, z, radius) {
  const padRadius = radius * 1.08;
  const pad = course.cylinder({ x, y, z, r: padRadius, h: 0.25, color: COLORS.yellow });
  const inner = course.cylinder({
    x,
    y: y + 0.14,
    z,
    r: padRadius * 0.66,
    h: 0.05,
    color: COLORS.pink
  });
  course.registerObstacle({
    type: 'spring',
    mesh: pad,
    x,
    y,
    z,
    radius: padRadius,
    inner,
    phase: course.rng() * 6.28
  });
}
