'use strict';

const { C2S, S2C, GAME_MODE } = require('../shared/protocol.js');

function copiedProgress(progress) {
  if (!progress) return null;
  return Object.freeze({ checkpoint: progress.checkpoint, finished: progress.finished });
}

function sameProgress(left, right) {
  return !!left && !!right && left.checkpoint === right.checkpoint && left.finished === right.finished;
}

function createRaceProgressAuthorityBoundaryVerification() {
  let pending = new WeakMap();
  let counters = {
    remembered: 0,
    stateComparisons: 0,
    stateMismatches: 0,
    finishComparisons: 0,
    finishMismatches: 0,
    stalePending: 0,
    missingPending: 0
  };

  function remember({ room, player, message, probeResult } = {}) {
    if (room?.mode !== GAME_MODE.RACE || !room.matchId || !player || !probeResult?.legacyProgress) {
      return false;
    }
    if (message?.type !== C2S.PLAYER_STATE && message?.type !== C2S.FINISH) return false;
    pending.set(
      player,
      Object.freeze({
        matchId: room.matchId,
        messageType: message.type,
        sequence: message.sequence,
        legacyProgress: copiedProgress(probeResult.legacyProgress)
      })
    );
    counters.remembered++;
    return true;
  }

  function take({ room, player, messageType, sequence = null } = {}) {
    const entry = player ? pending.get(player) : null;
    if (!entry) {
      counters.missingPending++;
      return null;
    }
    const sequenceMatches = sequence === null || entry.sequence === sequence;
    if (entry.matchId !== room?.matchId || entry.messageType !== messageType || !sequenceMatches) {
      pending.delete(player);
      counters.stalePending++;
      return null;
    }
    pending.delete(player);
    return entry;
  }

  function compare(entry, actual, kind) {
    const match = sameProgress(entry.legacyProgress, actual);
    if (kind === 'state') {
      counters.stateComparisons++;
      if (!match) counters.stateMismatches++;
    } else {
      counters.finishComparisons++;
      if (!match) counters.finishMismatches++;
    }
    return Object.freeze({
      match,
      expected: copiedProgress(entry.legacyProgress),
      actual: copiedProgress(actual)
    });
  }

  function observeAcceptedState({ room, player, message } = {}) {
    if (room?.mode !== GAME_MODE.RACE || message?.type !== C2S.PLAYER_STATE || !player) return null;
    const entry = take({
      room,
      player,
      messageType: C2S.PLAYER_STATE,
      sequence: message.sequence
    });
    if (!entry) return null;
    return compare(entry, { checkpoint: player.checkpoint, finished: !!player.finished }, 'state');
  }

  function observeOutcomePayload({ payload, room, player } = {}) {
    if (typeof payload !== 'string' || room?.mode !== GAME_MODE.RACE || !player) return null;
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return null;
    }
    const accepted = message?.type === S2C.PLAYER_FINISHED && message.id === player.id;
    const rejected = message?.type === S2C.FINISH_REJECTED;
    if (!accepted && !rejected) return null;
    if (message.matchId && message.matchId !== room.matchId) return null;

    const entry = take({ room, player, messageType: C2S.FINISH });
    if (!entry) return null;
    return compare(entry, { checkpoint: player.checkpoint, finished: accepted }, 'finish');
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    pending = new WeakMap();
    counters = {
      remembered: 0,
      stateComparisons: 0,
      stateMismatches: 0,
      finishComparisons: 0,
      finishMismatches: 0,
      stalePending: 0,
      missingPending: 0
    };
  }

  return Object.freeze({ remember, observeAcceptedState, observeOutcomePayload, metrics, reset });
}

const singleton = createRaceProgressAuthorityBoundaryVerification();

module.exports = Object.freeze({
  ...singleton,
  sameProgress,
  createRaceProgressAuthorityBoundaryVerification
});
