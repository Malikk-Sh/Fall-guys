'use strict';

const { segmentTypeAt } = require('../shared/courseSpec.js');

// Product telemetry only. None of these values participate in movement validation, rewards or
// records. Start/recovery comes from server-accepted race state, fall outcome comes from the
// server-owned respawn timestamp, and repeat hits are inferred from a sharp velocity impulse in
// consecutive accepted states while the player is already knocked down.
const KNOCKDOWN_FALL_WINDOW_MS = 3000;
const MAX_REPEAT_HITS_PER_KNOCKDOWN = 4;
const REPEAT_HIT_MIN_GAP_MS = 250;
const REPEAT_HORIZONTAL_DELTA = 5.5;
const REPEAT_UPWARD_SPEED = 3.5;
const REPEAT_UPWARD_DELTA = 2.5;
const MAX_PENDING_EVENTS = 4096;

const pending = [];
let dropped = 0;

function sourceFor(spec, state) {
  return segmentTypeAt(spec, Number(state?.z) || 0) || 'unknown';
}

function dimensions(player, spec, detail) {
  return {
    mode: 'race',
    course: spec?.difficulty || 'normal',
    detail: String(detail || 'unknown').slice(0, 32),
    device: player?.device || 'desktop'
  };
}

function enqueue(event) {
  if (pending.length >= MAX_PENDING_EVENTS) {
    dropped += 1;
    return false;
  }
  pending.push(event);
  return true;
}

function count(metric, player, spec, detail, amount = 1) {
  if (!Number.isSafeInteger(amount) || amount < 1) return false;
  return enqueue({ kind: 'count', metric, dimensions: dimensions(player, spec, detail), amount });
}

function observe(metric, value, player, spec, detail) {
  if (!Number.isFinite(value) || value < 0) return false;
  return enqueue({ kind: 'observe', metric, value, dimensions: dimensions(player, spec, detail) });
}

function resetActive(state) {
  state.active = false;
  state.activeStartedAt = null;
  state.activeSource = null;
  state.repeatHitsCounted = 0;
  state.lastRepeatHitAt = null;
}

function ensurePlayerState(player, spec) {
  const matchStartedAt = Number(player?.matchStartedAt) || 0;
  const current = player?.raceKnockdownMetricsState;
  if (current && current.matchStartedAt === matchStartedAt) return current;

  const created = {
    matchStartedAt,
    course: spec?.difficulty || 'normal',
    active: false,
    activeStartedAt: null,
    activeSource: null,
    lastStartedAt: null,
    lastSource: null,
    lastFallCountedStartedAt: null,
    lastRespawnAt: Number(player?.lastRespawn) || 0,
    repeatHitsCounted: 0,
    lastRepeatHitAt: null
  };
  player.raceKnockdownMetricsState = created;
  return created;
}

function looksLikeRepeatImpact(previous, state) {
  if (!previous || !state) return false;
  const horizontalDelta = Math.hypot(
    Number(state.vx || 0) - Number(previous.vx || 0),
    Number(state.vz || 0) - Number(previous.vz || 0)
  );
  const upwardDelta = Number(state.vy || 0) - Number(previous.vy || 0);
  const horizontalSpeed = Math.hypot(Number(state.vx || 0), Number(state.vz || 0));

  // Bumpers, sweepers and punchers apply an instantaneous strong horizontal impulse and usually an
  // upward kick. Normal limp movement, drag and landing change velocity more gradually. Requiring a
  // strong current speed avoids mistaking ordinary braking for another hit.
  return (
    (horizontalDelta >= REPEAT_HORIZONTAL_DELTA && horizontalSpeed >= REPEAT_HORIZONTAL_DELTA) ||
    (Number(state.vy || 0) >= REPEAT_UPWARD_SPEED && upwardDelta >= REPEAT_UPWARD_DELTA)
  );
}

