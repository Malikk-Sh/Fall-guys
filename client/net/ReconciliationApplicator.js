import { RECONCILIATION_APPLICATION_MODE } from './ReconciliationApplicationPolicy.js';

export const RECONCILIATION_APPLY_LIMITS = Object.freeze({
  SOFT_POSITION_STEP: 0.35,
  SOFT_VELOCITY_STEP: 1.25,
  HARD_MAX_POSITION_ERROR: 6,
  HARD_MAX_VELOCITY_ERROR: 20
});

export function normalizeMovementAuthoritySource(value) {
  return value === 'legacy' || value === 'shadow' ? value : null;
}

function finiteVector(value) {
  return (
    !!value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function validPlayer(player) {
  return (
    !!player &&
    player.remote !== true &&
    player.finished !== true &&
    finiteVector(player.physics) &&
    finiteVector(player.previous) &&
    finiteVector(player.velocity)
  );
}

function validProposal(proposal) {
  return (
    proposal?.apply === true &&
    (proposal.mode === RECONCILIATION_APPLICATION_MODE.SOFT ||
      proposal.mode === RECONCILIATION_APPLICATION_MODE.HARD) &&
    finiteVector(proposal.state?.position) &&
    finiteVector(proposal.state?.velocity)
  );
}

function noApplication(reason, mode = RECONCILIATION_APPLICATION_MODE.NONE) {
  return Object.freeze({
    applied: false,
    mode,
    reason,
    positionApplied: 0,
    velocityApplied: 0
  });
}

function boundedVectorDelta(current, target, limit) {
  const delta = {
    x: target.x - current.x,
    y: target.y - current.y,
    z: target.z - current.z
  };
  const distance = Math.hypot(delta.x, delta.y, delta.z);
  if (distance === 0 || distance <= limit) return { ...delta, distance };
  const scale = limit / distance;
  return {
    x: delta.x * scale,
    y: delta.y * scale,
    z: delta.z * scale,
    distance
  };
}

function translate(vector, delta) {
  vector.x += delta.x;
  vector.y += delta.y;
  vector.z += delta.z;
}

function setVector(vector, target) {
  vector.x = target.x;
  vector.y = target.y;
  vector.z = target.z;
}

function applyHardMotionState(player, state) {
  player.grounded = state.grounded === true;
  player.coyote = Math.max(0, Number(state.coyoteTime) || 0);
  player.jumpBuffer = Math.max(0, Number(state.jumpBuffer) || 0);
  player.diveTimer = Math.max(0, Number(state.diveTimer) || 0);
  player.diveCooldown = Math.max(0, Number(state.diveCooldown) || 0);
  player.rollTimer = Math.max(0, Number(state.rollTimer) || 0);
  player.landingRetention = Math.max(0, Number(state.landingRetention) || 0);
  player.recoveryWindow = Math.max(0, Number(state.recoveryWindow) || 0);
  player.knockdownTimer = Math.max(0, Number(state.knockdownTimer) || 0);
  player.knockdownImmunityTimer = Math.max(0, Number(state.knockdownImmunity) || 0);
  player.getupTimer = Math.max(0, Number(state.getupTimer) || 0);
  player.slamming = state.slamming === true;
  player.gliding = state.gliding === true;
}

export function applyReconciliationProposal(
  player,
  proposal,
  { movementAuthoritySource = null } = {}
) {
  const source = normalizeMovementAuthoritySource(movementAuthoritySource);
  if (source !== 'shadow') return noApplication('movement-authority-not-shadow');
  if (!validPlayer(player)) return noApplication('invalid-player');
  if (!validProposal(proposal)) return noApplication('invalid-proposal');

  const target = proposal.state;
  const positionError = Math.hypot(
    target.position.x - player.physics.x,
    target.position.y - player.physics.y,
    target.position.z - player.physics.z
  );
  const velocityError = Math.hypot(
    target.velocity.x - player.velocity.x,
    target.velocity.y - player.velocity.y,
    target.velocity.z - player.velocity.z
  );

  if (proposal.mode === RECONCILIATION_APPLICATION_MODE.SOFT) {
    const positionDelta = boundedVectorDelta(
      player.physics,
      target.position,
      RECONCILIATION_APPLY_LIMITS.SOFT_POSITION_STEP
    );
    const velocityDelta = boundedVectorDelta(
      player.velocity,
      target.velocity,
      RECONCILIATION_APPLY_LIMITS.SOFT_VELOCITY_STEP
    );
    translate(player.physics, positionDelta);
    // Move the interpolation anchor by the same amount so a correction is not rendered as a
    // one-frame teleport. The normal fixed step can keep interpolating from the corrected frame.
    translate(player.previous, positionDelta);
    translate(player.velocity, velocityDelta);
    return Object.freeze({
      applied: true,
      mode: RECONCILIATION_APPLICATION_MODE.SOFT,
      reason: proposal.reason ?? null,
      positionApplied: Math.min(positionError, RECONCILIATION_APPLY_LIMITS.SOFT_POSITION_STEP),
      velocityApplied: Math.min(velocityError, RECONCILIATION_APPLY_LIMITS.SOFT_VELOCITY_STEP)
    });
  }

  if (positionError > RECONCILIATION_APPLY_LIMITS.HARD_MAX_POSITION_ERROR) {
    return noApplication('hard-position-out-of-bounds', RECONCILIATION_APPLICATION_MODE.HARD);
  }
  if (velocityError > RECONCILIATION_APPLY_LIMITS.HARD_MAX_VELOCITY_ERROR) {
    return noApplication('hard-velocity-out-of-bounds', RECONCILIATION_APPLICATION_MODE.HARD);
  }

  setVector(player.physics, target.position);
  setVector(player.previous, target.position);
  setVector(player.velocity, target.velocity);
  applyHardMotionState(player, target);
  return Object.freeze({
    applied: true,
    mode: RECONCILIATION_APPLICATION_MODE.HARD,
    reason: proposal.reason ?? null,
    positionApplied: positionError,
    velocityApplied: velocityError
  });
}
