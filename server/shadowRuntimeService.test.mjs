import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('./shadowRuntimeService');

test('shadow runtime service is a process-local CommonJS singleton', () => {
  const loadedAgain = require('./shadowRuntimeService');
  assert.equal(loadedAgain, service);
  assert.ok(service.runtime);
  assert.equal(typeof service.accept, 'function');
  assert.equal(typeof service.tick, 'function');
  assert.equal(typeof service.snapshot, 'function');
  assert.equal(typeof service.metrics, 'function');
});

test('shadow runtime service facade delegates to one supplied runtime', () => {
  const calls = [];
  const runtime = {
    accept: options => {
      calls.push(['accept', options]);
      return { accepted: true };
    },
    tick: (rooms, now) => {
      calls.push(['tick', rooms, now]);
      return 17;
    },
    snapshot: player => {
      calls.push(['snapshot', player]);
      return { matchId: 'm1' };
    },
    metrics: () => {
      calls.push(['metrics']);
      return { processed: 3 };
    }
  };
  const isolated = service.createShadowRuntimeService({ runtime });
  const rooms = new Map();
  const player = { id: 'p1' };
  const options = { player };

  assert.equal(isolated.runtime, runtime);
  assert.deepEqual(isolated.accept(options), { accepted: true });
  assert.equal(isolated.tick(rooms, 123), 17);
  assert.deepEqual(isolated.snapshot(player), { matchId: 'm1' });
  assert.deepEqual(isolated.metrics(), { processed: 3 });
  assert.equal(calls.length, 4);
  assert.equal(calls[0][0], 'accept');
  assert.equal(calls[0][1], options);
  assert.equal(calls[1][0], 'tick');
  assert.equal(calls[1][1], rooms);
  assert.equal(calls[1][2], 123);
  assert.equal(calls[2][0], 'snapshot');
  assert.equal(calls[2][1], player);
  assert.equal(calls[3][0], 'metrics');
});

test('shadow runtime service rejects incomplete runtime implementations', () => {
  let failure = null;
  try {
    service.createShadowRuntimeService({ runtime: { accept() {} } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof TypeError);
  assert.match(failure.message, /requires accept, tick, snapshot and metrics/);
});
