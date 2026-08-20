import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EVENT_LOOP_WINDOW_MS, createEventLoopLoad } = require('./eventLoopLoad');

// Гистограмма задержки подменяется целиком: сервис обязан читать перцентиль и сбрасывать окно, а
// не измерять что-то своё. С настоящей гистограммой это было бы гонкой с реальной нагрузкой машины.
function fakeMonitor(percentilesNs = []) {
  const remaining = [...percentilesNs];
  return {
    enabled: false,
    resets: 0,
    last: 0,
    enable() {
      this.enabled = true;
    },
    disable() {
      this.enabled = false;
    },
    reset() {
      this.resets += 1;
    },
    percentile() {
      this.last = remaining.length ? remaining.shift() : this.last;
      return this.last;
    }
  };
}

const memory = { heapUsed: 64 * 1024 * 1024, heapTotal: 96 * 1024 * 1024, rss: 128 * 1024 * 1024 };

test('окно наблюдения включает гистограмму и сбрасывает её на каждом повороте', () => {
  const monitor = fakeMonitor([40e6, 10e6]);
  const load = createEventLoopLoad({ thresholdMs: 120, monitor });
  assert.equal(monitor.enabled, true);
  assert.equal(load.lagMs, 0, 'до первого окна задержка неизвестна, а не унаследована');

  assert.equal(load.rotate(), 40);
  assert.equal(load.lagMs, 40);
  assert.equal(monitor.resets, 1);

  assert.equal(load.rotate(), 10, 'решение принимается по последнему завершённому окну');
  assert.equal(monitor.resets, 2);
  load.stop();
});

test('перегрузка объявляется по порогу последнего окна', () => {
  const monitor = fakeMonitor([119.9e6, 120e6]);
  const load = createEventLoopLoad({ thresholdMs: 120, monitor });

  load.rotate();
  assert.equal(load.status({ memory }).overloaded, false);
  load.rotate();
  const overloaded = load.status({ memory });
  assert.equal(overloaded.overloaded, true);
  assert.equal(overloaded.eventLoopP95Ms, 120);
  assert.equal(overloaded.heapUsedMb, 64);
  assert.equal(overloaded.heapTotalMb, 96);
  assert.equal(overloaded.rssMb, 128);
  load.stop();
});

test('нечисловой перцентиль не превращается в перегрузку', () => {
  const monitor = fakeMonitor([Number.NaN]);
  const load = createEventLoopLoad({ thresholdMs: 120, monitor });
  assert.equal(load.rotate(), 0);
  assert.equal(load.status({ memory }).overloaded, false);
  assert.equal(load.status({ lagMs: Number.NaN, memory }).eventLoopP95Ms, 0);
  load.stop();
});

test('остановка выключает гистограмму и снимает таймер окна', () => {
  const monitor = fakeMonitor([5e6]);
  const load = createEventLoopLoad({ thresholdMs: 120, monitor });
  load.stop();
  assert.equal(monitor.enabled, false);
});

test('сервис не поднимается без осмысленного порога перегрузки', () => {
  assert.throws(() => createEventLoopLoad({ monitor: fakeMonitor() }), TypeError);
  assert.throws(() => createEventLoopLoad({ thresholdMs: 0, monitor: fakeMonitor() }), TypeError);
  assert.throws(() => createEventLoopLoad({ thresholdMs: Number.NaN, monitor: fakeMonitor() }), TypeError);
});

test('окно наблюдения по умолчанию короткое, а не равно аптайму', () => {
  assert.equal(EVENT_LOOP_WINDOW_MS, 5000);
  const load = createEventLoopLoad({ thresholdMs: 120, monitor: fakeMonitor() });
  assert.equal(load.windowMs, EVENT_LOOP_WINDOW_MS);
  load.stop();
});
