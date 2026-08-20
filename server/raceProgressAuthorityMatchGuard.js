'use strict';

const { AUTHORITY_SOURCE, validProgress } = require('./raceProgressAuthoritySelector');
const raceProgressAuthorityDecision = require('./raceProgressAuthorityDecision');

const MATCH_FALLBACK_REASON = Object.freeze({
  INVALID_CONTEXT: 'invalid-match-context',
  LEGACY_LOCKED: 'match-legacy-locked',
  SHADOW_REVOKED: 'match-shadow-revoked'
});

function progressSnapshot(progress) {
  if (!validProgress(progress)) return null;
  return Object.freeze({ checkpoint: progress.checkpoint, finished: progress.finished });
}

function legacyResult(progress, fallbackReason) {
  const snapshot = progressSnapshot(progress);
  return Object.freeze({
    ok: !!snapshot,
    source: AUTHORITY_SOURCE.LEGACY,
    fallbackReason,
    progress: snapshot
  });
}

function guardedResult(result) {
  if (!result || !validProgress(result.progress)) return null;
  const source =
    result.source === AUTHORITY_SOURCE.SHADOW ? AUTHORITY_SOURCE.SHADOW : AUTHORITY_SOURCE.LEGACY;
  return Object.freeze({
    ok: result.ok === true,
    source,
    fallbackReason: result.fallbackReason || null,
    progress: progressSnapshot(result.progress)
  });
}

function createRaceProgressAuthorityMatchGuard({ decision = raceProgressAuthorityDecision } = {}) {
  if (!decision || typeof decision.decide !== 'function') {
    throw new TypeError('race progress authority match guard requires a decision adapter');
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

  function decide({ room, player, legacyProgress } = {}) {
    if (!room || typeof room.matchId !== 'string' || !room.matchId || !validProgress(legacyProgress)) {
      return legacyResult(legacyProgress, MATCH_FALLBACK_REASON.INVALID_CONTEXT);
    }

    const lease = currentLease(room);
    if (lease?.source === AUTHORITY_SOURCE.LEGACY) {
      return legacyResult(legacyProgress, MATCH_FALLBACK_REASON.LEGACY_LOCKED);
    }

    let candidate = null;
    try {
      candidate = guardedResult(decision.decide({ room, player, legacyProgress }));
    } catch {
      candidate = null;
    }

    if (!lease) {
      if (candidate?.ok && candidate.source === AUTHORITY_SOURCE.SHADOW) {
        lock(room, AUTHORITY_SOURCE.SHADOW);
        return candidate;
      }
      lock(room, AUTHORITY_SOURCE.LEGACY);
      return candidate?.source === AUTHORITY_SOURCE.LEGACY && candidate.progress
        ? candidate
        : legacyResult(legacyProgress, MATCH_FALLBACK_REASON.LEGACY_LOCKED);
    }

    if (candidate?.ok && candidate.source === AUTHORITY_SOURCE.SHADOW) return candidate;

    lock(room, AUTHORITY_SOURCE.LEGACY);
    return legacyResult(
      legacyProgress,
      candidate?.fallbackReason || MATCH_FALLBACK_REASON.SHADOW_REVOKED
    );
  }

  function reset() {
    leases = new WeakMap();
  }

  return Object.freeze({ decide, sourceFor, reset });
}

const singleton = createRaceProgressAuthorityMatchGuard();

module.exports = Object.freeze({
  ...singleton,
  MATCH_FALLBACK_REASON,
  createRaceProgressAuthorityMatchGuard
});
