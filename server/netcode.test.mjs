// Тесты сетевого слоя и детерминизма физики.
//
// Запускаются под тем же загрузчиком, что и clientPhysics.test.mjs: он подменяет браузерные пути
// импорта на файлы из node_modules, поэтому клиентские модули исполняются в Node без браузера.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SnapshotBuffer,
  lerpAngle,
  MIN_RENDER_DELAY_MS,
  MAX_RENDER_DELAY_MS
} from '../client/net/SnapshotBuffer.js';
import { ClockSync } from '../client/net/ClockSync.js';
import { createCourseSpec, spawnFor } from '../shared/courseSpec.js';

const { createCourseSpec: serverCourseSpec, spawnFor: serverSpawnFor } = await import('./gameRules.js').then(
  m => m.default || m
);

test('буфер снапшотов интерполирует позицию между двумя пакетами', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(1000, [{ id: 'a', x: 0, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);
  buffer.push(1100, [{ id: 'a', x: 10, y: 4, z: -20, ry: 0, vx: 0, vz: 0 }]);

  // Ровно посередине между пакетами ожидаем ровно середину отрезка.
  const middle = buffer.sample('a', 1050);
  assert.equal(middle.x, 5);
  assert.equal(middle.y, 2);
  assert.equal(middle.z, -10);

  // На границах — точные значения пакетов, без смещения.
  assert.equal(buffer.sample('a', 1000).x, 0);
  assert.equal(buffer.sample('a', 1100).x, 10);

  // Четверть пути.
  assert.equal(buffer.sample('a', 1025).x, 2.5);
});

test('буфер экстраполирует по скорости, когда пакеты запаздывают, и ограничивает срок', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(1000, [{ id: 'a', x: 0, y: 3, z: 0, ry: 0, vx: 4, vz: -8 }]);

  // Через 100 мс после последнего пакета: 4 м/с * 0.1 с = 0.4 по X.
  const ahead = buffer.sample('a', 1100);
  assert.ok(ahead.extrapolated);
  assert.ok(Math.abs(ahead.x - 0.4) < 1e-9);
  assert.ok(Math.abs(ahead.z - -0.8) < 1e-9);

  // Вертикаль не экстраполируется: вертикальная скорость не передаётся, и догадки о прыжке
  // регулярно втыкали бы напарника в пол.
  assert.equal(ahead.y, 3);

  // Экстраполяция ограничена 250 мс: дальше позиция замирает, а не улетает в бесконечность.
  const far = buffer.sample('a', 1000 + 5000);
  assert.ok(Math.abs(far.x - 4 * 0.25) < 1e-9);
});

test('буфер интерполирует vertical velocity и прогнозирует прыжок по баллистике', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(1000, [{ id: 'a', x: 0, y: 2, z: 0, ry: 0, vx: 0, vy: 8, vz: 0, state: 'air' }]);
  buffer.push(1100, [{ id: 'a', x: 0, y: 2.7, z: 0, ry: 0, vx: 0, vy: 6, vz: 0, state: 'air' }]);
  assert.equal(buffer.sample('a', 1050).vy, 7);

  const airborne = buffer.sample('a', 1200);
  assert.ok(airborne.y > 2.7, 'прыгающий игрок продолжает подниматься между пакетами');

  const grounded = new SnapshotBuffer();
  grounded.push(1000, [{ id: 'b', x: 0, y: 1, z: 0, ry: 0, vx: 0, vy: 0, vz: 0, state: 'ground' }]);
  assert.equal(grounded.sample('b', 1200).y, 1, 'стоящий игрок не проваливается под пол');
});

