// Игровые метрики: разбивка, сохранность между перезапусками, границы.
//
// Проверяется не «счётчик увеличился», а то, ради чего метрики заводились: можно ли по ним
// ответить на вопрос. «Падений 4312» — не ответ; «на узком повороте на телефоне падают вдвое чаще,
// чем на компьютере» — ответ, и он требует разбивки, которая не схлопывается.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');
const { openDatabase } = require('./db');
const {
  MAX_PENDING_EVENTS,
  trackRaceKnockdownState,
  trackRaceKnockdownRespawn,
  raceKnockdownMetricsStatus,
  resetRaceKnockdownMetricsForTests
} = require('./raceKnockdownMetrics');

const DAY = 24 * 60 * 60 * 1000;

function memory(now = () => Date.UTC(2026, 0, 15)) {
  return new GameplayMetrics({ db: openDatabase(':memory:'), now });
}

// Строка сводки по измерениям — читать тесты так проще, чем по индексам.
function row(summary, match) {
  return summary.rows.find(item => Object.entries(match).every(([key, value]) => item[key] === value));
}

test('одинаковые измерения складываются, разные остаются раздельными', () => {
  const gameplay = memory();
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bridge', device: 'mobile' });
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bridge', device: 'mobile' });
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bridge', device: 'desktop' });
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bounce', device: 'mobile' });

  const summary = gameplay.summary({ days: 1 });
  assert.equal(row(summary, { detail: 'bridge', device: 'mobile' }).samples, 2);
  assert.equal(row(summary, { detail: 'bridge', device: 'desktop' }).samples, 1);
  assert.equal(
    row(summary, { detail: 'bounce', device: 'mobile' }).samples,
    1,
    'препятствие — отдельное измерение, иначе вопрос «где падают» не задать'
  );
  assert.equal(summary.rows.length, 3);
});

test('величина хранится суммой и показывается средним, а простой счётчик — нет', () => {
  const gameplay = memory();
  gameplay.observe('finish_time', 20_000, { mode: 'race', course: 'easy' });
  gameplay.observe('finish_time', 30_000, { mode: 'race', course: 'easy' });
  gameplay.count('match_started', { mode: 'race', course: 'easy' });

  const summary = gameplay.summary({ days: 1 });
  const times = row(summary, { metric: 'finish_time' });
  assert.equal(times.samples, 2);
  assert.equal(times.average, 25_000);
  assert.equal(
    row(summary, { metric: 'match_started' }).average,
    null,
    'у счётчика без величины среднее не показывается: ноль читался бы как настоящий ноль'
  );
});

