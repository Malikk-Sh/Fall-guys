import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  FINISH_DECISION_REASON,
  createRaceFinishAuthorityDecision,
  finishOutcomeFor,
  validFinishTiming
} = require('./raceFinishAuthorityDecision');

function room(overrides = {}) {
  return {
    mode: GAME_MODE.RACE,
    matchId: 'match-a',
    startedAt: 1000,
    spec: { segmentCount: 2 },
    ...overrides
  };
}

function player(overrides = {}) {
  return {
    id: 'p1',
    checkpoint: 2,
    finished: false,
    time: null,
    ...overrides
  };
}

function authorityDecision(source, progress = { checkpoint: 2, finished: false }, fallbackReason = null) {
  return Object.freeze({
    ok: true,
    source,
    fallbackReason,
    progress: Object.freeze({ ...progress })
  });
}

function candidate(overrides = {}) {
  return Object.freeze({
    matchId: 'match-a',
    serverTick: 30,
    lastProcessedInput: 7,
    checkpoint: 2,
    finished: true,
    finishServerTick: 29,
    finishServerTime: 1450,
    finishTimeMs: 450,
    ...overrides
  });
}

function fixture({
  guardResult,
  candidateResult = candidate(),
  guardError = null,
  candidateError = null
} = {}) {
  const guardCalls = [];
  const candidateCalls = [];
  const matchGuard = {
    decide(options) {
      guardCalls.push(options);
      if (guardError) throw guardError;
      return guardResult;
    }
  };
  const candidateFor = options => {
    candidateCalls.push(options);
    if (candidateError) throw candidateError;
    return candidateResult;
  };
  return {
    guardCalls,
    candidateCalls,
    decision: createRaceFinishAuthorityDecision({ matchGuard, candidateFor, runtimeService: {} })
  };
}

