import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createCourseSpec } = require('../shared/courseSpec.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const { createRaceFinishAuthorityCoreBridge } = require('./raceFinishAuthorityCoreBridge');
const { RACE_FINISH_Z_TOLERANCE } = require('./raceProgressSpatialGuard');

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

function fixture({ outcome = decision(), error = null, legacyResult = true, validateResult = null } = {}) {
  const decisionCalls = [];
  const legacyCalls = [];
  const validationCalls = [];
  const finishDecision = {
    decide(options) {
      decisionCalls.push(options);
      if (error) throw error;
      return outcome;
    }
  };
  const gameRules = {
    validateState(currentPlayer, value, spec, now) {
      validationCalls.push({ player: currentPlayer, value, spec, now });
      if (typeof validateResult === 'function') return validateResult(currentPlayer, value, spec, now);
      if (validateResult) return validateResult;
      return { ok: true, state: { ...value }, checkpoint: currentPlayer.checkpoint };
    },
    canFinish(currentPlayer, spec) {
      legacyCalls.push({ player: currentPlayer, spec });
      return legacyResult;
    }
  };
  const bridge = createRaceFinishAuthorityCoreBridge({ finishDecision });
  assert.equal(bridge.installGameRules(gameRules), true);
  return { bridge, gameRules, decisionCalls, legacyCalls, validationCalls };
}

function acceptState(gameRules, currentPlayer, spec, state, now) {
  const result = gameRules.validateState(currentPlayer, state, spec, now);
  assert.equal(result.ok, true);
  currentPlayer.last = { ...result.state };
  return result;
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

test('legacy finish requires a valid crossing point and keeps it across the trailing finish packet', () => {
  const spec = createCourseSpec(9, 'easy');
  const line = spec.finishZ + RACE_FINISH_Z_TOLERANCE;
  const currentPlayer = player({
    checkpoint: spec.segmentCount,
    last: { x: 20, y: 1, z: line + 0.1 }
  });
  const { bridge, gameRules, legacyCalls } = fixture({ legacyResult: true });
  bridge.attachPlayer(currentPlayer);

  // This is the P1 bypass: the packet endpoint is centered on the course, but interpolation shows
  // that the finish plane itself was crossed far outside the finish runout.
  acceptState(gameRules, currentPlayer, spec, { x: 0, y: 1, z: line - 1 }, 500);
  assert.equal(gameRules.canFinish(currentPlayer, spec), false);
  assert.equal(legacyCalls.length, 0, 'invalid spatial crossing never reaches the legacy finish gate');

  // Returning in front of the line clears any old evidence. A clean crossing through the actual
  // finish region then latches, and a later FINISH packet may remain behind the line without having
  // to cross it a second time.
  acceptState(gameRules, currentPlayer, spec, { x: 0, y: 1, z: line + 0.2 }, 600);
  acceptState(gameRules, currentPlayer, spec, { x: 0, y: 1, z: line - 0.2 }, 700);
  acceptState(gameRules, currentPlayer, spec, { x: 0.2, y: 1, z: line - 0.5 }, 800);
  assert.equal(gameRules.canFinish(currentPlayer, spec), true, 'valid crossing survives the trailing finish state');
  assert.equal(legacyCalls.length, 1);

  // A respawn/return before the plane invalidates the latch; it cannot authorize a later bypass.
  acceptState(gameRules, currentPlayer, spec, { x: 0, y: 1, z: line + 0.3 }, 900);
  assert.equal(gameRules.canFinish(currentPlayer, spec), false);
  assert.equal(legacyCalls.length, 1);
});

test('legacy finish rejects a crossing high above the course even when the endpoint returns inside', () => {
  const spec = createCourseSpec(19, 'easy');
  const line = spec.finishZ + RACE_FINISH_Z_TOLERANCE;
  const currentPlayer = player({
    checkpoint: spec.segmentCount,
    last: { x: 0, y: 7, z: line + 0.1 }
  });
  const { bridge, gameRules, legacyCalls } = fixture({ legacyResult: true });
  bridge.attachPlayer(currentPlayer);

  acceptState(gameRules, currentPlayer, spec, { x: 0, y: 1, z: line - 1 }, 500);
  assert.equal(gameRules.canFinish(currentPlayer, spec), false);
  assert.equal(legacyCalls.length, 0);
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

test('shadow accept does not re-check the lagging client snapshot', () => {
  const spec = createCourseSpec(11, 'easy');
  const currentPlayer = player({
    checkpoint: spec.segmentCount,
    // A shadow finish has already been spatially checked against server-owned simulation. This
    // snapshot is intentionally stale/invalid for the finish region and must not override it.
    last: { x: 20, y: 20, z: spec.finishZ + 10 }
  });
  const { bridge, gameRules, legacyCalls } = fixture({
    legacyResult: false,
    outcome: decision({
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: true,
      progress: { checkpoint: spec.segmentCount, finished: true },
      finishTimeMs: 450,
      finishServerTime: 1450,
      finishServerTick: 29,
      serverTick: 30,
      lastProcessedInput: 7
    })
  });

  bridge.attachPlayer(currentPlayer);
  bridge.prepare({ room: { matchId: 'm1', spec }, player: currentPlayer });
  assert.equal(gameRules.canFinish(currentPlayer, spec), true);
  assert.equal(legacyCalls.length, 0);
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
  assert.equal(gameRules.validateState, bridge.validateState);
  assert.equal(gameRules.canFinish, bridge.canFinish);
});
