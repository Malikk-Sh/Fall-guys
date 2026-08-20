'use strict';

const {
  AUTHORITY_SOURCE,
  FALLBACK_REASON,
  selectRaceProgressAuthority
} = require('./raceProgressAuthoritySelector');

const PROBE_ENV = 'SHADOW_RACE_AUTHORITY_PROBE';

function probeSource(value) {
  return value === AUTHORITY_SOURCE.SHADOW ? AUTHORITY_SOURCE.SHADOW : AUTHORITY_SOURCE.LEGACY;
}

function createCounters() {
  return {
    decisions: 0,
    requestedLegacy: 0,
    requestedShadow: 0,
    selectedLegacy: 0,
    selectedShadow: 0,
    fallbackInvalidLegacy: 0,
    fallbackShadowNotReady: 0,
    fallbackShadowUnavailable: 0
  };
}

function candidateProgress(sample) {
  if (!sample?.available) return null;
  return {
    checkpoint: sample.shadowCheckpoint,
    finished: sample.shadowFinished
  };
}

function createShadowRaceAuthorityProbe({
  requestedSource = probeSource(process.env[PROBE_ENV]),
  selector = selectRaceProgressAuthority
} = {}) {
  const source = probeSource(requestedSource);
  let counters = createCounters();

  function observe({ sample, player, readiness } = {}) {
    if (!sample || !player) return null;
    const result = selector({
      requestedSource: source,
      legacy: {
        checkpoint: player.checkpoint,
        finished: player.finished
      },
      shadow: candidateProgress(sample),
      readiness
    });

    counters.decisions++;
    if (source === AUTHORITY_SOURCE.SHADOW) counters.requestedShadow++;
    else counters.requestedLegacy++;
    if (result.source === AUTHORITY_SOURCE.SHADOW) counters.selectedShadow++;
    else counters.selectedLegacy++;
    if (result.fallbackReason === FALLBACK_REASON.INVALID_LEGACY) counters.fallbackInvalidLegacy++;
    if (result.fallbackReason === FALLBACK_REASON.SHADOW_NOT_READY) counters.fallbackShadowNotReady++;
    if (result.fallbackReason === FALLBACK_REASON.SHADOW_UNAVAILABLE) {
      counters.fallbackShadowUnavailable++;
    }
    return result;
  }

  function metrics() {
    return Object.freeze({
      requestedSource: source,
      ...counters
    });
  }

  function reset() {
    counters = createCounters();
  }

  return { observe, metrics, reset, requestedSource: source };
}

module.exports = {
  PROBE_ENV,
  createShadowRaceAuthorityProbe,
  probeSource
};
