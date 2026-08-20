import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AUTHORITY_ENV,
  authoritySource,
  candidateProgress,
  createRaceProgressAuthorityDecision
} = require('./raceProgressAuthorityDecision');
const { AUTHORITY_SOURCE, FALLBACK_REASON } = require('./raceProgressAuthoritySelector');

const ready = Object.freeze({ ready: true, reasons: Object.freeze([]) });
const blocked = Object.freeze({ ready: false, reasons: Object.freeze(['insufficient-state-samples']) });

function player(overrides = {}) {
  return { checkpoint: 1, finished: false, ...overrides };
}

function fixture({ requestedSource = AUTHORITY_SOURCE.SHADOW, readiness = ready, candidate = null } = {}) {
  const calls = [];
  const authorityService = {
    readiness: () => {
      calls.push('readiness');
      if (readiness instanceof Error) throw readiness;
      return readiness;
    }
  };
  const candidateFor = options => {
    calls.push('candidate');
    if (candidate instanceof Error) throw candidate;
    return candidate;
  };
  const decision = createRaceProgressAuthorityDecision({
    requestedSource,
    authorityService,
    candidateFor,
    runtimeService: { name: 'runtime' }
  });
  return { decision, calls };
}

test('authority source parser defaults every value except exact shadow to legacy', () => {
  assert.equal(AUTHORITY_ENV, 'RACE_PROGRESS_AUTHORITY');
  assert.equal(authoritySource('shadow'), AUTHORITY_SOURCE.SHADOW);
  assert.equal(authoritySource('legacy'), AUTHORITY_SOURCE.LEGACY);
  assert.equal(authoritySource('SHADOW'), AUTHORITY_SOURCE.LEGACY);
  assert.equal(authoritySource(undefined), AUTHORITY_SOURCE.LEGACY);
});

test('candidate progress strips runtime metadata before selector use', () => {
  const result = candidateProgress({
    checkpoint: 3,
    finished: true,
    matchId: 'm1',
    serverTick: 77,
    lastProcessedInput: 9,
    finishServerTick: 77
  });
  assert.deepEqual(result, { checkpoint: 3, finished: true });
  assert.equal(candidateProgress(null), null);
});

test('legacy source returns legacy progress without reading readiness or candidate', () => {
  const { decision, calls } = fixture({ requestedSource: AUTHORITY_SOURCE.LEGACY });
  const result = decision.decide({ player: player() });

  assert.equal(result.ok, true);
  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.deepEqual(result.progress, { checkpoint: 1, finished: false });
  assert.deepEqual(calls, []);
});

test('shadow source selects a valid candidate only after readiness allows it', () => {
  const candidate = {
    checkpoint: 2,
    finished: false,
    matchId: 'm1',
    serverTick: 20,
    lastProcessedInput: 4,
    finishServerTick: null
  };
  const { decision, calls } = fixture({ candidate });
  const result = decision.decide({ room: { matchId: 'm1' }, player: player() });

  assert.equal(result.source, AUTHORITY_SOURCE.SHADOW);
  assert.deepEqual(result.progress, { checkpoint: 2, finished: false });
  assert.deepEqual(calls, ['readiness', 'candidate']);
});

test('blocked readiness falls back before any candidate snapshot is read', () => {
  const { decision, calls } = fixture({ readiness: blocked });
  const result = decision.decide({ player: player() });

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_NOT_READY);
  assert.deepEqual(calls, ['readiness']);
});

test('readiness failures fail closed as shadow-not-ready', () => {
  const { decision, calls } = fixture({ readiness: new Error('metrics unavailable') });
  const result = decision.decide({ player: player() });

  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_NOT_READY);
  assert.deepEqual(calls, ['readiness']);
});

test('missing or failing candidate falls back to legacy after readiness passes', () => {
  for (const candidate of [null, new Error('snapshot unavailable')]) {
    const { decision, calls } = fixture({ candidate });
    const result = decision.decide({ player: player() });
    assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
    assert.equal(result.fallbackReason, FALLBACK_REASON.SHADOW_UNAVAILABLE);
    assert.deepEqual(calls, ['readiness', 'candidate']);
  }
});

test('invalid legacy progress fails before readiness or candidate access', () => {
  const { decision, calls } = fixture({
    candidate: { checkpoint: 2, finished: false }
  });
  const result = decision.decide({ player: player({ checkpoint: -1 }) });

  assert.equal(result.ok, false);
  assert.equal(result.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(result.fallbackReason, FALLBACK_REASON.INVALID_LEGACY);
  assert.equal(result.progress, null);
  assert.deepEqual(calls, []);
});

test('factory rejects missing readiness or candidate collaborators', () => {
  assert.throws(
    () => createRaceProgressAuthorityDecision({ authorityService: {}, candidateFor: () => null }),
    TypeError
  );
  assert.throws(
    () => createRaceProgressAuthorityDecision({ authorityService: { readiness() {} }, candidateFor: null }),
    TypeError
  );
});
