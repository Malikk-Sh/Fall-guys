import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECONCILIATION_APPLY_LIMITS,
  applyReconciliationProposal,
  normalizeMovementAuthoritySource
} from '../client/net/ReconciliationApplicator.js';
import { RECONCILIATION_APPLICATION_MODE } from '../client/net/ReconciliationApplicationPolicy.js';
import { createPlayerSimulationState } from '../shared/playerSimulation.js';

function player(overrides = {}) {
  return {
    remote: false,
    finished: false,
    physics: { x: 0, y: 0, z: 0 },
    previous: { x: -0.1, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    coyote: 0.1,
    jumpBuffer: 0.02,
    diveTimer: 0,
    diveCooldown: 0,
    rollTimer: 0,
    landingRetention: 0,
    recoveryWindow: 0,
    knockdownTimer: 0,
    knockdownImmunityTimer: 0,
    getupTimer: 0,
    slamming: false,
    gliding: false,
    dashes: 7,
    ...overrides
  };
}

function proposal(mode, state, reason = 'position-error') {
  return {
    apply: true,
    mode,
    reason,
    state: createPlayerSimulationState(state)
  };
}

test('movement authority marker is explicit and the applicator fails closed without shadow', () => {
  assert.equal(normalizeMovementAuthoritySource('legacy'), 'legacy');
  assert.equal(normalizeMovementAuthoritySource('shadow'), 'shadow');
  assert.equal(normalizeMovementAuthoritySource(null), null);
  assert.equal(normalizeMovementAuthoritySource('server'), null);
  assert.equal(normalizeMovementAuthoritySource({ source: 'shadow' }), null);

  const local = player();
  const before = structuredClone(local);
  const result = applyReconciliationProposal(
    local,
    proposal(RECONCILIATION_APPLICATION_MODE.SOFT, {
      position: { x: 2, y: 0, z: 0 },
      velocity: { x: 2, y: 0, z: 0 },
      grounded: true
    })
  );

  assert.deepEqual(result, {
    applied: false,
    mode: RECONCILIATION_APPLICATION_MODE.NONE,
    reason: 'movement-authority-not-shadow',
    positionApplied: 0,
    velocityApplied: 0
  });
  assert.deepEqual(local, before, 'missing movement authority never mutates the live player');
});

test('soft reconciliation applies only bounded position and velocity nudges', () => {
  const local = player();
  const result = applyReconciliationProposal(
    local,
    proposal(RECONCILIATION_APPLICATION_MODE.SOFT, {
      position: { x: 3, y: 4, z: 0 },
      velocity: { x: 0, y: 0, z: 5 },
      grounded: false,
      jumpBuffer: 0.12
    }),
    { movementAuthoritySource: 'shadow' }
  );

  assert.equal(result.applied, true);
  assert.equal(result.mode, RECONCILIATION_APPLICATION_MODE.SOFT);
  assert.equal(result.positionApplied, RECONCILIATION_APPLY_LIMITS.SOFT_POSITION_STEP);
  assert.equal(result.velocityApplied, RECONCILIATION_APPLY_LIMITS.SOFT_VELOCITY_STEP);
  assert.ok(Math.abs(local.physics.x - 0.21) < 1e-12);
  assert.ok(Math.abs(local.physics.y - 0.28) < 1e-12);
  assert.equal(local.physics.z, 0);
  assert.ok(Math.abs(local.previous.x - 0.11) < 1e-12);
  assert.ok(Math.abs(local.previous.y - 0.28) < 1e-12);
  assert.equal(local.velocity.x, 0);
  assert.equal(local.velocity.y, 0);
  assert.equal(local.velocity.z, RECONCILIATION_APPLY_LIMITS.SOFT_VELOCITY_STEP);
  assert.equal(local.grounded, true, 'soft nudges preserve local collision contact');
  assert.equal(local.jumpBuffer, 0.02, 'soft nudges do not overwrite local motion timers');
});

test('hard reconciliation synchronizes bounded deterministic motion state without progress side effects', () => {
  const local = player({ dashes: 7 });
  const result = applyReconciliationProposal(
    local,
    proposal(RECONCILIATION_APPLICATION_MODE.HARD, {
      position: { x: 2, y: 1, z: -3 },
      velocity: { x: 4, y: -2, z: 1 },
      grounded: false,
      coyoteTime: 0.03,
      jumpBuffer: 0.04,
      diveTimer: 0.2,
      diveCooldown: 0.5,
      rollTimer: 0.1,
      landingRetention: 0.12,
      recoveryWindow: 0.08,
      knockdownTimer: 0.3,
      knockdownImmunity: 0.6,
      getupTimer: 0.07,
      slamming: true,
      gliding: true,
      finished: true,
      dashes: 99
    }),
    { movementAuthoritySource: 'shadow' }
  );

  assert.equal(result.applied, true);
  assert.equal(result.mode, RECONCILIATION_APPLICATION_MODE.HARD);
  assert.deepEqual(local.physics, { x: 2, y: 1, z: -3 });
  assert.deepEqual(local.previous, { x: 2, y: 1, z: -3 });
  assert.deepEqual(local.velocity, { x: 4, y: -2, z: 1 });
  assert.equal(local.grounded, false);
  assert.equal(local.coyote, 0.03);
  assert.equal(local.jumpBuffer, 0.04);
  assert.equal(local.diveTimer, 0.2);
  assert.equal(local.diveCooldown, 0.5);
  assert.equal(local.rollTimer, 0.1);
  assert.equal(local.landingRetention, 0.12);
  assert.equal(local.recoveryWindow, 0.08);
  assert.equal(local.knockdownTimer, 0.3);
  assert.equal(local.knockdownImmunityTimer, 0.6);
  assert.equal(local.getupTimer, 0.07);
  assert.equal(local.slamming, true);
  assert.equal(local.gliding, true);
  assert.equal(local.finished, false, 'movement reconciliation cannot finish a race');
  assert.equal(local.dashes, 7, 'movement reconciliation cannot rewrite challenge progress');
});

test('hard reconciliation rejects implausible snaps instead of applying an unbounded teleport', () => {
  const local = player();
  const before = structuredClone(local);
  const result = applyReconciliationProposal(
    local,
    proposal(RECONCILIATION_APPLICATION_MODE.HARD, {
      position: { x: RECONCILIATION_APPLY_LIMITS.HARD_MAX_POSITION_ERROR + 0.01, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      grounded: true
    }),
    { movementAuthoritySource: 'shadow' }
  );

  assert.deepEqual(result, {
    applied: false,
    mode: RECONCILIATION_APPLICATION_MODE.HARD,
    reason: 'hard-position-out-of-bounds',
    positionApplied: 0,
    velocityApplied: 0
  });
  assert.deepEqual(local, before);
});
