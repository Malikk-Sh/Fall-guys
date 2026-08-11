'use strict';

const MAX_SEARCH_QUERY = 80;
const MAX_SEARCH_RESULTS = 50;
const DEFAULT_SEARCH_RESULTS = 20;
const MAX_RECENT_PARTNERS = 12;
const MAX_RECENT_REWARDS = 50;

function hasAsciiControl(value) {
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeSearchQuery(value) {
  const raw = String(value || '');
  const text = raw.normalize('NFKC').trim();
  if (text.length < 2 || text.length > MAX_SEARCH_QUERY || hasAsciiControl(raw)) return null;
  return text;
}

function clampLimit(value, fallback = DEFAULT_SEARCH_RESULTS) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_SEARCH_RESULTS);
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, match => `\\${match}`);
}

function nullableNumber(value) {
  return value == null ? null : Number(value);
}

class AdminPlayerSupport {
  constructor({ db } = {}) {
    if (!db) throw new Error('AdminPlayerSupport requires an open database');
    this.db = db;
    this.statements = prepare(db);
  }

  search(query, { limit = DEFAULT_SEARCH_RESULTS, now = Date.now() } = {}) {
    const normalized = normalizeSearchQuery(query);
    if (!normalized) {
      return {
        ok: false,
        reason: 'invalid-query',
        minLength: 2,
        maxLength: MAX_SEARCH_QUERY
      };
    }
    const safeLimit = clampLimit(limit);
    const like = `%${escapeLike(normalized)}%`;
    const prefix = `${escapeLike(normalized)}%`;
    const rows = this.statements.search.all(
      now,
      normalized,
      prefix,
      like,
      normalized,
      normalized,
      safeLimit
    );
    return {
      ok: true,
      query: normalized,
      results: rows.map(row => ({
        id: row.id,
        name: row.display_name,
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        activeSessions: Number(row.active_sessions || 0),
        hasExternalLogin: Boolean(row.has_external_login)
      }))
    };
  }

