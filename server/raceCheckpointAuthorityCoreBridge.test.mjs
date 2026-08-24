import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE } = require('../shared/protocol.js');
const { createCourseSpec } = require('../shared/courseSpec.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  createRaceCheckpointAuthorityCoreBridge,
  validCheckpoint
} = require('./raceCheckpointAuthorityCoreBridge');

function room(overrides = {}) {
  const current = {
    mode: GAME_MODE.RACE,
    matchId: 'm1',
    spec: { segmentCount: 4 },
    players: new Map(),
    ...overrides
  };
  return current;
}

function player(overrides = {}) {
  return {
    id: 'p1',
    checkpoint: 1,
    ...overrides
  };
}

function legacyResult(checkpoint = 2) {
  return {
    ok: true,
    state: {
      x: 1,
      y: 2,
      z: -20,
      ry: 0,
      vx: 0,
      vy: 0,
      vz: -8,
      state: 'ground',
      checkpoint
    },
    checkpoint
  };
}

function fixture({ source = AUTHORITY_SOURCE.SHADOW, validateResult = legacyResult() } = {}) {
  const legacyCalls = [];
  const gameRules = {
    validateState(...args) {
      legacyCalls.push(args);
      return validateResult;
    }
  };
  const matchGuard = {
    sourceFor() {
      if (source instanceof Error) throw source;
      return source;
    }
  };
  const bridge = createRaceCheckpointAuthorityCoreBridge({ matchGuard });
  bridge.installGameRules(gameRules);
  return { bridge, gameRules, legacyCalls };
}

function attach(bridge, currentRoom, currentPlayer) {
  currentRoom.players.set(currentPlayer.id, currentPlayer);
  bridge.attachPlayer(currentPlayer, currentRoom);
}

test('legacy and unlatched matches keep the complete legacy validation result', () => {
  for (const source of [AUTHORITY_SOURCE.LEGACY, null]) {
    const expected = legacyResult(2);
    const { bridge, gameRules } = fixture({ source, validateResult: expected });
    const currentRoom = room();
    const currentPlayer = player();
    attach(bridge, currentRoom, currentPlayer);

    const actual = gameRules.validateState(currentPlayer, {}, currentRoom.spec, 500);
    assert.equal(actual, expected);
    assert.equal(actual.checkpoint, 2);
    assert.equal(actual.state.checkpoint, 2);
    assert.equal(bridge.metrics().shadowProjections, 0);
  }
});

test('race checkpoint advance is suppressed outside the course corridor without rejecting movement', () => {
  const spec = createCourseSpec(7, 'easy');
  const currentRoom = room({ spec });
  const currentPlayer = player({ checkpoint: 0 });
  const line = spec.checkpoints[0];
  const outside = legacyResult(1);
  outside.state = { ...outside.state, x: 20, y: 1, z: line - 0.2, checkpoint: 1 };
  const { bridge, gameRules } = fixture({
    source: AUTHORITY_SOURCE.LEGACY,
    validateResult: outside
  });
  attach(bridge, currentRoom, currentPlayer);

  const actual = gameRules.validateState(currentPlayer, {}, spec, 500);
  assert.equal(actual.ok, true, 'movement validation stays accepted');
  assert.equal(actual.checkpoint, 0, 'being beside the course cannot grant the checkpoint');
  assert.equal(actual.state.checkpoint, 0);
});

test('race checkpoint advance is suppressed high above the course', () => {
  const spec = createCourseSpec(8, 'easy');
  const currentRoom = room({ spec });
  const currentPlayer = player({ checkpoint: 0 });
  const high = legacyResult(1);
  high.state = { ...high.state, x: 0, y: 7, z: spec.checkpoints[0] - 0.2, checkpoint: 1 };
  const { bridge, gameRules } = fixture({
    source: AUTHORITY_SOURCE.LEGACY,
    validateResult: high
  });
  attach(bridge, currentRoom, currentPlayer);

  const actual = gameRules.validateState(currentPlayer, {}, spec, 500);
  assert.equal(actual.ok, true, 'high state is still movement; only result progress is refused');
  assert.equal(actual.checkpoint, 0);
  assert.equal(actual.state.checkpoint, 0);
});

