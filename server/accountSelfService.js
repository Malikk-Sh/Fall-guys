'use strict';

const crypto = require('crypto');
const { generateCode, normalizeCode } = require('./accounts');

function recoveryHash(secret) {
  const normalized = normalizeCode(secret);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

class AccountSelfService {
  constructor({ db, auth } = {}) {
    if (!db) throw new Error('AccountSelfService требует открытую базу');
    if (!auth) throw new Error('AccountSelfService требует AuthService');
    this.db = db;
    this.auth = auth;
    this.account = db.prepare('SELECT id FROM accounts WHERE id = ?');
    this.rotate = db.prepare('UPDATE accounts SET secret_hash = ?, last_seen_at = ? WHERE id = ?');
  }

  rotateRecoveryCode({ accountId, currentToken, now = Date.now() } = {}) {
    const id = String(accountId || '');
    if (!id || !this.account.get(id)) return null;
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const secret = generateCode();
    const hash = recoveryHash(secret);
    if (!hash) throw new Error('Не удалось подготовить новый recovery code');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.rotate.run(hash, at, id);
      const revokedSessions = this.auth.revokeOtherSessions(id, currentToken);
      this.db.exec('COMMIT');
      return { secret, revokedSessions };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = { AccountSelfService, recoveryHash };
