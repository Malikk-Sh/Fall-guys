'use strict';

const AUTHORITY_SOURCE = Object.freeze({
  LEGACY: 'legacy',
  SHADOW: 'shadow'
});

const FALLBACK_REASON = Object.freeze({
  INVALID_LEGACY: 'invalid-legacy',
  SHADOW_NOT_READY: 'shadow-not-ready',
  SHADOW_UNAVAILABLE: 'shadow-unavailable'
});

function validProgress(progress) {
  return (
    !!progress &&
    Number.isSafeInteger(progress.checkpoint) &&
    progress.checkpoint >= 0 &&
    typeof progress.finished === 'boolean'
  );
}

function progressSnapshot(progress) {
  return Object.freeze({
    checkpoint: progress.checkpoint,
    finished: progress.finished
  });
}

function readinessAllowsShadow(readiness) {
  return (
    readiness?.ready === true &&
    Array.isArray(readiness.reasons) &&
    readiness.reasons.length === 0
  );
}

function selectedResult(source, progress, fallbackReason = null) {
  return Object.freeze({
    ok: true,
    source,
    fallbackReason,
    progress: progressSnapshot(progress)
  });
}

function selectRaceProgressAuthority({
  requestedSource = AUTHORITY_SOURCE.LEGACY,
  legacy,
  shadow = null,
  readiness = null
} = {}) {
  if (!validProgress(legacy)) {
    return Object.freeze({
      ok: false,
      source: AUTHORITY_SOURCE.LEGACY,
      fallbackReason: FALLBACK_REASON.INVALID_LEGACY,
      progress: null
    });
  }

  if (requestedSource !== AUTHORITY_SOURCE.SHADOW) {
    return selectedResult(AUTHORITY_SOURCE.LEGACY, legacy);
  }

  if (!readinessAllowsShadow(readiness)) {
    return selectedResult(AUTHORITY_SOURCE.LEGACY, legacy, FALLBACK_REASON.SHADOW_NOT_READY);
  }

  if (!validProgress(shadow)) {
    return selectedResult(AUTHORITY_SOURCE.LEGACY, legacy, FALLBACK_REASON.SHADOW_UNAVAILABLE);
  }

  return selectedResult(AUTHORITY_SOURCE.SHADOW, shadow);
}

module.exports = {
  AUTHORITY_SOURCE,
  FALLBACK_REASON,
  readinessAllowsShadow,
  selectRaceProgressAuthority,
  validProgress
};
