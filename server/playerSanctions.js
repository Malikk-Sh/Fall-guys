'use strict';

const { migrateDatabase } = require('./migrations');

const SANCTION_KINDS = Object.freeze(['warning', 'ban']);
const SANCTION_REASONS = Object.freeze(['afk', 'griefing', 'offensive-name', 'exploit-cheat', 'other']);
const MAX_NOTE = 1000;
const MIN_TEMP_BAN_MS = 60 * 1000;
const MAX_TEMP_BAN_MS = 365 * 24 * 60 * 60 * 1000;

function normalizeKind(value) {
  const kind = String(value || '').trim();
  return SANCTION_KINDS.includes(kind) ? kind : null;
}

function normalizeReason(value) {
  const reason = String(value || '').trim();
  return SANCTION_REASONS.includes(reason) ? reason : null;
}

function normalizeNote(value) {
  const text = String(value || '').trim();
  if (!text || text.length > MAX_NOTE || text.includes(String.fromCharCode(0))) return null;
  return text;
}

function normalizeDuration(value) {
  const duration = Number(value);
  if (!Number.isSafeInteger(duration) || duration < MIN_TEMP_BAN_MS || duration > MAX_TEMP_BAN_MS) return null;
  return duration;
}

function clampLimit(value, fallback = 50) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, 200);
}

function toSanction(row, now = Date.now()) {
  if (!row) return null;
  const expiresAt = row.expires_at == null ? null : Number(row.expires_at);
  const revokedAt = row.revoked_at == null ? null : Number(row.revoked_at);
  const kind = row.kind;
  const active = kind === 'ban' && revokedAt == null && (expiresAt == null || expiresAt > now);
  return {
    id: Number(row.id),
    accountId: row.account_id,
    kind,
    reason: row.reason,
    note: row.note,
    createdByAdminId: row.created_by_admin_id,
    createdAt: Number(row.created_at),
    expiresAt,
    permanent: kind === 'ban' && expiresAt == null,
    active,
    status:
      kind === 'warning'
        ? 'warning'
        : revokedAt != null
          ? 'revoked'
          : active
            ? 'active'
            : 'expired',
    revokedAt,
    revokedByAdminId: row.revoked_by_admin_id || null,
    revokeNote: row.revoke_note || null
  };
}

