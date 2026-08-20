'use strict';

const { C2S, S2C, GAME_MODE } = require('../shared/protocol.js');
const { shadowRaceProgressCandidate } = require('./shadowRaceProgressCandidate');

const BOUNDARY = Object.freeze({
  STATE: 'state',
  FINISH_ACCEPTED: 'finish-accepted',
  FINISH_REJECTED: 'finish-rejected'
});
const BOUNDARIES = new Set(Object.values(BOUNDARY));

function createCounters() {
  return {
    boundarySamples: 0,
    stateSamples: 0,
    finishAcceptedSamples: 0,
    finishRejectedSamples: 0,
    candidateAvailableSamples: 0,
    candidateUnavailableSamples: 0,
    invalidLegacySamples: 0,
    checkpointMatches: 0,
    checkpointMismatches: 0,
    shadowAheadSamples: 0,
    legacyAheadSamples: 0,
    finishComparableSamples: 0,
    finishMatches: 0,
    finishMismatches: 0,
    acceptedButShadowUnfinishedSamples: 0,
    rejectedButShadowFinishedSamples: 0,
    maxCheckpointDelta: 0
  };
}

function rate(part, total) {
  return total > 0 ? Math.round((part / total) * 10_000) / 10_000 : 0;
}

function createShadowRaceProgressDiagnostics({ candidateFor = shadowRaceProgressCandidate } = {}) {
  let counters = createCounters();

  function observeBoundary({ boundary, room, player, runtimeService } = {}) {
    if (!BOUNDARIES.has(boundary) || room?.mode !== GAME_MODE.RACE || !player) return null;
    counters.boundarySamples++;
    if (boundary === BOUNDARY.STATE) counters.stateSamples++;
    if (boundary === BOUNDARY.FINISH_ACCEPTED) counters.finishAcceptedSamples++;
    if (boundary === BOUNDARY.FINISH_REJECTED) counters.finishRejectedSamples++;

    if (
      !Number.isSafeInteger(player.checkpoint) ||
      player.checkpoint < 0 ||
      typeof player.finished !== 'boolean'
    ) {
      counters.invalidLegacySamples++;
      return Object.freeze({ available: false, boundary, reason: 'invalid-legacy' });
    }

    let candidate = null;
    try {
      candidate = candidateFor({ room, player, runtimeService });
    } catch {
      candidate = null;
    }
    if (!candidate) {
      counters.candidateUnavailableSamples++;
      return Object.freeze({ available: false, boundary, reason: 'candidate-unavailable' });
    }

    counters.candidateAvailableSamples++;
    const checkpointDelta = candidate.checkpoint - player.checkpoint;
    const absoluteDelta = Math.abs(checkpointDelta);
    counters.maxCheckpointDelta = Math.max(counters.maxCheckpointDelta, absoluteDelta);
    if (checkpointDelta === 0) counters.checkpointMatches++;
    else {
      counters.checkpointMismatches++;
      if (checkpointDelta > 0) counters.shadowAheadSamples++;
      else counters.legacyAheadSamples++;
    }

    const finishBoundary = boundary !== BOUNDARY.STATE;
    let finishMatch = null;
    if (finishBoundary) {
      counters.finishComparableSamples++;
      finishMatch = candidate.finished === player.finished;
      if (finishMatch) counters.finishMatches++;
      else counters.finishMismatches++;
      if (boundary === BOUNDARY.FINISH_ACCEPTED && !candidate.finished) {
        counters.acceptedButShadowUnfinishedSamples++;
      }
      if (boundary === BOUNDARY.FINISH_REJECTED && candidate.finished) {
        counters.rejectedButShadowFinishedSamples++;
      }
    }

    return Object.freeze({
      available: true,
      boundary,
      matchId: candidate.matchId,
      serverTick: candidate.serverTick,
      lastProcessedInput: candidate.lastProcessedInput,
      legacyCheckpoint: player.checkpoint,
      shadowCheckpoint: candidate.checkpoint,
      checkpointDelta,
      legacyFinished: player.finished,
      shadowFinished: candidate.finished,
      finishMatch
    });
  }

  function observeAcceptedState({ message, room, player, runtimeService } = {}) {
    if (message?.type !== C2S.PLAYER_STATE) return null;
    if (message.matchId && room?.matchId && message.matchId !== room.matchId) return null;
    if (!Number.isSafeInteger(message.sequence) || message.sequence !== player?.lastSequence) return null;
    return observeBoundary({ boundary: BOUNDARY.STATE, room, player, runtimeService });
  }

  function observeOutcomePayload({ payload, room, player, runtimeService } = {}) {
    if (typeof payload !== 'string' || !room || !player) return null;
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return null;
    }

    let boundary = null;
    if (message?.type === S2C.PLAYER_FINISHED && message.id === player.id) {
      boundary = BOUNDARY.FINISH_ACCEPTED;
    } else if (message?.type === S2C.FINISH_REJECTED) {
      boundary = BOUNDARY.FINISH_REJECTED;
    } else {
      return null;
    }
    if (message.matchId && room.matchId && message.matchId !== room.matchId) return null;
    return observeBoundary({ boundary, room, player, runtimeService });
  }

  function metrics() {
    const snapshot = { ...counters };
    const checkpointComparable = snapshot.checkpointMatches + snapshot.checkpointMismatches;
    return {
      ...snapshot,
      availabilityRate: rate(snapshot.candidateAvailableSamples, snapshot.boundarySamples),
      checkpointMismatchRate: rate(snapshot.checkpointMismatches, checkpointComparable),
      finishMismatchRate: rate(snapshot.finishMismatches, snapshot.finishComparableSamples)
    };
  }

  function reset() {
    counters = createCounters();
  }

  return { observeBoundary, observeAcceptedState, observeOutcomePayload, metrics, reset };
}

module.exports = {
  BOUNDARY,
  createShadowRaceProgressDiagnostics
};
