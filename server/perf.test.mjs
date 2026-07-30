// Тесты бюджета кадра и адаптивного качества.
//
// Логика решения намеренно не знает ни о рендерере, ни о «качестве» — она знает только про времена
// кадров. Поэтому проверяется здесь напрямую, синтетическим временем, без браузера.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Perf, FRAME_BUDGET_MS } from '../client/core/Perf.js';

// Заполняет окно замеров одинаковыми кадрами.
const feed = (perf, ms, frames = 240) => {
  for (let i = 0; i < frames; i++) perf.sample(ms);
};

test('без достаточного числа замеров решение не принимается', () => {
  const perf = new Perf();
  feed(perf, 40, 20);
  assert.equal(perf.verdict(100_000), 0, 'по двум десяткам кадров судить нельзя');
});

test('устойчивая просадка понижает качество, но не мгновенно', () => {
  const perf = new Perf();
  feed(perf, 33); // 30 кадров в секунду
  assert.equal(perf.verdict(1000), 0, 'первое же превышение бюджета не должно менять качество');
  assert.equal(perf.verdict(2000), 0, 'полутора секунд мало');
  assert.equal(perf.verdict(4000), -1, 'через две с половиной секунды просадка признаётся устойчивой');
});

test('одиночный тяжёлый кадр не считается просадкой', () => {
  const perf = new Perf();
  feed(perf, 16);
  perf.sample(400); // сборка мусора или компиляция шейдера
  assert.equal(perf.verdict(1000), 0);
  assert.equal(perf.verdict(9000), 0, 'медиана устойчива к единичному выбросу');
});

test('запас по бюджету возвращает качество, но только спустя долгое время', () => {
  const perf = new Perf();
  perf.raiseAttempts = 2;
  feed(perf, 15);
  assert.equal(perf.verdict(1000), 0);
  assert.equal(perf.verdict(10_000), 0, 'десяти секунд для возврата мало');
  assert.equal(perf.verdict(17_000), 1, 'через пятнадцать секунд запаса пробуем вернуть');
});

test('исчерпав попытки, качество больше не повышается', () => {
  const perf = new Perf();
  feed(perf, 15);
  perf.raiseFailed();
  perf.raiseFailed();
  assert.equal(perf.raiseAttempts, 0);
  assert.equal(perf.verdict(1000), 0);
  assert.equal(perf.verdict(60_000), 0, 'устройство дважды доказало, что не тянет');
});

test('зона покоя между порогами не двигает качество ни в одну сторону', () => {
  const perf = new Perf();
  // 18 мс — хуже бюджета, но лучше порога просадки: типичное состояние здоровой игры.
  feed(perf, 18);
  assert.ok(18 > FRAME_BUDGET_MS, 'проверяемое время действительно выше бюджета');
  assert.equal(perf.verdict(1000), 0);
  assert.equal(perf.verdict(60_000), 0, 'ни понижения, ни повышения — иначе качество бы дрожало');
});

test('накопленное время просадки сбрасывается, если кадры выправились', () => {
  const perf = new Perf();
  feed(perf, 33);
  assert.equal(perf.verdict(1000), 0, 'счётчик просадки пошёл');

  // Кадры выправились до того, как истекли две с половиной секунды.
  feed(perf, 15);
  assert.equal(perf.verdict(2000), 0);

  // И снова просели: отсчёт должен идти заново, а не продолжать прежний.
  feed(perf, 33);
  assert.equal(perf.verdict(2600), 0, 'отсчёт начинается заново, а не продолжает прошлый');
  assert.equal(perf.verdict(5200), -1);
});

test('сброс забывает и замеры, и накопленное время', () => {
  const perf = new Perf();
  feed(perf, 33);
  perf.verdict(1000);
  perf.reset();
  assert.equal(perf.ready, false, 'после сброса решений не принимаем, пока не наберём замеры');
  feed(perf, 33);
  assert.equal(perf.verdict(1500), 0, 'отсчёт просадки тоже сброшен');
});

test('медиана и частота кадров считаются по окну', () => {
  const perf = new Perf();
  feed(perf, 20);
  assert.equal(perf.median, 20);
  assert.equal(perf.fps, 50);
});
