'use strict';

const { createShadowRaceProgressDiagnostics } = require('./shadowRaceProgressDiagnostics');
const { evaluateShadowRaceAuthorityReadiness } = require('./shadowRaceAuthorityReadiness');
const { createShadowRaceAuthorityProbe } = require('./shadowRaceAuthorityProbe');
const raceProgressAuthorityBoundaryVerification = require('./raceProgressAuthorityBoundaryVerification');
const raceFinishAuthorityCoreVerification = require('./raceFinishAuthorityCoreVerification');

function createShadowRaceAuthorityService({
  progressDiagnostics = createShadowRaceProgressDiagnostics(),
  authorityProbe = createShadowRaceAuthorityProbe(),
  boundaryVerification = raceProgressAuthorityBoundaryVerification,
  finishCoreVerification = raceFinishAuthorityCoreVerification,
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
  if (
    !boundaryVerification ||
    typeof boundaryVerification.metrics !== 'function' ||
    typeof boundaryVerification.reset !== 'function'
  ) {
    throw new TypeError('shadow race authority service requires boundary verification');
  }
  if (
    !finishCoreVerification ||
    typeof finishCoreVerification.metrics !== 'function' ||
    typeof finishCoreVerification.reset !== 'function'
  ) {
    throw new TypeError('shadow race authority service requires finish core verification');
  }
  if (typeof readinessFor !== 'function') {
    throw new TypeError('shadow race authority service requires a readiness evaluator');
  }

  function readinessFrom(coreProgress) {
    const authorityVerification = boundaryVerification.metrics();
    const finishCoreVerificationMetrics = finishCoreVerification.metrics();
    return Object.freeze({
      authorityVerification,
      finishCoreVerification: finishCoreVerificationMetrics,
      authorityReadiness: readinessFor(coreProgress, {}, authorityVerification, finishCoreVerificationMetrics)
    });
  }

  function readiness() {
    return readinessFrom(progressDiagnostics.metrics()).authorityReadiness;
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
    const { authorityVerification, finishCoreVerification: finishVerification, authorityReadiness } =
      readinessFrom(coreProgress);
    return Object.freeze({
      coreProgress,
      authorityVerification,
      finishCoreVerification: finishVerification,
      authorityReadiness,
      authorityProbe: authorityProbe.metrics()
    });
  }

  function reset() {
    progressDiagnostics.reset();
    authorityProbe.reset();
    boundaryVerification.reset();
    finishCoreVerification.reset();
  }

  return {
    progressDiagnostics,
    authorityProbe,
    boundaryVerification,
    finishCoreVerification,
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
