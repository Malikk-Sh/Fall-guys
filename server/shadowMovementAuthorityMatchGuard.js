'use strict';

const raceProgressAuthorityMatchGuard = require('./raceProgressAuthorityMatchGuard');
const shadowRuntimeService = require('./shadowRuntimeService');
const {
  MOVEMENT_AUTHORITY_SOURCE,
  evaluateShadowMovementAuthorityReadiness
} = require('./shadowMovementAuthorityReadiness');

const MATCH_FALLBACK_REASON = Object.freeze({
  INVALID_CONTEXT: 'invalid-match-context',
  RACE_AUTHORITY_UNRESOLVED: 'race-authority-unresolved',
  LEGACY_LOCKED: 'match-legacy-locked',
  SHADOW_REVOKED: 'match-shadow-revoked'
});

const DEFAULT_MOVEMENT_PARITY_EVIDENCE = Object.freeze({
  collisionParityVerified: false,
  obstacleParityVerified: false
});

function validShadowSnapshot(snapshot, matchId) {
  const state = snapshot?.state;
  return (
    !!snapshot &&
    snapshot.matchId === matchId &&
    !!state &&
    Number.isFinite(state.position?.x) &&
    Number.isFinite(state.position?.y) &&
    Number.isFinite(state.position?.z) &&
    Number.isFinite(state.velocity?.x) &&
    Number.isFinite(state.velocity?.y) &&
    Number.isFinite(state.velocity?.z) &&
    typeof state.grounded === 'boolean'
  );
}

function normalizeParityEvidence(evidence) {
  return Object.freeze({
    collisionParityVerified: evidence?.collisionParityVerified === true,
    obstacleParityVerified: evidence?.obstacleParityVerified === true
  });
}

function legacyDecision(fallbackReason, reasons = []) {
  return Object.freeze({
    ready: false,
    source: MOVEMENT_AUTHORITY_SOURCE.LEGACY,
    fallbackReason,
    reasons: Object.freeze([...reasons])
  });
}

function createShadowMovementAuthorityMatchGuard({
  raceAuthorityGuard = raceProgressAuthorityMatchGuard,
  runtimeService = shadowRuntimeService,
  parityProvider = () => DEFAULT_MOVEMENT_PARITY_EVIDENCE
} = {}) {
  if (!raceAuthorityGuard || typeof raceAuthorityGuard.sourceFor !== 'function') {
    throw new TypeError('movement authority match guard requires a race authority source');
  }
  if (!runtimeService || typeof runtimeService.snapshot !== 'function') {
    throw new TypeError('movement authority match guard requires a shadow runtime service');
  }
  if (typeof parityProvider !== 'function') {
    throw new TypeError('movement authority match guard requires a parity provider');
  }

  let leases = new WeakMap();

  function currentLease(room) {
    const lease = room ? leases.get(room) : null;
    if (!lease || lease.matchId !== room?.matchId) return null;
    return lease;
  }

  function lock(room, source) {
    const lease = Object.freeze({ matchId: room.matchId, source });
    leases.set(room, lease);
    return lease;
  }

  function sourceFor(room) {
    return currentLease(room)?.source || null;
  }

  function readinessFor({ room, player }) {
    let raceAuthoritySource = null;
    try {
      raceAuthoritySource = raceAuthorityGuard.sourceFor(room);
    } catch {
      raceAuthoritySource = null;
    }
    if (raceAuthoritySource === null || raceAuthoritySource === undefined) {
      return legacyDecision(MATCH_FALLBACK_REASON.RACE_AUTHORITY_UNRESOLVED);
    }

    let snapshot = null;
    try {
      snapshot = runtimeService.snapshot(player);
    } catch {
      snapshot = null;
    }

    let parityEvidence = DEFAULT_MOVEMENT_PARITY_EVIDENCE;
    try {
      parityEvidence = normalizeParityEvidence(parityProvider({ room, player, snapshot }));
    } catch {
      parityEvidence = DEFAULT_MOVEMENT_PARITY_EVIDENCE;
    }

    const readiness = evaluateShadowMovementAuthorityReadiness({
      raceAuthoritySource,
      shadowStateAvailable: validShadowSnapshot(snapshot, room.matchId),
      ...parityEvidence
    });
    return Object.freeze({ ...readiness, fallbackReason: null });
  }

  function decide({ room, player } = {}) {
    if (!room || typeof room.matchId !== 'string' || !room.matchId || !player || typeof player !== 'object') {
      return legacyDecision(MATCH_FALLBACK_REASON.INVALID_CONTEXT);
    }

    const lease = currentLease(room);
    if (lease?.source === MOVEMENT_AUTHORITY_SOURCE.LEGACY) {
      return legacyDecision(MATCH_FALLBACK_REASON.LEGACY_LOCKED);
    }

    const candidate = readinessFor({ room, player });
    if (!lease && candidate.fallbackReason === MATCH_FALLBACK_REASON.RACE_AUTHORITY_UNRESOLVED) {
      return candidate;
    }

    if (!lease) {
      if (candidate.ready && candidate.source === MOVEMENT_AUTHORITY_SOURCE.SHADOW) {
        lock(room, MOVEMENT_AUTHORITY_SOURCE.SHADOW);
        return candidate;
      }
      lock(room, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
      return Object.freeze({
        ...candidate,
        source: MOVEMENT_AUTHORITY_SOURCE.LEGACY,
        fallbackReason: candidate.fallbackReason || MATCH_FALLBACK_REASON.LEGACY_LOCKED
      });
    }

    if (candidate.ready && candidate.source === MOVEMENT_AUTHORITY_SOURCE.SHADOW) return candidate;

    lock(room, MOVEMENT_AUTHORITY_SOURCE.LEGACY);
    return legacyDecision(
      candidate.fallbackReason || MATCH_FALLBACK_REASON.SHADOW_REVOKED,
      candidate.reasons
    );
  }

  function reset() {
    leases = new WeakMap();
  }

  return Object.freeze({ decide, sourceFor, reset });
}

const singleton = createShadowMovementAuthorityMatchGuard();

module.exports = Object.freeze({
  ...singleton,
  DEFAULT_MOVEMENT_PARITY_EVIDENCE,
  MATCH_FALLBACK_REASON,
  createShadowMovementAuthorityMatchGuard,
  normalizeParityEvidence,
  validShadowSnapshot
});
