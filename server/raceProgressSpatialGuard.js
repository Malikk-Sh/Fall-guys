'use strict';

const { CORRIDOR_MARGIN, corridorHalfWidth, corridorZones } = require('../shared/courseSpec.js');

// Progress is a server-owned result boundary, not a movement rule. The player may move anywhere
// allowed by the ordinary state validator, but a checkpoint/finish only counts while the actual
// crossing point stays inside the race course corridor.
//
// Keep the lower bound that legacy progress already used. The upper cap is deliberately generous:
// the strongest normal vertical launch is the spring at 11.4, which rises by less than three metres
// under the shared 22.5 gravity. Six metres leaves ample room for honest airborne crossings while
// refusing a client that progresses through checkpoint planes high above the course.
const RACE_PROGRESS_MIN_Y = -3;
const RACE_PROGRESS_MAX_Y = 6;
const RACE_FINISH_Z_TOLERANCE = 1;

const zonesBySpec = new WeakMap();

function isRaceCourseSpec(spec) {
  return (
    !!spec &&
    typeof spec === 'object' &&
    Number.isSafeInteger(spec.segmentCount) &&
    spec.segmentCount > 0 &&
    Array.isArray(spec.segments) &&
    spec.segments.length === spec.segmentCount &&
    Array.isArray(spec.checkpoints) &&
    spec.checkpoints.length === spec.segmentCount &&
    Number.isFinite(spec.finishZ)
  );
}

function zonesFor(spec) {
  if (!isRaceCourseSpec(spec)) return null;
  let zones = zonesBySpec.get(spec);
  if (!zones) {
    zones = corridorZones(spec);
    zonesBySpec.set(spec, zones);
  }
  return zones;
}

function finitePosition(state) {
  if (!state || !Number.isFinite(state.x) || !Number.isFinite(state.y) || !Number.isFinite(state.z))
    return null;
  return { x: Number(state.x), y: Number(state.y), z: Number(state.z) };
}

function crossingPositionAtZ(previous, current, line) {
  const from = finitePosition(previous);
  const to = finitePosition(current);
  if (!from || !to || !Number.isFinite(line)) return null;
  if (from.z < line || to.z >= line || from.z === to.z) return null;

  const ratio = (line - from.z) / (to.z - from.z);
  if (ratio < 0 || ratio > 1) return null;
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
    z: line
  };
}

function raceProgressPositionAllowed(spec, state) {
  const position = finitePosition(state);
  if (!position) return false;

  const zones = zonesFor(spec);
  if (!zones) return false;
  const halfWidth = corridorHalfWidth(zones, position.z);
  // corridorHalfWidth returns Infinity outside known course zones. For movement that means "no
  // corridor restriction here"; for progress it must mean the opposite — a checkpoint/finish
  // outside the known course is not evidence of crossing the course boundary.
  if (!Number.isFinite(halfWidth)) return false;

  return (
    Math.abs(position.x) <= halfWidth + CORRIDOR_MARGIN &&
    position.y > RACE_PROGRESS_MIN_Y &&
    position.y <= RACE_PROGRESS_MAX_Y
  );
}

function raceProgressCrossingAllowed(spec, previous, current, line) {
  const crossing = crossingPositionAtZ(previous, current, line);
  return !!crossing && raceProgressPositionAllowed(spec, crossing);
}

module.exports = Object.freeze({
  RACE_PROGRESS_MIN_Y,
  RACE_PROGRESS_MAX_Y,
  RACE_FINISH_Z_TOLERANCE,
  crossingPositionAtZ,
  isRaceCourseSpec,
  raceProgressCrossingAllowed,
  raceProgressPositionAllowed
});
