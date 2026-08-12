'use strict';

const { AdminAnalytics } = require('./adminAnalytics');
const { AdminPlayerSupport } = require('./adminPlayerSupport');
const { ModerationQueue } = require('./moderation');
const { safeName: safeAccountName, MAX_NAME: MAX_PLAYER_NAME } = require('./accounts');

const ADMIN_MODERATOR_PREFIX = 'admin:';
const DAY_MS = 24 * 60 * 60 * 1000;
const MODERATOR_MAX_BAN_MS = 7 * DAY_MS;
const OWNER_MAX_BAN_MS = 365 * DAY_MS;
const MAX_SUPPORT_NOTE = 300;

function normalizeSupportNote(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 3 && text.length <= MAX_SUPPORT_NOTE ? text : null;
}

function normalizeRequestedPlayerName(value) {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > MAX_PLAYER_NAME) return null;
  return safeAccountName(normalized) === normalized ? normalized : null;
}

class AdminControlService {
  constructor({
    db,
    health,
    gameplay,
    adminAuth,
    sanctions = null,
    auth = null,
    accounts = null,
    disconnectAccount = null,
    connectionCount = null,
    revokeReconnectSessions = null
  } = {}) {
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
    this.sanctions = sanctions;
    this.auth = auth;
    this.accounts = accounts;
    this.disconnectAccount = typeof disconnectAccount === 'function' ? disconnectAccount : null;
    this.connectionCount = typeof connectionCount === 'function' ? connectionCount : null;
    this.revokeReconnectSessions =
      typeof revokeReconnectSessions === 'function' ? revokeReconnectSessions : null;
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
          : null,
        sanctions: this.#sanctionContext(profile.account.id, now),
        live: {
          sockets: Number(this.connectionCount?.(profile.account.id) || 0)
        }
      }
    };
    this.adminAuth.audit({
      actor,
      action: 'player.support.view',
      targetType: 'player-account',
      targetId: profile.account.id,
      now
    });
    return result;
  }

  playerLogout({ targetAccountId, note, actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'operator'].includes(actor.role)) return { ok: false, reason: 'support-action-forbidden' };
    if (!this.auth) return { ok: false, reason: 'player-support-actions-unavailable' };
    const id = String(targetAccountId || '').trim();
    if (!id || !this.statements.accountName.get(id)) return { ok: false, reason: 'unknown-account' };
    const internalNote = normalizeSupportNote(note);
    if (!internalNote) return { ok: false, reason: 'invalid-support-note', maxLength: MAX_SUPPORT_NOTE };

    let revokedSessions = 0;
    let revokedSocketTickets = 0;
    let revokedReconnectSessions = 0;
    let disconnectedSockets = 0;
    const failedSteps = [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      revokedSessions = Number(this.auth.revokeAccountSessions(id) || 0);
      try {
        if (typeof this.auth.revokeAccountSocketTickets !== 'function') {
          throw new Error('socket-ticket revocation unavailable');
        }
        revokedSocketTickets = Number(this.auth.revokeAccountSocketTickets(id) || 0);
      } catch {
        failedSteps.push('socket-tickets');
      }
      try {
        if (!this.revokeReconnectSessions) throw new Error('reconnect-session revocation unavailable');
        revokedReconnectSessions = Number(this.revokeReconnectSessions(id) || 0);
      } catch {
        failedSteps.push('reconnect-sessions');
      }
      try {
        if (!this.disconnectAccount) throw new Error('socket disconnection unavailable');
        disconnectedSockets = Number(
          this.disconnectAccount(id, { code: 4004, reason: 'support-logout' }) || 0
        );
      } catch {
        failedSteps.push('active-sockets');
      }

      this.adminAuth.audit({
        actor,
        action: 'player.support.logout',
        targetType: 'player-account',
        targetId: id,
        detail: {
          note: internalNote,
          revokedSessions,
          revokedSocketTickets,
          revokedReconnectSessions,
          disconnectedSockets,
          complete: failedSteps.length === 0,
          failedSteps
        },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const result = {
      accountId: id,
      revokedSessions,
      revokedSocketTickets,
      revokedReconnectSessions,
      disconnectedSockets
    };
    return failedSteps.length
      ? { ok: false, reason: 'support-logout-incomplete', ...result, failedSteps }
      : { ok: true, ...result };
  }

  playerRename({ targetAccountId, name, note, actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'moderator'].includes(actor.role))
      return { ok: false, reason: 'support-action-forbidden' };
    if (!this.accounts || typeof this.accounts.rename !== 'function') {
      return { ok: false, reason: 'player-support-actions-unavailable' };
    }
    const id = String(targetAccountId || '').trim();
    const account = id ? this.statements.accountName.get(id) : null;
    if (!account) return { ok: false, reason: 'unknown-account' };
    const requestedName = normalizeRequestedPlayerName(name);
    if (!requestedName) {
      return { ok: false, reason: 'invalid-player-name', maxLength: MAX_PLAYER_NAME };
    }
    const internalNote = normalizeSupportNote(note);
    if (!internalNote) return { ok: false, reason: 'invalid-support-note', maxLength: MAX_SUPPORT_NOTE };
    if (account.display_name === requestedName) {
      return { ok: false, reason: 'no-change', name: requestedName };
    }

    let updatedName;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      updatedName = this.accounts.rename(id, requestedName);
      this.adminAuth.audit({
        actor,
        action: 'player.support.rename',
        targetType: 'player-account',
        targetId: id,
        detail: { fromName: account.display_name, toName: updatedName, note: internalNote },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, accountId: id, previousName: account.display_name, name: updatedName };
  }

  moderationQueue({ status = 'open', limit = 50 } = {}) {
    return this.moderation.queue({ status, limit });
  }

  moderationCase(targetAccountId, { now = Date.now() } = {}) {
    const item = this.#decorateCase(this.moderation.get(targetAccountId));
    return item ? { ...item, sanctions: this.#sanctionContext(targetAccountId, now) } : null;
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
      return result.case
        ? {
            ...result,
            case: {
              ...this.#decorateCase(result.case),
              sanctions: this.#sanctionContext(targetAccountId, now)
            }
          }
        : result;
    }
    return {
      ...result,
      case: {
        ...this.#decorateCase(result.case),
        sanctions: this.#sanctionContext(targetAccountId, now)
      }
    };
  }

  sanctionApply({
    targetAccountId,
    kind,
    reason,
    note,
    durationMs = null,
    permanent = false,
    actor,
    now = Date.now()
  } = {}) {
    if (!this.sanctions) return { ok: false, reason: 'sanctions-unavailable' };
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'moderator'].includes(actor.role)) return { ok: false, reason: 'sanctions-forbidden' };

    const normalizedKind = String(kind || '').trim();
    const isPermanent = normalizedKind === 'ban' && permanent === true;
    const duration = durationMs == null ? null : Number(durationMs);
    if (isPermanent && actor.role !== 'owner') {
      return { ok: false, reason: 'permanent-sanction-owner-only' };
    }
    if (normalizedKind === 'ban' && !isPermanent) {
      const max = actor.role === 'owner' ? OWNER_MAX_BAN_MS : MODERATOR_MAX_BAN_MS;
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > max) {
        return { ok: false, reason: 'sanction-duration-forbidden', maxDurationMs: max };
      }
    }

    const result = this.sanctions.apply({
      accountId: targetAccountId,
      kind: normalizedKind,
      reason,
      note,
      createdByAdminId: actor.id,
      durationMs: duration,
      permanent: isPermanent,
      now,
      audit: sanction =>
        this.adminAuth.audit({
          actor,
          action: 'player.sanction.apply',
          targetType: 'player-account',
          targetId: sanction.accountId,
          detail: {
            sanctionId: sanction.id,
            kind: sanction.kind,
            reason: sanction.reason,
            permanent: sanction.permanent,
            expiresAt: sanction.expiresAt,
            notePresent: true
          },
          now: sanction.createdAt
        })
    });
    if (!result.ok) return result;

    let revokedSessions = 0;
    let disconnectedSockets = 0;
    if (result.sanction.kind === 'ban') {
      try {
        revokedSessions = Number(this.auth?.revokeAccountSessions?.(result.sanction.accountId) || 0);
      } catch {
        revokedSessions = 0;
      }
      try {
        disconnectedSockets = Number(this.disconnectAccount?.(result.sanction.accountId) || 0);
      } catch {
        disconnectedSockets = 0;
      }
    }
    return {
      ...result,
      sanction: this.#decorateSanction(result.sanction),
      revokedSessions,
      disconnectedSockets
    };
  }

  sanctionRevoke({ sanctionId, note, actor, now = Date.now() } = {}) {
    if (!this.sanctions) return { ok: false, reason: 'sanctions-unavailable' };
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'moderator'].includes(actor.role)) return { ok: false, reason: 'sanctions-forbidden' };
    const current = this.sanctions.get(sanctionId, { now });
    if (!current) return { ok: false, reason: 'unknown-sanction' };
    if (current.permanent && actor.role !== 'owner') {
      return { ok: false, reason: 'permanent-sanction-owner-only' };
    }
    const result = this.sanctions.revoke({
      sanctionId,
      revokedByAdminId: actor.id,
      note,
      now,
      audit: ({ before, after }) =>
        this.adminAuth.audit({
          actor,
          action: 'player.sanction.revoke',
          targetType: 'player-account',
          targetId: before.accountId,
          detail: {
            sanctionId: before.id,
            permanent: before.permanent,
            previousExpiresAt: before.expiresAt,
            notePresent: Boolean(after.revokeNote)
          },
          now: after.revokedAt
        })
    });
    return result.ok ? { ...result, sanction: this.#decorateSanction(result.sanction) } : result;
  }

  #sanctionContext(accountId, now = Date.now()) {
    if (!this.sanctions) return { active: null, history: [] };
    return {
      active: this.#decorateSanction(this.sanctions.active(accountId, { now })),
      history: this.sanctions.history(accountId, { now }).map(item => this.#decorateSanction(item))
    };
  }

  #adminName(adminId) {
    const id = String(adminId || '');
    if (!id) return null;
    return this.statements.adminName.get(id)?.display_name || null;
  }

  #moderatorName(moderatorId) {
    const value = String(moderatorId || '');
    if (!value.startsWith(ADMIN_MODERATOR_PREFIX)) return null;
    return this.#adminName(value.slice(ADMIN_MODERATOR_PREFIX.length));
  }

  #decorateSanction(item) {
    if (!item) return null;
    return {
      ...item,
      createdByName: this.#adminName(item.createdByAdminId),
      revokedByName: this.#adminName(item.revokedByAdminId)
    };
  }

  #decorateCase(item) {
    if (!item) return null;
    return {
      ...item,
      moderatorName: this.#moderatorName(item.moderatorId),
      history: item.history.map(event => ({
        ...event,
        moderatorName: this.#moderatorName(event.moderatorId)
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
    adminName: db.prepare('SELECT display_name FROM admin_users WHERE id = ?'),
    accountName: db.prepare('SELECT display_name FROM accounts WHERE id = ?')
  };
}

module.exports = {
  AdminControlService,
  ADMIN_MODERATOR_PREFIX,
  MODERATOR_MAX_BAN_MS,
  OWNER_MAX_BAN_MS,
  MAX_SUPPORT_NOTE,
  normalizeSupportNote,
  normalizeRequestedPlayerName
};
