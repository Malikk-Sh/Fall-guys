'use strict';

const { GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const {
  isRaceCourseSpec,
  raceProgressPositionAllowed
} = require('./raceProgressSpatialGuard');

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

    // This is a common result boundary, independent of legacy/shadow authority. The legacy
    // validator may project a checkpoint from the crossed Z plane, but that projection is not a
    // valid race result when the accepted endpoint is outside the actual course corridor or high
    // above it. Movement itself stays accepted; only the checkpoint advance is suppressed.
    const previousCheckpoint = player?.checkpoint;
    if (
      isRaceCourseSpec(spec) &&
      Number.isSafeInteger(previousCheckpoint) &&
      result.checkpoint > previousCheckpoint &&
      !raceProgressPositionAllowed(spec, result.state)
    ) {
      return {
        ...result,
        checkpoint: previousCheckpoint,
        state: { ...result.state, checkpoint: previousCheckpoint }
      };
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
