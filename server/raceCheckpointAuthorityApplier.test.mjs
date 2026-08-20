import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  createRaceCheckpointAuthorityApplier,
  validCourseCheckpoint
} = require('./raceCheckpointAuthorityApplier');

function room(overrides = {}) {
  return {
    mode: GAME_MODE.RACE,
    matchId: 'match-a',
    spec: { segmentCount: 4 },
    ...overrides
  };
}

function player(overrides = {}) {
  return {
    checkpoint: 1,
    checkpointAt: 100,
    finished: false,
    time: null,
    last: { x: 1, y: 2, z: -20, checkpoint: 1 },
    ...overrides
  };
}

function decision(source, checkpoint, fallbackReason = null) {
  return Object.freeze({
    ok: true,
    source,
    fallbackReason,
    progress: Object.freeze({ checkpoint, finished: false })
  });
}

function fixture(results) {
  const calls = [];
  let index = 0;
  const matchGuard = {
    decide(options) {
      calls.push(options);
      const value = results[Math.min(index, results.length - 1)];
      index += 1;
      if (value instanceof Error) throw value;
      return value;
    }
  };
  return {
    calls,
    applier: createRaceCheckpointAuthorityApplier({ matchGuard })
  };
}

test('legacy decision preserves the complete player state', () => {
  const current = player();
  const before = structuredClone(current);
  const { applier, calls } = fixture([decision(AUTHORITY_SOURCE.LEGACY, 1, 'shadow-not-ready')]);

  const result = applier.apply({ room: room(), player: current, now: 500 });

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.applied, false);
  assert.equal(result.fallbackReason, 'shadow-not-ready');
  assert.deepEqual(current, before);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].legacyProgress, { checkpoint: 1, finished: false });
});

test('shadow decision advances only checkpoint authority and checkpoint time', () => {
  const current = player();
  const previousLast = current.last;
  const { applier } = fixture([decision(AUTHORITY_SOURCE.SHADOW, 2)]);

  const result = applier.apply({ room: room(), player: current, now: 500 });

  assert.equal(result.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(result.applied, true);
  assert.equal(result.previousCheckpoint, 1);
  assert.equal(result.checkpoint, 2);
  assert.equal(current.checkpoint, 2);
  assert.equal(current.checkpointAt, 500);
  assert.equal(current.finished, false);
  assert.equal(current.time, null);
  assert.equal(current.last, previousLast);
  assert.deepEqual(current.last, { x: 1, y: 2, z: -20, checkpoint: 1 });
});

test('unchanged shadow checkpoint does not rewrite checkpoint timing', () => {
  const current = player();
  const { applier } = fixture([decision(AUTHORITY_SOURCE.SHADOW, 1)]);

  const result = applier.apply({ room: room(), player: current, now: 500 });

  assert.equal(result.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(result.applied, false);
  assert.equal(current.checkpoint, 1);
  assert.equal(current.checkpointAt, 100);
});

test('shadow checkpoint rollback and out-of-course checkpoint fail closed', () => {
  const current = player({ checkpoint: 2 });
  const { applier } = fixture([
    decision(AUTHORITY_SOURCE.SHADOW, 1),
    decision(AUTHORITY_SOURCE.SHADOW, 5)
  ]);

  const rollback = applier.apply({ room: room(), player: current, now: 500 });
  const outsideCourse = applier.apply({ room: room(), player: current, now: 600 });

  assert.equal(rollback.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(rollback.fallbackReason, 'invalid-shadow-checkpoint');
  assert.equal(outsideCourse.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(outsideCourse.fallbackReason, 'invalid-shadow-checkpoint');
  assert.equal(current.checkpoint, 2);
  assert.equal(current.checkpointAt, 100);
});

test('co-op and already-finished players never consult the race guard', () => {
  const { applier, calls } = fixture([decision(AUTHORITY_SOURCE.SHADOW, 2)]);

  assert.equal(applier.apply({ room: room({ mode: GAME_MODE.COOP }), player: player(), now: 500 }), null);
  assert.equal(applier.apply({ room: room(), player: player({ finished: true }), now: 500 }), null);
  assert.equal(calls.length, 0);
});

test('guard errors fail open to unchanged legacy gameplay state', () => {
  const current = player();
  const before = structuredClone(current);
  const { applier } = fixture([new Error('readiness unavailable')]);

  assert.equal(applier.apply({ room: room(), player: current, now: 500 }), null);
  assert.deepEqual(current, before);
  assert.equal(applier.metrics().errors, 1);
});

test('metrics distinguish legacy, shadow, apply and rejected decisions', () => {
  const current = player();
  const { applier } = fixture([
    decision(AUTHORITY_SOURCE.LEGACY, 1),
    decision(AUTHORITY_SOURCE.SHADOW, 1),
    decision(AUTHORITY_SOURCE.SHADOW, 2),
    decision(AUTHORITY_SOURCE.SHADOW, 1)
  ]);

  applier.apply({ room: room(), player: current, now: 200 });
  applier.apply({ room: room(), player: current, now: 300 });
  applier.apply({ room: room(), player: current, now: 400 });
  applier.apply({ room: room(), player: current, now: 500 });

  assert.deepEqual(applier.metrics(), {
    attempts: 4,
    legacyDecisions: 1,
    shadowDecisions: 3,
    appliedAdvances: 1,
    unchangedShadowDecisions: 1,
    rejectedShadowDecisions: 1,
    errors: 0
  });
  assert.equal(Object.isFrozen(applier.metrics()), true);

  applier.reset();
  assert.equal(applier.metrics().attempts, 0);
});

test('course checkpoint validation is bounded by server course spec', () => {
  assert.equal(validCourseCheckpoint(room(), 0), true);
  assert.equal(validCourseCheckpoint(room(), 4), true);
  assert.equal(validCourseCheckpoint(room(), 5), false);
  assert.equal(validCourseCheckpoint(room(), -1), false);
  assert.equal(validCourseCheckpoint(room({ spec: {} }), 0), false);
});
