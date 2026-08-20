'use strict';

const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');

function validCourseCheckpoint(room, checkpoint) {
  const limit = room?.spec?.segmentCount;
  return (
    Number.isSafeInteger(limit) &&
    limit >= 0 &&
    Number.isSafeInteger(checkpoint) &&
    checkpoint >= 0 &&
    checkpoint <= limit
  );
}

function createMetrics() {
  return {
    attempts: 0,
    legacyDecisions: 0,
    shadowDecisions: 0,
    appliedAdvances: 0,
    unchangedShadowDecisions: 0,
    rejectedShadowDecisions: 0,
    errors: 0
  };
}

function createRaceCheckpointAuthorityApplier({ matchGuard = raceProgressAuthorityMatchGuard } = {}) {
  if (!matchGuard || typeof matchGuard.decide !== 'function') {
    throw new TypeError('race checkpoint authority applier requires a match guard');
  }

  let counters = createMetrics();

  function apply({ room, player, now = Date.now() } = {}) {
    if (room?.mode !== GAME_MODE.RACE || !player || player.finished) return null;
    if (!validCourseCheckpoint(room, player.checkpoint)) return null;

    counters.attempts += 1;
    const previousCheckpoint = player.checkpoint;
    const legacyProgress = {
      checkpoint: previousCheckpoint,
      finished: false
    };

    let decision;
    try {
      decision = matchGuard.decide({ room, player, legacyProgress });
    } catch {
      counters.errors += 1;
      return null;
    }

    if (!decision?.ok || !decision.progress) {
      counters.errors += 1;
      return null;
    }

    if (decision.source !== AUTHORITY_SOURCE.SHADOW) {
      counters.legacyDecisions += 1;
      return Object.freeze({
        source: AUTHORITY_SOURCE.LEGACY,
        applied: false,
        previousCheckpoint,
        checkpoint: previousCheckpoint,
        fallbackReason: decision.fallbackReason || null
      });
    }

    counters.shadowDecisions += 1;
    const checkpoint = decision.progress.checkpoint;
    if (!validCourseCheckpoint(room, checkpoint) || checkpoint < previousCheckpoint) {
      counters.rejectedShadowDecisions += 1;
      return Object.freeze({
        source: AUTHORITY_SOURCE.LEGACY,
        applied: false,
        previousCheckpoint,
        checkpoint: previousCheckpoint,
        fallbackReason: 'invalid-shadow-checkpoint'
      });
    }

    if (checkpoint === previousCheckpoint) {
      counters.unchangedShadowDecisions += 1;
      return Object.freeze({
        source: AUTHORITY_SOURCE.SHADOW,
        applied: false,
        previousCheckpoint,
        checkpoint,
        fallbackReason: null
      });
    }

    player.checkpoint = checkpoint;
    if (Number.isFinite(now)) player.checkpointAt = now;
    counters.appliedAdvances += 1;
    return Object.freeze({
      source: AUTHORITY_SOURCE.SHADOW,
      applied: true,
      previousCheckpoint,
      checkpoint,
      fallbackReason: null
    });
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    counters = createMetrics();
  }

  return Object.freeze({ apply, metrics, reset });
}

const singleton = createRaceCheckpointAuthorityApplier();

module.exports = Object.freeze({
  ...singleton,
  createRaceCheckpointAuthorityApplier,
  validCourseCheckpoint
});