// Ради этого всё и затевалось: прежние счётчики жили в памяти процесса и обнулялись при каждом
// развёртывании — то есть чаще, чем набиралась статистика.
test('накопленное переживает перезапуск процесса', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wobble-metrics-'));
  const file = join(directory, 'metrics.db');
  const now = () => Date.UTC(2026, 0, 15);
  try {
    const first = new GameplayMetrics({ db: openDatabase(file), now });
    first.count('fall', { mode: 'race', course: 'chaos', detail: 'crosswind' });
    first.flush();
    first.db.close();

    const second = new GameplayMetrics({ db: openDatabase(file), now });
    second.count('fall', { mode: 'race', course: 'chaos', detail: 'crosswind' });
    const summary = second.summary({ days: 1 });
    assert.equal(
      row(summary, { detail: 'crosswind' }).samples,
      2,
      'счёт продолжается, а не начинается заново'
    );
    second.db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('дни разделены, а сводка берёт заданное окно', () => {
  let today = Date.UTC(2026, 0, 15);
  const gameplay = new GameplayMetrics({ db: openDatabase(':memory:'), now: () => today });
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bridge' });
  gameplay.flush();

  today += 3 * DAY;
  gameplay.count('fall', { mode: 'race', course: 'easy', detail: 'bridge' });

  assert.equal(row(gameplay.summary({ days: 7 }), { detail: 'bridge' }).samples, 2, 'неделя видит оба дня');
  assert.equal(
    row(gameplay.summary({ days: 1 }), { detail: 'bridge' }).samples,
    1,
    'сегодня — только сегодня'
  );
});

test('старые дни удаляются по сроку хранения', () => {
  let today = Date.UTC(2026, 0, 15);
  const gameplay = new GameplayMetrics({
    db: openDatabase(':memory:'),
    now: () => today,
    retentionDays: 30
  });
  gameplay.count('fall', { mode: 'race', course: 'easy' });
  gameplay.flush();

  today += 40 * DAY;
  gameplay.count('fall', { mode: 'race', course: 'easy' });
  gameplay.flush();

  assert.equal(
    row(gameplay.summary({ days: 60 }), { metric: 'fall' }).samples,
    1,
    'запись сорокадневной давности при сроке в тридцать дней обязана исчезнуть'
  );
});

// Уборка вызывается из сброса, а сброс выходит сразу, когда копить было нечего. Сервер, в который
// перестали играть, так и держал бы прошлогодние строки: срок хранения, который соблюдается только
// пока идёт игра, — не срок хранения.
test('срок хранения соблюдается и на затихшем сервере', () => {
  let today = Date.UTC(2026, 0, 15);
  const gameplay = new GameplayMetrics({
    db: openDatabase(':memory:'),
    now: () => today,
    retentionDays: 30
  });
  gameplay.count('fall', { mode: 'race', course: 'easy' });
  gameplay.flush();

  // Больше ни одного события — только время идёт и кто-то смотрит сводку.
  today += 40 * DAY;
  assert.deepEqual(gameplay.summary({ days: 60 }).rows, [], 'просроченное убрано без новых событий');
});

// Защита не от нагрузки, а от ошибки: измерение, куда случайно попало что-то уникальное, иначе
// превратит буфер в утечку памяти.
test('поток уникальных значений отбрасывается и считается', () => {
  const gameplay = memory();
  for (let i = 0; i < 6000; i++) gameplay.count('fall', { mode: 'race', course: 'easy', detail: `id${i}` });
  assert.ok(gameplay.pending.size <= 5000, 'буфер не растёт бесконечно');
  assert.ok(gameplay.dropped > 0, 'потери обязаны быть видны, а не проглочены молча');
  assert.equal(gameplay.summary({ days: 1 }).dropped, gameplay.dropped);
});

test('пробел внутри значения нормализуется, а разные наборы измерений не сливаются', () => {
  const gameplay = memory();
  gameplay.count('fall', { mode: 'race', course: 'узкий поворот', detail: 'мост' });
  gameplay.count('fall', { mode: 'race', course: 'узкий', detail: 'поворот мост' });

  const summary = gameplay.summary({ days: 1 });
  assert.equal(row(summary, { course: 'узкий_поворот' }).detail, 'мост');
  assert.equal(row(summary, { course: 'узкий' }).detail, 'поворот_мост');
  assert.equal(summary.rows.length, 2, 'наборы измерений разные — значит, и строки разные');
});

test('race knockdown измеряет старт, повторный удар, восстановление и падение после удара', () => {
  resetRaceKnockdownMetricsForTests();
  const gameplay = memory();
  const spec = {
    difficulty: 'easy',
    segmentCount: 1,
    segments: [{ type: 'bumpers' }],
    checkpoints: [-18],
    finishZ: -31
  };
  const player = {
    device: 'mobile',
    matchStartedAt: 1000,
    lastRespawn: 0
  };

  const start = { x: 0, y: 1, z: -11, vx: 10, vy: 6.2, vz: 0, state: 'knockdown' };
  trackRaceKnockdownState({ player, spec, state: start, previousState: null, now: 2000 });

  const repeat = { ...start, vx: -10, vy: 6, state: 'knockdown' };
  trackRaceKnockdownState({ player, spec, state: repeat, previousState: start, now: 2300 });

  const recovered = { ...repeat, vx: -3, vy: 0, state: 'ground' };
  trackRaceKnockdownState({ player, spec, state: recovered, previousState: repeat, now: 3400 });

  const second = { ...start, vx: 9, vy: 5, state: 'knockdown' };
  trackRaceKnockdownState({ player, spec, state: second, previousState: recovered, now: 5000 });
  player.lastRespawn = 6500;
  assert.equal(trackRaceKnockdownRespawn({ player, now: 6500 }), true);
  assert.equal(
    trackRaceKnockdownRespawn({ player, now: 6500 }),
    false,
    'один server-side respawn не должен засчитываться дважды'
  );

  const summary = gameplay.summary({ days: 1 });
  assert.equal(row(summary, { metric: 'knockdown_started', detail: 'bumpers' }).samples, 2);
  assert.equal(row(summary, { metric: 'knockdown_repeat_hit', detail: 'bumpers' }).samples, 1);
  assert.equal(row(summary, { metric: 'knockdown_recovered', detail: 'bumpers' }).samples, 1);
  assert.equal(row(summary, { metric: 'knockdown_recovered', detail: 'bumpers' }).average, 1400);
  assert.equal(row(summary, { metric: 'knockdown_then_fall', detail: 'bumpers' }).samples, 1);
  assert.equal(row(summary, { metric: 'knockdown_then_fall', detail: 'bumpers' }).average, 1500);
  resetRaceKnockdownMetricsForTests();
});

test('race knockdown ограничивает число inferred repeat hits на одно сбивание', () => {
  resetRaceKnockdownMetricsForTests();
  const gameplay = memory();
  const spec = {
    difficulty: 'chaos',
    segmentCount: 1,
    segments: [{ type: 'punchers' }],
    checkpoints: [-18],
    finishZ: -31
  };
  const player = { device: 'desktop', matchStartedAt: 2000, lastRespawn: 0 };
  let previous = { x: 0, y: 1, z: -11, vx: 10, vy: 5, vz: 0, state: 'knockdown' };
  trackRaceKnockdownState({ player, spec, state: previous, now: 3000 });

  for (let index = 0; index < 7; index += 1) {
    const next = { ...previous, vx: index % 2 === 0 ? -10 : 10, vy: 5, state: 'knockdown' };
    trackRaceKnockdownState({
      player,
      spec,
      state: next,
      previousState: previous,
      now: 3300 + index * 300
    });
    previous = next;
  }

  const summary = gameplay.summary({ days: 1 });
  assert.equal(
    row(summary, { metric: 'knockdown_repeat_hit', detail: 'punchers' }).samples,
    4,
    'аномальный поток не может раздувать один knockdown бесконечными повторными ударами'
  );
  resetRaceKnockdownMetricsForTests();
});

test('переполнение knockdown queue попадает в общий dropped signal', () => {
  resetRaceKnockdownMetricsForTests();
  const gameplay = memory();
  const spec = {
    difficulty: 'easy',
    segmentCount: 1,
    segments: [{ type: 'bumpers' }],
    checkpoints: [-18],
    finishZ: -31
  };
  const state = { x: 0, y: 1, z: -11, vx: 10, vy: 5, vz: 0, state: 'knockdown' };

  for (let index = 0; index <= MAX_PENDING_EVENTS; index += 1) {
    trackRaceKnockdownState({
      player: { device: 'desktop', matchStartedAt: index + 1, lastRespawn: 0 },
      spec,
      state,
      now: 10_000 + index
    });
  }

  assert.deepEqual(raceKnockdownMetricsStatus(), { pending: MAX_PENDING_EVENTS, dropped: 1 });
  const summary = gameplay.summary({ days: 1 });
  assert.equal(summary.dropped, 1, 'оператор видит потерю knockdown telemetry в обычном dropped поле');
  assert.equal(row(summary, { metric: 'knockdown_started', detail: 'bumpers' }).samples, MAX_PENDING_EVENTS);
  assert.deepEqual(raceKnockdownMetricsStatus(), { pending: 0, dropped: 0 });
  resetRaceKnockdownMetricsForTests();
});

test('устройство различает палец и мышь', () => {
  const iphone =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const pixel =
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Mobile Safari/537.36';
  const desktop =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
  assert.equal(deviceFromUserAgent(iphone), 'mobile');
  assert.equal(deviceFromUserAgent(pixel), 'mobile');
  assert.equal(deviceFromUserAgent(desktop), 'desktop');
  assert.equal(deviceFromUserAgent(''), 'desktop', 'неизвестное не создаёт третью категорию');
  assert.equal(deviceFromUserAgent(undefined), 'desktop');
});

test('без базы метрики не падают, а просто ничего не пишут', () => {
  const gameplay = new GameplayMetrics({});
  assert.equal(gameplay.count('fall', { mode: 'race' }), true);
  assert.equal(gameplay.flush(), 0);
  assert.deepEqual(gameplay.summary({ days: 1 }).rows, []);
});
