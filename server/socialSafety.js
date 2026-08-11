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
    const row = this.statements.avoidPair.get(pair[0], pair[1]);
    return Boolean(row && (row.account_a_avoided_at != null || row.account_b_avoided_at != null));
  }

  listAvoided(accountId) {
    const actor = String(accountId || '');
    if (!actor || !this.statements.account.get(actor)) return [];
    return this.statements.listAvoided.all(actor, actor, actor, actor, actor).map(row => ({
      id: row.target_account_id,
      name: row.display_name || 'Wobbler',
      avoidedAt: Number(row.avoided_at || 0)
    }));
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
    const current = this.statements.avoidPair.get(pair[0], pair[1]);
    const actorIsA = actor === pair[0];
    const alreadyAvoided = actorIsA
      ? current?.account_a_avoided_at != null
      : current?.account_b_avoided_at != null;
    if (actorIsA) this.statements.upsertAvoidA.run(pair[0], pair[1], actor, at, at);
    else this.statements.upsertAvoidB.run(pair[0], pair[1], actor, at, at);
    return { ok: true, avoided: true, created: !alreadyAvoided };
  }

  unavoid({ accountId, targetAccountId }) {
    const pair = pairFor(accountId, targetAccountId);
    if (!pair) return { ok: false, reason: 'invalid-target' };
    const actor = String(accountId || '');
    const target = String(targetAccountId || '');
    if (!this.statements.account.get(actor) || !this.statements.account.get(target)) {
      return { ok: false, reason: 'unknown-account' };
    }
    const current = this.statements.avoidPair.get(pair[0], pair[1]);
    const actorIsA = actor === pair[0];
    const active = actorIsA ? current?.account_a_avoided_at != null : current?.account_b_avoided_at != null;
    if (!active) return { ok: true, avoided: false, removed: false };
    if (actorIsA) this.statements.clearAvoidA.run(pair[0], pair[1]);
    else this.statements.clearAvoidB.run(pair[0], pair[1]);
    this.statements.deleteEmptyAvoid.run(pair[0], pair[1]);
    return { ok: true, avoided: false, removed: true };
  }

  report({ accountId, targetAccountId, reason, now = Date.now() }) {
    const reporter = String(accountId || '');
    const target = String(targetAccountId || '');
    const normalizedReason = String(reason || '');
    if (!pairFor(reporter, target)) return { ok: false, reason: 'invalid-target' };
    if (!REPORT_REASON_SET.has(normalizedReason)) return { ok: false, reason: 'invalid-reason' };
    const reporterAccount = this.statements.account.get(reporter);
    const targetAccount = this.statements.account.get(target);
    if (!reporterAccount || !targetAccount) return { ok: false, reason: 'unknown-account' };
    const latest = this.statements.latestPartner.get(reporter);
    if (latest?.partner_account_id !== target) return { ok: false, reason: 'not-recent-partner' };

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

    this.statements.upsertReport.run(
      reporter,
      target,
      normalizedReason,
      at,
      at,
      targetAccount.display_name || 'Wobbler',
      latest.last_chapter_id || null
    );
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
    account: db.prepare('SELECT display_name FROM accounts WHERE id = ?'),
    latestPartner: db.prepare(`
      SELECT partner_account_id, last_chapter_id, last_played_at
      FROM recent_partners
      WHERE account_id = ?
      ORDER BY last_played_at DESC, partner_account_id ASC
      LIMIT 1
    `),
    avoidPair: db.prepare(`
      SELECT account_a_avoided_at, account_b_avoided_at
      FROM matchmaking_avoids
      WHERE account_a = ? AND account_b = ?
    `),
    listAvoided: db.prepare(`
      SELECT
        CASE WHEN ma.account_a = ? THEN ma.account_b ELSE ma.account_a END AS target_account_id,
        a.display_name,
        CASE
          WHEN ma.account_a = ? THEN ma.account_a_avoided_at
          ELSE ma.account_b_avoided_at
        END AS avoided_at
      FROM matchmaking_avoids ma
      JOIN accounts a
        ON a.id = CASE WHEN ma.account_a = ? THEN ma.account_b ELSE ma.account_a END
      WHERE (ma.account_a = ? AND ma.account_a_avoided_at IS NOT NULL)
         OR (ma.account_b = ? AND ma.account_b_avoided_at IS NOT NULL)
      ORDER BY avoided_at DESC, target_account_id ASC
    `),
    upsertAvoidA: db.prepare(`
      INSERT INTO matchmaking_avoids
        (account_a, account_b, created_by_account_id, created_at, account_a_avoided_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_a, account_b) DO UPDATE SET
        account_a_avoided_at = COALESCE(account_a_avoided_at, excluded.account_a_avoided_at)
    `),
    upsertAvoidB: db.prepare(`
      INSERT INTO matchmaking_avoids
        (account_a, account_b, created_by_account_id, created_at, account_b_avoided_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (account_a, account_b) DO UPDATE SET
        account_b_avoided_at = COALESCE(account_b_avoided_at, excluded.account_b_avoided_at)
    `),
    clearAvoidA: db.prepare(`
      UPDATE matchmaking_avoids SET account_a_avoided_at = NULL
      WHERE account_a = ? AND account_b = ?
    `),
    clearAvoidB: db.prepare(`
      UPDATE matchmaking_avoids SET account_b_avoided_at = NULL
      WHERE account_a = ? AND account_b = ?
    `),
    deleteEmptyAvoid: db.prepare(`
      DELETE FROM matchmaking_avoids
      WHERE account_a = ? AND account_b = ?
        AND account_a_avoided_at IS NULL AND account_b_avoided_at IS NULL
    `),
    report: db.prepare(`
      SELECT report_count, last_reported_at
      FROM social_reports
      WHERE reporter_account_id = ? AND target_account_id = ? AND reason = ?
    `),
    upsertReport: db.prepare(`
      INSERT INTO social_reports
        (
          reporter_account_id,
          target_account_id,
          reason,
          report_count,
          first_reported_at,
          last_reported_at,
          target_name_snapshot,
          chapter_id_snapshot
        )
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT (reporter_account_id, target_account_id, reason) DO UPDATE SET
        report_count = report_count + 1,
        last_reported_at = excluded.last_reported_at,
        target_name_snapshot = excluded.target_name_snapshot,
        chapter_id_snapshot = excluded.chapter_id_snapshot
    `)
  };
}

module.exports = { SocialSafety, REPORT_REASONS, REPORT_COOLDOWN_MS, pairFor };