test('буфер удерживает историю ограниченного размера и знает активных игроков', () => {
  const buffer = new SnapshotBuffer();
  for (let i = 0; i < 100; i++) {
    buffer.push(1000 + i * 66, [{ id: 'a', x: i, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);
  }
  assert.ok(buffer.snapshots.length <= 32, 'история не должна расти неограниченно');
  assert.deepEqual(buffer.activeIds(), ['a']);

  buffer.push(20000, [{ id: 'b', x: 0, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);
  assert.deepEqual(buffer.activeIds(), ['b'], 'исчезнувший игрок больше не считается активным');
});

test('пакеты, пришедшие не по порядку, встают на своё место', () => {
  const buffer = new SnapshotBuffer();
  buffer.push(1000, [{ id: 'a', x: 0, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);
  buffer.push(1200, [{ id: 'a', x: 20, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);
  buffer.push(1100, [{ id: 'a', x: 10, y: 0, z: 0, ry: 0, vx: 0, vz: 0 }]);

  const times = buffer.snapshots.map(s => s.time);
  assert.deepEqual(times, [1000, 1100, 1200]);
  assert.equal(buffer.sample('a', 1150).x, 15);
});

test('интерполяция угла идёт кратчайшим путём через ноль', () => {
  // Из 350° в 10°: правильный путь — вперёд на 20°, а не назад на 340°.
  const from = (350 * Math.PI) / 180;
  const to = (10 * Math.PI) / 180;
  const middle = lerpAngle(from, to, 0.5);
  const degrees = ((middle * 180) / Math.PI + 360) % 360;
  assert.ok(Math.abs(degrees - 0) < 1e-6 || Math.abs(degrees - 360) < 1e-6, `получено ${degrees}°`);
});

test('задержка отрисовки адаптируется к jitter и остаётся в безопасных пределах', () => {
  const stable = new SnapshotBuffer();
  for (let i = 0; i < 10; i++) stable.push(i * 66, [], i * 66);
  assert.equal(stable.renderDelay, MIN_RENDER_DELAY_MS);

  const mobile = new SnapshotBuffer();
  let arrival = 0;
  for (let i = 0; i < 10; i++) {
    arrival += i % 2 ? 106 : 26;
    mobile.push(i * 66, [], arrival);
  }
  assert.ok(mobile.renderDelay > stable.renderDelay);
  assert.ok(mobile.renderDelay <= MAX_RENDER_DELAY_MS);

  const extreme = new SnapshotBuffer();
  let extremeArrival = 0;
  for (let i = 0; i < 20; i++) {
    extremeArrival += 1000;
    extreme.push(i * 66, [], extremeArrival);
  }
  assert.equal(extreme.renderDelay, MAX_RENDER_DELAY_MS);
});

test('синхронизация часов выбирает замер с наименьшим RTT', () => {
  const clock = new ClockSync();
  assert.equal(clock.synced, false);

  // Часы сервера опережают клиентские ровно на 5000 мс.
  const OFFSET = 5000;
  // Медленный замер: 400 мс туда-обратно.
  clock.record(1000, 1000 + OFFSET + 200, 1400);
  // Быстрый и точный: 20 мс.
  clock.record(2000, 2000 + OFFSET + 10, 2020);
  // Ещё один медленный, уже после точного — не должен испортить оценку.
  clock.record(3000, 3000 + OFFSET + 300, 3600);

  assert.ok(clock.synced);
  assert.ok(Math.abs(clock.offset - OFFSET) < 1, `смещение ${clock.offset}, ожидалось ~${OFFSET}`);
  assert.ok(Math.abs(clock.latency - 10) < 1, `задержка ${clock.latency}, ожидалась ~10`);

  // serverNow должен переводить локальное время в серверное.
  assert.ok(Math.abs(clock.serverNow(10000) - (10000 + OFFSET)) < 1);
});

test('синхронизация часов игнорирует мусорные замеры', () => {
  const clock = new ClockSync();
  clock.record(NaN, 1000, 1100);
  clock.record(1000, NaN, 1100);
  // Ответ «раньше» запроса физически невозможен — такой замер отбрасывается.
  clock.record(2000, 3000, 1000);
  assert.equal(clock.synced, false, 'ни один некорректный замер не должен приниматься');
});

test('клиент и сервер строят одинаковую спеку трассы', () => {
  // Раньше эти формулы были продублированы вручную в двух файлах. Расхождение означало бы, что
  // сервер не засчитывает финиш, до которого игрок честно добежал.
  for (const difficulty of ['easy', 'normal', 'chaos']) {
    for (const seed of [0, 1, 42, 65535, 4294967295]) {
      assert.deepEqual(createCourseSpec(seed, difficulty), serverCourseSpec(seed, difficulty));
    }
  }

  const spec = createCourseSpec(7, 'normal');
  for (let checkpoint = 0; checkpoint <= spec.segmentCount; checkpoint++) {
    assert.deepEqual(spawnFor(spec, checkpoint), serverSpawnFor(spec, checkpoint));
  }
});

test('некорректная сложность приводится к normal с обеих сторон', () => {
  assert.deepEqual(createCourseSpec(1, 'нет-такой'), serverCourseSpec(1, 'нет-такой'));
  assert.equal(createCourseSpec(1, 'нет-такой').difficulty, 'normal');
});

test('приветственное сообщение не портит оценку часов нулевым RTT', () => {
  // Регрессия на реальный баг. У hello нет парного запроса, поэтому честного RTT из него не
  // получить. Когда оно клалось в общий набор как замер с RTT = 0, такой замер навсегда выигрывал
  // выбор минимума, и настоящие ping уже не могли уточнить смещение.
  const clock = new ClockSync();
  const OFFSET = 5000;

  // Приветствие: клиент видит серверное время, уже отставшее на время пути (50 мс).
  clock.seed(10_000 + OFFSET - 50, 10_000);
  assert.ok(clock.synced, 'начальная оценка должна работать сразу');
  assert.ok(Math.abs(clock.offset - (OFFSET - 50)) < 1, 'грубая оценка близка, но смещена на путь');

  // Настоящий замер обязан её заменить, а не проиграть нулевому RTT.
  clock.record(20_000, 20_000 + OFFSET + 10, 20_020);
  assert.ok(
    Math.abs(clock.offset - OFFSET) < 1,
    `после реального замера смещение должно уточниться, получено ${clock.offset}`
  );
  assert.ok(Math.abs(clock.rtt - 20) < 1, 'RTT берётся из настоящего замера, а не нулевой');
});

test('начальная оценка не перетирает уже собранные замеры', () => {
  const clock = new ClockSync();
  clock.record(1000, 1000 + 3000 + 5, 1010);
  const before = clock.offset;
  clock.seed(999_999_999);
  assert.equal(clock.offset, before, 'seed применяется только при пустом наборе замеров');
});
