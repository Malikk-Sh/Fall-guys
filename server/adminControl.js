'use strict';

const { AdminAnalytics } = require('./adminAnalytics');
const { AdminPlayerSupport } = require('./adminPlayerSupport');
const { ModerationQueue } = require('./moderation');

const ADMIN_MODERATOR_PREFIX = 'admin:';

class AdminControlService {
  constructor({ db, health, gameplay, adminAuth } = {}) {
    if (!db) throw new Error('AdminControlService requires an open database');
    if (typeof health !== 'function') throw new Error('AdminControlService requires health()');
    if (!gameplay || typeof gameplay.summary !== 'function') {
      throw new Error('AdminControlService requires GameplayMetrics');
    }
    if (!adminAuth || typeof adminAuth.audit !== 'function') {
      throw new Error('AdminControlService requires AdminAuthService');
    }
    this.db = db;
    this.health = health;
    this.gameplay = gameplay;
    this.adminAuth = adminAuth;
    this.analyticsReport = new AdminAnalytics({ db, gameplay });
    this.playerSupport = new AdminPlayerSupport({ db });
    this.moderation = new ModerationQueue({ db });
    this.statements = prepare(db);
  }

  overview({ now = Date.now() } = {}) {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const accounts = Number(this.statements.accountCount.get().count || 0);
    const active24h = Number(this.statements.activeAccounts.get(dayAgo, now).count || 0);
    const reports24h = Number(this.statements.reports24h.get(dayAgo).count || 0);
    const competitiveRecords = Number(this.statements.competitiveRecords.get().count || 0);
    const openCases = this.moderation.queue({ status: 'open', limit: 200 });
    const reviewingCases = this.moderation.queue({ status: 'reviewing', limit: 200 });
    return {
      health: this.health(),
      accounts: { total: accounts, active24h },
      moderation: {
        open: openCases.ok ? openCases.cases.length : 0,
        openTruncated: Boolean(openCases.ok && openCases.cases.length === 200),
        reviewing: reviewingCases.ok ? reviewingCases.cases.length : 0,
        reviewingTruncated: Boolean(reviewingCases.ok && reviewingCases.cases.length === 200),
        reports24h
      },
      competitiveRecords
    };
  }

  analytics({ days = 7, limit = 300, mode = 'all', course = 'all', device = 'all' } = {}) {
    return this.analyticsReport.report({ days, limit, mode, course, device });
  }

  playerSearch(query, { limit = 20, now = Date.now() } = {}) {
    return this.playerSupport.search(query, { limit, now });
  }

  playerDetail(accountId, { actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    const profile = this.playerSupport.get(accountId, { now });
    if (!profile) return { ok: false, reason: 'unknown-account' };
    const moderation = this.moderation.get(profile.account.id);
    const result = {
      ok: true,
      player: {
        ...profile,
        moderation: moderation
          ? {
              status: moderation.status,
              storedStatus: moderation.storedStatus,
              uniqueReporters: moderation.uniqueReporters,
              totalReports: moderation.totalReports,
              reasons: moderation.reasons,
              lastReportedAt: moderation.lastReportedAt,
              reviewedThrough: moderation.reviewedThrough
            }
          : null
      }
    };
    // Viewing account-level support data is more sensitive than aggregate analytics. Keep an audit
    // record of the exact player whose card was opened, but never duplicate the card contents.
    this.adminAuth.audit({
      actor,
      action: 'player.support.view',
      targetType: 'player-account',
      targetId: profile.account.id,
      now
    });
    return result;
  }

  moderationQueue({ status = 'open', limit = 50 } = {}) {
    return this.moderation.queue({ status, limit });
  }

  moderationCase(targetAccountId) {
    return this.#decorateCase(this.moderation.get(targetAccountId));
  }

  moderationTransition({ targetAccountId, status, note, expectedRevision, actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    const result = this.moderation.transition({
      targetAccountId,
      status,
      moderatorId: `${ADMIN_MODERATOR_PREFIX}${actor.id}`,
      note,
      expectedRevision,
      rejectSameStatus: true,
      now,
      audit: transition =>
        this.adminAuth.audit({
          actor,
          action: 'moderation.case.transition',
          targetType: 'player-account',
          targetId: transition.targetAccountId,
          detail: {
            fromStatus: transition.fromStatus,
            toStatus: transition.toStatus,
            reviewedThrough: transition.reviewedThrough,
            notePresent: Boolean(transition.note)
          },
          now: transition.createdAt
        })
    });
    if (!result.ok) {
      return result.case ? { ...result, case: this.#decorateCase(result.case) } : result;
    }
    return { ...result, case: this.#decorateCase(result.case) };
  }

  #adminName(moderatorId) {
    const value = String(moderatorId || '');
    if (!value.startsWith(ADMIN_MODERATOR_PREFIX)) return null;
    const id = value.slice(ADMIN_MODERATOR_PREFIX.length);
    return this.statements.adminName.get(id)?.display_name || null;
  }

  #decorateCase(item) {
    if (!item) return null;
    return {
      ...item,
      moderatorName: this.#adminName(item.moderatorId),
      history: item.history.map(event => ({
        ...event,
        moderatorName: this.#adminName(event.moderatorId)
      }))
    };
  }
}

function prepare(db) {
  return {
    accountCount: db.prepare('SELECT COUNT(*) AS count FROM accounts'),
    activeAccounts: db.prepare(`
      SELECT COUNT(DISTINCT account_id) AS count
      FROM account_sessions
      WHERE last_seen_at >= ? AND expires_at > ?
    `),
    reports24h: db.prepare(`
      SELECT COALESCE(SUM(occurrences), 0) AS count
      FROM social_report_evidence
      WHERE reported_at >= ?
    `),
    competitiveRecords: db.prepare('SELECT COUNT(*) AS count FROM leaderboard_entries'),
    adminName: db.prepare('SELECT display_name FROM admin_users WHERE id = ?')
  };
}

module.exports = { AdminControlService, ADMIN_MODERATOR_PREFIX };
