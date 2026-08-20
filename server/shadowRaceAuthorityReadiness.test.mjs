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

test('default policy stays advisory-false until both state and finish evidence are sufficient', () => {
  const result = evaluateShadowRaceAuthorityReadiness(
    healthyMetrics({
      stateSamples: DEFAULT_SHADOW_AUTHORITY_POLICY.minStateSamples - 1,
      finishComparableSamples: DEFAULT_SHADOW_AUTHORITY_POLICY.minFinishSamples - 1
    })
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, [
    REASON.INSUFFICIENT_STATE_SAMPLES,
    REASON.INSUFFICIENT_FINISH_SAMPLES
  ]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.reasons), true);
  assert.equal(Object.isFrozen(result.policy), true);
});

test('clean evidence above the default policy produces a read-only ready signal', () => {
  const metrics = healthyMetrics();
  const result = evaluateShadowRaceAuthorityReadiness(metrics);

  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.observed, {
    stateSamples: 300,
    finishSamples: 30,
    availabilityRate: 1,
    checkpointMismatchRate: 0,
    finishMismatchRate: 0,
    maxCheckpointDelta: 0,
    invalidLegacySamples: 0,
    acceptedButShadowUnfinishedSamples: 0,
    rejectedButShadowFinishedSamples: 0
  });
  assert.deepEqual(metrics, healthyMetrics(), 'the evaluator never mutates observed diagnostics');
});

test('each migration risk keeps authority readiness false with an explicit reason', () => {
  const result = evaluateShadowRaceAuthorityReadiness(
    healthyMetrics({
      availabilityRate: 0.9,
      invalidLegacySamples: 1,
      checkpointMismatchRate: 0.2,
      maxCheckpointDelta: 2,
      finishMismatchRate: 0.1,
      acceptedButShadowUnfinishedSamples: 1,
      rejectedButShadowFinishedSamples: 1
    })
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.reasons, [
    REASON.CANDIDATE_AVAILABILITY,
    REASON.INVALID_LEGACY,
    REASON.CHECKPOINT_MISMATCH,
    REASON.CHECKPOINT_DELTA,
    REASON.FINISH_MISMATCH,
    REASON.ACCEPTED_SHADOW_UNFINISHED,
    REASON.REJECTED_SHADOW_FINISHED
  ]);
});

test('invalid metrics fail closed instead of manufacturing a positive readiness signal', () => {
  for (const metrics of [
    null,
    {},
    healthyMetrics({ availabilityRate: 2 }),
    healthyMetrics({ stateSamples: -1 })
  ]) {
    assert.equal(validMetrics(metrics), false);
    const result = evaluateShadowRaceAuthorityReadiness(metrics);
    assert.equal(result.ready, false);
    assert.deepEqual(result.reasons, [REASON.INVALID_METRICS]);
  }
});

test('tests and later rollout stages can supply a stricter or looser policy without changing defaults', () => {
  const policy = normalizePolicy({
    minStateSamples: 2,
    minFinishSamples: 1,
    minAvailabilityRate: 0.5,
    maxCheckpointMismatchRate: 0.5,
    maxFinishMismatchRate: 0.5,
    maxCheckpointDelta: 3
  });
  const result = evaluateShadowRaceAuthorityReadiness(
    healthyMetrics({
      stateSamples: 2,
      finishComparableSamples: 1,
      availabilityRate: 0.5,
      checkpointMismatchRate: 0.5,
      finishMismatchRate: 0.5,
      maxCheckpointDelta: 3
    }),
    policy
  );

  assert.equal(result.ready, true);
  assert.equal(DEFAULT_SHADOW_AUTHORITY_POLICY.minStateSamples, 300);
  assert.equal(DEFAULT_SHADOW_AUTHORITY_POLICY.minFinishSamples, 30);
});

test('invalid policy overrides fall back to the conservative default policy', () => {
  const normalized = normalizePolicy({ minStateSamples: -1, minAvailabilityRate: 2 });
  assert.equal(normalized, DEFAULT_SHADOW_AUTHORITY_POLICY);

  const result = evaluateShadowRaceAuthorityReadiness(healthyMetrics({ stateSamples: 2 }), {
    minStateSamples: -1
  });
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes(REASON.INSUFFICIENT_STATE_SAMPLES));
});
