import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  createRaceFinishAuthorityCoreVerification,
  validFinishDecision
} = require('./raceFinishAuthorityCoreVerification');

function room(overrides = {}) {
  return { mode: GAME_MODE.RACE, matchId: 'match-a', ...overrides };
}

function player(overrides = {}) {
  return { id: 'p1', finished: false, time: null, ...overrides };
}

function shadowDecision(overrides = {}) {
  return Object.freeze({
    ok: true,
    source: AUTHORITY_SOURCE.SHADOW,
    handled: true,
    accept: true,
    finishTimeMs: 450,
    ...overrides
  });
}

test('accepted shadow finish is verified against both core outcome and server-owned timing', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentRoom = room();
  const currentPlayer = player({ finished: true, time: 450 });

  assert.equal(
    verification.remember({ room: currentRoom, player: currentPlayer, decision: shadowDecision() }),
    true
  );
  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: 'finish', matchId: 'match-a', id: 'p1', time: 450 }),
    room: currentRoom,
    player: currentPlayer
  });

  assert.equal(result.match, true);
  assert.equal(result.outcomeMatch, true);
  assert.equal(result.timingMatch, true);
  assert.deepEqual(verification.metrics(), {
    remembered: 1,
    comparisons: 1,
    acceptComparisons: 1,
    rejectComparisons: 0,
    outcomeMismatches: 0,
    timingMismatches: 0,
    stalePending: 0
  });
  assert.equal(verification.hasPending(currentPlayer), false);
});

test('shadow rejection is verified without requiring finish timing', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentRoom = room();
  const currentPlayer = player();
  verification.remember({
    room: currentRoom,
    player: currentPlayer,
    decision: shadowDecision({ accept: false, finishTimeMs: null })
  });

  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: 'finishRejected', matchId: 'match-a', reason: 'finish-validation' }),
    room: currentRoom,
    player: currentPlayer
  });

  assert.equal(result.match, true);
  assert.equal(verification.metrics().rejectComparisons, 1);
});

test('opposite core outcome is counted as an authority mismatch', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentRoom = room();
  const currentPlayer = player();
  verification.remember({ room: currentRoom, player: currentPlayer, decision: shadowDecision() });

  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: 'finishRejected', matchId: 'match-a', reason: 'finish-validation' }),
    room: currentRoom,
    player: currentPlayer
  });

  assert.equal(result.match, false);
  assert.equal(result.outcomeMatch, false);
  assert.equal(verification.metrics().outcomeMismatches, 1);
});

test('accepted core outcome with wrong duration is counted as a timing mismatch', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentRoom = room();
  const currentPlayer = player({ finished: true, time: 451 });
  verification.remember({ room: currentRoom, player: currentPlayer, decision: shadowDecision() });

  const result = verification.observeOutcomePayload({
    payload: JSON.stringify({ type: 'finish', matchId: 'match-a', id: 'p1', time: 451 }),
    room: currentRoom,
    player: currentPlayer
  });

  assert.equal(result.match, false);
  assert.equal(result.outcomeMatch, true);
  assert.equal(result.timingMatch, false);
  assert.equal(verification.metrics().timingMismatches, 1);
});

test('non-finish payload preserves the pending comparison for the actual finish outcome', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentRoom = room();
  const currentPlayer = player({ finished: true, time: 450 });
  verification.remember({ room: currentRoom, player: currentPlayer, decision: shadowDecision() });

  assert.equal(
    verification.observeOutcomePayload({
      payload: JSON.stringify({ type: 'snapshot', matchId: 'match-a' }),
      room: currentRoom,
      player: currentPlayer
    }),
    null
  );
  assert.equal(verification.hasPending(currentPlayer), true);
});

test('new shadow decision detects an unconsumed previous decision as stale', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentPlayer = player();
  verification.remember({ room: room(), player: currentPlayer, decision: shadowDecision() });
  verification.remember({
    room: room({ matchId: 'match-b' }),
    player: currentPlayer,
    decision: shadowDecision({ accept: false, finishTimeMs: null })
  });

  assert.equal(verification.metrics().stalePending, 1);
});

test('verification accepts only well-formed handled shadow decisions in race context', () => {
  const verification = createRaceFinishAuthorityCoreVerification();
  const currentPlayer = player();

  assert.equal(validFinishDecision(shadowDecision()), true);
  assert.equal(validFinishDecision(shadowDecision({ accept: true, finishTimeMs: null })), false);
  assert.equal(validFinishDecision(shadowDecision({ source: AUTHORITY_SOURCE.LEGACY })), false);
  assert.equal(
    verification.remember({
      room: room({ mode: GAME_MODE.COOP }),
      player: currentPlayer,
      decision: shadowDecision()
    }),
    false
  );
  assert.equal(verification.metrics().remembered, 0);
});
