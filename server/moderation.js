'use strict';

const { migrateDatabase } = require('./migrations');

const MODERATION_STATUSES = Object.freeze(['open', 'reviewing', 'resolved', 'dismissed']);
const MODERATION_STATUS_SET = new Set(MODERATION_STATUSES);
const CLOSED_STATUSES = new Set(['resolved', 'dismissed']);
const MAX_MODERATOR_ID = 80;
const MAX_NOTE = 1000;

function hasAsciiControl(value) {
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeModeratorId(value) {
  const raw = String(value || '');
  const text = raw.trim();
  if (!text || text.length > MAX_MODERATOR_ID || hasAsciiControl(raw)) return null;
  return text;
}

function normalizeNote(value) {
  if (value == null) return '';
  const text = String(value).trim();
  if (text.length > MAX_NOTE || text.includes(String.fromCharCode(0))) return null;
  return text;
}

function clampLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 200);
}

function toSummary(row) {
  if (!row) return null;
  return {
    targetAccountId: row.target_account_id,
    currentName: row.current_name || 'Wobbler',
    status: row.effective_status || 'open',
    storedStatus: row.stored_status || 'open',
    uniqueReporters: Number(row.reporter_count || 0),
    totalReports: Number(row.report_count || 0),
    firstReportedAt: Number(row.first_reported_at || 0),
    lastReportedAt: Number(row.last_reported_at || 0),
    reasons: {
      afk: Number(row.afk_count || 0),
      griefing: Number(row.griefing_count || 0),
      offensiveName: Number(row.offensive_name_count || 0),
      exploitCheat: Number(row.exploit_cheat_count || 0)
    },
    reviewedThrough: Number(row.reviewed_through || 0),
    moderatorId: row.moderator_id || null,
    note: row.note || null,
    updatedAt: Number(row.updated_at || 0)
  };
}

