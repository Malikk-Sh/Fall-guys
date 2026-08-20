import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const service = require('./shadowRuntimeService');

test('shadow runtime service is a process-local CommonJS singleton', () => {
  assert.equal(require('./shadowRuntimeService'), service);
  assert.ok(service.runtime);
  for (const method of ['accept', 'tick', 'snapshot', 'metrics']) {
    assert.equal(typeof service[method], 'function');
  }
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
  assert.deepEqual(calls, [
    ['accept', options],
    ['tick', rooms, 123],
    ['snapshot', player],
    ['metrics']
  ]);
});

test('shadow runtime service rejects incomplete runtime implementations', () => {
  assert.throws(
    () => service.createShadowRuntimeService({ runtime: { accept() {} } }),
    /requires accept, tick, snapshot and metrics/
  );
});
