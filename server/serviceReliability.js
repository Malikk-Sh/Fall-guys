'use strict';

const { migrateDatabase } = require('./migrations');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_EVENT_ROWS = 20_000;
const HOUSEKEEPING_INTERVAL_MS = HOUR_MS;

const PERIODS = Object.freeze({
  '1h': { ms: HOUR_MS, bucketMs: MINUTE_MS },
  '6h': { ms: 6 * HOUR_MS, bucketMs: 5 * MINUTE_MS },
  '24h': { ms: DAY_MS, bucketMs: 15 * MINUTE_MS },
  '7d': { ms: 7 * DAY_MS, bucketMs: HOUR_MS },
  '30d': { ms: 30 * DAY_MS, bucketMs: 6 * HOUR_MS }
});

const LIFECYCLE_EVENTS = Object.freeze([
  'server_started',
  'server_drain_started',
  'server_drain_finished',
  'shutdown_started',
  'shutdown_complete'
]);

const ERROR_EVENTS = Object.freeze([
  'message_handler_threw',
  'socket_send_failed',
  'socket_send_threw',
  'invalid_room_transition',
  'shutdown_forced',
  'database_close_failed'
]);

const ALLOWED_EVENTS = new Set([...LIFECYCLE_EVENTS, ...ERROR_EVENTS]);
const ALLOWED_SEVERITIES = new Set(['info', 'warn', 'error']);

