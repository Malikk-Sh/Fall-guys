import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { validateMessage } from '../shared/validation.js';
import { loadStateMessage, loadTargets, httpBaseFromWebSocket } from './loadProbeConfig.mjs';

const require = createRequire(import.meta.url);
const { buildIdentity, normalizeCommit } = require('./buildInfo.js');
const { trackSignatureMetrics } = require('./signatureMetrics.js');

function fakeGameplay() {
  const calls = [];
  return {
    calls,
    count(metric, dimensions) {
      calls.push({ type: 'count', metric, dimensions });
      return true;
    },
    observe(metric, value, dimensions) {
      calls.push({ type: 'observe', metric, value, dimensions });
      return true;
    }
  };
}

const dimensions = (_room, _player, detail) => ({
  mode: 'coop',
  course: 'ch7',
  detail,
  device: 'mobile'
});

function acceptedSignature(signature) {
  return { ok: true, relay: { action: 'signatureState', signature } };
}

test('build identity нормализует commit и берёт точную версию package', () => {
  assert.equal(normalizeCommit('  0123456789abcdef  '), '0123456789ab');
  assert.equal(normalizeCommit(''), 'unknown');
  assert.deepEqual(
    buildIdentity({ env: { WOBBLE_BUILD_SHA: 'abcdef0123456789' }, startedAt: '2026-08-10T00:00:00.000Z' }),
    {
      version: '2.4.0',
      commit: 'abcdef012345',
      startedAt: '2026-08-10T00:00:00.000Z'
    }
  );
});

test('load targets разделяют WebSocket, HTTP и PID наблюдателя', () => {
  assert.equal(httpBaseFromWebSocket('wss://game.example/ws'), 'https://game.example');
  assert.equal(httpBaseFromWebSocket('ws://127.0.0.1:3000/ws'), 'http://127.0.0.1:3000');
  assert.deepEqual(
    loadTargets({
      WOBBLE_WS_URL: 'wss://game.example/ws',
      WOBBLE_HTTP_URL: 'https://health.example/',
      WOBBLE_SERVER_PID: '4321'
    }),
    {
      wsUrl: 'wss://game.example/ws',
      httpUrl: 'https://health.example',
      serverPid: '4321'
    }
  );
  assert.equal(loadTargets({ WOBBLE_URL: 'ws://legacy.example/ws' }).httpUrl, 'http://legacy.example');
});

test('load probe snapshots соответствуют текущей state-схеме протокола', () => {
  const message = loadStateMessage({ matchId: 'load-match', sequence: 17, z: -24.5 });
  assert.deepEqual(validateMessage(message), { ok: true });
  assert.equal(message.sequence, 17);
  assert.equal(message.state.z, -24.5);
});

test('Energy Core metrics считаются только по принятому сервером lifecycle', () => {
  const room = { matchId: 'm1' };
  const player = { id: 'p1' };
  const gameplay = fakeGameplay();
  const core = { id: 'core', position: {}, carrier: 'p1', insertedInto: null };

  assert.equal(
    trackSignatureMetrics({
      room,
      player,
      message: { objectId: 'core:pickup' },
      result: acceptedSignature({ core, signal: null }),
      gameplay,
      dimensions,
      now: 1000
    }),
    true
  );
  trackSignatureMetrics({
    room,
    player,
    message: { objectId: 'core:throw' },
    result: acceptedSignature({ core: { ...core, carrier: null }, signal: null }),
    gameplay,
    dimensions,
    now: 1400
  });
  trackSignatureMetrics({
    room,
    player,
    message: { objectId: 'core:insert' },
    result: acceptedSignature({ core: { ...core, carrier: null, insertedInto: 'socket' }, signal: null }),
    gameplay,
    dimensions,
    now: 3100
  });

  assert.deepEqual(
    gameplay.calls.map(call => [call.type, call.metric, call.value ?? null]),
    [
      ['count', 'core_pickup', null],
      ['count', 'core_throw', null],
      ['count', 'core_insert', null],
      ['observe', 'core_time_to_insert', 2100]
    ]
  );

  const before = gameplay.calls.length;
  assert.equal(
    trackSignatureMetrics({
      room,
      player,
      message: { objectId: 'core:pickup' },
      result: { ok: false },
      gameplay,
      dimensions,
      now: 4000
    }),
    false
  );
  assert.equal(gameplay.calls.length, before);
});

test('Signal metrics различают ошибку, reset и одно успешное решение', () => {
  const room = { matchId: 'm2' };
  const player = { id: 'operator' };
  const gameplay = fakeGameplay();

  trackSignatureMetrics({
    room,
    player,
    message: { objectId: 'signal:press:2' },
    result: acceptedSignature({ core: null, signal: { progress: 0, solved: false } }),
    gameplay,
    dimensions,
    now: 5000
  });
  trackSignatureMetrics({
    room,
    player,
    message: { objectId: 'signal:press:1' },
    result: acceptedSignature({ core: null, signal: { progress: 4, solved: true } }),
    gameplay,
    dimensions,
    now: 8200
  });
  // Повторное серверное состояние solved не должно удваивать funnel.
  trackSignatureMetrics({
    room,
    player,
    message: { objectId: 'signal:press:1' },
    result: acceptedSignature({ core: null, signal: { progress: 4, solved: true } }),
    gameplay,
    dimensions,
    now: 9000
  });

  assert.deepEqual(
    gameplay.calls.map(call => [call.type, call.metric, call.value ?? null]),
    [
      ['count', 'signal_wrong_press', null],
      ['count', 'signal_reset', null],
      ['count', 'signal_solved', null],
      ['observe', 'signal_solve_ms', 3200]
    ]
  );
});