test('legacy authority leaves the existing finish handler completely in control', () => {
  const currentRoom = room();
  const currentPlayer = player();
  const before = structuredClone({ room: currentRoom, player: currentPlayer });
  const { decision, guardCalls, candidateCalls } = fixture({
    guardResult: authorityDecision(AUTHORITY_SOURCE.LEGACY, { checkpoint: 2, finished: false })
  });

  const outcome = decision.decide({ room: currentRoom, player: currentPlayer });

  assert.equal(outcome.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(outcome.handled, false);
  assert.equal(outcome.accept, null);
  assert.equal(candidateCalls.length, 0, 'legacy selection never reads shadow finish evidence');
  assert.equal(guardCalls.length, 1);
  assert.deepEqual(guardCalls[0].legacyProgress, { checkpoint: 2, finished: false });
  assert.deepEqual({ room: currentRoom, player: currentPlayer }, before);
});

test('shadow authority rejects client finish until the server shadow has actually finished', () => {
  const shadowProgress = { checkpoint: 2, finished: false };
  const { decision } = fixture({
    guardResult: authorityDecision(AUTHORITY_SOURCE.SHADOW, shadowProgress),
    candidateResult: candidate({
      finished: false,
      finishServerTick: null,
      finishServerTime: null,
      finishTimeMs: null
    })
  });

  const outcome = decision.decide({ room: room(), player: player() });

  assert.equal(outcome.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(outcome.handled, true);
  assert.equal(outcome.accept, false);
  assert.equal(outcome.fallbackReason, FINISH_DECISION_REASON.SHADOW_NOT_FINISHED);
  assert.equal(outcome.finishTimeMs, null);
});

test('server-finished shadow authority returns the server-owned finish time for core', () => {
  const shadowProgress = { checkpoint: 2, finished: true };
  const evidence = candidate();
  const currentRoom = room();
  const currentPlayer = player();
  const before = structuredClone({ room: currentRoom, player: currentPlayer, evidence });
  const { decision } = fixture({
    guardResult: authorityDecision(AUTHORITY_SOURCE.SHADOW, shadowProgress),
    candidateResult: evidence
  });

  const outcome = decision.decide({ room: currentRoom, player: currentPlayer });

  assert.deepEqual(outcome, {
    ok: true,
    source: AUTHORITY_SOURCE.SHADOW,
    handled: true,
    accept: true,
    fallbackReason: null,
    progress: { checkpoint: 2, finished: true },
    finishTimeMs: 450,
    finishServerTime: 1450,
    finishServerTick: 29,
    serverTick: 30,
    lastProcessedInput: 7
  });
  assert.equal(Object.isFrozen(outcome), true);
  assert.deepEqual({ room: currentRoom, player: currentPlayer, evidence }, before);
});

test('missing or mismatched shadow evidence cannot fall through to legacy finish', () => {
  const selected = authorityDecision(AUTHORITY_SOURCE.SHADOW, { checkpoint: 2, finished: true });

  const missing = finishOutcomeFor({ room: room(), authorityDecision: selected, candidate: null });
  assert.equal(missing.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(missing.handled, true);
  assert.equal(missing.accept, false);
  assert.equal(missing.fallbackReason, FINISH_DECISION_REASON.SHADOW_UNAVAILABLE);

  const mismatch = finishOutcomeFor({
    room: room(),
    authorityDecision: selected,
    candidate: candidate({ matchId: 'match-b' })
  });
  assert.equal(mismatch.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(mismatch.handled, true);
  assert.equal(mismatch.accept, false);
  assert.equal(mismatch.fallbackReason, FINISH_DECISION_REASON.SHADOW_MISMATCH);
});

test('shadow finish timing must be server-consistent before core may accept it', () => {
  const selected = authorityDecision(AUTHORITY_SOURCE.SHADOW, { checkpoint: 2, finished: true });
  const invalidTiming = [
    candidate({ finishTimeMs: -1 }),
    candidate({ finishServerTime: 1400 }),
    candidate({ finishServerTick: 31 }),
    candidate({ finishServerTick: null })
  ];

  for (const evidence of invalidTiming) {
    const outcome = finishOutcomeFor({ room: room(), authorityDecision: selected, candidate: evidence });
    assert.equal(outcome.source, AUTHORITY_SOURCE.SHADOW);
    assert.equal(outcome.handled, true);
    assert.equal(outcome.accept, false);
    assert.equal(outcome.fallbackReason, FINISH_DECISION_REASON.SHADOW_TIMING_INVALID);
  }
});

test('guard and candidate failures have explicit bounded fallback behavior', () => {
  const guardFailure = fixture({ guardError: new Error('guard unavailable') });
  const legacy = guardFailure.decision.decide({ room: room(), player: player() });
  assert.equal(legacy.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(legacy.handled, false);
  assert.equal(legacy.ok, false);
  assert.equal(legacy.fallbackReason, FINISH_DECISION_REASON.GUARD_ERROR);

  const candidateFailure = fixture({
    guardResult: authorityDecision(AUTHORITY_SOURCE.SHADOW, { checkpoint: 2, finished: true }),
    candidateError: new Error('runtime unavailable')
  });
  const shadow = candidateFailure.decision.decide({ room: room(), player: player() });
  assert.equal(shadow.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(shadow.handled, true);
  assert.equal(shadow.accept, false);
  assert.equal(shadow.fallbackReason, FINISH_DECISION_REASON.SHADOW_UNAVAILABLE);
});

test('non-race context remains on the existing legacy finish path', () => {
  const { decision, guardCalls } = fixture({
    guardResult: authorityDecision(AUTHORITY_SOURCE.SHADOW, { checkpoint: 2, finished: true })
  });
  const outcome = decision.decide({ room: room({ mode: GAME_MODE.COOP }), player: player() });

  assert.equal(outcome.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(outcome.handled, false);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallbackReason, FINISH_DECISION_REASON.INVALID_CONTEXT);
  assert.equal(guardCalls.length, 0);
});

test('finish timing helper rejects client-like or inconsistent timestamps', () => {
  assert.equal(validFinishTiming(room(), candidate()), true);
  assert.equal(validFinishTiming(room({ startedAt: null }), candidate()), false);
  assert.equal(validFinishTiming(room(), candidate({ finishServerTime: 999, finishTimeMs: -1 })), false);
  assert.equal(validFinishTiming(room(), candidate({ finishServerTime: 1451 })), false);
  assert.equal(validFinishTiming(room(), candidate({ finishServerTick: 31 })), false);
});
