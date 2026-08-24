// Одно правило чекпоинта на клиенте и на сервере.
//
// Тест держит три вещи, и каждая из них ломалась в живой игре:
//
//  1. рамки арки читаются В ПЛОСКОСТИ арки, а не на состоянии после неё — иначе честный игрок,
//     упавший сразу за аркой, теряет её тем вернее, чем хуже у него связь;
//  2. засчитывается ПЕРЕСЕЧЕНИЕ, а не «оказался за чертой» — иначе клиент выдаёт арку, которую
//     сервер выдать структурно не может, и забег не заканчивается вовсе;
//  3. клиент и сервер зовут одну и ту же функцию с одной и той же рамкой — расхождение в одну
//     единицу здесь и было тем, из-за чего разошлись их ответы.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHECKPOINT_HALF_WIDTH,
  CHECKPOINT_MIN_Y,
  crossedCheckpoint,
  crossingPointAtZ
} from '../shared/courseProgress.js';
import { createCourseSpec, validateState } from './gameRules.js';

const LINE = -18;
const at = (x, y, z) => ({ x, y, z });

test('пересечение считается только вперёд по трассе', () => {
  assert.ok(crossedCheckpoint(at(0, 1, LINE + 2), at(0, 1, LINE - 2), LINE));
  // Назад — не пересечение: игрока отбросило, арку он не проходил заново.
  assert.equal(crossedCheckpoint(at(0, 1, LINE - 2), at(0, 1, LINE + 2), LINE), false);
  // Уже за чертой оба конца — пересекать нечего.
  assert.equal(crossedCheckpoint(at(0, 1, LINE - 5), at(0, 1, LINE - 9), LINE), false);
  // Ещё не дошёл.
  assert.equal(crossedCheckpoint(at(0, 1, LINE + 9), at(0, 1, LINE + 5), LINE), false);
});

test('касание черты ровно на границе засчитывается один раз, а не дважды', () => {
  // Ровно на черте — ещё не за ней: `to.z >= line` пересечением не считается.
  assert.equal(crossedCheckpoint(at(0, 1, LINE + 1), at(0, 1, LINE), LINE), false);
  // Следующий шаг с той же точки — уже пересечение.
  assert.ok(crossedCheckpoint(at(0, 1, LINE), at(0, 1, LINE - 1), LINE));
});

test('высота читается в плоскости арки, а не в конце отрезка', () => {
  // Игрок проходит арку на высоте пола и тут же падает в проём. К следующей выборке он уже глубоко
  // под трассой — но арку он прошёл честно, и это должно быть видно.
  const before = at(0, 1, LINE + 0.2);
  const after = at(0, -9, LINE - 3.8);

  const point = crossingPointAtZ(before, after, LINE);
  assert.ok(point.y > CHECKPOINT_MIN_Y, `в плоскости арки высота ${point.y} должна быть выше порога`);
  assert.ok(after.y <= CHECKPOINT_MIN_Y, 'подготовка: конец отрезка обязан быть ниже порога');
  assert.ok(crossedCheckpoint(before, after, LINE), 'арка засчитана честно пройденной');
});

test('обратный случай тоже держится: прошёл ПОД аркой — не засчитано', () => {
  // Здесь всё наоборот: в плоскости арки игрок глубоко внизу, а к концу отрезка его подбросило.
  // Старое правило, читавшее конец отрезка, арку бы выдало.
  const before = at(0, -9, LINE + 0.2);
  const after = at(0, 2, LINE - 3.8);

  assert.ok(after.y > CHECKPOINT_MIN_Y, 'подготовка: конец отрезка выше порога');
  assert.equal(crossedCheckpoint(before, after, LINE), false);
});

test('пролёт сбоку от арки не засчитывается ни разу и не засчитывается позже', () => {
  const outside = CHECKPOINT_HALF_WIDTH + 3;
  // Пересёк плоскость вне рамки.
  assert.equal(crossedCheckpoint(at(outside, 1, LINE + 2), at(outside, 1, LINE - 2), LINE), false);
  // И снесло обратно к оси уже ЗА аркой. Правило «я за чертой?» здесь бы её выдало — а сервер
  // выдать её уже не может никогда, потому что пересечение бывает только одно.
  assert.equal(crossedCheckpoint(at(outside, 1, LINE - 2), at(0, 1, LINE - 6), LINE), false);
});

