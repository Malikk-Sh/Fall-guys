'use strict';

const DEFAULT_SHADOW_AUTHORITY_POLICY = Object.freeze({
  minStateSamples: 300,
  minFinishSamples: 30,
  minAvailabilityRate: 0.98,
  maxCheckpointMismatchRate: 0.01,
  maxFinishMismatchRate: 0,
  maxCheckpointDelta: 1,
  maxInvalidLegacySamples: 0,
  maxAcceptedButShadowUnfinishedSamples: 0,
  maxRejectedButShadowFinishedSamples: 0
});

const REASON = Object.freeze({
  INVALID_METRICS: 'invalid-metrics',
  INSUFFICIENT_STATE_SAMPLES: 'insufficient-state-samples',
  INSUFFICIENT_FINISH_SAMPLES: 'insufficient-finish-samples',
  CANDIDATE_AVAILABILITY: 'candidate-availability',
  INVALID_LEGACY: 'invalid-legacy',
  CHECKPOINT_MISMATCH: 'checkpoint-mismatch',
  CHECKPOINT_DELTA: 'checkpoint-delta',
  FINISH_MISMATCH: 'finish-mismatch',
  ACCEPTED_SHADOW_UNFINISHED: 'accepted-shadow-unfinished',
  REJECTED_SHADOW_FINISHED: 'rejected-shadow-finished'
});

function finiteRate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  const integerFields = [
    'stateSamples',
    'finishComparableSamples',
    'invalidLegacySamples',
    'acceptedButShadowUnfinishedSamples',
    'rejectedButShadowFinishedSamples',
    'maxCheckpointDelta'
  ];
  if (!integerFields.every(field => nonNegativeInteger(metrics[field]))) return false;
  return (
    finiteRate(metrics.availabilityRate) &&
    finiteRate(metrics.checkpointMismatchRate) &&
    finiteRate(metrics.finishMismatchRate)
  );
}

function normalizePolicy(policy = {}) {
  const merged = { ...DEFAULT_SHADOW_AUTHORITY_POLICY, ...policy };
  const integerFields = [
    'minStateSamples',
    'minFinishSamples',
    'maxCheckpointDelta',
    'maxInvalidLegacySamples',
    'maxAcceptedButShadowUnfinishedSamples',
    'maxRejectedButShadowFinishedSamples'
  ];
  if (!integerFields.every(field => nonNegativeInteger(merged[field]))) {
    return DEFAULT_SHADOW_AUTHORITY_POLICY;
  }
  if (
    !finiteRate(merged.minAvailabilityRate) ||
    !finiteRate(merged.maxCheckpointMismatchRate) ||
    !finiteRate(merged.maxFinishMismatchRate)
  ) {
    return DEFAULT_SHADOW_AUTHORITY_POLICY;
  }
  return Object.freeze({ ...merged });
}

function evaluateShadowRaceAuthorityReadiness(metrics, policyOverrides = {}) {
  const policy = normalizePolicy(policyOverrides);
  if (!validMetrics(metrics)) {
    return Object.freeze({
      ready: false,
      reasons: Object.freeze([REASON.INVALID_METRICS]),
      policy
    });
  }

  const reasons = [];
  if (metrics.stateSamples < policy.minStateSamples) reasons.push(REASON.INSUFFICIENT_STATE_SAMPLES);
  if (metrics.finishComparableSamples < policy.minFinishSamples) {
    reasons.push(REASON.INSUFFICIENT_FINISH_SAMPLES);
  }
  if (metrics.availabilityRate < policy.minAvailabilityRate) reasons.push(REASON.CANDIDATE_AVAILABILITY);
  if (metrics.invalidLegacySamples > policy.maxInvalidLegacySamples) reasons.push(REASON.INVALID_LEGACY);
  if (metrics.checkpointMismatchRate > policy.maxCheckpointMismatchRate) {
    reasons.push(REASON.CHECKPOINT_MISMATCH);
  }
  if (metrics.maxCheckpointDelta > policy.maxCheckpointDelta) reasons.push(REASON.CHECKPOINT_DELTA);
  if (metrics.finishMismatchRate > policy.maxFinishMismatchRate) reasons.push(REASON.FINISH_MISMATCH);
  if (
    metrics.acceptedButShadowUnfinishedSamples > policy.maxAcceptedButShadowUnfinishedSamples
  ) {
    reasons.push(REASON.ACCEPTED_SHADOW_UNFINISHED);
  }
  if (metrics.rejectedButShadowFinishedSamples > policy.maxRejectedButShadowFinishedSamples) {
    reasons.push(REASON.REJECTED_SHADOW_FINISHED);
  }

  return Object.freeze({
    ready: reasons.length === 0,
    reasons: Object.freeze(reasons),
    policy,
    observed: Object.freeze({
      stateSamples: metrics.stateSamples,
      finishSamples: metrics.finishComparableSamples,
      availabilityRate: metrics.availabilityRate,
      checkpointMismatchRate: metrics.checkpointMismatchRate,
      finishMismatchRate: metrics.finishMismatchRate,
      maxCheckpointDelta: metrics.maxCheckpointDelta,
      invalidLegacySamples: metrics.invalidLegacySamples,
      acceptedButShadowUnfinishedSamples: metrics.acceptedButShadowUnfinishedSamples,
      rejectedButShadowFinishedSamples: metrics.rejectedButShadowFinishedSamples
    })
  });
}

module.exports = {
  DEFAULT_SHADOW_AUTHORITY_POLICY,
  REASON,
  evaluateShadowRaceAuthorityReadiness,
  normalizePolicy,
  validMetrics
};
