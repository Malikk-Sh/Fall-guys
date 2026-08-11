'use strict';

const { ModerationQueue } = require('./moderation');

class AdminControlService {
  constructor({ db, health, gameplay } = {}) {
    if (!db) throw new Error('AdminControlService requires an open database');
    if (typeof health !== 'function') throw new Error('AdminControlService requires health()');
    if (!gameplay || typeof gameplay.summary !== 'function') {
      throw new Error('AdminControlService requires GameplayMetrics');
    }
    this.db = db;
    this.health = health;
    this.gameplay = gameplay;
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

  analytics({ days = 7, limit = 200 } = {}) {
    return this.gameplay.summary({ days, limit });
  }

  moderationQueue({ status = 'open', limit = 50 } = {}) {
    return this.moderation.queue({ status, limit });
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
    competitiveRecords: db.prepare('SELECT COUNT(*) AS count FROM leaderboard_entries')
  };
}

module.exports = { AdminControlService };
