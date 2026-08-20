export const RECONCILIATION_ACTION = Object.freeze({
  NONE: 'none',
  SOFT: 'soft',
  HARD: 'hard',
  SKIP: 'skip'
});

// These thresholds classify the already-computed prediction error; this module does not move the
// player yet. Keeping them named and testable gives the eventual correction cutover one explicit
// policy instead of scattering magic numbers through the render/physics loop.
//
// Soft position error is around one normal 30 Hz movement slice. Hard correction is deliberately
// much larger so ordinary jitter cannot cause teleports. The velocity hard limit sits above the
// current dive speed, while grounded disagreement only becomes hard when the vertical separation
// shows that the two simulations are no longer describing the same contact.
export const RECONCILIATION_THRESHOLDS = Object.freeze({
  SOFT_POSITION_ERROR: 0.3,
  HARD_POSITION_ERROR: 1.5,
  SOFT_VELOCITY_ERROR: 3,
  HARD_VELOCITY_ERROR: 14,
  HARD_VERTICAL_ERROR: 0.85
});

function validError(error) {
  return (
    !!error &&
    Number.isFinite(error.positionError) &&
    error.positionError >= 0 &&
    Number.isFinite(error.horizontalPositionError) &&
    error.horizontalPositionError >= 0 &&
    Number.isFinite(error.verticalPositionError) &&
    error.verticalPositionError >= 0 &&
    Number.isFinite(error.velocityError) &&
    error.velocityError >= 0 &&
    typeof error.groundedMismatch === 'boolean'
  );
}

function result(action, reason) {
  return Object.freeze({ action, reason });
}

export function reconciliationDecision({ error = null, historyGap = false } = {}) {
  if (historyGap) return result(RECONCILIATION_ACTION.HARD, 'history-gap');
  if (!validError(error)) return result(RECONCILIATION_ACTION.SKIP, 'invalid-error');

  if (error.positionError >= RECONCILIATION_THRESHOLDS.HARD_POSITION_ERROR) {
    return result(RECONCILIATION_ACTION.HARD, 'position-error');
  }
  if (error.velocityError >= RECONCILIATION_THRESHOLDS.HARD_VELOCITY_ERROR) {
    return result(RECONCILIATION_ACTION.HARD, 'velocity-error');
  }
  if (
    error.groundedMismatch &&
    error.verticalPositionError >= RECONCILIATION_THRESHOLDS.HARD_VERTICAL_ERROR
  ) {
    return result(RECONCILIATION_ACTION.HARD, 'ground-contact');
  }

  if (error.positionError >= RECONCILIATION_THRESHOLDS.SOFT_POSITION_ERROR) {
    return result(RECONCILIATION_ACTION.SOFT, 'position-error');
  }
  if (error.velocityError >= RECONCILIATION_THRESHOLDS.SOFT_VELOCITY_ERROR) {
    return result(RECONCILIATION_ACTION.SOFT, 'velocity-error');
  }
  if (error.groundedMismatch) return result(RECONCILIATION_ACTION.SOFT, 'ground-contact');

  return result(RECONCILIATION_ACTION.NONE, 'within-tolerance');
}
