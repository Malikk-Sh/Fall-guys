'use strict';

const crypto = require('crypto');
const { generateCode, normalizeCode } = require('./accounts');

const RECOVERY_ROTATION_TTL_MS = 15 * 60 * 1000;

function recoveryHash(secret) {
  const normalized = normalizeCode(secret);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

class AccountSelfService {
  constructor({ db, auth, rotationTtlMs = RECOVERY_ROTATION_TTL_MS } = {}) {
    if (!db) throw new Error('AccountSelfService требует открытую базу');
    if (!auth) throw new Error('AccountSelfService требует AuthService');
    this.db = db;
    this.auth = auth;
    this.rotationTtlMs = rotationTtlMs;
    this.account = db.prepare(`
      SELECT id, secret_hash, pending_secret_hash, pending_secret_created_at
      FROM accounts
      WHERE id = ?
    `);
    this.prepare = db.prepare(`
      UPDATE accounts
      SET pending_secret_hash = ?, pending_secret_created_at = ?
      WHERE id = ?
    `);
    this.clearPending = db.prepare(`
      UPDATE accounts
      SET pending_secret_hash = NULL, pending_secret_created_at = NULL
      WHERE id = ? AND pending_secret_hash = ?
    `);
    this.promote = db.prepare(`
      UPDATE accounts
      SET
        secret_hash = pending_secret_hash,
        pending_secret_hash = NULL,
        pending_secret_created_at = NULL,
        last_seen_at = ?
      WHERE id = ? AND pending_secret_hash = ?
    `);
  }

  prepareRecoveryCode({ accountId, now = Date.now() } = {}) {
    const id = String(accountId || '');
    if (!id || !this.account.get(id)) return null;
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const secret = generateCode();
    const hash = recoveryHash(secret);
    if (!hash) throw new Error('Не удалось подготовить новый recovery code');
    this.prepare.run(hash, at, id);
    return { secret, expiresAt: at + this.rotationTtlMs };
  }

  confirmRecoveryCode({ accountId, currentToken, secret, now = Date.now() } = {}) {
    const id = String(accountId || '');
    const hash = recoveryHash(secret);
    if (!id) return { ok: false, reason: 'invalid-account' };
    if (!hash) return { ok: false, reason: 'invalid-code' };
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const row = this.account.get(id);
    if (!row) return { ok: false, reason: 'unknown-account' };

    // Повтор confirm после потерянного HTTP-ответа безопасен: если новый hash уже активен,
    // клиенту достаточно получить подтверждение, ничего повторно менять не нужно.
    if (row.secret_hash === hash) {
      return { ok: true, confirmed: true, alreadyConfirmed: true, revokedSessions: 0 };
    }

    if (!row.pending_secret_hash) return { ok: false, reason: 'rotation-not-prepared' };
    if (row.pending_secret_hash !== hash) return { ok: false, reason: 'rotation-mismatch' };
    const preparedAt = Number(row.pending_secret_created_at || 0);
    if (!preparedAt || at - preparedAt > this.rotationTtlMs) {
      this.clearPending.run(id, hash);
      return { ok: false, reason: 'rotation-expired' };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const promoted = this.promote.run(at, id, hash).changes;
      if (promoted !== 1) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'rotation-mismatch' };
      }
      const revokedSessions = this.auth.revokeOtherSessions(id, currentToken, at);
      this.db.exec('COMMIT');
      return {
        ok: true,
        confirmed: true,
        alreadyConfirmed: false,
        revokedSessions
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = {
  AccountSelfService,
  RECOVERY_ROTATION_TTL_MS,
  recoveryHash
};
