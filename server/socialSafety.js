'use strict';

const REPORT_REASONS = Object.freeze(['afk', 'griefing', 'offensive-name', 'exploit-cheat']);
const REPORT_REASON_SET = new Set(REPORT_REASONS);
const REPORT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

function pairFor(first, second) {
  const a = String(first || '');
  const b = String(second || '');
  if (!a || !b || a === b) return null;
  return a < b ? [a, b] : [b, a];
}

class SocialSafety {
  constructor({ db, reportCooldownMs = REPORT_COOLDOWN_MS } = {}) {
    if (!db) throw new Error('SocialSafety требует открытую базу');
    this.db = db;
    this.reportCooldownMs = reportCooldownMs;
    this.statements = prepare(db);
  }

  isRecentPartner(accountId, targetAccountId) {
    const pair = pairFor(accountId, targetAccountId);
    if (!pair) return false;
    const latest = this.statements.latestPartner.get(String(accountId));
    return latest?.partner_account_id === String(targetAccountId);
  }

  shouldAvoid(firstAccountId, secondAccountId) {
    const pair = pairFor(firstAccountId, secondAccountId);
    if (!pair) return false;
    return Boolean(this.statements.avoidPair.get(pair[0], pair[1]));
  }

  avoid({ accountId, targetAccountId, now = Date.now() }) {
    const pair = pairFor(accountId, targetAccountId);
    if (!pair) return { ok: false, reason: 'invalid-target' };
    const actor = String(accountId || '');
    const target = String(targetAccountId || '');
    if (!this.statements.account.get(actor) || !this.statements.account.get(target)) {
      return { ok: false, reason: 'unknown-account' };
    }
    if (!this.isRecentPartner(actor, target)) return { ok: false, reason: 'not-recent-partner' };
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const result = this.statements.insertAvoid.run(pair[0], pair[1], actor, at);
    return { ok: true, avoided: true, created: Number(result.changes || 0) > 0 };
  }

  report({ accountId, targetAccountId, reason, now = Date.now() }) {
    const reporter = String(accountId || '');
    const target = String(targetAccountId || '');
    const normalizedReason = String(reason || '');
    if (!pairFor(reporter, target)) return { ok: false, reason: 'invalid-target' };
    if (!REPORT_REASON_SET.has(normalizedReason)) return { ok: false, reason: 'invalid-reason' };
    if (!this.statements.account.get(reporter) || !this.statements.account.get(target)) {
      return { ok: false, reason: 'unknown-account' };
    }
    if (!this.isRecentPartner(reporter, target)) return { ok: false, reason: 'not-recent-partner' };

    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const previous = this.statements.report.get(reporter, target, normalizedReason);
    if (previous && at - Number(previous.last_reported_at || 0) < this.reportCooldownMs) {
      return {
        ok: true,
        accepted: false,
        duplicate: true,
        reportCount: Number(previous.report_count || 1)
      };
    }

    this.statements.upsertReport.run(reporter, target, normalizedReason, at, at);
    const saved = this.statements.report.get(reporter, target, normalizedReason);
    return {
      ok: true,
      accepted: true,
      duplicate: false,
      reportCount: Number(saved?.report_count || 1)
    };
  }
}

function prepare(db) {
  return {
    account: db.prepare('SELECT 1 AS present FROM accounts WHERE id = ?'),
    latestPartner: db.prepare(`
      SELECT partner_account_id
      FROM recent_partners
      WHERE account_id = ?
      ORDER BY last_played_at DESC, partner_account_id ASC
      LIMIT 1
    `),
    avoidPair: db.prepare(
      'SELECT 1 AS present FROM matchmaking_avoids WHERE account_a = ? AND account_b = ?'
    ),
    insertAvoid: db.prepare(`
      INSERT OR IGNORE INTO matchmaking_avoids
        (account_a, account_b, created_by_account_id, created_at)
      VALUES (?, ?, ?, ?)
    `),
    report: db.prepare(`
      SELECT report_count, last_reported_at
      FROM social_reports
      WHERE reporter_account_id = ? AND target_account_id = ? AND reason = ?
    `),
    upsertReport: db.prepare(`
      INSERT INTO social_reports
        (reporter_account_id, target_account_id, reason, report_count, first_reported_at, last_reported_at)
      VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT (reporter_account_id, target_account_id, reason) DO UPDATE SET
        report_count = report_count + 1,
        last_reported_at = excluded.last_reported_at
    `)
  };
}

module.exports = { SocialSafety, REPORT_REASONS, REPORT_COOLDOWN_MS, pairFor };
