'use strict';

const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceFinishAuthorityDecision = require('./raceFinishAuthorityDecision');
const { isRaceCourseSpec, raceProgressPositionAllowed } = require('./raceProgressSpatialGuard');

function createMetrics() {
  return {
    attempts: 0,
    legacyDecisions: 0,
    shadowAccepts: 0,
    shadowRejects: 0,
    errors: 0
  };
}

function validAuthoritativeTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function createRaceFinishAuthorityCoreBridge({ finishDecision = raceFinishAuthorityDecision } = {}) {
  if (!finishDecision || typeof finishDecision.decide !== 'function') {
    throw new TypeError('race finish authority core bridge requires a finish decision');
  }

  const pendingByPlayer = new WeakMap();
  const timeStateByPlayer = new WeakMap();
  let legacyCanFinish = null;
  let counters = createMetrics();

  function canFinish(player, spec) {
    const pending = player ? pendingByPlayer.get(player) : null;
    // A shadow accept comes from shadowRaceProgress, which applies the same spatial guard to the
    // server-owned simulated position before it can mark progress finished. Do not re-check the
    // lagging client snapshot here or a valid server finish could be rejected by network delay.
    if (pending?.source === AUTHORITY_SOURCE.SHADOW) return pending.accept === true;

    // Legacy progress is based on the last accepted client state. It still has to be inside the
    // canonical race corridor; reaching the finish Z plane far beside or high above the course is
    // movement, but it is not a valid race result.
    if (isRaceCourseSpec(spec) && !raceProgressPositionAllowed(spec, player?.last)) return false;
    return typeof legacyCanFinish === 'function' ? legacyCanFinish(player, spec) : false;
  }

  function installGameRules(gameRules) {
    if (!gameRules || typeof gameRules.canFinish !== 'function') {
      throw new TypeError('race finish authority core bridge requires gameRules.canFinish');
    }
    if (gameRules.canFinish === canFinish) return false;
    if (legacyCanFinish && gameRules.canFinish !== legacyCanFinish) {
      throw new Error('race finish authority core bridge is already installed on another gameRules object');
    }
    legacyCanFinish = gameRules.canFinish;
    gameRules.canFinish = canFinish;
    return true;
  }

  function authoritativeAssignedTime(player, assigned) {
    const pending = pendingByPlayer.get(player);
    if (
      pending?.source === AUTHORITY_SOURCE.SHADOW &&
      pending.accept === true &&
      validAuthoritativeTime(pending.finishTimeMs)
    ) {
      return pending.finishTimeMs;
    }
    return assigned;
  }

  function attachPlayer(player) {
    if (!player || typeof player !== 'object' || timeStateByPlayer.has(player)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(player, 'time');
    if (descriptor && descriptor.configurable === false) return false;
    if (descriptor?.get || descriptor?.set) return false;

    const state = {
      value: player.time,
      enumerable: descriptor ? descriptor.enumerable !== false : true
    };
    Object.defineProperty(player, 'time', {
      configurable: true,
      enumerable: state.enumerable,
      get() {
        return state.value;
      },
      set(value) {
        state.value = authoritativeAssignedTime(player, value);
      }
    });
    timeStateByPlayer.set(player, state);
    return true;
  }

  function detachPlayer(player) {
    const state = player ? timeStateByPlayer.get(player) : null;
    if (!state) return false;
    const value = state.value;
    pendingByPlayer.delete(player);
    timeStateByPlayer.delete(player);
    delete player.time;
    Object.defineProperty(player, 'time', {
      configurable: true,
      enumerable: state.enumerable,
      writable: true,
      value
    });
    return true;
  }

  function normalizeShadowDecision(decision) {
    const accepted = decision?.accept === true && validAuthoritativeTime(decision.finishTimeMs);
    if (decision?.accept === true && !accepted) counters.errors += 1;
    return Object.freeze({
      ...decision,
      source: AUTHORITY_SOURCE.SHADOW,
      handled: true,
      accept: accepted
    });
  }

  function prepare({ room, player } = {}) {
    if (!player) return null;
    counters.attempts += 1;

    let decision;
    try {
      decision = finishDecision.decide({ room, player });
    } catch {
      counters.errors += 1;
      pendingByPlayer.delete(player);
      return null;
    }

    if (!decision || typeof decision !== 'object') {
      counters.errors += 1;
      pendingByPlayer.delete(player);
      return null;
    }

    if (decision.source !== AUTHORITY_SOURCE.SHADOW) {
      counters.legacyDecisions += 1;
      pendingByPlayer.delete(player);
      return decision;
    }

    const normalized = normalizeShadowDecision(decision);
    pendingByPlayer.set(player, normalized);
    if (normalized.accept) counters.shadowAccepts += 1;
    else counters.shadowRejects += 1;
    return normalized;
  }

  function clear(player) {
    return player ? pendingByPlayer.delete(player) : false;
  }

  function managesPlayer(player) {
    return !!player && timeStateByPlayer.has(player);
  }

  function hasPending(player) {
    return !!player && pendingByPlayer.has(player);
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    counters = createMetrics();
  }

  return Object.freeze({
    attachPlayer,
    canFinish,
    clear,
    detachPlayer,
    hasPending,
    installGameRules,
    managesPlayer,
    metrics,
    prepare,
    reset
  });
}

const singleton = createRaceFinishAuthorityCoreBridge();

module.exports = Object.freeze({
  ...singleton,
  createRaceFinishAuthorityCoreBridge,
  validAuthoritativeTime
});