function trackRaceKnockdownState({ player, spec, state, previousState = null, now = Date.now() } = {}) {
  if (!player || player.bot || !spec || !state) return false;

  const tracked = ensurePlayerState(player, spec);
  const isKnockdown = state.state === 'knockdown';
  if (isKnockdown && !tracked.active) {
    const source = sourceFor(spec, state);
    tracked.active = true;
    tracked.activeStartedAt = now;
    tracked.activeSource = source;
    tracked.lastStartedAt = now;
    tracked.lastSource = source;
    tracked.repeatHitsCounted = 0;
    tracked.lastRepeatHitAt = now;
    count('knockdown_started', player, spec, source);
  } else if (
    isKnockdown &&
    tracked.active &&
    tracked.repeatHitsCounted < MAX_REPEAT_HITS_PER_KNOCKDOWN &&
    now - (tracked.lastRepeatHitAt ?? tracked.activeStartedAt ?? now) >= REPEAT_HIT_MIN_GAP_MS &&
    looksLikeRepeatImpact(previousState, state)
  ) {
    const source = sourceFor(spec, state);
    count('knockdown_repeat_hit', player, spec, source);
    tracked.repeatHitsCounted += 1;
    tracked.lastRepeatHitAt = now;
  }

  if (!isKnockdown && tracked.active) {
    observe(
      'knockdown_recovered',
      Math.max(0, now - (tracked.activeStartedAt ?? now)),
      player,
      spec,
      tracked.activeSource || tracked.lastSource || sourceFor(spec, state)
    );
    resetActive(tracked);
  }

  return true;
}

// Called from the existing movement-history reset path. The race RESPawn handler sets
// `player.lastRespawn` immediately before that reset, so the frustrating outcome is recorded even if
// the browser disconnects before sending another player-state packet. Other resetHistory calls are
// harmless because the respawn timestamp has not advanced; co-op players never create this state.
function trackRaceKnockdownRespawn({ player, now = player?.lastRespawn } = {}) {
  if (!player || player.bot) return false;
  const tracked = player.raceKnockdownMetricsState;
  if (!tracked) return false;

  const respawnAt = Number(now) || 0;
  if (respawnAt <= tracked.lastRespawnAt) return false;
  tracked.lastRespawnAt = respawnAt;

  if (
    tracked.lastStartedAt != null &&
    tracked.lastFallCountedStartedAt !== tracked.lastStartedAt &&
    respawnAt >= tracked.lastStartedAt &&
    respawnAt - tracked.lastStartedAt <= KNOCKDOWN_FALL_WINDOW_MS
  ) {
    observe(
      'knockdown_then_fall',
      respawnAt - tracked.lastStartedAt,
      player,
      { difficulty: tracked.course },
      tracked.lastSource || 'unknown'
    );
    tracked.lastFallCountedStartedAt = tracked.lastStartedAt;
  }

  // Respawn is not a normal get-up. Clear an active knockdown without emitting recovered.
  if (tracked.active) resetActive(tracked);
  return true;
}

function drainRaceKnockdownMetrics(gameplay) {
  if (!gameplay || typeof gameplay.count !== 'function' || typeof gameplay.observe !== 'function') return 0;

  // The normal GameplayMetrics.dropped field is the operator-visible signal for incomplete
  // instrumentation. Fold queue overflow into it before resetting the local counter so an overloaded
  // knockdown experiment cannot silently look complete.
  if (dropped > 0 && Number.isFinite(gameplay.dropped)) gameplay.dropped += dropped;
  dropped = 0;

  const events = pending.splice(0);
  for (const event of events) {
    if (event.kind === 'observe') gameplay.observe(event.metric, event.value, event.dimensions);
    else gameplay.count(event.metric, event.dimensions, event.amount);
  }
  return events.length;
}

function raceKnockdownMetricsStatus() {
  return { pending: pending.length, dropped };
}

function resetRaceKnockdownMetricsForTests() {
  pending.length = 0;
  dropped = 0;
}

module.exports = {
  KNOCKDOWN_FALL_WINDOW_MS,
  MAX_REPEAT_HITS_PER_KNOCKDOWN,
  REPEAT_HIT_MIN_GAP_MS,
  trackRaceKnockdownState,
  trackRaceKnockdownRespawn,
  drainRaceKnockdownMetrics,
  raceKnockdownMetricsStatus,
  resetRaceKnockdownMetricsForTests
};