  get(accountId, { now = Date.now() } = {}) {
    const id = String(accountId || '').trim();
    if (!id || id.length > 160 || hasAsciiControl(id)) return null;
    const account = this.statements.account.get(id);
    if (!account) return null;

    const session = this.statements.sessions.get(now, now, now, now, id);
    const stats = this.statements.stats.get(id);
    const loadout = this.statements.loadout.get(id);
    const reportSummary = this.statements.reportSummary.get(id);
    const reportsSubmitted = this.statements.reportsSubmitted.get(id);
    const avoidCount = this.statements.avoidCount.get(id, id);

    return {
      account: {
        id: account.id,
        name: account.display_name,
        createdAt: Number(account.created_at),
        lastSeenAt: Number(account.last_seen_at),
        recoveryRotationPending: account.pending_secret_created_at != null,
        recoveryRotationStartedAt: nullableNumber(account.pending_secret_created_at)
      },
      login: {
        providers: this.statements.identities.all(id).map(row => ({
          provider: row.provider,
          linkedAt: Number(row.linked_at)
        })),
        sessions: {
          active: Number(session?.active_count || 0),
          totalStored: Number(session?.stored_count || 0),
          latestSeenAt: nullableNumber(session?.latest_seen_at),
          oldestActiveCreatedAt: nullableNumber(session?.oldest_active_created_at),
          soonestActiveExpiresAt: nullableNumber(session?.soonest_active_expires_at)
        }
      },
      progress: {
        stats: {
          coopMatchesCompleted: Number(stats?.coop_matches_completed || 0),
          coopChaptersCompleted: Number(stats?.coop_chapters_completed || 0),
          coopRevives: Number(stats?.coop_revives || 0),
          updatedAt: nullableNumber(stats?.updated_at)
        },
        chapters: this.statements.chapters.all(id).map(row => ({
          chapterId: row.chapter_id,
          completions: Number(row.completions || 0),
          bestTimeMs: Number(row.best_time_ms || 0),
          revives: Number(row.revives || 0),
          flawless: Boolean(row.flawless),
          lastCompletedAt: Number(row.last_completed_at || 0)
        })),
        achievements: this.statements.achievements.all(id).map(row => ({
          id: row.achievement_id,
          unlockedAt: Number(row.unlocked_at)
        })),
        personalRecords: this.statements.records.all(id).map(row => ({
          mode: row.mode,
          courseKey: row.course_key,
          timeMs: Number(row.time_ms),
          achievedAt: Number(row.achieved_at)
        }))
      },
      inventory: {
        loadout: loadout
          ? {
              body: loadout.body,
              visor: loadout.visor || null,
              antenna: loadout.antenna || null,
              trail: loadout.trail || null,
              finish: loadout.finish || null,
              updatedAt: Number(loadout.updated_at)
            }
          : null,
        cosmetics: this.statements.cosmetics.all(id).map(row => ({
          id: row.cosmetic_id,
          unlockedAt: Number(row.unlocked_at),
          source: row.source
        })),
        recentRewards: this.statements.rewards.all(id, MAX_RECENT_REWARDS).map(row => ({
          source: row.source,
          reward: row.reward,
          cosmeticId: row.cosmetic_id || null,
          grantedAt: Number(row.granted_at),
          dayKey: row.day_key
        }))
      },
      social: {
        recentPartners: this.statements.partners.all(id, id, MAX_RECENT_PARTNERS).map(row => ({
          id: row.partner_account_id,
          name: row.display_name || 'Wobbler',
          matchesTogether: Number(row.matches_together || 0),
          lastChapterId: row.last_chapter_id,
          lastPlayedAt: Number(row.last_played_at),
          avoidedByThisPlayer: row.own_avoided_at != null
        })),
        avoidedByThisPlayer: Number(avoidCount?.count || 0),
        reportsReceived: {
          reporters: Number(reportSummary?.reporters || 0),
          total: Number(reportSummary?.total || 0),
          lastReportedAt: nullableNumber(reportSummary?.last_reported_at),
          reasons: this.statements.reportReasons.all(id).map(row => ({
            reason: row.reason,
            count: Number(row.count || 0)
          }))
        },
        reportsSubmitted: Number(reportsSubmitted?.count || 0)
      }
    };
  }
}

