'use strict';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_RETENTION_DAYS = 30;

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

function periodSpec(value) {
  const key = String(value || '24h').trim();
  return Object.hasOwn(PERIODS, key) ? { key, ...PERIODS[key] } : { key: '24h', ...PERIODS['24h'] };
}

function cleanBuildValue(value) {
  return String(value || '')
    .trim()
    .slice(0, 120);
}

function buildFrom(value = {}) {
  return {
    version: cleanBuildValue(value.version) || 'unknown',
    commit: cleanBuildValue(value.commit) || 'unknown',
    release: cleanBuildValue(value.release) || ''
  };
}

function statusRank(value) {
  if (value === 'critical') return 2;
  if (value === 'warning') return 1;
  return 0;
}

class ServiceReliabilityReader {
  constructor({ db, liveHealth = null, retentionDays = DEFAULT_RETENTION_DAYS, now = () => Date.now() } = {}) {
    if (!db) throw new Error('ServiceReliabilityReader requires an open database');
    this.db = db;
    this.liveHealth = typeof liveHealth === 'function' ? liveHealth : null;
    this.retentionDays = Math.max(1, Math.min(90, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
    this.now = now;
    this.statements = prepare(db);
  }

  async report({ period = '24h', now = this.now() } = {}) {
    const spec = periodSpec(period);
    const at = Number(now);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid reliability report time');
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

    let live = null;
    try {
      live = this.liveHealth ? await this.liveHealth() : null;
    } catch {
      live = null;
    }
    const latest = this.statements.latestBuild.get() || null;
    const storedBuild = latest
      ? {
          version: latest.version,
          commit: latest.commit_sha,
          release: latest.release_tag || ''
        }
      : {};

    return {
      generatedAt: at,
      retentionDays: this.retentionDays,
      period: spec.key,
      from,
      to: at,
      status,
      reasons,
      build: buildFrom(live || storedBuild),
      live: Boolean(live?.ok),
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
    summary: db.prepare(`
      SELECT COUNT(*) AS samples,
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
      SELECT CAST(sampled_at / ? AS INTEGER) * ? AS bucket_at,
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
    `),
    latestBuild: db.prepare(`
      SELECT version, commit_sha, release_tag
      FROM service_reliability_samples
      ORDER BY sampled_at DESC, commit_sha DESC
      LIMIT 1
    `)
  };
}

module.exports = { ServiceReliabilityReader, PERIODS, periodSpec };
