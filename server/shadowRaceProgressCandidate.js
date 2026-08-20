'use strict';

const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const shadowRuntimeService = require('./shadowRuntimeService');

const ACTIVE_STATES = new Set([ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING]);

function safeCheckpointLimit(room) {
  const segmentCount = room?.spec?.segmentCount;
  if (Number.isSafeInteger(segmentCount) && segmentCount >= 0) return segmentCount;
  const checkpoints = room?.spec?.checkpoints;
  return Array.isArray(checkpoints) ? checkpoints.length : -1;
}

function validProgress(progress, checkpointLimit) {
  if (!progress || checkpointLimit < 0) return false;
  if (!Number.isSafeInteger(progress.checkpoint)) return false;
  if (progress.checkpoint < 0 || progress.checkpoint > checkpointLimit) return false;
  if (typeof progress.finished !== 'boolean') return false;
  if (progress.finished && progress.checkpoint !== checkpointLimit) return false;
  const validFinishTick = Number.isSafeInteger(progress.finishServerTick) && progress.finishServerTick >= 0;
  if (progress.finished && !validFinishTick) return false;
  if (!progress.finished && progress.finishServerTick !== null) return false;
  return true;
}

function finishTimingFor(room, shadow) {
  const finished = shadow?.progress?.finished === true;
  const finishServerTime = shadow?.finishServerTime;
  if (!finished) {
    return finishServerTime === null ? Object.freeze({ finishServerTime: null, finishTimeMs: null }) : null;
  }

  if (!Number.isSafeInteger(room?.startedAt) || room.startedAt < 0) return null;
  if (!Number.isSafeInteger(finishServerTime) || finishServerTime < room.startedAt) return null;
  return Object.freeze({
    finishServerTime,
    finishTimeMs: finishServerTime - room.startedAt
  });
}

function shadowRaceProgressCandidate({ room, player, runtimeService = shadowRuntimeService } = {}) {
  if (!room || !player || room.mode !== GAME_MODE.RACE) return null;
  if (!room.matchId || !ACTIVE_STATES.has(room.state)) return null;
  if (!runtimeService || typeof runtimeService.snapshot !== 'function') return null;

  let shadow;
  try {
    shadow = runtimeService.snapshot(player);
  } catch {
    return null;
  }
  if (!shadow || shadow.matchId !== room.matchId) return null;
  if (!Number.isSafeInteger(shadow.lastServerTick) || shadow.lastServerTick < 0) return null;
  if (!Number.isSafeInteger(shadow.lastProcessedInput) || shadow.lastProcessedInput < 0) return null;

  const checkpointLimit = safeCheckpointLimit(room);
  if (!validProgress(shadow.progress, checkpointLimit)) return null;
  const finishTiming = finishTimingFor(room, shadow);
  if (!finishTiming) return null;

  return Object.freeze({
    matchId: shadow.matchId,
    serverTick: shadow.lastServerTick,
    lastProcessedInput: shadow.lastProcessedInput,
    checkpoint: shadow.progress.checkpoint,
    finished: shadow.progress.finished,
    finishServerTick: shadow.progress.finishServerTick,
    finishServerTime: finishTiming.finishServerTime,
    finishTimeMs: finishTiming.finishTimeMs
  });
}

module.exports = {
  shadowRaceProgressCandidate,
  finishTimingFor,
  safeCheckpointLimit,
  validProgress
};
