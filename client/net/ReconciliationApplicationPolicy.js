import { createPlayerSimulationState } from '/shared/playerSimulation.js';
import { RECONCILIATION_ACTION } from './ReconciliationPolicy.js';

export const RECONCILIATION_APPLICATION_MODE = Object.freeze({
  NONE: 'none',
  SOFT: 'soft',
  HARD: 'hard'
});

function validPredictedState(state) {
  return (
    !!state &&
    typeof state === 'object' &&
    Number.isFinite(state.position?.x) &&
    Number.isFinite(state.position?.y) &&
    Number.isFinite(state.position?.z) &&
    Number.isFinite(state.velocity?.x) &&
    Number.isFinite(state.velocity?.y) &&
    Number.isFinite(state.velocity?.z) &&
    typeof state.grounded === 'boolean'
  );
}

function frozenSimulationState(state) {
  const clone = createPlayerSimulationState(state);
  return Object.freeze({
    ...clone,
    position: Object.freeze({ ...clone.position }),
    velocity: Object.freeze({ ...clone.velocity })
  });
}

function noApplication(reason) {
  return Object.freeze({
    apply: false,
    mode: RECONCILIATION_APPLICATION_MODE.NONE,
    reason,
    state: null
  });
}

export function reconciliationApplicationProposal({
  raceAuthoritySource = null,
  correction = null,
  predicted = null
} = {}) {
  if (raceAuthoritySource !== 'shadow') return noApplication('authority-not-shadow');

  const action = correction?.action;
  if (action === RECONCILIATION_ACTION.NONE || action === RECONCILIATION_ACTION.SKIP) {
    return noApplication('correction-not-actionable');
  }
  if (action !== RECONCILIATION_ACTION.SOFT && action !== RECONCILIATION_ACTION.HARD) {
    return noApplication('invalid-correction');
  }
  if (!predicted) return noApplication('missing-predicted-state');
  if (!validPredictedState(predicted)) return noApplication('invalid-predicted-state');

  return Object.freeze({
    apply: true,
    mode:
      action === RECONCILIATION_ACTION.HARD
        ? RECONCILIATION_APPLICATION_MODE.HARD
        : RECONCILIATION_APPLICATION_MODE.SOFT,
    reason: typeof correction.reason === 'string' ? correction.reason : null,
    state: frozenSimulationState(predicted)
  });
}
