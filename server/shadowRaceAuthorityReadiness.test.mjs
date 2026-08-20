import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_SHADOW_AUTHORITY_POLICY,
  REASON,
  evaluateShadowRaceAuthorityReadiness,
  normalizePolicy,
  validMetrics
} = require('./shadowRaceAuthorityReadiness');

function healthyMetrics(overrides = {}) {
  return {
    stateSamples: 300,
    finishComparableSamples: 30,
    availabilityRate: 1,
    checkpointMismatchRate: 0,
    finishMismatchRate: 0,
    maxCheckpointDelta: 0,
    invalidLegacySamples: 0,
    acceptedButShadowUnfinishedSamples: 0,
    rejectedButShadowFinishedSamples: 0,
    ...overrides
  };
}

function assertInvalidMetrics(metrics) {
  assert.equal(validMetrics(metrics), false);
  const result = evaluateShadowRaceAuthorityReadiness(metrics);
  assert.equal(result.ready, false);
  assert.equal(result.reasons.length, 1);
  assert.equal(result.reasons[0], REASON.INVALID_METRICS);
}

test('default policy needs enough state and finish evidence', () => {
  const metrics = healthyMetrics({
    stateSamples: DEFAULT_SHADOW_AUTHORITY_POLICY.minStateSamples - 1,
    finishComparableSamples: DEFAULT_SHADOW_AUTHORITY_POLICY.minFinishSamples - 1
  });
  const result = evaluateShadowRaceAuthorityReadiness(metrics);

  assert.equal(result.ready, false);
  assert.equal(result.reasons.length, 2);
  assert.equal(result.reasons[0], REASON.INSUFFICIENT_STATE_SAMPLES);
  assert.equal(result.reasons[1], REASON.INSUFFICIENT_FINISH_SAMPLES);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.equal(Object.isFrozen(result.policy), true);
});

test('clean default evidence is advisory-ready', () => {
  const metrics = healthyMetrics();
  const result = evaluateShadowRaceAuthorityReadiness(metrics);

  assert.equal(result.ready, true);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.observed.stateSamples, 300);
  assert.equal(result.observed.finishSamples, 30);
  assert.equal(result.observed.availabilityRate, 1);
  assert.equal(result.observed.checkpointMismatchRate, 0);
  assert.equal(result.observed.finishMismatchRate, 0);
  assert.equal(result.observed.maxCheckpointDelta, 0);
  assert.equal(result.observed.invalidLegacySamples, 0);
  assert.equal(result.observed.acceptedButShadowUnfinishedSamples, 0);
  assert.equal(result.observed.rejectedButShadowFinishedSamples, 0);
  assert.deepEqual(metrics, healthyMetrics());
});

test('each migration risk blocks readiness explicitly', () => {
  const metrics = healthyMetrics({
    availabilityRate: 0.9,
    invalidLegacySamples: 1,
    checkpointMismatchRate: 0.2,
    maxCheckpointDelta: 2,
    finishMismatchRate: 0.1,
    acceptedButShadowUnfinishedSamples: 1,
    rejectedButShadowFinishedSamples: 1
  });
  const result = evaluateShadowRaceAuthorityReadiness(metrics);

  assert.equal(result.ready, false);
  assert.equal(result.reasons.length, 7);
  assert.ok(result.reasons.includes(REASON.CANDIDATE_AVAILABILITY));
  assert.ok(result.reasons.includes(REASON.INVALID_LEGACY));
  assert.ok(result.reasons.includes(REASON.CHECKPOINT_MISMATCH));
  assert.ok(result.reasons.includes(REASON.CHECKPOINT_DELTA));
  assert.ok(result.reasons.includes(REASON.FINISH_MISMATCH));
  assert.ok(result.reasons.includes(REASON.ACCEPTED_SHADOW_UNFINISHED));
  assert.ok(result.reasons.includes(REASON.REJECTED_SHADOW_FINISHED));
});

test('malformed metrics fail closed', () => {
  assertInvalidMetrics(null);
  assertInvalidMetrics({});
  assertInvalidMetrics(healthyMetrics({ availabilityRate: 2 }));
  assertInvalidMetrics(healthyMetrics({ stateSamples: -1 }));
});

test('policy overrides can be stricter or looser', () => {
  const policy = normalizePolicy({
    minStateSamples: 2,
    minFinishSamples: 1,
    minAvailabilityRate: 0.5,
    maxCheckpointMismatchRate: 0.5,
    maxFinishMismatchRate: 0.5,
    maxCheckpointDelta: 3
  });
  const metrics = healthyMetrics({
    stateSamples: 2,
    finishComparableSamples: 1,
    availabilityRate: 0.5,
    checkpointMismatchRate: 0.5,
    finishMismatchRate: 0.5,
    maxCheckpointDelta: 3
  });
  const result = evaluateShadowRaceAuthorityReadiness(metrics, policy);

  assert.equal(result.ready, true);
  assert.equal(DEFAULT_SHADOW_AUTHORITY_POLICY.minStateSamples, 300);
  assert.equal(DEFAULT_SHADOW_AUTHORITY_POLICY.minFinishSamples, 30);
});

test('invalid policy overrides use conservative defaults', () => {
  const normalized = normalizePolicy({ minStateSamples: -1, minAvailabilityRate: 2 });
  assert.equal(normalized, DEFAULT_SHADOW_AUTHORITY_POLICY);

  const metrics = healthyMetrics({ stateSamples: 2 });
  const result = evaluateShadowRaceAuthorityReadiness(metrics, { minStateSamples: -1 });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes(REASON.INSUFFICIENT_STATE_SAMPLES));
});
