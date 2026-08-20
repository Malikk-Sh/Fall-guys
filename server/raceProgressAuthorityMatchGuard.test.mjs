import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  MATCH_FALLBACK_REASON,
  createRaceProgressAuthorityMatchGuard
} = require('./raceProgressAuthorityMatchGuard');

const legacy = checkpoint => ({ checkpoint, finished: false });
const shadow = checkpoint => ({ checkpoint, finished: false });

function result(source, progress, fallbackReason = null) {
  return Object.freeze({ ok: true, source, fallbackReason, progress: Object.freeze({ ...progress }) });
}

function decisionFixture(results) {
  const calls = [];
  let index = 0;
  return {
    calls,
    decision: {
      decide(options) {
        calls.push(options);
        const value = results[Math.min(index, results.length - 1)];
        index += 1;
        if (value instanceof Error) throw value;
        return value;
      }
    }
  };
}

test('legacy first decision locks the whole match without reading later shadow decisions', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.LEGACY, legacy(0), 'shadow-not-ready'),
    result(AUTHORITY_SOURCE.SHADOW, shadow(1))
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  const first = guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  const second = guard.decide({ room, player: {}, legacyProgress: legacy(1) });

  assert.equal(first.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(first.fallbackReason, 'shadow-not-ready');
  assert.equal(second.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(second.fallbackReason, MATCH_FALLBACK_REASON.LEGACY_LOCKED);
  assert.deepEqual(second.progress, legacy(1));
  assert.equal(fixture.calls.length, 1);
  assert.equal(guard.sourceFor(room), AUTHORITY_SOURCE.LEGACY);
});

test('shadow remains selected while every boundary stays shadow-ready', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.SHADOW, shadow(0)),
    result(AUTHORITY_SOURCE.SHADOW, shadow(1))
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  const first = guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  const second = guard.decide({ room, player: {}, legacyProgress: legacy(1) });

  assert.equal(first.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(second.source, AUTHORITY_SOURCE.SHADOW);
  assert.deepEqual(second.progress, shadow(1));
  assert.equal(fixture.calls.length, 2);
  assert.equal(guard.sourceFor(room), AUTHORITY_SOURCE.SHADOW);
});

test('shadow fallback permanently locks the current match to legacy', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.SHADOW, shadow(0)),
    result(AUTHORITY_SOURCE.LEGACY, legacy(1), 'boundary-state-mismatch'),
    result(AUTHORITY_SOURCE.SHADOW, shadow(2))
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  const fallback = guard.decide({ room, player: {}, legacyProgress: legacy(1) });
  const later = guard.decide({ room, player: {}, legacyProgress: legacy(2) });

  assert.equal(fallback.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(fallback.fallbackReason, 'boundary-state-mismatch');
  assert.deepEqual(fallback.progress, legacy(1));
  assert.equal(later.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(later.fallbackReason, MATCH_FALLBACK_REASON.LEGACY_LOCKED);
  assert.deepEqual(later.progress, legacy(2));
  assert.equal(fixture.calls.length, 2);
});

test('new match id may choose shadow after the previous match was legacy-locked', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.LEGACY, legacy(0), 'shadow-not-ready'),
    result(AUTHORITY_SOURCE.SHADOW, shadow(0))
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  room.matchId = 'match-b';
  const nextMatch = guard.decide({ room, player: {}, legacyProgress: legacy(0) });

  assert.equal(nextMatch.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(guard.sourceFor(room), AUTHORITY_SOURCE.SHADOW);
  assert.equal(fixture.calls.length, 2);
});

test('decision errors revoke an active shadow lease fail-closed', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.SHADOW, shadow(0)),
    new Error('readiness unavailable')
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  const fallback = guard.decide({ room, player: {}, legacyProgress: legacy(1) });

  assert.equal(fallback.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(fallback.fallbackReason, MATCH_FALLBACK_REASON.SHADOW_REVOKED);
  assert.deepEqual(fallback.progress, legacy(1));
  assert.equal(guard.sourceFor(room), AUTHORITY_SOURCE.LEGACY);
});

test('invalid context fails closed without creating a match lease', () => {
  const fixture = decisionFixture([result(AUTHORITY_SOURCE.SHADOW, shadow(0))]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: null };

  const invalidMatch = guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  const invalidLegacy = guard.decide({
    room: { matchId: 'match-b' },
    player: {},
    legacyProgress: { checkpoint: -1, finished: false }
  });

  assert.equal(invalidMatch.ok, true);
  assert.equal(invalidMatch.source, AUTHORITY_SOURCE.LEGACY);
  assert.equal(invalidMatch.fallbackReason, MATCH_FALLBACK_REASON.INVALID_CONTEXT);
  assert.equal(invalidLegacy.ok, false);
  assert.equal(invalidLegacy.progress, null);
  assert.equal(fixture.calls.length, 0);
  assert.equal(guard.sourceFor(room), null);
});

test('guard copies results and never mutates caller progress', () => {
  const legacyProgress = legacy(0);
  const shadowProgress = shadow(1);
  const fixture = decisionFixture([result(AUTHORITY_SOURCE.SHADOW, shadowProgress)]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  const selected = guard.decide({ room, player: {}, legacyProgress });

  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.progress), true);
  assert.notEqual(selected.progress, shadowProgress);
  assert.deepEqual(legacyProgress, legacy(0));
  assert.deepEqual(shadowProgress, shadow(1));
});

test('reset removes match leases and allows a fresh decision', () => {
  const fixture = decisionFixture([
    result(AUTHORITY_SOURCE.LEGACY, legacy(0), 'shadow-not-ready'),
    result(AUTHORITY_SOURCE.SHADOW, shadow(0))
  ]);
  const guard = createRaceProgressAuthorityMatchGuard({ decision: fixture.decision });
  const room = { matchId: 'match-a' };

  guard.decide({ room, player: {}, legacyProgress: legacy(0) });
  guard.reset();
  const selected = guard.decide({ room, player: {}, legacyProgress: legacy(0) });

  assert.equal(selected.source, AUTHORITY_SOURCE.SHADOW);
  assert.equal(fixture.calls.length, 2);
});
