import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { C2S, S2C, GAME_MODE } = require('../shared/protocol.js');
const {
  sameProgress,
  createRaceProgressAuthorityBoundaryVerification
} = require('./raceProgressAuthorityBoundaryVerification');

function room(overrides = {}) {
  return { mode: GAME_MODE.RACE, matchId: 'm1', ...overrides };
}

function player(overrides = {}) {
  return { id: 'p1', checkpoint: 1, finished: false, ...overrides };
}

function probeResult(progress) {
  return { legacyProgress: progress };
}

test('sameProgress compares only checkpoint and finished state', () => {
  assert.equal(sameProgress({ checkpoint: 2, finished: false }, { checkpoint: 2, finished: false }), true);
  assert.equal(sameProgress({ checkpoint: 2, finished: false }, { checkpoint: 3, finished: false }), false);
  assert.equal(sameProgress({ checkpoint: 2, finished: false }, { checkpoint: 2, finished: true }), false);
  assert.equal(sameProgress(null, { checkpoint: 2, finished: false }), false);
});

test('accepted state verifies the pre-mutation proposal against the core player outcome', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player();
  const message = { type: C2S.PLAYER_STATE, sequence: 7 };

  assert.equal(
    verification.remember({
      room: room(),
      player: racer,
      message,
      probeResult: probeResult({ checkpoint: 2, finished: false })
    }),
    true
  );
  racer.checkpoint = 2;
  const result = verification.observeAcceptedState({ room: room(), player: racer, message });

  assert.equal(result.match, true);
  assert.deepEqual(result.expected, { checkpoint: 2, finished: false });
  assert.deepEqual(result.actual, { checkpoint: 2, finished: false });
  assert.deepEqual(verification.metrics(), {
    remembered: 1,
    stateComparisons: 1,
    stateMismatches: 0,
    finishComparisons: 0,
    finishMismatches: 0,
    stalePending: 0,
    missingPending: 0
  });
});

test('state mismatch is measured without changing the core outcome', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player({ checkpoint: 1 });
  const message = { type: C2S.PLAYER_STATE, sequence: 8 };
  verification.remember({
    room: room(),
    player: racer,
    message,
    probeResult: probeResult({ checkpoint: 2, finished: false })
  });
  const before = structuredClone(racer);
  const result = verification.observeAcceptedState({ room: room(), player: racer, message });

  assert.equal(result.match, false);
  assert.deepEqual(racer, before);
  assert.equal(verification.metrics().stateMismatches, 1);
});

test('accepted finish verifies only for the player named by PLAYER_FINISHED', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player({ checkpoint: 3 });
  const message = { type: C2S.FINISH, sequence: 9 };
  verification.remember({
    room: room(),
    player: racer,
    message,
    probeResult: probeResult({ checkpoint: 3, finished: true })
  });
  racer.finished = true;

  assert.equal(
    verification.observeOutcomePayload({
      payload: JSON.stringify({ type: S2C.PLAYER_FINISHED, matchId: 'm1', id: 'other' }),
      room: room(),
      player: racer
    }),
    null
  );
  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: S2C.PLAYER_FINISHED, matchId: 'm1', id: 'p1' }),
    room: room(),
    player: racer
  });

  assert.equal(result.match, true);
  assert.equal(verification.metrics().finishComparisons, 1);
  assert.equal(verification.metrics().missingPending, 0);
});

test('rejected finish compares the final checkpoint and unfinished core state', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player({ checkpoint: 2 });
  verification.remember({
    room: room(),
    player: racer,
    message: { type: C2S.FINISH, sequence: 10 },
    probeResult: probeResult({ checkpoint: 3, finished: false })
  });
  racer.checkpoint = 3;

  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: S2C.FINISH_REJECTED, matchId: 'm1' }),
    room: room(),
    player: racer
  });

  assert.equal(result.match, true);
  assert.deepEqual(result.actual, { checkpoint: 3, finished: false });
  assert.equal(verification.metrics().finishMismatches, 0);
});

test('stale sequence or match clears a pending projection without comparison', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player();
  verification.remember({
    room: room(),
    player: racer,
    message: { type: C2S.PLAYER_STATE, sequence: 11 },
    probeResult: probeResult({ checkpoint: 2, finished: false })
  });

  assert.equal(
    verification.observeAcceptedState({
      room: room(),
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 12 }
    }),
    null
  );
  assert.equal(verification.metrics().stalePending, 1);
  assert.equal(verification.metrics().stateComparisons, 0);
});

test('co-op outcomes are ignored instead of counted as missing race projections', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const coopRoom = room({ mode: GAME_MODE.COOP });
  const racer = player();

  assert.equal(
    verification.remember({
      room: coopRoom,
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 1 },
      probeResult: probeResult({ checkpoint: 1, finished: false })
    }),
    false
  );
  assert.equal(
    verification.observeAcceptedState({
      room: coopRoom,
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 1 }
    }),
    null
  );
  assert.equal(verification.metrics().missingPending, 0);
});

test('reset clears counters and pending projections', () => {
  const verification = createRaceProgressAuthorityBoundaryVerification();
  const racer = player();
  const message = { type: C2S.PLAYER_STATE, sequence: 13 };
  verification.remember({
    room: room(),
    player: racer,
    message,
    probeResult: probeResult({ checkpoint: 2, finished: false })
  });

  verification.reset();
  assert.equal(verification.metrics().remembered, 0);
  assert.equal(verification.observeAcceptedState({ room: room(), player: racer, message }), null);
  assert.equal(verification.metrics().missingPending, 1);
});
