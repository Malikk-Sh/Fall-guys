'use strict';

const crypto = require('crypto');
const { ERROR_CODES } = require('../shared/protocol.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_PER_ACCOUNT = 400;
const DEFAULT_QUERY_LIMIT = DEFAULT_MAX_PER_ACCOUNT;
const MAX_QUERY_LIMIT = 2000;
const DEFAULT_MAX_WRITES_PER_MINUTE = 60;
const MAX_RATE_TRACKED_ACCOUNTS = 10_000;
const MAX_VALUE_MS = 7 * DAY_MS;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
const CORRELATION_KEY = crypto.randomBytes(32);

const FIXED_CODES = Object.freeze({
  auth: new Set(['authenticated', 'account-sanctioned']),
  connection: new Set(['disconnected', 'resumed', 'socket-error']),
  room: new Set(['created', 'joined']),
  matchmaking: new Set(['queued', 'matched', 'cancelled', 'away', 'disconnected', 'restart']),
  match: new Set(['started', 'completed', 'abandoned']),
  support: new Set(['forced-logout', 'renamed'])
});
const NETWORK_ERROR_CODES = new Set(Object.values(ERROR_CODES));
const MODES = new Set(['race', 'coop']);
const PHASES = new Set(['roomless', 'matchmaking', 'LOBBY', 'COUNTDOWN', 'PLAYING', 'RESULTS', 'CLOSING']);
const DEVICES = new Set(['mobile', 'desktop']);

function cleanAccountId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) return '';
  for (const character of id) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return '';
  }
  return id;
}

function validCode(kind, code) {
  const normalizedKind = String(kind || '').trim();
  const normalizedCode = String(code || '').trim();
  if (normalizedKind === 'network-error') {
    return NETWORK_ERROR_CODES.has(normalizedCode) ? normalizedCode : '';
  }
  return FIXED_CODES[normalizedKind]?.has(normalizedCode) ? normalizedCode : '';
}

function correlationRef(scope, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return crypto.createHmac('sha256', CORRELATION_KEY).update(`${scope}:${raw}`).digest('hex').slice(0, 12);
}

function safeEnum(value, allowed) {
  const text = String(value || '').trim();
  return allowed.has(text) ? text : null;
}

function safeValueMs(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > MAX_VALUE_MS) return null;
  return number;
}

function clampLimit(value, ceiling = MAX_QUERY_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  const boundedCeiling = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(ceiling) || MAX_QUERY_LIMIT));
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Math.min(DEFAULT_QUERY_LIMIT, boundedCeiling);
  return Math.min(parsed, boundedCeiling);
}

