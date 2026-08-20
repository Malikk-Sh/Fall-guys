'use strict';

const {
  AUTHORITY_SOURCE,
  readinessAllowsShadow,
  selectRaceProgressAuthority,
  validProgress
} = require('./raceProgressAuthoritySelector');
const { shadowRaceProgressCandidate } = require('./shadowRaceProgressCandidate');
const shadowRuntimeService = require('./shadowRuntimeService');
const shadowRaceAuthorityService = require('./shadowRaceAuthorityService');

const AUTHORITY_ENV = 'RACE_PROGRESS_AUTHORITY';

function authoritySource(value) {
  return value === AUTHORITY_SOURCE.SHADOW ? AUTHORITY_SOURCE.SHADOW : AUTHORITY_SOURCE.LEGACY;
}

function candidateProgress(candidate) {
  if (!candidate) return null;
  return {
    checkpoint: candidate.checkpoint,
    finished: candidate.finished
  };
}

function createRaceProgressAuthorityDecision({
  requestedSource = authoritySource(process.env[AUTHORITY_ENV]),
  candidateFor = shadowRaceProgressCandidate,
  selector = selectRaceProgressAuthority,
  runtimeService = shadowRuntimeService,
  authorityService = shadowRaceAuthorityService
} = {}) {
  const source = authoritySource(requestedSource);
  if (typeof candidateFor !== 'function' || typeof selector !== 'function') {
    throw new TypeError('race progress authority decision requires candidate and selector functions');
  }
  if (!authorityService || typeof authorityService.readiness !== 'function') {
    throw new TypeError('race progress authority decision requires authority readiness service');
  }

  function decide({ room, player } = {}) {
    const legacy = {
      checkpoint: player?.checkpoint,
      finished: player?.finished
    };
    if (!validProgress(legacy)) {
      return selector({ requestedSource: source, legacy });
    }
    if (source !== AUTHORITY_SOURCE.SHADOW) {
      return selector({ requestedSource: source, legacy });
    }

    let readiness = null;
    try {
      readiness = authorityService.readiness();
    } catch {
      readiness = null;
    }
    if (!readinessAllowsShadow(readiness)) {
      return selector({ requestedSource: source, legacy, readiness });
    }

    let candidate = null;
    try {
      candidate = candidateFor({ room, player, runtimeService });
    } catch {
      candidate = null;
    }
    return selector({
      requestedSource: source,
      legacy,
      shadow: candidateProgress(candidate),
      readiness
    });
  }

  return Object.freeze({
    decide,
    requestedSource: source
  });
}

const singleton = createRaceProgressAuthorityDecision();

module.exports = Object.freeze({
  ...singleton,
  AUTHORITY_ENV,
  authoritySource,
  candidateProgress,
  createRaceProgressAuthorityDecision
});