class PlayerSanctions {
  constructor({ db } = {}) {
    if (!db) throw new Error('PlayerSanctions requires an open database');
    this.db = db;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  active(accountId, { now = Date.now() } = {}) {
    const id = String(accountId || '').trim();
    if (!id) return null;
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    return toSanction(this.statements.active.get(id, at), at);
  }

  get(sanctionId, { now = Date.now() } = {}) {
    const id = Number(sanctionId);
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return toSanction(this.statements.byId.get(id), now);
  }

  history(accountId, { limit = 50, now = Date.now() } = {}) {
    const id = String(accountId || '').trim();
    if (!id) return [];
    return this.statements.history.all(id, clampLimit(limit)).map(row => toSanction(row, now));
  }

  apply({ accountId, kind, reason, note, createdByAdminId, durationMs = null, permanent = false, now = Date.now(), audit = null } = {}) {
    const id = String(accountId || '').trim();
    const normalizedKind = normalizeKind(kind);
    const normalizedReason = normalizeReason(reason);
    const normalizedNote = normalizeNote(note);
    const adminId = String(createdByAdminId || '').trim();
    if (!id || !this.statements.account.get(id)) return { ok: false, reason: 'unknown-account' };
    if (!normalizedKind) return { ok: false, reason: 'invalid-sanction-kind', allowedKinds: SANCTION_KINDS };
    if (!normalizedReason) return { ok: false, reason: 'invalid-sanction-reason', allowedReasons: SANCTION_REASONS };
    if (!normalizedNote) return { ok: false, reason: 'sanction-note-required' };
    if (!adminId || !this.statements.admin.get(adminId)) return { ok: false, reason: 'invalid-admin-actor' };
    if (audit != null && typeof audit !== 'function') return { ok: false, reason: 'invalid-audit-hook' };

    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    let expiresAt = null;
    if (normalizedKind === 'warning') {
      if (permanent || durationMs != null) return { ok: false, reason: 'warning-has-no-duration' };
    } else if (!permanent) {
      const duration = normalizeDuration(durationMs);
      if (duration == null) return { ok: false, reason: 'invalid-sanction-duration' };
      expiresAt = at + duration;
    }

    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      if (normalizedKind === 'ban' && this.active(id, { now: at })) {
        this.db.exec('ROLLBACK');
        inTransaction = false;
        return { ok: false, reason: 'active-ban-exists', active: this.active(id, { now: at }) };
      }
      const inserted = this.statements.insert.run(
        id,
        normalizedKind,
        normalizedReason,
        normalizedNote,
        adminId,
        at,
        expiresAt
      );
      const sanction = toSanction(this.statements.byId.get(Number(inserted.lastInsertRowid)), at);
      if (audit) audit(sanction);
      this.db.exec('COMMIT');
      inTransaction = false;
      return { ok: true, sanction };
    } catch (error) {
      if (inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  revoke({ sanctionId, revokedByAdminId, note, now = Date.now(), audit = null } = {}) {
    const id = Number(sanctionId);
    const adminId = String(revokedByAdminId || '').trim();
    const normalizedNote = normalizeNote(note);
    if (!Number.isSafeInteger(id) || id < 1) return { ok: false, reason: 'invalid-sanction' };
    if (!adminId || !this.statements.admin.get(adminId)) return { ok: false, reason: 'invalid-admin-actor' };
    if (!normalizedNote) return { ok: false, reason: 'revoke-note-required' };
    if (audit != null && typeof audit !== 'function') return { ok: false, reason: 'invalid-audit-hook' };
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();

    let inTransaction = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      const current = toSanction(this.statements.byId.get(id), at);
      if (!current) {
        this.db.exec('ROLLBACK');
        inTransaction = false;
        return { ok: false, reason: 'unknown-sanction' };
      }
      if (current.kind !== 'ban' || !current.active) {
        this.db.exec('ROLLBACK');
        inTransaction = false;
        return { ok: false, reason: 'sanction-not-active', sanction: current };
      }
      this.statements.revoke.run(at, adminId, normalizedNote, id);
      const sanction = toSanction(this.statements.byId.get(id), at);
      if (audit) audit({ before: current, after: sanction });
      this.db.exec('COMMIT');
      inTransaction = false;
      return { ok: true, sanction };
    } catch (error) {
      if (inTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  publicView(sanction) {
    const item = sanction?.accountId ? sanction : this.get(sanction?.id || sanction);
    if (!item || item.kind !== 'ban' || !item.active) return null;
    return {
      reason: item.reason,
      expiresAt: item.expiresAt,
      permanent: item.permanent
    };
  }
}

function prepare(db) {
  const select = `
    SELECT
      id, account_id, kind, reason, note, created_by_admin_id, created_at, expires_at,
      revoked_at, revoked_by_admin_id, revoke_note
    FROM player_sanctions
  `;
  return {
    account: db.prepare('SELECT id FROM accounts WHERE id = ?'),
    admin: db.prepare('SELECT id FROM admin_users WHERE id = ?'),
    active: db.prepare(`
      ${select}
      WHERE account_id = ?
        AND kind = 'ban'
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY expires_at IS NOT NULL, created_at DESC, id DESC
      LIMIT 1
    `),
    byId: db.prepare(`${select} WHERE id = ?`),
    history: db.prepare(`${select} WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),
    insert: db.prepare(`
      INSERT INTO player_sanctions
        (account_id, kind, reason, note, created_by_admin_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    revoke: db.prepare(`
      UPDATE player_sanctions
      SET revoked_at = ?, revoked_by_admin_id = ?, revoke_note = ?
      WHERE id = ? AND revoked_at IS NULL
    `)
  };
}

module.exports = {
  PlayerSanctions,
  SANCTION_KINDS,
  SANCTION_REASONS,
  MAX_NOTE,
  MIN_TEMP_BAN_MS,
  MAX_TEMP_BAN_MS,
  normalizeKind,
  normalizeReason,
  normalizeNote,
  normalizeDuration
};