test('мусор в координатах пересечением не считается', () => {
  assert.equal(crossingPointAtZ(null, at(0, 1, LINE - 1), LINE), null);
  assert.equal(crossingPointAtZ(at(0, 1, LINE + 1), null, LINE), null);
  assert.equal(crossingPointAtZ(at(0, NaN, LINE + 1), at(0, 1, LINE - 1), LINE), null);
  assert.equal(crossingPointAtZ(at(0, 1, LINE + 1), at(0, 1, LINE - 1), NaN), null);
  assert.equal(crossedCheckpoint(at(0, 1, LINE + 1), at(0, Infinity, LINE - 1), LINE), false);
});

test('точка пересечения лежит между концами отрезка', () => {
  const point = crossingPointAtZ(at(-4, 3, LINE + 6), at(6, -1, LINE - 4), LINE);
  assert.equal(point.z, LINE);
  assert.ok(point.x > -4 && point.x < 6);
  assert.ok(point.y > -1 && point.y < 3);
  // Доля пути до черты — 6/10, значит и координаты сдвинуты на те же 6/10.
  assert.ok(Math.abs(point.x - (-4 + 10 * 0.6)) < 1e-9);
  assert.ok(Math.abs(point.y - (3 - 4 * 0.6)) < 1e-9);
});

// Сервер обязан ходить через ту же функцию. Тест смотрит на это через настоящий validateState:
// если он снова начнёт считать рамки по-своему, случай «прошёл и упал» отвалится первым.
test('validateState засчитывает арку игроку, упавшему сразу за ней', () => {
  const spec = createCourseSpec(20260824, 'normal');
  const line = spec.checkpoints[0];
  const now = 1_000_000;
  // Игрок сорвался в проём перед самой аркой и пересекает её плоскость уже падая: в плоскости он
  // ещё выше порога, а к следующей выборке — при обычных 66 мс и скорости падения 16 — уже ниже.
  const player = {
    checkpoint: 0,
    last: { x: 0, y: -2.5, z: line + 0.05, ry: 0, vx: 0, vy: -16, vz: -7, state: 'air' },
    lastAt: now - 66
  };
  const falling = { x: 0.1, y: -3.56, z: line - 0.41, ry: 0, vx: 0, vy: -17.5, vz: -7, state: 'air' };
  assert.ok(falling.y <= CHECKPOINT_MIN_Y, 'подготовка: выборка после арки обязана быть ниже порога');

  const result = validateState(player, falling, spec, now);
  assert.equal(result.ok, true, `состояние должно пройти жёсткую проверку, а не отсеяться: ${result.reason}`);
  assert.equal(result.checkpoint, 1, 'арка пройдена честно и обязана быть засчитана');
});

test('validateState не выдаёт арку тому, кто пересёк плоскость вне рамки', () => {
  const spec = createCourseSpec(20260824, 'normal');
  const line = spec.checkpoints[0];
  const now = 1_000_000;
  const outside = CHECKPOINT_HALF_WIDTH + 2;
  const player = {
    checkpoint: 0,
    last: { x: outside, y: 1, z: line + 0.4, ry: 0, vx: 0, vy: 0, vz: -8, state: 'air' },
    lastAt: now - 66
  };
  const result = validateState(
    player,
    { x: outside, y: 0.6, z: line - 0.7, ry: 0, vx: 0, vy: -3, vz: -8, state: 'air' },
    spec,
    now
  );
  assert.equal(result.ok, true);
  assert.equal(result.checkpoint, 0);
});

test('validateState по-прежнему не выдаёт больше одной арки за пакет', () => {
  const spec = createCourseSpec(20260824, 'normal');
  const now = 1_000_000;
  // Долгая пауза поднимает потолок шага — ровно то, чем раньше срезали сразу два чекпоинта.
  const player = {
    checkpoint: 0,
    last: { x: 0, y: 1, z: spec.checkpoints[0] + 1, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' },
    lastAt: now - 800
  };
  const result = validateState(
    player,
    { x: 0, y: 1, z: spec.checkpoints[1] - 1, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' },
    spec,
    now
  );
  if (result.ok) assert.equal(result.checkpoint, 1, 'за один пакет — не больше одной арки');
});