function prepare(db) {
  return {
    search: db.prepare(`
      WITH candidates AS (
        SELECT
          a.id AS id,
          a.display_name AS display_name,
          a.created_at AS created_at,
          a.last_seen_at AS last_seen_at,
          SUM(CASE WHEN s.expires_at > ? THEN 1 ELSE 0 END) AS active_sessions,
          EXISTS(SELECT 1 FROM account_identities ai WHERE ai.account_id = a.id) AS has_external_login
        FROM accounts a
        LEFT JOIN account_sessions s ON s.account_id = a.id
        WHERE a.id = ?
           OR a.id LIKE ? ESCAPE '\\'
           OR a.display_name LIKE ? ESCAPE '\\'
        GROUP BY a.id, a.display_name, a.created_at, a.last_seen_at
      )
      SELECT id, display_name, created_at, last_seen_at, active_sessions, has_external_login
      FROM candidates
      ORDER BY
        CASE
          WHEN id = ? THEN 0
          WHEN display_name = ? COLLATE NOCASE THEN 1
          ELSE 2
        END,
        last_seen_at DESC,
        id ASC
      LIMIT ?
    `),
    account: db.prepare(`
      SELECT id, display_name, created_at, last_seen_at, pending_secret_created_at
      FROM accounts
      WHERE id = ?
    `),
    identities: db.prepare(`
      SELECT provider, MIN(created_at) AS linked_at
      FROM account_identities
      WHERE account_id = ?
      GROUP BY provider
      ORDER BY provider ASC
    `),
    sessions: db.prepare(`
      SELECT
        COUNT(*) AS stored_count,
        SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS active_count,
        MAX(CASE WHEN expires_at > ? THEN last_seen_at ELSE NULL END) AS latest_seen_at,
        MIN(CASE WHEN expires_at > ? THEN created_at ELSE NULL END) AS oldest_active_created_at,
        MIN(CASE WHEN expires_at > ? THEN expires_at ELSE NULL END) AS soonest_active_expires_at
      FROM account_sessions
      WHERE account_id = ?
    `),
    stats: db.prepare(`
      SELECT coop_matches_completed, coop_chapters_completed, coop_revives, updated_at
      FROM account_stats
      WHERE account_id = ?
    `),
    chapters: db.prepare(`
      SELECT chapter_id, completions, best_time_ms, revives, flawless, last_completed_at
      FROM chapter_progress
      WHERE account_id = ?
      ORDER BY CAST(SUBSTR(chapter_id, 3) AS INTEGER) ASC, chapter_id ASC
    `),
    achievements: db.prepare(`
      SELECT achievement_id, unlocked_at
      FROM achievements
      WHERE account_id = ?
      ORDER BY unlocked_at DESC, achievement_id ASC
    `),
    records: db.prepare(`
      SELECT mode, course_key, time_ms, achieved_at
      FROM personal_records
      WHERE account_id = ?
      ORDER BY achieved_at DESC, mode ASC, course_key ASC
    `),
    cosmetics: db.prepare(`
      SELECT cosmetic_id, unlocked_at, source
      FROM account_cosmetics
      WHERE account_id = ?
      ORDER BY unlocked_at DESC, cosmetic_id ASC
    `),
    loadout: db.prepare(`
      SELECT body, visor, antenna, trail, finish, updated_at
      FROM account_loadout
      WHERE account_id = ?
    `),
    rewards: db.prepare(`
      SELECT source, reward, cosmetic_id, granted_at, day_key
      FROM reward_grants
      WHERE account_id = ?
      ORDER BY granted_at DESC, source ASC
      LIMIT ?
    `),
    partners: db.prepare(`
      SELECT
        rp.partner_account_id,
        a.display_name,
        rp.matches_together,
        rp.last_chapter_id,
        rp.last_played_at,
        CASE
          WHEN ma.account_a = ? THEN ma.account_a_avoided_at
          ELSE ma.account_b_avoided_at
        END AS own_avoided_at
      FROM recent_partners rp
      LEFT JOIN accounts a ON a.id = rp.partner_account_id
      LEFT JOIN matchmaking_avoids ma
        ON ma.account_a = MIN(rp.account_id, rp.partner_account_id)
       AND ma.account_b = MAX(rp.account_id, rp.partner_account_id)
      WHERE rp.account_id = ?
      ORDER BY rp.last_played_at DESC, rp.partner_account_id ASC
      LIMIT ?
    `),
    avoidCount: db.prepare(`
      SELECT COUNT(*) AS count
      FROM matchmaking_avoids
      WHERE (account_a = ? AND account_a_avoided_at IS NOT NULL)
         OR (account_b = ? AND account_b_avoided_at IS NOT NULL)
    `),
    reportSummary: db.prepare(`
      SELECT
        COUNT(DISTINCT reporter_account_id) AS reporters,
        COALESCE(SUM(report_count), 0) AS total,
        MAX(last_reported_at) AS last_reported_at
      FROM social_reports
      WHERE target_account_id = ?
    `),
    reportReasons: db.prepare(`
      SELECT reason, SUM(report_count) AS count
      FROM social_reports
      WHERE target_account_id = ?
      GROUP BY reason
      ORDER BY count DESC, reason ASC
    `),
    reportsSubmitted: db.prepare(`
      SELECT COALESCE(SUM(report_count), 0) AS count
      FROM social_reports
      WHERE reporter_account_id = ?
    `)
  };
}

module.exports = {
  AdminPlayerSupport,
  MAX_SEARCH_QUERY,
  MAX_SEARCH_RESULTS,
  normalizeSearchQuery,
  clampLimit,
  escapeLike
};
