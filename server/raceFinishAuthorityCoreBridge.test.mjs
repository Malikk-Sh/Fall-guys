import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const { createRaceFinishAuthorityCoreBridge } = require('./raceFinishAuthorityCoreBridge');

function player(overrides = {}) {
  return {
    checkpoint: 2,
    finished: false,
    time: null,
    ...overrides
  };
}

function decision(overrides = {}) {
  return Object.freeze({
    ok: true,
    source: AUTHORITY_SOURCE.LEGACY,
    handled: false,
    accept: null,
    fallbackReason: null,
    progress: { checkpoint: 2, finished: false },
    finishTimeMs: null,
    ...overrides
  });
}

function fixture({ outcome = decision(), error = null, legacyResult = true } = {}) {
  const decisionCalls = [];
  const legacyCalls = [];
  const finishDecision = {
    decide(options) {
      decisionCalls.push(options);
      if (error) throw error;
      return outcome;
    }
  };
  const gameRules = {
    canFinish(currentPlayer, spec) {
      legacyCalls.push({ player: currentPlayer, spec });
      return legacyResult;
    }
  };
  const bridge = createRaceFinishAuthorityCoreBridge({ finishDecision });
  assert.equal(bridge.installGameRules(gameRules), true);
  return { bridge, gameRules, decisionCalls, legacyCalls };
}

test('legacy authority preserves the original core finish gate and assigned finish time', () => {
  const currentPlayer = player();
  const spec = { segmentCount: 2 };
  const { bridge, gameRules, legacyCalls } = fixture({ legacyResult: true });

  assert.equal(bridge.attachPlayer(currentPlayer), true);
  const prepared = bridge.prepare({ room: { matchId: 'm1' }, player: currentPlayer });
  assert.equal(prepared.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(gameRules.canFinish(currentPlayer, spec), true);
  assert.equal(legacyCalls.length, 1);

  currentPlayer.time = 999;
  assert.equal(currentPlayer.time, 999, 'legacy core assignment remains untouched');
  assert.equal(bridge.hasPending(currentPlayer), false);
});

test('shadow reject blocks the legacy core gate even when legacy would accept', () => {
  const currentPlayer = player();
  const { bridge, gameRules, legacyCalls } = fixture({
    legacyResult: true,
    outcome: decision({
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: false,
      fallbackReason: 'shadow-not-finished'
    })
  });

  bridge.attachPlayer(currentPlayer);
  const prepared = bridge.prepare({ room: { matchId: 'm1' }, player: currentPlayer });

  assert.equal(prepared.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(prepared.accept, false);
  assert.equal(gameRules.canFinish(currentPlayer, {}), false);
  assert.equal(legacyCalls.length, 0, 'shadow authority never falls through to legacy canFinish');
  currentPlayer.time = 777;
  assert.equal(currentPlayer.time, 777, 'a rejected shadow decision cannot inject finish timing');
});

test('shadow accept overrides the legacy gate and captures the server-owned finish time', () => {
  const currentPlayer = player();
  const { bridge, gameRules, legacyCalls } = fixture({
    legacyResult: false,
    outcome: decision({
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: true,
      progress: { checkpoint: 2, finished: true },
      finishTimeMs: 450,
      finishServerTime: 1450,
      finishServerTick: 29,
      serverTick: 30,
      lastProcessedInput: 7
    })
  });

  bridge.attachPlayer(currentPlayer);
  bridge.prepare({ room: { matchId: 'm1' }, player: currentPlayer });

  assert.equal(gameRules.canFinish(currentPlayer, {}), true);
  assert.equal(legacyCalls.length, 0);
  currentPlayer.time = 9999;
  assert.equal(currentPlayer.time, 450, 'core writes the authoritative server finish duration');

  bridge.clear(currentPlayer);
  currentPlayer.time = null;
  assert.equal(currentPlayer.time, null, 'later lifecycle resets are normal after the decision is consumed');
});

test('malformed accepted shadow timing fails closed before core can finish', () => {
  const currentPlayer = player();
  const { bridge, gameRules } = fixture({
    legacyResult: true,
    outcome: decision({
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: true,
      progress: { checkpoint: 2, finished: true },
      finishTimeMs: null
    })
  });

  bridge.attachPlayer(currentPlayer);
  const prepared = bridge.prepare({ room: { matchId: 'm1' }, player: currentPlayer });

  assert.equal(prepared.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(prepared.accept, false);
  assert.equal(gameRules.canFinish(currentPlayer, {}), false);
  assert.equal(bridge.metrics().errors, 1);
});

test('decision failure falls back to the untouched legacy gate', () => {
  const currentPlayer = player();
  const { bridge, gameRules, legacyCalls } = fixture({
    legacyResult: true,
    error: new Error('decision failed')
  });

  bridge.attachPlayer(currentPlayer);
  assert.equal(bridge.prepare({ room: { matchId: 'm1' }, player: currentPlayer }), null);
  assert.equal(gameRules.canFinish(currentPlayer, {}), true);
  assert.equal(legacyCalls.length, 1);
  assert.equal(bridge.metrics().errors, 1);
});

test('player time seam is idempotent and can be restored to plain data', () => {
  const currentPlayer = player({ time: 123 });
  const { bridge } = fixture();

  assert.equal(bridge.attachPlayer(currentPlayer), true);
  assert.equal(bridge.attachPlayer(currentPlayer), false);
  assert.equal(bridge.managesPlayer(currentPlayer), true);
  assert.equal(Object.getOwnPropertyDescriptor(currentPlayer, 'time').get instanceof Function, true);

  assert.equal(bridge.detachPlayer(currentPlayer), true);
  const descriptor = Object.getOwnPropertyDescriptor(currentPlayer, 'time');
  assert.equal(descriptor.get, undefined);
  assert.equal(descriptor.writable, true);
  assert.equal(currentPlayer.time, 123);
  assert.equal(bridge.managesPlayer(currentPlayer), false);
});

test('gameRules installation is idempotent for the same bridge', () => {
  const { bridge, gameRules } = fixture();
  assert.equal(bridge.installGameRules(gameRules), false);
  assert.equal(gameRules.canFinish, bridge.canFinish);
});
