import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MOVEMENT_AUTHORITY_SOURCE,
  REASON,
  evaluateShadowMovementAuthorityReadiness
} = require('./shadowMovementAuthorityReadiness');
const {
  MATCH_FALLBACK_REASON,
  createShadowMovementAuthorityMatchGuard
} = require('./shadowMovementAuthorityMatchGuard');

function validSnapshot(matchId) {
  return {
    matchId,
    state: {
      position: { x: 1, y: 2, z: 3 },
      velocity: { x: 0.1, y: 0.2, z: 0.3 },
      grounded: true
    }
  };
}

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

test('match guard waits for race authority before taking an irreversible movement lease', () => {
  let raceAuthoritySource = null;
  const room = { matchId: 'movement-match-a' };
  const player = {};
  const guard = createShadowMovementAuthorityMatchGuard({
    raceAuthorityGuard: { sourceFor: () => raceAuthoritySource },
    runtimeService: { snapshot: () => validSnapshot(room.matchId) },
    parityProvider: () => ({ collisionParityVerified: true, obstacleParityVerified: true })
  });

  const unresolved = guard.decide({ room, player });
  assert.equal(unresolved.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.equal(unresolved.fallbackReason, MATCH_FALLBACK_REASON.RACE_AUTHORITY_UNRESOLVED);
  assert.equal(
    guard.sourceFor(room),
    null,
    'unresolved race authority does not lock movement to legacy'
  );

  raceAuthoritySource = MOVEMENT_AUTHORITY_SOURCE.SHADOW;
  const shadow = guard.decide({ room, player });
  assert.equal(shadow.ready, true);
  assert.equal(shadow.source, MOVEMENT_AUTHORITY_SOURCE.SHADOW);
  assert.equal(guard.sourceFor(room), MOVEMENT_AUTHORITY_SOURCE.SHADOW);
});

test('default movement parity evidence locks an established race to legacy', () => {
  const room = { matchId: 'movement-match-b' };
  const player = {};
  const guard = createShadowMovementAuthorityMatchGuard({
    raceAuthorityGuard: { sourceFor: () => MOVEMENT_AUTHORITY_SOURCE.SHADOW },
    runtimeService: { snapshot: () => validSnapshot(room.matchId) }
  });

  const decision = guard.decide({ room, player });
  assert.equal(decision.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.equal(decision.fallbackReason, MATCH_FALLBACK_REASON.LEGACY_LOCKED);
  assert.deepEqual(decision.reasons, [
    REASON.COLLISION_PARITY_UNVERIFIED,
    REASON.OBSTACLE_PARITY_UNVERIFIED
  ]);
  assert.equal(guard.sourceFor(room), MOVEMENT_AUTHORITY_SOURCE.LEGACY);
});

test('shadow movement lease revokes to legacy and cannot flip back inside the same match', () => {
  let parityEvidence = { collisionParityVerified: true, obstacleParityVerified: true };
  const room = { matchId: 'movement-match-c' };
  const player = {};
  const guard = createShadowMovementAuthorityMatchGuard({
    raceAuthorityGuard: { sourceFor: () => MOVEMENT_AUTHORITY_SOURCE.SHADOW },
    runtimeService: { snapshot: () => validSnapshot(room.matchId) },
    parityProvider: () => parityEvidence
  });

  assert.equal(guard.decide({ room, player }).source, MOVEMENT_AUTHORITY_SOURCE.SHADOW);

  parityEvidence = { collisionParityVerified: false, obstacleParityVerified: true };
  const revoked = guard.decide({ room, player });
  assert.equal(revoked.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.equal(revoked.fallbackReason, MATCH_FALLBACK_REASON.SHADOW_REVOKED);
  assert.deepEqual(revoked.reasons, [REASON.COLLISION_PARITY_UNVERIFIED]);

  parityEvidence = { collisionParityVerified: true, obstacleParityVerified: true };
  const locked = guard.decide({ room, player });
  assert.equal(locked.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.equal(locked.fallbackReason, MATCH_FALLBACK_REASON.LEGACY_LOCKED);

  room.matchId = 'movement-match-d';
  assert.equal(
    guard.decide({ room, player }).source,
    MOVEMENT_AUTHORITY_SOURCE.SHADOW,
    'a new match may make a fresh movement authority decision'
  );
});

test('movement guard treats malformed shadow state as unavailable even with complete parity evidence', () => {
  const room = { matchId: 'movement-match-e' };
  const guard = createShadowMovementAuthorityMatchGuard({
    raceAuthorityGuard: { sourceFor: () => MOVEMENT_AUTHORITY_SOURCE.SHADOW },
    runtimeService: {
      snapshot: () => ({
        matchId: room.matchId,
        state: {
          position: { x: 0, y: 0, z: 0 },
          velocity: { x: 0, y: 0, z: NaN },
          grounded: true
        }
      })
    },
    parityProvider: () => ({ collisionParityVerified: true, obstacleParityVerified: true })
  });

  const decision = guard.decide({ room, player: {} });
  assert.equal(decision.source, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
  assert.ok(decision.reasons.includes(REASON.SHADOW_STATE_UNAVAILABLE));
});
