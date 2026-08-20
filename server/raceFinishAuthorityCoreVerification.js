'use strict';

const { S2C, GAME_MODE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');

function createCounters() {
  return {
    remembered: 0,
    comparisons: 0,
    acceptComparisons: 0,
    rejectComparisons: 0,
    outcomeMismatches: 0,
    timingMismatches: 0,
    stalePending: 0
  };
}

function validFinishDecision(decision) {
  if (!decision || decision.source !== AUTHORITY_SOURCE.SHADOW || decision.handled !== true) return false;
  if (typeof decision.accept !== 'boolean') return false;
  if (!decision.accept) return true;
  return Number.isSafeInteger(decision.finishTimeMs) && decision.finishTimeMs >= 0;
}

function createRaceFinishAuthorityCoreVerification() {
  let pending = new WeakMap();
  let counters = createCounters();

  function remember({ room, player, decision } = {}) {
    if (room?.mode !== GAME_MODE.RACE || !room.matchId || !player || !validFinishDecision(decision)) {
      return false;
    }
    if (pending.has(player)) counters.stalePending += 1;
    pending.set(
      player,
      Object.freeze({
        matchId: room.matchId,
        accept: decision.accept,
        finishTimeMs: decision.accept ? decision.finishTimeMs : null
      })
    );
    counters.remembered += 1;
    return true;
  }

  function hasPending(player) {
    return !!player && pending.has(player);
  }

  function clear(player) {
    return player ? pending.delete(player) : false;
  }

  function observeOutcomePayload({ payload, room, player } = {}) {
    if (typeof payload !== 'string' || room?.mode !== GAME_MODE.RACE || !player) return null;
    const expected = pending.get(player);
    if (!expected) return null;

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

    pending.delete(player);
    if (expected.matchId !== room.matchId) {
      counters.stalePending += 1;
      return Object.freeze({ match: false, reason: 'match-mismatch' });
    }

    counters.comparisons += 1;
    const actualAccept = accepted;
    if (expected.accept) counters.acceptComparisons += 1;
    else counters.rejectComparisons += 1;

    const outcomeMatch = actualAccept === expected.accept;
    if (!outcomeMatch) counters.outcomeMismatches += 1;

    let timingMatch = true;
    if (expected.accept && actualAccept) {
      timingMatch =
        player.time === expected.finishTimeMs &&
        Number.isSafeInteger(message.time) &&
        message.time === expected.finishTimeMs;
      if (!timingMatch) counters.timingMismatches += 1;
    }

    return Object.freeze({
      match: outcomeMatch && timingMatch,
      expected: Object.freeze({ ...expected }),
      actual: Object.freeze({
        accept: actualAccept,
        finishTimeMs: actualAccept && Number.isSafeInteger(message.time) ? message.time : null
      }),
      outcomeMatch,
      timingMatch
    });
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    pending = new WeakMap();
    counters = createCounters();
  }

  return Object.freeze({ clear, hasPending, metrics, observeOutcomePayload, remember, reset });
}

const singleton = createRaceFinishAuthorityCoreVerification();

module.exports = Object.freeze({
  ...singleton,
  createRaceFinishAuthorityCoreVerification,
  validFinishDecision
});
