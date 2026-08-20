import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createShadowRaceAuthorityService } = require('./shadowRaceAuthorityService');

function serviceFixture({ stateSample = { available: true }, outcomeSample = { available: true } } = {}) {
  const calls = [];
  const progressMetrics = { stateSamples: 1 };
  const verificationMetrics = {
    remembered: 1,
    stateComparisons: 1,
    stateMismatches: 0,
    finishComparisons: 0,
    finishMismatches: 0,
    stalePending: 0,
    missingPending: 0
  };
  const progressDiagnostics = {
    observeAcceptedState: options => {
      calls.push(['state', options]);
      return stateSample;
    },
    observeOutcomePayload: options => {
      calls.push(['outcome', options]);
      return outcomeSample;
    },
    metrics: () => {
      calls.push(['progressMetrics']);
      return progressMetrics;
    },
    reset: () => calls.push(['progressReset'])
  };
  const authorityProbe = {
    observe: options => {
      calls.push(['probe', options]);
      return Object.freeze({ source: 'legacy' });
    },
    metrics: () => {
      calls.push(['probeMetrics']);
      return Object.freeze({ decisions: 1 });
    },
    reset: () => calls.push(['probeReset'])
  };
  const boundaryVerification = {
    metrics: () => {
      calls.push(['verificationMetrics']);
      return verificationMetrics;
    },
    reset: () => calls.push(['verificationReset'])
  };
  const readinessFor = (metrics, _policy, verification) => {
    calls.push(['readiness', metrics, verification]);
    return Object.freeze({ ready: true, reasons: Object.freeze([]) });
  };
  const service = createShadowRaceAuthorityService({
    progressDiagnostics,
    authorityProbe,
    boundaryVerification,
    readinessFor
  });
  return { service, calls, progressMetrics, verificationMetrics };
}

test('accepted state is diagnosed before verification-aware readiness and probe evaluation', () => {
  const { service, calls, progressMetrics, verificationMetrics } = serviceFixture();
  const player = { checkpoint: 0, finished: false };
  const result = service.observeAcceptedState({ player, message: { sequence: 1 } });

  assert.equal(Object.isFrozen(result), true);
  assert.equal(result.sample.available, true);
  assert.equal(result.authorityReadiness.ready, true);
  assert.equal(result.probeDecision.source, 'legacy');
  assert.deepEqual(
    calls.map(([name]) => name),
    ['state', 'progressMetrics', 'verificationMetrics', 'readiness', 'probe']
  );
  assert.equal(calls[3][1], progressMetrics);
  assert.equal(calls[3][2], verificationMetrics);
  assert.equal(calls[4][1].player, player);
  assert.equal(calls[4][1].sample, result.sample);
  assert.equal(calls[4][1].readiness, result.authorityReadiness);
});

test('unobserved boundaries do not manufacture readiness or probe decisions', () => {
  const { service, calls } = serviceFixture({ stateSample: null });
  const result = service.observeAcceptedState({ player: { checkpoint: 0, finished: false } });

  assert.equal(result, null);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['state']
  );
});

test('finish outcomes use the same shared diagnostics and verification-aware probe pipeline', () => {
  const { service, calls } = serviceFixture();
  const player = { checkpoint: 3, finished: true };
  const result = service.observeOutcomePayload({ player, payload: '{"type":"playerFinished"}' });

  assert.equal(result.sample.available, true);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['outcome', 'progressMetrics', 'verificationMetrics', 'readiness', 'probe']
  );
  assert.equal(calls[4][1].player, player);
});

test('metrics expose one coherent progress, verification, readiness and probe snapshot', () => {
  const { service, calls, progressMetrics, verificationMetrics } = serviceFixture();
  const metrics = service.metrics();

  assert.equal(Object.isFrozen(metrics), true);
  assert.equal(metrics.coreProgress, progressMetrics);
  assert.equal(metrics.authorityVerification, verificationMetrics);
  assert.equal(metrics.authorityReadiness.ready, true);
  assert.deepEqual(metrics.authorityProbe, { decisions: 1 });
  assert.deepEqual(
    calls.map(([name]) => name),
    ['progressMetrics', 'verificationMetrics', 'readiness', 'probeMetrics']
  );
});

test('reset clears progress, probe and boundary verification diagnostics', () => {
  const { service, calls } = serviceFixture();
  service.reset();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['progressReset', 'probeReset', 'verificationReset']
  );
});

test('factory rejects incomplete collaborators instead of creating a partial service', () => {
  assert.throws(() => createShadowRaceAuthorityService({ progressDiagnostics: {} }), TypeError);
  assert.throws(
    () =>
      createShadowRaceAuthorityService({
        progressDiagnostics: {
          observeAcceptedState() {},
          observeOutcomePayload() {},
          metrics() {},
          reset() {}
        },
        authorityProbe: {}
      }),
    TypeError
  );

  const progressDiagnostics = {
    observeAcceptedState() {},
    observeOutcomePayload() {},
    metrics() {},
    reset() {}
  };
  const authorityProbe = {
    observe() {},
    metrics() {},
    reset() {}
  };
  assert.throws(
    () => createShadowRaceAuthorityService({ progressDiagnostics, authorityProbe, boundaryVerification: {} }),
    TypeError
  );
});