function periodSpec(value) {
  const key = String(value || '24h').trim();
  return Object.hasOwn(PERIODS, key) ? { key, ...PERIODS[key] } : { key: '24h', ...PERIODS['24h'] };
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function nonNegativeInt(value) {
  return Math.max(0, Math.round(finiteNumber(value)));
}

function safeBuild(health = {}) {
  const clean = value =>
    String(value || '')
      .trim()
      .slice(0, 120);
  return {
    version: clean(health.version) || 'unknown',
    commit: clean(health.commit) || 'unknown',
    release: clean(health.release) || ''
  };
}

function safeFingerprint(value) {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  return /^[0-9a-f]{12,64}$/.test(text) ? text : '';
}

function safeHealth(getHealth) {
  try {
    const value = getHealth?.();
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function statusRank(value) {
  if (value === 'critical') return 2;
  if (value === 'warning') return 1;
  return 0;
}

class ServiceReliability {
  constructor({
    db,
    health,
    now = () => Date.now(),
    retentionDays = DEFAULT_RETENTION_DAYS,
    maxEventRows = DEFAULT_MAX_EVENT_ROWS
  } = {}) {
    if (!db) throw new Error('ServiceReliability requires an open database');
    if (typeof health !== 'function') throw new Error('ServiceReliability requires health()');
    this.db = db;
    this.health = health;
    this.now = now;
    this.retentionDays = Math.max(1, Math.min(90, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
    this.maxEventRows = Math.max(1000, Math.min(100_000, Number(maxEventRows) || DEFAULT_MAX_EVENT_ROWS));
    this.previousCounters = null;
    this.lastPrunedAt = 0;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  sample({ now = this.now(), health = safeHealth(this.health) } = {}) {
    const at = Number(now);
    if (!Number.isSafeInteger(at) || at < 0) return false;
    const metrics = health.metrics || {};
    const current = {
      resumeSucceeded: nonNegativeInt(metrics.resumeSucceeded),
      resumeFailed: nonNegativeInt(metrics.resumeFailed),
      handlerErrors: nonNegativeInt(metrics.handlerErrors),
      socketSendFailures: nonNegativeInt(metrics.socketSendFailures),
      capacityRejected: nonNegativeInt(metrics.capacityRejected),
      snapshotsSkippedForLoad: nonNegativeInt(metrics.snapshotsSkippedForLoad)
    };
    const previous = this.previousCounters;
    const delta = name => (previous ? Math.max(0, current[name] - previous[name]) : 0);
    const build = safeBuild(health);
    const sampledAt = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    this.statements.upsertSample.run(
      sampledAt,
      build.version,
      build.commit,
      build.release,
      finiteNumber(health.load?.eventLoopP95Ms),
      nonNegativeInt(health.load?.rssMb),
      nonNegativeInt(health.load?.heapUsedMb),
      nonNegativeInt(health.capacity?.socketCount),
      nonNegativeInt(health.capacity?.activeMatches),
      nonNegativeInt(health.matchmaking?.waiting),
      delta('resumeSucceeded'),
      delta('resumeFailed'),
      delta('handlerErrors'),
      delta('socketSendFailures'),
      delta('capacityRejected'),
      delta('snapshotsSkippedForLoad')
    );
    // Advance only after persistence succeeds; transient storage failure must not lose deltas.
    this.previousCounters = current;
    this.prune(at);
    return true;
  }

  recordEvent({ event, severity = 'info', fingerprint = '', occurredAt = this.now() } = {}) {
    const eventName = String(event || '').trim();
    const level = String(severity || '').trim();
    const at = Number(occurredAt);
    if (!ALLOWED_EVENTS.has(eventName) || !ALLOWED_SEVERITIES.has(level)) return false;
    if (!Number.isSafeInteger(at) || at < 0) return false;
    const build = safeBuild(safeHealth(this.health));
    const bucketAt = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    this.statements.upsertEvent.run(
      bucketAt,
      at,
      at,
      eventName,
      level,
      safeFingerprint(fingerprint),
      build.version,
      build.commit,
      build.release
    );
    this.statements.capEvents.run(this.maxEventRows);
    this.prune(at);
    return true;
  }

  prune(now = this.now(), { force = false } = {}) {
    const at = Number(now);
    if (!Number.isSafeInteger(at) || at < 0) return 0;
    if (!force && at - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return 0;
    const cutoff = at - this.retentionDays * DAY_MS;
    const samples = Number(this.statements.pruneSamples.run(cutoff)?.changes || 0);
    const events = Number(this.statements.pruneEvents.run(cutoff)?.changes || 0);
    this.lastPrunedAt = at;
    return samples + events;
  }

  report({ period = '24h', now = this.now() } = {}) {
    const spec = periodSpec(period);
    const at = Number(now);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid reliability report time');
    this.prune(at, { force: true });
    // Stored event occurrences are minute-bucketed, so expose the same aligned boundary.
    const from = Math.floor((at - spec.ms) / MINUTE_MS) * MINUTE_MS;
    const raw = this.statements.summary.get(from, at) || {};
    const summary = {
      samples: Number(raw.samples || 0),
      reconnectSucceeded: Number(raw.resume_succeeded || 0),
      reconnectFailed: Number(raw.resume_failed || 0),
      handlerErrors: Number(raw.handler_errors || 0),
      socketSendFailures: Number(raw.socket_send_failures || 0),
      capacityRejected: Number(raw.capacity_rejected || 0),
      snapshotsSkippedForLoad: Number(raw.snapshots_skipped_for_load || 0),
      eventLoopP95MsMax: Number(raw.event_loop_max || 0),
      eventLoopP95MsAverage:
        raw.event_loop_avg == null ? 0 : Math.round(Number(raw.event_loop_avg) * 10) / 10,
      rssMbMax: Number(raw.rss_max || 0),
      heapUsedMbMax: Number(raw.heap_max || 0),
      socketsMax: Number(raw.sockets_max || 0),
      activeMatchesMax: Number(raw.matches_max || 0),
      matchmakingWaitingMax: Number(raw.matchmaking_max || 0)
    };
    const reconnectAttempts = summary.reconnectSucceeded + summary.reconnectFailed;
    summary.reconnectSuccessPercent = reconnectAttempts
      ? Math.round((summary.reconnectSucceeded / reconnectAttempts) * 1000) / 10
      : null;

    const errors = this.statements.errorGroups.all(from, at, 50).map(row => ({
      event: row.event,
      severity: row.severity,
      fingerprint: row.fingerprint || null,
      occurrences: Number(row.occurrences || 0),
      firstOccurredAt: Number(row.first_occurred_at),
      lastOccurredAt: Number(row.last_occurred_at),
      build: {
        version: row.version,
        commit: row.commit_sha,
        release: row.release_tag || null
      }
    }));

    const lifecycle = this.statements.lifecycle.all(from, at, 100).map(row => ({
      event: row.event,
      severity: row.severity,
      occurrences: Number(row.occurrences || 0),
      firstOccurredAt: Number(row.first_occurred_at),
      lastOccurredAt: Number(row.last_occurred_at),
      build: {
        version: row.version,
        commit: row.commit_sha,
        release: row.release_tag || null
      }
    }));

    const series = this.statements.series.all(spec.bucketMs, spec.bucketMs, from, at).map(row => ({
      at: Number(row.bucket_at),
      eventLoopP95Ms: Number(row.event_loop_p95_ms || 0),
      rssMb: Number(row.rss_mb || 0),
      sockets: Number(row.socket_count || 0),
      activeMatches: Number(row.active_matches || 0),
      reconnectSucceeded: Number(row.resume_succeeded || 0),
      reconnectFailed: Number(row.resume_failed || 0),
      handlerErrors: Number(row.handler_errors || 0),
      socketSendFailures: Number(row.socket_send_failures || 0),
      capacityRejected: Number(row.capacity_rejected || 0)
    }));

    const reasons = [];
    let status = 'healthy';
    const raise = (next, code) => {
      if (statusRank(next) > statusRank(status)) status = next;
      if (!reasons.includes(code)) reasons.push(code);
    };
    if (summary.handlerErrors > 0 || errors.some(item => item.severity === 'error')) {
      raise('critical', 'internal-errors');
    }
    if (errors.some(item => item.severity === 'warn')) raise('warning', 'operational-warnings');
    if (summary.eventLoopP95MsMax >= 250) raise('critical', 'event-loop-critical');
    else if (summary.eventLoopP95MsMax >= 120) raise('warning', 'event-loop-high');
    if (reconnectAttempts >= 5 && summary.reconnectFailed / reconnectAttempts >= 0.5) {
      raise('critical', 'reconnect-failure-rate-critical');
    } else if (reconnectAttempts >= 5 && summary.reconnectFailed / reconnectAttempts >= 0.25) {
      raise('warning', 'reconnect-failure-rate-high');
    }
    if (summary.socketSendFailures >= 5) raise('warning', 'socket-send-failures');
    if (summary.capacityRejected > 0) raise('warning', 'capacity-rejections');
    if (lifecycle.some(item => item.severity === 'warn' || item.severity === 'error')) {
      raise('warning', 'lifecycle-warning');
    }

    return {
      generatedAt: at,
      retentionDays: this.retentionDays,
      period: spec.key,
      from,
      to: at,
      status,
      reasons,
      build: safeBuild(safeHealth(this.health)),
      summary,
      errors,
      lifecycle,
      series
    };
  }
}

function prepare(db) {
  const errorList = ERROR_EVENTS.map(value => `'${value}'`).join(', ');
  const lifecycleList = LIFECYCLE_EVENTS.map(value => `'${value}'`).join(', ');
  return {
    upsertSample: db.prepare(`
      INSERT INTO service_reliability_samples
        (sampled_at, version, commit_sha, release_tag, event_loop_p95_ms, rss_mb, heap_used_mb,
         socket_count, active_matches, matchmaking_waiting, resume_succeeded, resume_failed,
         handler_errors, socket_send_failures, capacity_rejected, snapshots_skipped_for_load)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sampled_at, commit_sha) DO UPDATE SET
        version = excluded.version,
        release_tag = excluded.release_tag,
        event_loop_p95_ms = MAX(service_reliability_samples.event_loop_p95_ms, excluded.event_loop_p95_ms),
        rss_mb = MAX(service_reliability_samples.rss_mb, excluded.rss_mb),
        heap_used_mb = MAX(service_reliability_samples.heap_used_mb, excluded.heap_used_mb),
        socket_count = MAX(service_reliability_samples.socket_count, excluded.socket_count),
        active_matches = MAX(service_reliability_samples.active_matches, excluded.active_matches),
        matchmaking_waiting = MAX(service_reliability_samples.matchmaking_waiting, excluded.matchmaking_waiting),
        resume_succeeded = service_reliability_samples.resume_succeeded + excluded.resume_succeeded,
        resume_failed = service_reliability_samples.resume_failed + excluded.resume_failed,
        handler_errors = service_reliability_samples.handler_errors + excluded.handler_errors,
        socket_send_failures = service_reliability_samples.socket_send_failures + excluded.socket_send_failures,
        capacity_rejected = service_reliability_samples.capacity_rejected + excluded.capacity_rejected,
        snapshots_skipped_for_load = service_reliability_samples.snapshots_skipped_for_load + excluded.snapshots_skipped_for_load
    `),
    upsertEvent: db.prepare(`
      INSERT INTO service_reliability_events
        (bucket_at, first_occurred_at, last_occurred_at, event, severity, fingerprint,
         version, commit_sha, release_tag, occurrences)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(bucket_at, event, severity, fingerprint, version, commit_sha, release_tag)
      DO UPDATE SET
        last_occurred_at = MAX(service_reliability_events.last_occurred_at, excluded.last_occurred_at),
        occurrences = service_reliability_events.occurrences + 1
    `),
    capEvents: db.prepare(`
      DELETE FROM service_reliability_events
      WHERE id IN (
        SELECT id FROM service_reliability_events
        ORDER BY last_occurred_at DESC, id DESC
        LIMIT -1 OFFSET ?
      )
    `),
    pruneSamples: db.prepare('DELETE FROM service_reliability_samples WHERE sampled_at < ?'),
    pruneEvents: db.prepare('DELETE FROM service_reliability_events WHERE last_occurred_at < ?'),
    summary: db.prepare(`
      SELECT
        COUNT(*) AS samples,
        SUM(resume_succeeded) AS resume_succeeded,
        SUM(resume_failed) AS resume_failed,
        SUM(handler_errors) AS handler_errors,
        SUM(socket_send_failures) AS socket_send_failures,
        SUM(capacity_rejected) AS capacity_rejected,
        SUM(snapshots_skipped_for_load) AS snapshots_skipped_for_load,
        MAX(event_loop_p95_ms) AS event_loop_max,
        AVG(event_loop_p95_ms) AS event_loop_avg,
        MAX(rss_mb) AS rss_max,
        MAX(heap_used_mb) AS heap_max,
        MAX(socket_count) AS sockets_max,
        MAX(active_matches) AS matches_max,
        MAX(matchmaking_waiting) AS matchmaking_max
      FROM service_reliability_samples
      WHERE sampled_at >= ? AND sampled_at <= ?
    `),
    errorGroups: db.prepare(`
      SELECT event, severity, fingerprint, version, commit_sha, release_tag,
             SUM(occurrences) AS occurrences,
             MIN(first_occurred_at) AS first_occurred_at,
             MAX(last_occurred_at) AS last_occurred_at
      FROM service_reliability_events
      WHERE bucket_at >= ? AND bucket_at <= ?
        AND event IN (${errorList})
      GROUP BY event, severity, fingerprint, version, commit_sha, release_tag
      ORDER BY CASE severity WHEN 'error' THEN 3 WHEN 'warn' THEN 2 ELSE 1 END DESC,
               occurrences DESC, last_occurred_at DESC
      LIMIT ?
    `),
    lifecycle: db.prepare(`
      SELECT event, severity, version, commit_sha, release_tag, occurrences,
             first_occurred_at, last_occurred_at
      FROM service_reliability_events
      WHERE bucket_at >= ? AND bucket_at <= ?
        AND event IN (${lifecycleList})
      ORDER BY last_occurred_at DESC, id DESC
      LIMIT ?
    `),
    series: db.prepare(`
      SELECT
        CAST(sampled_at / ? AS INTEGER) * ? AS bucket_at,
        MAX(event_loop_p95_ms) AS event_loop_p95_ms,
        MAX(rss_mb) AS rss_mb,
        MAX(socket_count) AS socket_count,
        MAX(active_matches) AS active_matches,
        SUM(resume_succeeded) AS resume_succeeded,
        SUM(resume_failed) AS resume_failed,
        SUM(handler_errors) AS handler_errors,
        SUM(socket_send_failures) AS socket_send_failures,
        SUM(capacity_rejected) AS capacity_rejected
      FROM service_reliability_samples
      WHERE sampled_at >= ? AND sampled_at <= ?
      GROUP BY bucket_at
      ORDER BY bucket_at ASC
    `)
  };
}

module.exports = {
  ServiceReliability,
  PERIODS,
  LIFECYCLE_EVENTS,
  ERROR_EVENTS,
  ALLOWED_EVENTS,
  DEFAULT_RETENTION_DAYS,
  periodSpec,
  safeBuild,
  safeFingerprint
};
