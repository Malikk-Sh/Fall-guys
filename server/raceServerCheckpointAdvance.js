'use strict';

const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const raceCheckpointAuthorityApplier = require('./raceCheckpointAuthorityApplier');

function createMetrics() {
  return {
    attempts: 0,
    applied: 0,
    unchanged: 0,
    fallbacks: 0,
    legacySkipped: 0,
    unlatchedSkipped: 0,
    errors: 0
  };
}

function createRaceServerCheckpointAdvance({
  matchGuard = raceProgressAuthorityMatchGuard,
  checkpointApplier = raceCheckpointAuthorityApplier
} = {}) {
  if (!matchGuard || typeof matchGuard.sourceFor !== 'function') {
    throw new TypeError('race server checkpoint advance requires a match authority guard');
  }
  if (!checkpointApplier || typeof checkpointApplier.apply !== 'function') {
    throw new TypeError('race server checkpoint advance requires a checkpoint authority applier');
  }

  let counters = createMetrics();

  function apply({ room, player, now = Date.now() } = {}) {
    if (
      room?.mode !== GAME_MODE.RACE ||
      room.state !== ROOM_STATE.PLAYING ||
      !room.matchId ||
      !player ||
      player.bot ||
      player.finished
    ) {
      return null;
    }

    let source;
    try {
      source = matchGuard.sourceFor(room);
    } catch {
      counters.errors += 1;
      return null;
    }

    if (source === AUTHORITY_SOURCE.LEGACY) {
      counters.legacySkipped += 1;
      return null;
    }
    if (source !== AUTHORITY_SOURCE.SHADOW) {
      counters.unlatchedSkipped += 1;
      return null;
    }

    counters.attempts += 1;
    let result;
    try {
      result = checkpointApplier.apply({ room, player, now });
    } catch {
      counters.errors += 1;
      return null;
    }

    if (!result || typeof result !== 'object') {
      counters.errors += 1;
      return null;
    }
    if (result.source !== AUTHORITY_SOURCE.SHADOW) {
      counters.fallbacks += 1;
      return result;
    }

    if (result.applied === true) counters.applied += 1;
    else counters.unchanged += 1;
    return result;
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    counters = createMetrics();
  }

  return Object.freeze({ apply, metrics, reset });
}

const singleton = createRaceServerCheckpointAdvance();

module.exports = Object.freeze({
  ...singleton,
  createRaceServerCheckpointAdvance
});