class ModerationQueue {
  constructor({ db } = {}) {
    if (!db) throw new Error('ModerationQueue требует открытую базу');
    this.db = db;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  queue({ status = 'open', limit = 50 } = {}) {
    const normalizedStatus = String(status || 'open').trim();
    if (normalizedStatus !== 'all' && !MODERATION_STATUS_SET.has(normalizedStatus)) {
      return { ok: false, reason: 'invalid-status', allowedStatuses: [...MODERATION_STATUSES, 'all'] };
    }
    const rows = this.statements.queue.all(normalizedStatus, normalizedStatus, clampLimit(limit));
    return { ok: true, status: normalizedStatus, cases: rows.map(toSummary) };
  }

  get(targetAccountId) {
    const target = String(targetAccountId || '').trim();
    if (!target) return null;
    const summary = toSummary(this.statements.summary.get(target));
    if (!summary) return null;
    const reports = this.statements.reports.all(target).map(row => ({
      reporterAccountId: row.reporter_account_id,
      reason: row.reason,
      reportCount: Number(row.report_count || 0),
      firstReportedAt: Number(row.first_reported_at || 0),
      lastReportedAt: Number(row.last_reported_at || 0),
      targetNameSnapshot: row.target_name_snapshot || null,
      chapterIdSnapshot: row.chapter_id_snapshot || null
    }));
    const evidence = this.statements.evidence.all(target).map(row => ({
      id: Number(row.id),
      reporterAccountId: row.reporter_account_id,
      reason: row.reason,
      reportedAt: Number(row.reported_at || 0),
      occurrences: Number(row.occurrences || 1),
      targetNameSnapshot: row.target_name_snapshot || null,
      chapterIdSnapshot: row.chapter_id_snapshot || null
    }));
    const history = this.statements.history.all(target).map(row => ({
      id: Number(row.id),
      fromStatus: row.from_status,
      toStatus: row.to_status,
      moderatorId: row.moderator_id,
      note: row.note || null,
      reviewedThrough: Number(row.reviewed_through || 0),
      createdAt: Number(row.created_at || 0)
    }));
    return { ...summary, reports, evidence, history };
  }

  transition({ targetAccountId, status, moderatorId, note, now = Date.now() } = {}) {
    const target = String(targetAccountId || '').trim();
    const nextStatus = String(status || '').trim();
    const moderator = normalizeModeratorId(moderatorId);
    const normalizedNote = normalizeNote(note);
    if (!target) return { ok: false, reason: 'invalid-target' };
    if (!MODERATION_STATUS_SET.has(nextStatus)) {
      return { ok: false, reason: 'invalid-status', allowedStatuses: MODERATION_STATUSES };
    }
    if (!moderator) return { ok: false, reason: 'invalid-moderator' };
    if (normalizedNote == null) return { ok: false, reason: 'note-too-long' };
    if (CLOSED_STATUSES.has(nextStatus) && !normalizedNote) {
      return { ok: false, reason: 'note-required' };
    }

    const current = this.get(target);
    if (!current) return { ok: false, reason: 'no-reports' };
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const reviewedThrough = CLOSED_STATUSES.has(nextStatus)
      ? current.lastReportedAt
      : nextStatus === 'open'
        ? 0
        : current.reviewedThrough;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.upsertCase.run(
        target,
        nextStatus,
        reviewedThrough,
        moderator,
        normalizedNote || null,
        at
      );
      this.statements.insertEvent.run(
        target,
        current.status,
        nextStatus,
        moderator,
        normalizedNote || null,
        reviewedThrough,
        at
      );
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    return { ok: true, case: this.get(target) };
  }
}

function prepare(db) {
  const summarySelect = `
    SELECT
      sr.target_account_id,
      COALESCE(a.display_name, MAX(sr.target_name_snapshot), 'Wobbler') AS current_name,
      COUNT(DISTINCT sr.reporter_account_id) AS reporter_count,
      SUM(sr.report_count) AS report_count,
      MIN(sr.first_reported_at) AS first_reported_at,
      MAX(sr.last_reported_at) AS last_reported_at,
      SUM(CASE WHEN sr.reason = 'afk' THEN sr.report_count ELSE 0 END) AS afk_count,
      SUM(CASE WHEN sr.reason = 'griefing' THEN sr.report_count ELSE 0 END) AS griefing_count,
      SUM(CASE WHEN sr.reason = 'offensive-name' THEN sr.report_count ELSE 0 END) AS offensive_name_count,
      SUM(CASE WHEN sr.reason = 'exploit-cheat' THEN sr.report_count ELSE 0 END) AS exploit_cheat_count,
      mc.status AS stored_status,
      COALESCE(mc.reviewed_through, 0) AS reviewed_through,
      mc.moderator_id,
      mc.note,
      COALESCE(mc.updated_at, 0) AS updated_at
    FROM social_reports sr
    LEFT JOIN accounts a ON a.id = sr.target_account_id
    LEFT JOIN moderation_cases mc ON mc.target_account_id = sr.target_account_id
  `;
  const grouped = `
    GROUP BY
      sr.target_account_id,
      a.display_name,
      mc.status,
      mc.reviewed_through,
      mc.moderator_id,
      mc.note,
      mc.updated_at
  `;
  const effective = `
    CASE
      WHEN stored_status IN ('resolved', 'dismissed') AND last_reported_at > reviewed_through THEN 'open'
      ELSE COALESCE(stored_status, 'open')
    END
  `;

  return {
    queue: db.prepare(`
      WITH summaries AS (
        ${summarySelect}
        ${grouped}
      ), effective_cases AS (
        SELECT summaries.*, ${effective} AS effective_status
        FROM summaries
      )
      SELECT *
      FROM effective_cases
      WHERE ? = 'all' OR effective_status = ?
      ORDER BY
        reporter_count DESC,
        exploit_cheat_count DESC,
        offensive_name_count DESC,
        report_count DESC,
        last_reported_at DESC,
        target_account_id ASC
      LIMIT ?
    `),
    summary: db.prepare(`
      WITH summaries AS (
        ${summarySelect}
        WHERE sr.target_account_id = ?
        ${grouped}
      )
      SELECT summaries.*, ${effective} AS effective_status
      FROM summaries
    `),
    reports: db.prepare(`
      SELECT
        reporter_account_id,
        reason,
        report_count,
        first_reported_at,
        last_reported_at,
        target_name_snapshot,
        chapter_id_snapshot
      FROM social_reports
      WHERE target_account_id = ?
      ORDER BY last_reported_at DESC, reporter_account_id ASC, reason ASC
    `),
    evidence: db.prepare(`
      SELECT
        id,
        reporter_account_id,
        reason,
        reported_at,
        occurrences,
        target_name_snapshot,
        chapter_id_snapshot
      FROM social_report_evidence
      WHERE target_account_id = ?
      ORDER BY reported_at DESC, id DESC
    `),
    history: db.prepare(`
      SELECT id, from_status, to_status, moderator_id, note, reviewed_through, created_at
      FROM moderation_events
      WHERE target_account_id = ?
      ORDER BY created_at ASC, id ASC
    `),
    upsertCase: db.prepare(`
      INSERT INTO moderation_cases
        (target_account_id, status, reviewed_through, moderator_id, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (target_account_id) DO UPDATE SET
        status = excluded.status,
        reviewed_through = excluded.reviewed_through,
        moderator_id = excluded.moderator_id,
        note = excluded.note,
        updated_at = excluded.updated_at
    `),
    insertEvent: db.prepare(`
      INSERT INTO moderation_events
        (target_account_id, from_status, to_status, moderator_id, note, reviewed_through, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
  };
}

module.exports = {
  ModerationQueue,
  MODERATION_STATUSES,
  MAX_MODERATOR_ID,
  MAX_NOTE,
  normalizeModeratorId,
  normalizeNote,
  clampLimit
};
