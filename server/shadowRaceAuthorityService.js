'use strict';

const { createShadowRaceProgressDiagnostics } = require('./shadowRaceProgressDiagnostics');
const { evaluateShadowRaceAuthorityReadiness } = require('./shadowRaceAuthorityReadiness');
const { createShadowRaceAuthorityProbe } = require('./shadowRaceAuthorityProbe');

function createShadowRaceAuthorityService({
  progressDiagnostics = createShadowRaceProgressDiagnostics(),
  authorityProbe = createShadowRaceAuthorityProbe(),
  readinessFor = evaluateShadowRaceAuthorityReadiness
} = {}) {
  if (
    !progressDiagnostics ||
    typeof progressDiagnostics.observeAcceptedState !== 'function' ||
    typeof progressDiagnostics.observeOutcomePayload !== 'function' ||
    typeof progressDiagnostics.metrics !== 'function' ||
    typeof progressDiagnostics.reset !== 'function'
  ) {
    throw new TypeError('shadow race authority service requires progress diagnostics');
  }
  if (
    !authorityProbe ||
    typeof authorityProbe.observe !== 'function' ||
    typeof authorityProbe.metrics !== 'function' ||
    typeof authorityProbe.reset !== 'function'
  ) {
    throw new TypeError('shadow race authority service requires an authority probe');
  }
  if (typeof readinessFor !== 'function') {
    throw new TypeError('shadow race authority service requires a readiness evaluator');
  }

  function readiness() {
    return readinessFor(progressDiagnostics.metrics());
  }

  function observe(method, options) {
    const sample = progressDiagnostics[method](options);
    if (!sample) return null;
    const authorityReadiness = readiness();
    const probeDecision = authorityProbe.observe({
      sample,
      player: options?.player,
      readiness: authorityReadiness
    });
    return Object.freeze({ sample, authorityReadiness, probeDecision });
  }

  function metrics() {
    const coreProgress = progressDiagnostics.metrics();
    return Object.freeze({
      coreProgress,
      authorityReadiness: readinessFor(coreProgress),
      authorityProbe: authorityProbe.metrics()
    });
  }

  function reset() {
    progressDiagnostics.reset();
    authorityProbe.reset();
  }

  return {
    progressDiagnostics,
    authorityProbe,
    observeAcceptedState: options => observe('observeAcceptedState', options),
    observeOutcomePayload: options => observe('observeOutcomePayload', options),
    readiness,
    metrics,
    reset
  };
}

const singleton = createShadowRaceAuthorityService();

module.exports = Object.freeze({
  ...singleton,
  createShadowRaceAuthorityService
});