class IncidentDiagnostics {
  constructor({
    db,
    now = () => Date.now(),
    retentionDays = DEFAULT_RETENTION_DAYS,
    maxPerAccount = DEFAULT_MAX_PER_ACCOUNT,
    maxWritesPerMinute = DEFAULT_MAX_WRITES_PER_MINUTE
  } = {}) {
    if (!db) throw new Error('IncidentDiagnostics requires an open database');
    this.db = db;
    this.now = now;
    this.retentionDays = Math.max(1, Math.min(90, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
    this.maxPerAccount = Math.max(10, Math.min(2000, Number(maxPerAccount) || DEFAULT_MAX_PER_ACCOUNT));
    this.maxWritesPerMinute = Math.max(
      5,
      Math.min(600, Number(maxWritesPerMinute) || DEFAULT_MAX_WRITES_PER_MINUTE)
    );
    this.writeBuckets = new Map();
    this.lastPrunedAt = 0;
    this.statements = prepare(db);
  }

  record({
    accountId,
    kind,
    code,
    occurredAt = this.now(),
    roomId = null,
    matchId = null,
    mode = null,
    phase = null,
    device = null,
    valueMs = null
  } = {}) {
    const id = cleanAccountId(accountId);
    const normalizedKind = String(kind || '').trim();
    const normalizedCode = validCode(normalizedKind, code);
    const at = Number(occurredAt);
    if (!id || !normalizedCode || !Number.isSafeInteger(at) || at < 0) return false;
    const rateNow = Number(this.now());
    if (!Number.isSafeInteger(rateNow) || rateNow < 0 || !this.#allowWrite(id, rateNow)) return false;
    if (!this.statements.accountExists.get(id)) return false;

    this.#prune(at);
    this.statements.insert.run(
      id,
      at,
      normalizedKind,
      normalizedCode,
      correlationRef('room', roomId),
      correlationRef('match', matchId),
      safeEnum(mode, MODES),
      safeEnum(phase, PHASES),
      safeEnum(device, DEVICES),
      safeValueMs(valueMs)
    );
    this.statements.capAccount.run(id, id, this.maxPerAccount);
    return true;
  }

  timeline(accountId, { limit = this.maxPerAccount, now = this.now() } = {}) {
    const id = cleanAccountId(accountId);
    const at = Number(now);
    if (!id || !Number.isSafeInteger(at) || at < 0) return null;
    const account = this.statements.account.get(id);
    if (!account) return null;
    this.#prune(at, true);
    const from = at - this.retentionDays * DAY_MS;
    const requestedLimit = clampLimit(limit, this.maxPerAccount);
    const rowsWithSentinel = this.statements.timeline.all(id, from, requestedLimit + 1);
    const truncated = rowsWithSentinel.length > requestedLimit;
    const rows = truncated ? rowsWithSentinel.slice(0, requestedLimit) : rowsWithSentinel;
    const summary = this.statements.summary.get(id, from) || {};
    return {
      generatedAt: at,
      retentionDays: this.retentionDays,
      maxEventsPerAccount: this.maxPerAccount,
      returnedEvents: rows.length,
      truncated,
      account: { id: account.id, name: account.display_name },
      summary: {
        events: Number(summary.events || 0),
        disconnects: Number(summary.disconnects || 0),
        resumes: Number(summary.resumes || 0),
        networkErrors: Number(summary.network_errors || 0),
        matchesCompleted: Number(summary.matches_completed || 0),
        matchesAbandoned: Number(summary.matches_abandoned || 0),
        lastEventAt: summary.last_event_at == null ? null : Number(summary.last_event_at)
      },
      events: rows.map(row => ({
        occurredAt: Number(row.occurred_at),
        kind: row.kind,
        code: row.code,
        roomRef: row.room_ref || null,
        matchRef: row.match_ref || null,
        mode: row.mode || null,
        phase: row.phase || null,
        device: row.device || null,
        valueMs: row.value_ms == null ? null : Number(row.value_ms)
      }))
    };
  }

  #allowWrite(accountId, now) {
    let bucket = this.writeBuckets.get(accountId);
    if (!bucket) {
      if (this.writeBuckets.size >= MAX_RATE_TRACKED_ACCOUNTS) {
        const oldest = this.writeBuckets.keys().next().value;
        if (oldest !== undefined) this.writeBuckets.delete(oldest);
      }
      bucket = { tokens: this.maxWritesPerMinute, updatedAt: now };
      this.writeBuckets.set(accountId, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(
        this.maxWritesPerMinute,
        bucket.tokens + (elapsed * this.maxWritesPerMinute) / 60_000
      );
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #prune(now, force = false) {
    if (!force && now - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    this.statements.prune.run(now - this.retentionDays * DAY_MS);
  }
}

function prepare(db) {
  return {
    accountExists: db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?'),
    account: db.prepare('SELECT id, display_name FROM accounts WHERE id = ?'),
    insert: db.prepare(`
      INSERT INTO player_incident_events
        (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    capAccount: db.prepare(`
      DELETE FROM player_incident_events
      WHERE account_id = ?
        AND id IN (
          SELECT id
          FROM player_incident_events
          WHERE account_id = ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
    `),
    prune: db.prepare('DELETE FROM player_incident_events WHERE occurred_at < ?'),
    timeline: db.prepare(`
      SELECT id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms
      FROM player_incident_events
      WHERE account_id = ? AND occurred_at >= ?
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `),
    summary: db.prepare(`
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN kind = 'connection' AND code = 'disconnected' THEN 1 ELSE 0 END) AS disconnects,
        SUM(CASE WHEN kind = 'connection' AND code = 'resumed' THEN 1 ELSE 0 END) AS resumes,
            SUM(
              CASE
                WHEN kind = 'network-error' OR (kind = 'connection' AND code = 'socket-error') THEN 1
                ELSE 0
              END
            ) AS network_errors,
        SUM(CASE WHEN kind = 'match' AND code = 'completed' THEN 1 ELSE 0 END) AS matches_completed,
        SUM(CASE WHEN kind = 'match' AND code = 'abandoned' THEN 1 ELSE 0 END) AS matches_abandoned,
        MAX(occurred_at) AS last_event_at
      FROM player_incident_events
      WHERE account_id = ? AND occurred_at >= ?
    `)
  };
}

module.exports = {
  IncidentDiagnostics,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_MAX_PER_ACCOUNT,
  MAX_QUERY_LIMIT,
  DEFAULT_MAX_WRITES_PER_MINUTE,
  validCode,
  correlationRef
};