test('shadow-latched race preserves movement validation but suppresses client checkpoint advance', () => {
  const expected = legacyResult(2);
  const { bridge, gameRules, legacyCalls } = fixture({ validateResult: expected });
  const currentRoom = room();
  const currentPlayer = player({ checkpoint: 1 });
  attach(bridge, currentRoom, currentPlayer);

  const value = { x: 1 };
  const actual = gameRules.validateState(currentPlayer, value, currentRoom.spec, 500);

  assert.notEqual(actual, expected);
  assert.equal(actual.ok, true);
  assert.equal(actual.checkpoint, 1);
  assert.equal(actual.state.checkpoint, 1);
  assert.deepEqual(
    { ...actual.state, checkpoint: expected.state.checkpoint },
    expected.state,
    'position, velocity and movement state still come from the legacy validator'
  );
  assert.deepEqual(legacyCalls, [[currentPlayer, value, currentRoom.spec, 500]]);
  assert.deepEqual(bridge.metrics(), {
    calls: 1,
    legacyDecisions: 0,
    shadowProjections: 1,
    clientCheckpointSuppressed: 1,
    errors: 0
  });
});

test('shadow projection also blocks a client checkpoint rollback', () => {
  const { bridge, gameRules } = fixture({ validateResult: legacyResult(1) });
  const currentRoom = room();
  const currentPlayer = player({ checkpoint: 2 });
  attach(bridge, currentRoom, currentPlayer);

  const actual = gameRules.validateState(currentPlayer, {}, currentRoom.spec, 500);
  assert.equal(actual.checkpoint, 2);
  assert.equal(actual.state.checkpoint, 2);
  assert.equal(bridge.metrics().clientCheckpointSuppressed, 1);
});

test('invalid movement results pass through without authority projection', () => {
  const invalid = { ok: false, reason: 'speed', position: { x: 0, y: 1, z: 2 } };
  const { bridge, gameRules } = fixture({ validateResult: invalid });
  const currentRoom = room();
  const currentPlayer = player();
  attach(bridge, currentRoom, currentPlayer);

  assert.equal(gameRules.validateState(currentPlayer, {}, currentRoom.spec, 500), invalid);
  assert.equal(bridge.metrics().shadowProjections, 0);
});

test('co-op, stale room association and guard errors fail open to legacy validation', () => {
  const coop = fixture();
  const coopRoom = room({ mode: GAME_MODE.COOP });
  const coopPlayer = player();
  attach(coop.bridge, coopRoom, coopPlayer);
  assert.equal(coop.gameRules.validateState(coopPlayer, {}, coopRoom.spec, 500).checkpoint, 2);

  const stale = fixture();
  const staleRoom = room();
  const stalePlayer = player();
  stale.bridge.attachPlayer(stalePlayer, staleRoom);
  assert.equal(stale.gameRules.validateState(stalePlayer, {}, staleRoom.spec, 500).checkpoint, 2);

  const guardFailure = fixture({ source: new Error('lease unavailable') });
  const guardedRoom = room();
  const guardedPlayer = player();
  attach(guardFailure.bridge, guardedRoom, guardedPlayer);
  assert.equal(guardFailure.gameRules.validateState(guardedPlayer, {}, guardedRoom.spec, 500).checkpoint, 2);
  assert.equal(guardFailure.bridge.metrics().errors, 1);
});

test('invalid authoritative checkpoint fails open and bridge installation is idempotent', () => {
  const { bridge, gameRules } = fixture();
  const currentRoom = room();
  const currentPlayer = player({ checkpoint: 5 });
  attach(bridge, currentRoom, currentPlayer);

  assert.equal(gameRules.validateState(currentPlayer, {}, currentRoom.spec, 500).checkpoint, 2);
  assert.equal(bridge.metrics().errors, 1);
  assert.equal(bridge.installGameRules(gameRules), false);
  assert.equal(bridge.managesPlayer(currentPlayer), true);
  assert.equal(bridge.detachPlayer(currentPlayer), true);
  assert.equal(bridge.managesPlayer(currentPlayer), false);
});

test('checkpoint validation stays bounded by the server course', () => {
  const currentRoom = room();
  assert.equal(validCheckpoint(currentRoom, 0), true);
  assert.equal(validCheckpoint(currentRoom, 4), true);
  assert.equal(validCheckpoint(currentRoom, 5), false);
  assert.equal(validCheckpoint(currentRoom, -1), false);
  assert.equal(validCheckpoint(room({ spec: {} }), 0), false);
});
