'use strict';

const { C2S, GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { validateState, canFinish } = require('./gameRules');
const raceProgressAuthorityDecision = require('./raceProgressAuthorityDecision');

const ACTIVE_STATES = new Set([ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);

function copiedProgress(progress) {
  if (!progress) return null;
  return Object.freeze({ checkpoint: progress.checkpoint, finished: progress.finished });
}

function legacyProgressProposal({
  room,
  player,
  message,
  now = Date.now(),
  validate = validateState,
  finishAllowed = canFinish
} = {}) {
  if (!room || room.mode !== GAME_MODE.RACE || !ACTIVE_STATES.has(room.state)) return null;
  if (!player || !message) return null;
  if (message.matchId && message.matchId !== room.matchId) return null;
  if (message.sequence <= (player.lastSequence ?? -1)) return null;

  if (message.type === C2S.PLAYER_STATE) {
    if (now < room.startedAt - 300) return null;
    if (now - (player.receivedAt || 0) < 32) return null;
    const result = validate(player, message.state, room.spec, now);
    if (!result?.ok) return null;
    return Object.freeze({ checkpoint: result.checkpoint, finished: !!player.finished });
  }

  if (message.type !== C2S.FINISH || player.finished) return null;
  const result = validate(player, message.state, room.spec, now);
  const projected = result?.ok
    ? {
        ...player,
        checkpoint: result.checkpoint,
        last: { ...result.state, id: player.id }
      }
    : player;
  const finished = !!player.finished || finishAllowed(projected, room.spec);
  return Object.freeze({ checkpoint: projected.checkpoint ?? 0, finished });
}

function createRaceProgressAuthorityBoundaryProbe({
  decision = raceProgressAuthorityDecision,
  proposalFor = legacyProgressProposal
} = {}) {
  if (!decision || typeof decision.decide !== 'function' || typeof proposalFor !== 'function') {
    throw new TypeError('race progress authority boundary probe requires decision and proposal functions');
  }

  const counters = {
    samples: 0,
    stateSamples: 0,
    finishSamples: 0,
    selectedLegacy: 0,
    selectedShadow: 0,
    invalidDecisions: 0,
    fallbackReasons: Object.create(null)
  };

  function observe({ room, player, message, now } = {}) {
    const legacyProgress = proposalFor({ room, player, message, now });
    if (!legacyProgress) return null;

    const result = decision.decide({ room, player, legacyProgress });
    counters.samples++;
    if (message.type === C2S.PLAYER_STATE) counters.stateSamples++;
    else counters.finishSamples++;

    if (!result?.ok || !result.progress) counters.invalidDecisions++;
    if (result?.source === 'shadow') counters.selectedShadow++;
    else counters.selectedLegacy++;
    if (result?.fallbackReason) {
      counters.fallbackReasons[result.fallbackReason] =
        (counters.fallbackReasons[result.fallbackReason] || 0) + 1;
    }

    return Object.freeze({
      messageType: message.type,
      legacyProgress: copiedProgress(legacyProgress),
      ok: !!result?.ok,
      source: result?.source || 'legacy',
      fallbackReason: result?.fallbackReason || null,
      progress: copiedProgress(result?.progress)
    });
  }

  function metrics() {
    return Object.freeze({
      samples: counters.samples,
      stateSamples: counters.stateSamples,
      finishSamples: counters.finishSamples,
      selectedLegacy: counters.selectedLegacy,
      selectedShadow: counters.selectedShadow,
      invalidDecisions: counters.invalidDecisions,
      fallbackReasons: Object.freeze({ ...counters.fallbackReasons })
    });
  }

  function reset() {
    counters.samples = 0;
    counters.stateSamples = 0;
    counters.finishSamples = 0;
    counters.selectedLegacy = 0;
    counters.selectedShadow = 0;
    counters.invalidDecisions = 0;
    counters.fallbackReasons = Object.create(null);
  }

  return Object.freeze({ observe, metrics, reset });
}

const singleton = createRaceProgressAuthorityBoundaryProbe();

module.exports = Object.freeze({
  ...singleton,
  ACTIVE_STATES,
  legacyProgressProposal,
  createRaceProgressAuthorityBoundaryProbe
});
