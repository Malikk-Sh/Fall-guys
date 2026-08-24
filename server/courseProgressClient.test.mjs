// Клиентская сторона общего правила чекпоинта — на настоящей `Course`, а не на макете.
//
// Смысл теста в одном: клиент не должен выдавать арку, которую сервер выдать структурно не может.
// Пока он это делал, игрок с полным счётчиком слал финиш, который сервер принять не мог, и забег
// не заканчивался вовсе.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { courseSpec } from '../client/core/Config.js';
import { Course } from '../client/game/Course.js';
import { CoopCourse } from '../client/game/CoopCourse.js';
import { CHECKPOINT_HALF_WIDTH } from '../shared/courseProgress.js';
import { COOP_CHAPTER_IDS, coopSpec } from '../shared/coopChapters.js';

const at = (x, y, z) => new THREE.Vector3(x, y, z);

function raceCourse(seed = 31337) {
  const spec = courseSpec(seed, 'normal');
  return { spec, course: new Course(new THREE.Scene(), spec, { quality: 'low' }) };
}

test('обычный проход сквозь арку засчитывается ровно один раз', () => {
  const { spec, course } = raceCourse();
  const line = spec.checkpoints[0];

  assert.equal(course.checkpointFor(at(0, 1, line + 0.2), at(0, 1, line - 0.2), 0), 1);
  // Тот же шаг ещё раз, уже с новым счётчиком, второй арки не даёт: следующая черта далеко.
  assert.equal(course.checkpointFor(at(0, 1, line - 0.2), at(0, 1, line - 0.6), 1), 1);
  course.dispose();
});

test('пролёт сбоку от арки не засчитывается и не засчитывается позже', () => {
  const { spec, course } = raceCourse();
  const line = spec.checkpoints[0];
  const outside = CHECKPOINT_HALF_WIDTH + 3;

  // Пересёк плоскость вне рамки.
  assert.equal(course.checkpointFor(at(outside, 1, line + 0.4), at(outside, 1, line - 0.4), 0), 0);
  // И снесло обратно к оси уже ЗА аркой. Старое правило «я за чертой?» выдало бы её здесь — и это
  // ровно тот момент, после которого клиент и сервер расходились навсегда.
  assert.equal(course.checkpointFor(at(outside, 1, line - 0.4), at(0, 1, line - 2), 0), 0);
  course.dispose();
});

test('падение сразу за аркой арку не отменяет', () => {
  const { spec, course } = raceCourse();
  const line = spec.checkpoints[0];
  // Шаг физики — 1/60 с, поэтому отрезок короткий, и в его пределах высота почти не меняется.
  // Важно, что засчитывается высота В ПЛОСКОСТИ арки: дальше игрок падает, но арку он прошёл.
  assert.equal(course.checkpointFor(at(0, 0.9, line + 0.12), at(0.05, 0.5, line - 0.02), 0), 1);
  course.dispose();
});

test('телепорт назад за арку её не отбирает и вперёд её не выдаёт', () => {
  const { spec, course } = raceCourse();
  const line = spec.checkpoints[0];
  // Возрождение сбрасывает previous вместе с позицией — обе точки совпадают, пересечения нет.
  const point = at(0, 1.15, line + 3.1);
  assert.equal(course.checkpointFor(point, point, 0), 0);
  // Движение назад через черту счётчик не трогает.
  assert.equal(course.checkpointFor(at(0, 1, line - 1), at(0, 1, line + 1), 1), 1);
  course.dispose();
});

test('последняя арка пройдена — счётчик больше не растёт', () => {
  const { spec, course } = raceCourse();
  const last = spec.checkpoints.length;
  assert.equal(course.checkpointFor(at(0, 1, spec.finishZ + 1), at(0, 1, spec.finishZ - 1), last), last);
  course.dispose();
});

test('кооператив пользуется тем же правилом и той же рамкой', () => {
  const spec = coopSpec(COOP_CHAPTER_IDS[0]);
  const course = new CoopCourse(new THREE.Scene(), spec, { quality: 'low' });
  const line = course.spec.checkpoints[0];
  assert.ok(Number.isFinite(line), 'подготовка: у главы обязана быть хотя бы одна арка');

  assert.equal(course.checkpointFor(at(0, 1, line + 0.2), at(0, 1, line - 0.2), 0), 1);
  // 11.5 лежит между старой клиентской рамкой кооператива (12) и серверной (11). Клиент был ШИРЕ
  // сервера — то есть выдавал арку, которую сервер не выдаст. Теперь обе стороны отвечают одно.
  assert.equal(course.checkpointFor(at(11.5, 1, line + 0.2), at(11.5, 1, line - 0.2), 0), 0);
  course.dispose();
});
