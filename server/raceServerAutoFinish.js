'use strict';

const { C2S, GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const shadowRuntimeService = require('./shadowRuntimeService');

const PLAYER_STATES = new Set(['ground', 'air', 'dive', 'slam', 'knockdown', 'downed']);

function createMetrics() {
  return {
    candidates: 0,
    emitted: 0,
    legacySkipped: 0,
    unlatchedSkipped: 0,
    invalidSnapshot: 0,
    invalidState: 0,
    duplicateSuppressed: 0,
    emitFailures: 0
  };
}

function finiteStateFor(player) {
  const source = player?.last;
  if (!source || ![source.x, source.y, source.z, source.ry, source.vx, source.vz].every(Number.isFinite)) {
    return null;
  }
  const state = {
    x: Number(source.x),
    y: Number(source.y),
    z: Number(source.z),
    ry: Number(source.ry),
    vx: Number(source.vx),
    vz: Number(source.vz)
  };
  if (Number.isFinite(source.vy)) state.vy = Number(source.vy);
  if (PLAYER_STATES.has(source.state)) state.state = source.state;
  return state;
}

function validFinishedSnapshot(snapshot, room) {
  return (
    !!snapshot &&
    snapshot.matchId === room?.matchId &&
    snapshot.progress?.finished === true &&
    Number.isSafeInteger(snapshot.finishServerTime) &&
    Number.isSafeInteger(room?.startedAt) &&
    snapshot.finishServerTime >= room.startedAt
  );
}

function createRaceServerAutoFinish({
  runtimeService = shadowRuntimeService,
  matchGuard = raceProgressAuthorityMatchGuard
} = {}) {
  if (!runtimeService || typeof runtimeService.snapshot !== 'function') {
    throw new TypeError('race server auto finish requires a shadow runtime service');
  }
  if (!matchGuard || typeof matchGuard.sourceFor !== 'function') {
    throw new TypeError('race server auto finish requires a match authority guard');
  }

  let attempted = new WeakMap();
  let counters = createMetrics();

  function apply({ room, player } = {}) {
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

    const source = matchGuard.sourceFor(room);
    if (source === AUTHORITY_SOURCE.LEGACY) {
      counters.legacySkipped += 1;
      return null;
    }
    if (source !== AUTHORITY_SOURCE.SHADOW) {
      counters.unlatchedSkipped += 1;
      return null;
    }

    let snapshot;
    try {
      snapshot = runtimeService.snapshot(player);
    } catch {
      counters.invalidSnapshot += 1;
      return null;
    }
    if (!validFinishedSnapshot(snapshot, room)) {
      if (snapshot?.progress?.finished === true) counters.invalidSnapshot += 1;
      return null;
    }

    counters.candidates += 1;
    const previous = attempted.get(player);
    if (previous?.matchId === room.matchId && previous.finishServerTime === snapshot.finishServerTime) {
      counters.duplicateSuppressed += 1;
      return null;
    }

    const state = finiteStateFor(player);
    if (!state) {
      counters.invalidState += 1;
      return null;
    }
    const sequence = (player.lastSequence ?? -1) + 1;
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      counters.invalidState += 1;
      return null;
    }
    const ws = player.ws;
    if (!ws || typeof ws.emit !== 'function') {
      counters.invalidState += 1;
      return null;
    }

    attempted.set(player, {
      matchId: room.matchId,
      finishServerTime: snapshot.finishServerTime
    });
    const message = Object.freeze({
      type: C2S.FINISH,
      matchId: room.matchId,
      sequence,
      state: Object.freeze(state)
    });

    try {
      ws.emit('message', Buffer.from(JSON.stringify(message)));
      counters.emitted += 1;
    } catch {
      counters.emitFailures += 1;
      return null;
    }
    return message;
  }

  function metrics() {
    return Object.freeze({ ...counters });
  }

  function reset() {
    attempted = new WeakMap();
    counters = createMetrics();
  }

  return Object.freeze({ apply, metrics, reset });
}

const singleton = createRaceServerAutoFinish();

module.exports = Object.freeze({
  ...singleton,
  createRaceServerAutoFinish,
  finiteStateFor,
  validFinishedSnapshot
});
