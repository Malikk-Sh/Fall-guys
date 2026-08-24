'use strict';

const { spawnFor } = require('../shared/courseSpec.js');
const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const { isRaceCourseSpec, raceProgressCrossingAllowed } = require('./raceProgressSpatialGuard');

function createMetrics() {
  return {
    calls: 0,
    legacyDecisions: 0,
    shadowProjections: 0,
    clientCheckpointSuppressed: 0,
    errors: 0
  };
}

function validCheckpoint(room, checkpoint) {
  return (
    Number.isSafeInteger(checkpoint) &&
    checkpoint >= 0 &&
    Number.isSafeInteger(room?.spec?.segmentCount) &&
    checkpoint <= room.spec.segmentCount
  );
}

function createRaceCheckpointAuthorityCoreBridge({ matchGuard = raceProgressAuthorityMatchGuard } = {}) {
  if (!matchGuard || typeof matchGuard.sourceFor !== 'function') {
    throw new TypeError('race checkpoint authority core bridge requires a match authority guard');
  }

  const roomByPlayer = new WeakMap();
  let legacyValidateState = null;
  let counters = createMetrics();

  function attachedRoomFor(player, spec) {
    const room = player ? roomByPlayer.get(player) : null;
    if (!room || room.mode !== GAME_MODE.RACE || !room.matchId || room.spec !== spec) return null;
    if (room.players?.get && room.players.get(player.id) !== player) return null;
    return room;
  }

  function validateState(player, value, spec, now) {
    if (typeof legacyValidateState !== 'function') {
      throw new Error('race checkpoint authority core bridge is not installed');
    }

    counters.calls += 1;
    const result = legacyValidateState(player, value, spec, now);
    if (!result?.ok) return result;

    // This is a common result boundary, independent of legacy/shadow authority. Legacy validation
    // first decides whether the state update is valid movement and whether its segment crosses the
    // next checkpoint Z plane. We then validate the interpolated point ON that plane, not the packet
    // endpoint: a diagonal update cannot cross beside the course and merely end inside it.
    const previousCheckpoint = player?.checkpoint;
    if (
      isRaceCourseSpec(spec) &&
      Number.isSafeInteger(previousCheckpoint) &&
      result.checkpoint > previousCheckpoint
    ) {
      const line = spec.checkpoints[previousCheckpoint];
      const previous = player?.last || spawnFor(spec, previousCheckpoint);
      if (!raceProgressCrossingAllowed(spec, previous, result.state, line)) {
        return {
          ...result,
          checkpoint: previousCheckpoint,
          state: { ...result.state, checkpoint: previousCheckpoint }
        };
      }
    }

    const room = attachedRoomFor(player, spec);
    if (!room) {
      counters.legacyDecisions += 1;
      return result;
    }

    let source;
    try {
      source = matchGuard.sourceFor(room);
    } catch {
      counters.errors += 1;
      counters.legacyDecisions += 1;
      return result;
    }

    if (source !== AUTHORITY_SOURCE.SHADOW) {
      counters.legacyDecisions += 1;
      return result;
    }

    const checkpoint = player.checkpoint;
    if (!validCheckpoint(room, checkpoint)) {
      counters.errors += 1;
      counters.legacyDecisions += 1;
      return result;
    }

    counters.shadowProjections += 1;
    if (result.checkpoint !== checkpoint) counters.clientCheckpointSuppressed += 1;
    return {
      ...result,
      checkpoint,
      state: { ...result.state, checkpoint }
    };
  }

  function installGameRules(gameRules) {
    if (!gameRules || typeof gameRules.validateState !== 'function') {
      throw new TypeError('race checkpoint authority core bridge requires gameRules.validateState');
    }
    if (gameRules.validateState === validateState) return false;
    if (legacyValidateState && gameRules.validateState !== legacyValidateState) {
      throw new Error(
        'race checkpoint authority core bridge is already installed on another gameRules object'
      );
    }
    legacyValidateState = gameRules.validateState;
    gameRules.validateState = validateState;
    return true;
  }

  function attachPlayer(player, room) {
    if (!player || typeof player !== 'object' || !room || typeof room !== 'object') return false;
    const previous = roomByPlayer.get(player);
    roomByPlayer.set(player, room);
    return previous !== room;
  }

  function detachPlayer(player) {
    return player ? roomByPlayer.delete(player) : false;
  }

  function managesPlayer(player) {
    return !!player && roomByPlayer.has(player);
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    counters = createMetrics();
  }

  return Object.freeze({
    attachPlayer,
    detachPlayer,
    installGameRules,
    managesPlayer,
    metrics,
    reset,
    validateState
  });
}

const singleton = createRaceCheckpointAuthorityCoreBridge();

module.exports = Object.freeze({
  ...singleton,
  createRaceCheckpointAuthorityCoreBridge,
  validCheckpoint
});
