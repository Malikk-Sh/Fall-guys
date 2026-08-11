const crypto = require('crypto');
const { migrateDatabase } = require('./migrations');

const SESSION_COOKIE = 'wobble_session';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SOCKET_TICKET_TTL_MS = 2 * 60 * 1000;
const PUBLIC_SESSION_ID_LENGTH = 24;

function hashToken(token) {
  if (typeof token !== 'string' || token.length < 24 || token.length > 256) return '';
  return crypto.createHash('sha256').update(token).digest('hex');
}

function publicSessionId(tokenHash) {
  return /^[a-f0-9]{64}$/.test(String(tokenHash || ''))
    ? String(tokenHash).slice(0, PUBLIC_SESSION_ID_LENGTH)
    : '';
}

function validPublicSessionId(value) {
  return new RegExp(`^[a-f0-9]{${PUBLIC_SESSION_ID_LENGTH}}$`).test(String(value || ''));
}

function parseCookies(header = '') {
  const result = {};
  for (const pair of String(header || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const key = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!key) continue;
    try {
      result[key] = decodeURIComponent(value);
    } catch {
      result[key] = value;
    }
  }
  return result;
}

function cookieForSession(token, { secure = true, maxAgeMs = DEFAULT_SESSION_TTL_MS } = {}) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearSessionCookie({ secure = true } = {}) {
  const attributes = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

class AuthService {
  constructor({ db, sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    if (!db) throw new Error('AuthService требует открытую базу');
    this.db = db;
    this.sessionTtlMs = sessionTtlMs;
    this.socketTickets = new Map();
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  createSession(accountId, now = Date.now()) {
    const id = String(accountId || '');
    if (!this.statements.account.get(id)) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now + this.sessionTtlMs;
    this.statements.insertSession.run(hashToken(token), id, now, now, expiresAt);
    return { token, accountId: id, expiresAt };
  }

  resolveSession(token, now = Date.now()) {
    const hash = hashToken(token);
    if (!hash) return null;
    const row = this.statements.session.get(hash);
    if (!row) return null;
    if (row.expires_at <= now) {
      this.statements.deleteSession.run(hash);
      return null;
    }
    const expiresAt = now + this.sessionTtlMs;
    this.statements.touchSession.run(now, expiresAt, hash);
    return {
      accountId: row.account_id,
      account: {
        id: row.account_id,
        name: row.display_name,
        createdAt: row.created_at
      },
      expiresAt
    };
  }

  listSessions(accountId, currentToken, now = Date.now()) {
    const id = String(accountId || '');
    if (!id || !this.statements.account.get(id)) return [];
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    this.statements.expireAccountSessions.run(id, at);
    const currentHash = hashToken(currentToken);
    return this.statements.sessions
      .all(id)
      .map(row => ({
        id: publicSessionId(row.token_hash),
        current: Boolean(currentHash && row.token_hash === currentHash),
        createdAt: Number(row.created_at),
        lastSeenAt: Number(row.last_seen_at),
        expiresAt: Number(row.expires_at)
      }))
      .sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
  }

  revokeAccountSession({ accountId, sessionId, currentToken } = {}) {
    const id = String(accountId || '');
    const requested = String(sessionId || '').trim().toLowerCase();
    if (!id || !validPublicSessionId(requested)) return { ok: false, reason: 'invalid-session' };
    const currentHash = hashToken(currentToken);
    if (currentHash && publicSessionId(currentHash) === requested) {
      return { ok: false, reason: 'current-session' };
    }
    const row = this.statements.sessionByPublicId.get(id, requested);
    if (!row) return { ok: true, removed: false };
    const removed = this.statements.deleteSessionForAccount.run(row.token_hash, id).changes > 0;
    return { ok: true, removed };
  }

  revokeOtherSessions(accountId, currentToken) {
    const id = String(accountId || '');
    const currentHash = hashToken(currentToken);
    if (!id || !currentHash) return 0;
    return this.statements.deleteOtherSessions.run(id, currentHash).changes;
  }

  createSocketTicket(accountId, now = Date.now()) {
    const id = String(accountId || '');
    if (!this.statements.account.get(id)) return null;
    this.cleanupSocketTickets(now);
    const token = `WST.${crypto.randomBytes(24).toString('base64url')}`;
    this.socketTickets.set(hashToken(token), { accountId: id, expiresAt: now + SOCKET_TICKET_TTL_MS });
    return { token, accountId: id, expiresAt: now + SOCKET_TICKET_TTL_MS };
  }

  // WST — не session и не bearer на две минуты. Он существует ровно до первого успешного
  // socket-auth. Удаляем запись ДО возврата результата: повтор того же token уже в следующем
  // синхронном вызове увидит пустой Map, поэтому replay невозможен даже в пределах TTL.
  consumeSocketTicket(token, now = Date.now()) {
    if (typeof token !== 'string' || !token.startsWith('WST.')) return null;
    const hash = hashToken(token);
    const ticket = hash ? this.socketTickets.get(hash) : null;
    if (!ticket) return null;
    this.socketTickets.delete(hash);
    if (ticket.expiresAt <= now) return null;
    return { ...ticket };
  }

  cleanupSocketTickets(now = Date.now()) {
    for (const [hash, ticket] of this.socketTickets) {
      if (ticket.expiresAt <= now) this.socketTickets.delete(hash);
    }
  }

  revokeSession(token) {
    const hash = hashToken(token);
    if (!hash) return false;
    return this.statements.deleteSession.run(hash).changes > 0;
  }

  revokeAccountSessions(accountId) {
    return this.statements.deleteAccountSessions.run(String(accountId || '')).changes;
  }

  identity(provider, subject) {
    const row = this.statements.identity.get(String(provider || ''), String(subject || ''));
    if (!row) return null;
    return { provider: row.provider, subject: row.provider_subject, accountId: row.account_id };
  }

  identities(accountId) {
    return this.statements.identities.all(String(accountId || '')).map(row => ({
      provider: row.provider,
      subject: row.provider_subject,
      createdAt: row.created_at
    }));
  }

  linkIdentity({ provider, subject, accountId, createdAt = Date.now() }) {
    const safeProvider = String(provider || '')
      .trim()
      .slice(0, 32);
    const safeSubject = String(subject || '')
      .trim()
      .slice(0, 255);
    const id = String(accountId || '');
    if (!safeProvider || !safeSubject || !this.statements.account.get(id)) return null;
    const existing = this.identity(safeProvider, safeSubject);
    if (existing) return existing.accountId === id ? existing : null;
    this.statements.insertIdentity.run(safeProvider, safeSubject, id, createdAt);
    return { provider: safeProvider, subject: safeSubject, accountId: id };
  }

  cleanup(now = Date.now()) {
    this.cleanupSocketTickets(now);
    return this.statements.expireSessions.run(now).changes;
  }
}

function prepare(db) {
  return {
    account: db.prepare('SELECT id FROM accounts WHERE id = ?'),
    insertSession: db.prepare(`
      INSERT INTO account_sessions (token_hash, account_id, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    session: db.prepare(`
      SELECT s.account_id, s.expires_at, a.display_name, a.created_at
      FROM account_sessions s
      JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?
    `),
    sessions: db.prepare(`
      SELECT token_hash, created_at, last_seen_at, expires_at
      FROM account_sessions
      WHERE account_id = ?
      ORDER BY last_seen_at DESC, created_at DESC, token_hash ASC
    `),
    touchSession: db.prepare(
      'UPDATE account_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'
    ),
    sessionByPublicId: db.prepare(`
      SELECT token_hash
      FROM account_sessions
      WHERE account_id = ? AND substr(token_hash, 1, ${PUBLIC_SESSION_ID_LENGTH}) = ?
      LIMIT 1
    `),
    deleteSession: db.prepare('DELETE FROM account_sessions WHERE token_hash = ?'),
    deleteSessionForAccount: db.prepare(
      'DELETE FROM account_sessions WHERE token_hash = ? AND account_id = ?'
    ),
    deleteOtherSessions: db.prepare(
      'DELETE FROM account_sessions WHERE account_id = ? AND token_hash <> ?'
    ),
    deleteAccountSessions: db.prepare('DELETE FROM account_sessions WHERE account_id = ?'),
    expireSessions: db.prepare('DELETE FROM account_sessions WHERE expires_at <= ?'),
    expireAccountSessions: db.prepare(
      'DELETE FROM account_sessions WHERE account_id = ? AND expires_at <= ?'
    ),
    identity: db.prepare(
      'SELECT provider, provider_subject, account_id FROM account_identities WHERE provider = ? AND provider_subject = ?'
    ),
    identities: db.prepare(
      'SELECT provider, provider_subject, created_at FROM account_identities WHERE account_id = ? ORDER BY created_at'
    ),
    insertIdentity: db.prepare(`
      INSERT INTO account_identities (provider, provider_subject, account_id, created_at)
      VALUES (?, ?, ?, ?)
    `)
  };
}

module.exports = {
  AuthService,
  SESSION_COOKIE,
  DEFAULT_SESSION_TTL_MS,
  SOCKET_TICKET_TTL_MS,
  PUBLIC_SESSION_ID_LENGTH,
  hashToken,
  publicSessionId,
  parseCookies,
  cookieForSession,
  clearSessionCookie
};
