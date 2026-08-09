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
