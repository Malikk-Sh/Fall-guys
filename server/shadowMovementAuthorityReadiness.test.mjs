import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MOVEMENT_AUTHORITY_SOURCE,
  REASON,
  evaluateShadowMovementAuthorityReadiness
} = require('./shadowMovementAuthorityReadiness');

test('movement authority remains legacy until every independent safety boundary is verified', () => {
  assert.deepEqual(evaluateShadowMovementAuthorityReadiness(), {
    ready: false,
    source: MOVEMENT_AUTHORITY_SOURCE.LEGACY,
    reasons: [
      REASON.RACE_AUTHORITY_NOT_SHADOW,
      REASON.SHADOW_STATE_UNAVAILABLE,
      REASON.COLLISION_PARITY_UNVERIFIED,
      REASON.OBSTACLE_PARITY_UNVERIFIED
    ]
  });

  assert.deepEqual(
    evaluateShadowMovementAuthorityReadiness({
      raceAuthoritySource: MOVEMENT_AUTHORITY_SOURCE.SHADOW,
      shadowStateAvailable: true
    }),
    {
      ready: false,
      source: MOVEMENT_AUTHORITY_SOURCE.LEGACY,
      reasons: [REASON.COLLISION_PARITY_UNVERIFIED, REASON.OBSTACLE_PARITY_UNVERIFIED]
    }
  );
});

test('race progress shadow authority alone can never enable movement correction', () => {
  const decision = evaluateShadowMovementAuthorityReadiness({
    raceAuthoritySource: MOVEMENT_AUTHORITY_SOURCE.SHADOW,
    shadowStateAvailable: true,
    collisionParityVerified: false,
    obstacleParityVerified: false
  });

  assert.equal(decision.ready, false);
  assert.equal(decision.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.ok(decision.reasons.includes(REASON.COLLISION_PARITY_UNVERIFIED));
  assert.ok(decision.reasons.includes(REASON.OBSTACLE_PARITY_UNVERIFIED));
});

test('movement shadow authority is possible only when every required parity signal is explicit', () => {
  assert.deepEqual(
    evaluateShadowMovementAuthorityReadiness({
      raceAuthoritySource: MOVEMENT_AUTHORITY_SOURCE.SHADOW,
      shadowStateAvailable: true,
      collisionParityVerified: true,
      obstacleParityVerified: true
    }),
    {
      ready: true,
      source: MOVEMENT_AUTHORITY_SOURCE.SHADOW,
      reasons: []
    }
  );
});

test('truthy non-boolean readiness values fail closed', () => {
  const decision = evaluateShadowMovementAuthorityReadiness({
    raceAuthoritySource: MOVEMENT_AUTHORITY_SOURCE.SHADOW,
    shadowStateAvailable: 1,
    collisionParityVerified: 'yes',
    obstacleParityVerified: {}
  });

  assert.equal(decision.ready, false);
  assert.equal(decision.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.deepEqual(decision.reasons, [
    REASON.SHADOW_STATE_UNAVAILABLE,
    REASON.COLLISION_PARITY_UNVERIFIED,
    REASON.OBSTACLE_PARITY_UNVERIFIED
  ]);
});
