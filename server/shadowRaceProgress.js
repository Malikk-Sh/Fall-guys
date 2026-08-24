'use strict';

const { isRaceCourseSpec, raceProgressPositionAllowed } = require('./raceProgressSpatialGuard');

// Kept as the coarse crossing predicate for compatibility with the existing pure helpers. Full
// gameplay specs additionally pass through raceProgressPositionAllowed(), which uses the canonical
// course corridor and the common vertical progress cap. Minimal diagnostic/test specs historically
// contain only checkpoints + finishZ; they deliberately retain this coarse contract.
const CHECKPOINT_HALF_WIDTH = 11;
const CHECKPOINT_MIN_Y = -3;
const FINISH_MIN_Y = -4;
const FINISH_Z_TOLERANCE = 1;

function finitePosition(state) {
  const position = state?.position;
  if (!position) return null;
  if (![position.x, position.y, position.z].every(Number.isFinite)) return null;
  return { x: Number(position.x), y: Number(position.y), z: Number(position.z) };
}

function normalizedCheckpoint(value, spec) {
  const max = Array.isArray(spec?.checkpoints) ? spec.checkpoints.length : 0;
  if (!Number.isSafeInteger(value)) return 0;
  return Math.max(0, Math.min(max, value));
}

function validSpec(spec) {
  return (
    !!spec &&
    Array.isArray(spec.checkpoints) &&
    spec.checkpoints.every(Number.isFinite) &&
    Number.isFinite(spec.finishZ)
  );
}

function createShadowRaceProgress(spec, overrides = {}) {
  const checkpoint = normalizedCheckpoint(overrides.checkpoint, spec);
  return {
    checkpoint,
    finished: overrides.finished === true,
    finishServerTick:
      Number.isSafeInteger(overrides.finishServerTick) && overrides.finishServerTick >= 0
        ? overrides.finishServerTick
        : null
  };
}

function checkpointCrossed(previous, current, line) {
  return (
    previous.z >= line &&
    current.z < line &&
    current.y > CHECKPOINT_MIN_Y &&
    Math.abs(current.x) < CHECKPOINT_HALF_WIDTH
  );
}

function fullSpecPositionAllowed(spec, current) {
  return !isRaceCourseSpec(spec) || raceProgressPositionAllowed(spec, current);
}

function canFinishFromShadow(progress, current, spec) {
  return (
    !progress.finished &&
    progress.checkpoint === spec.checkpoints.length &&
    current.z < spec.finishZ + FINISH_Z_TOLERANCE &&
    current.y > FINISH_MIN_Y &&
    fullSpecPositionAllowed(spec, current)
  );
}

function advanceShadowRaceProgress(progress, previousState, currentState, spec, serverTick = null) {
  if (!validSpec(spec)) return { progress: createShadowRaceProgress(spec, progress), events: [] };
  const previous = finitePosition(previousState);
  const current = finitePosition(currentState);
  const next = createShadowRaceProgress(spec, progress);
  if (!previous || !current || next.finished) return { progress: next, events: [] };

  const events = [];
  const line = spec.checkpoints[next.checkpoint];
  if (
    line !== undefined &&
    checkpointCrossed(previous, current, line) &&
    fullSpecPositionAllowed(spec, current)
  ) {
    next.checkpoint += 1;
    events.push({ type: 'checkpoint', checkpoint: next.checkpoint });
  }

  if (canFinishFromShadow(next, current, spec)) {
    next.finished = true;
    next.finishServerTick = Number.isSafeInteger(serverTick) && serverTick >= 0 ? serverTick : null;
    events.push({ type: 'finish', checkpoint: next.checkpoint, serverTick: next.finishServerTick });
  }

  return { progress: next, events };
}

module.exports = {
  CHECKPOINT_HALF_WIDTH,
  CHECKPOINT_MIN_Y,
  FINISH_MIN_Y,
  FINISH_Z_TOLERANCE,
  advanceShadowRaceProgress,
  canFinishFromShadow,
  checkpointCrossed,
  createShadowRaceProgress,
  finitePosition,
  validSpec
};
