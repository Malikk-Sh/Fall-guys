'use strict';

const MOVEMENT_AUTHORITY_SOURCE = Object.freeze({
  LEGACY: 'legacy',
  SHADOW: 'shadow'
});

const REASON = Object.freeze({
  RACE_AUTHORITY_NOT_SHADOW: 'race-authority-not-shadow',
  SHADOW_STATE_UNAVAILABLE: 'shadow-state-unavailable',
  COLLISION_PARITY_UNVERIFIED: 'collision-parity-unverified',
  OBSTACLE_PARITY_UNVERIFIED: 'obstacle-parity-unverified'
});

function evaluateShadowMovementAuthorityReadiness({
  raceAuthoritySource = null,
  shadowStateAvailable = false,
  collisionParityVerified = false,
  obstacleParityVerified = false
} = {}) {
  const reasons = [];
  if (raceAuthoritySource !== MOVEMENT_AUTHORITY_SOURCE.SHADOW) {
    reasons.push(REASON.RACE_AUTHORITY_NOT_SHADOW);
  }
  if (shadowStateAvailable !== true) reasons.push(REASON.SHADOW_STATE_UNAVAILABLE);
  if (collisionParityVerified !== true) reasons.push(REASON.COLLISION_PARITY_UNVERIFIED);
  if (obstacleParityVerified !== true) reasons.push(REASON.OBSTACLE_PARITY_UNVERIFIED);

  return Object.freeze({
    ready: reasons.length === 0,
    source:
      reasons.length === 0 ? MOVEMENT_AUTHORITY_SOURCE.SHADOW : MOVEMENT_AUTHORITY_SOURCE.LEGACY,
    reasons: Object.freeze(reasons)
  });
}

module.exports = Object.freeze({
  MOVEMENT_AUTHORITY_SOURCE,
  REASON,
  evaluateShadowMovementAuthorityReadiness
});
