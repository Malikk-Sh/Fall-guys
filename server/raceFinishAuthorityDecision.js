'use strict';

const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE, validProgress } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const { shadowRaceProgressCandidate } = require('./shadowRaceProgressCandidate');
const shadowRuntimeService = require('./shadowRuntimeService');

const FINISH_DECISION_REASON = Object.freeze({
  INVALID_CONTEXT: 'invalid-finish-context',
  GUARD_ERROR: 'finish-guard-error',
  SHADOW_UNAVAILABLE: 'shadow-finish-unavailable',
  SHADOW_MISMATCH: 'shadow-finish-mismatch',
  SHADOW_NOT_FINISHED: 'shadow-not-finished',
  SHADOW_TIMING_INVALID: 'shadow-finish-timing-invalid'
});

function legacyOutcome({ ok = true, fallbackReason = null, progress = null } = {}) {
  return Object.freeze({
    ok,
    source: AUTHORITY_SOURCE.LEGACY,
    handled: false,
    accept: null,
    fallbackReason,
    progress: validProgress(progress) ? Object.freeze({ ...progress }) : null,
    finishTimeMs: null,
    finishServerTime: null,
    finishServerTick: null,
    serverTick: null,
    lastProcessedInput: null
  });
}

function shadowOutcome(candidate, { accept, fallbackReason = null } = {}) {
  return Object.freeze({
    ok: true,
    source: AUTHORITY_SOURCE.SHADOW,
    handled: true,
    accept,
    fallbackReason,
    progress: Object.freeze({ checkpoint: candidate.checkpoint, finished: candidate.finished }),
    finishTimeMs: accept ? candidate.finishTimeMs : null,
    finishServerTime: accept ? candidate.finishServerTime : null,
    finishServerTick: accept ? candidate.finishServerTick : null,
    serverTick: candidate.serverTick,
    lastProcessedInput: candidate.lastProcessedInput
  });
}

function candidateMatchesDecision(room, authorityDecision, candidate) {
  if (!room?.matchId || !candidate || candidate.matchId !== room.matchId) return false;
  if (!validProgress(authorityDecision?.progress)) return false;
  return (
    candidate.checkpoint === authorityDecision.progress.checkpoint &&
    candidate.finished === authorityDecision.progress.finished &&
    Number.isSafeInteger(candidate.serverTick) &&
    candidate.serverTick >= 0 &&
    Number.isSafeInteger(candidate.lastProcessedInput) &&
    candidate.lastProcessedInput >= 0
  );
}

function validFinishTiming(room, candidate) {
  return (
    Number.isSafeInteger(room?.startedAt) &&
    room.startedAt >= 0 &&
    Number.isSafeInteger(candidate?.finishTimeMs) &&
    candidate.finishTimeMs >= 0 &&
    Number.isSafeInteger(candidate.finishServerTime) &&
    candidate.finishServerTime === room.startedAt + candidate.finishTimeMs &&
    Number.isSafeInteger(candidate.finishServerTick) &&
    candidate.finishServerTick >= 0 &&
    candidate.finishServerTick <= candidate.serverTick
  );
}

function finishOutcomeFor({ room, authorityDecision, candidate = null } = {}) {
  if (!authorityDecision?.ok || authorityDecision.source !== AUTHORITY_SOURCE.SHADOW) {
    return legacyOutcome({
      ok: authorityDecision?.ok !== false,
      fallbackReason: authorityDecision?.fallbackReason || null,
      progress: authorityDecision?.progress || null
    });
  }

  if (!candidate) {
    return Object.freeze({
      ...legacyOutcome({ ok: false, fallbackReason: FINISH_DECISION_REASON.SHADOW_UNAVAILABLE }),
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: false
    });
  }
  if (!candidateMatchesDecision(room, authorityDecision, candidate)) {
    return shadowOutcome(candidate, {
      accept: false,
      fallbackReason: FINISH_DECISION_REASON.SHADOW_MISMATCH
    });
  }
  if (!candidate.finished) {
    return shadowOutcome(candidate, {
      accept: false,
      fallbackReason: FINISH_DECISION_REASON.SHADOW_NOT_FINISHED
    });
  }
  if (!validFinishTiming(room, candidate)) {
    return shadowOutcome(candidate, {
      accept: false,
      fallbackReason: FINISH_DECISION_REASON.SHADOW_TIMING_INVALID
    });
  }
  return shadowOutcome(candidate, { accept: true });
}

function createRaceFinishAuthorityDecision({
  matchGuard = raceProgressAuthorityMatchGuard,
  candidateFor = shadowRaceProgressCandidate,
  runtimeService = shadowRuntimeService
} = {}) {
  if (!matchGuard || typeof matchGuard.decide !== 'function' || typeof candidateFor !== 'function') {
    throw new TypeError('race finish authority decision requires match guard and candidate functions');
  }

  function decide({ room, player } = {}) {
    if (room?.mode !== GAME_MODE.RACE || !player) {
      return legacyOutcome({ ok: false, fallbackReason: FINISH_DECISION_REASON.INVALID_CONTEXT });
    }

    const legacyProgress = {
      checkpoint: player.checkpoint,
      finished: player.finished === true
    };
    let authorityDecision;
    try {
      authorityDecision = matchGuard.decide({ room, player, legacyProgress });
    } catch {
      return legacyOutcome({ ok: false, fallbackReason: FINISH_DECISION_REASON.GUARD_ERROR });
    }

    if (authorityDecision?.source !== AUTHORITY_SOURCE.SHADOW) {
      return finishOutcomeFor({ room, authorityDecision });
    }

    let candidate = null;
    try {
      candidate = candidateFor({ room, player, runtimeService });
    } catch {
      candidate = null;
    }
    return finishOutcomeFor({ room, authorityDecision, candidate });
  }

  return Object.freeze({ decide });
}

const singleton = createRaceFinishAuthorityDecision();

module.exports = Object.freeze({
  ...singleton,
  FINISH_DECISION_REASON,
  candidateMatchesDecision,
  createRaceFinishAuthorityDecision,
  finishOutcomeFor,
  legacyOutcome,
  validFinishTiming
});
