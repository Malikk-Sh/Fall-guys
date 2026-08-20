import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { C2S, S2C, GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { createShadowRaceProgressDiagnostics } = require('./shadowRaceProgressDiagnostics');

function fixture() {
  const room = {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'match-a',
    spec: { segmentCount: 3 }
  };
  const player = {
    id: 'p1',
    checkpoint: 1,
    finished: false,
    lastSequence: 7
  };
  return { room, player };
}

function candidate(overrides = {}) {
  return {
    matchId: 'match-a',
    serverTick: 12,
    lastProcessedInput: 4,
    checkpoint: 1,
    finished: false,
    finishServerTick: null,
    ...overrides
  };
}

test('accepted legacy state is sampled only after core applies the matching sequence', () => {
  const diagnostics = createShadowRaceProgressDiagnostics({ candidateFor: () => candidate() });
  const { room, player } = fixture();

  assert.equal(
    diagnostics.observeAcceptedState({
      message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 6 },
      room,
      player
    }),
    null
  );
  assert.equal(diagnostics.metrics().boundarySamples, 0);

  const sample = diagnostics.observeAcceptedState({
    message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 7 },
    room,
    player
  });
  assert.deepEqual(sample, {
    available: true,
    boundary: 'state',
    matchId: 'match-a',
    serverTick: 12,
    lastProcessedInput: 4,
    legacyCheckpoint: 1,
    shadowCheckpoint: 1,
    checkpointDelta: 0,
    legacyFinished: false,
    shadowFinished: false,
    finishMatch: null
  });
  assert.deepEqual(diagnostics.metrics(), {
    boundarySamples: 1,
    stateSamples: 1,
    finishAcceptedSamples: 0,
    finishRejectedSamples: 0,
    candidateAvailableSamples: 1,
    candidateUnavailableSamples: 0,
    invalidLegacySamples: 0,
    checkpointMatches: 1,
    checkpointMismatches: 0,
    shadowAheadSamples: 0,
    legacyAheadSamples: 0,
    finishComparableSamples: 0,
    finishMatches: 0,
    finishMismatches: 0,
    acceptedButShadowUnfinishedSamples: 0,
    rejectedButShadowFinishedSamples: 0,
    maxCheckpointDelta: 0,
    availabilityRate: 1,
    checkpointMismatchRate: 0,
    finishMismatchRate: 0
  });
});

test('checkpoint diagnostics preserve whether shadow or legacy is ahead', () => {
  let next = candidate({ checkpoint: 3 });
  const diagnostics = createShadowRaceProgressDiagnostics({ candidateFor: () => next });
  const { room, player } = fixture();

  diagnostics.observeAcceptedState({
    message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 7 },
    room,
    player
  });
  next = candidate({ checkpoint: 0 });
  diagnostics.observeAcceptedState({
    message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 7 },
    room,
    player
  });

  const metrics = diagnostics.metrics();
  assert.equal(metrics.checkpointMismatches, 2);
  assert.equal(metrics.shadowAheadSamples, 1);
  assert.equal(metrics.legacyAheadSamples, 1);
  assert.equal(metrics.maxCheckpointDelta, 2);
  assert.equal(metrics.checkpointMismatchRate, 1);
});

test('core finish outcomes compare accepted and rejected decisions with shadow finish state', () => {
  let next = candidate({ checkpoint: 3, finished: true, finishServerTick: 12 });
  const diagnostics = createShadowRaceProgressDiagnostics({ candidateFor: () => next });
  const { room, player } = fixture();
  player.checkpoint = 3;
  player.finished = true;

  const accepted = diagnostics.observeOutcomePayload({
    payload: JSON.stringify({
      type: S2C.PLAYER_FINISHED,
      matchId: room.matchId,
      id: player.id,
      time: 1000
    }),
    room,
    player
  });
  assert.equal(accepted.boundary, 'finish-accepted');
  assert.equal(accepted.finishMatch, true);

  player.finished = false;
  next = candidate({ checkpoint: 3, finished: true, finishServerTick: 12 });
  const rejected = diagnostics.observeOutcomePayload({
    payload: JSON.stringify({ type: S2C.FINISH_REJECTED, matchId: room.matchId }),
    room,
    player
  });
  assert.equal(rejected.boundary, 'finish-rejected');
  assert.equal(rejected.finishMatch, false);

  assert.equal(
    diagnostics.observeOutcomePayload({
      payload: JSON.stringify({
        type: S2C.PLAYER_FINISHED,
        matchId: room.matchId,
        id: 'someone-else'
      }),
      room,
      player
    }),
    null
  );

  const metrics = diagnostics.metrics();
  assert.equal(metrics.finishAcceptedSamples, 1);
  assert.equal(metrics.finishRejectedSamples, 1);
  assert.equal(metrics.finishComparableSamples, 2);
  assert.equal(metrics.finishMatches, 1);
  assert.equal(metrics.finishMismatches, 1);
  assert.equal(metrics.rejectedButShadowFinishedSamples, 1);
  assert.equal(metrics.acceptedButShadowUnfinishedSamples, 0);
  assert.equal(metrics.finishMismatchRate, 0.5);
});

test('unavailable candidates, malformed legacy state and co-op stay diagnostic-only', () => {
  const diagnostics = createShadowRaceProgressDiagnostics({ candidateFor: () => null });
  const { room, player } = fixture();

  const unavailable = diagnostics.observeAcceptedState({
    message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 7 },
    room,
    player
  });
  assert.deepEqual(unavailable, {
    available: false,
    boundary: 'state',
    reason: 'candidate-unavailable'
  });

  player.checkpoint = 'bad';
  const invalid = diagnostics.observeOutcomePayload({
    payload: JSON.stringify({ type: S2C.FINISH_REJECTED, matchId: room.matchId }),
    room,
    player
  });
  assert.deepEqual(invalid, {
    available: false,
    boundary: 'finish-rejected',
    reason: 'invalid-legacy'
  });

  room.mode = GAME_MODE.COOP;
  assert.equal(
    diagnostics.observeAcceptedState({
      message: { type: C2S.PLAYER_STATE, matchId: room.matchId, sequence: 7 },
      room,
      player
    }),
    null
  );
  assert.equal(diagnostics.observeOutcomePayload({ payload: '{', room, player }), null);

  const metrics = diagnostics.metrics();
  assert.equal(metrics.boundarySamples, 2);
  assert.equal(metrics.candidateUnavailableSamples, 1);
  assert.equal(metrics.invalidLegacySamples, 1);
  assert.equal(metrics.availabilityRate, 0);

  diagnostics.reset();
  assert.equal(diagnostics.metrics().boundarySamples, 0);
});
