// Правило выбора качества графики.
//
// Проверяется без сцены и браузера: решение зависит только от выбора игрока, замеров кадров и
// характеристик устройства — всё три подаются снаружи.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Quality } from '../client/core/Quality.js';

const device = over => () => ({ memory: 8, cores: 8, coarsePointer: false, pixelRatio: 1, ...over });

// Perf-заглушка: verdict задаётся сценарием, вызовы reset и raiseFailed считаются.
function perfStub(verdicts) {
  const queue = [...verdicts];
  return {
    resets: 0,
    regrets: 0,
    verdict: () => queue.shift() ?? 0,
    reset() {
      this.resets++;
    },
    raiseFailed() {
      this.regrets++;
    }
  };
}

test('догадка по железу занижает качество только на слабых устройствах', () => {
  assert.equal(new Quality({ device: device() }).effective(), 'high');
  assert.equal(new Quality({ device: device({ memory: 4 }) }).effective(), 'low');
  assert.equal(new Quality({ device: device({ cores: 4 }) }).effective(), 'low');
  assert.equal(
    new Quality({ device: device({ coarsePointer: true, pixelRatio: 3 }) }).effective(),
    'low',
    'плотный экран с сенсором — почти всегда телефон'
  );
  assert.equal(
    new Quality({ device: device({ coarsePointer: true, pixelRatio: 2 }) }).effective(),
    'high',
    'сенсор сам по себе не приговор'
  );
});

test('выбор игрока сильнее и замеров, и догадки', () => {
  const quality = new Quality({ device: device({ memory: 2 }) });
  assert.equal(quality.effective(), 'low');
  assert.equal(quality.cycle(), 'low');
  assert.equal(quality.cycle(), 'high');
  assert.equal(quality.effective(), 'high', 'ручной выбор перекрывает догадку');

  // Даже при провальных кадрах ручной выбор не трогается: это решение человека.
  const perf = perfStub([-1, -1, -1]);
  assert.equal(quality.adapt(1000, { running: true, perf }), null);
  assert.equal(quality.effective(), 'high');
  assert.equal(perf.resets, 0, 'чужое решение не сбрасывает замеры');
});

test('подстройка снижает качество по плохим кадрам и возвращает по хорошим', () => {
  const quality = new Quality({ device: device() });
  const perf = perfStub([-1, 1]);
  assert.equal(quality.adapt(1000, { running: true, perf }), 'low');
  assert.equal(quality.effective(), 'low');
  assert.equal(quality.adapt(200_000, { running: true, perf }), 'high');
  assert.equal(quality.effective(), 'high');
  assert.equal(perf.resets, 2, 'после каждой смены замеры начинаются заново');
});

test('в меню и при неизменном вердикте не меняется ничего', () => {
  const quality = new Quality({ device: device() });
  assert.equal(quality.adapt(1000, { running: false, perf: perfStub([-1]) }), null, 'вне забега не меряем');
  assert.equal(quality.adapt(1000, { running: true, perf: perfStub([0]) }), null, 'нет вердикта — нет смены');
  assert.equal(quality.adapt(1000, { running: true, perf: perfStub([1]) }), null, 'уже высокое');
});

// Понижение сразу после возврата означает, что возврат был ошибкой. Perf об этом узнаёт и
// откладывает следующую попытку — иначе качество прыгало бы туда-сюда каждую минуту.
test('неудачный возврат к высокому качеству запоминается', () => {
  const quality = new Quality({ device: device() });
  const perf = perfStub([-1, 1, -1]);
  quality.adapt(0, { running: true, perf });
  quality.adapt(10_000, { running: true, perf });
  assert.equal(perf.regrets, 0);
  quality.adapt(20_000, { running: true, perf });
  assert.equal(perf.regrets, 1, 'падение через десять секунд после возврата — это сожаление');

  const patient = new Quality({ device: device() });
  const slow = perfStub([-1, 1, -1]);
  patient.adapt(0, { running: true, perf: slow });
  patient.adapt(10_000, { running: true, perf: slow });
  patient.adapt(200_000, { running: true, perf: slow });
  assert.equal(slow.regrets, 0, 'спустя три минуты падение — это уже другая история');
});

test('подпись отличает автоматический выбор от ручного', () => {
  const quality = new Quality({ device: device() });
  assert.equal(quality.label(), 'авто (high)');
  quality.cycle();
  assert.equal(quality.label(), 'low');
});
