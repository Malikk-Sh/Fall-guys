'use strict';

const crypto = require('crypto');
const { migrateDatabase } = require('./migrations');

const ADMIN_SESSION_COOKIE = 'wobble_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ADMIN_SESSIONS_PER_USER = 20;
const MAX_AUDIT_DETAIL = 4000;
const ADMIN_ROLES = Object.freeze(['owner', 'operator', 'moderator', 'analyst', 'viewer']);
const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze([
    'dashboard.read',
    'analytics.read',
    'moderation.read',
    'moderation.write',
    'audit.read',
    'admin.manage',
    'ops.execute'
  ]),
  operator: Object.freeze(['dashboard.read', 'analytics.read', 'moderation.read', 'audit.read']),
  moderator: Object.freeze(['dashboard.read', 'moderation.read', 'moderation.write']),
  analyst: Object.freeze(['dashboard.read', 'analytics.read']),
  viewer: Object.freeze(['dashboard.read'])
});

function hashSecret(secret) {
  const text = String(secret || '').trim();
  if (!/^WADMIN\.[A-Za-z0-9_-]{40,80}$/.test(text)) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hashSession(token) {
  const text = String(token || '').trim();
  if (!/^WAS\.[A-Za-z0-9_-]{40,80}$/.test(text)) return '';
  return crypto.createHash('sha256').update(text).digest('hex');
}

function hasAsciiControl(value) {
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function normalizeName(value) {
  const raw = String(value || '');
  const text = raw.trim();
  return text && text.length <= 80 && !hasAsciiControl(raw) ? text : null;
}

function normalizeRole(value) {
  const role = String(value || '').trim();
  return ADMIN_ROLES.includes(role) ? role : null;
}

function generateAccessCode() {
  return `WADMIN.${crypto.randomBytes(32).toString('base64url')}`;
}

function generateSessionToken() {
  return `WAS.${crypto.randomBytes(32).toString('base64url')}`;
}

function csrfFromSessionHash(tokenHash) {
  return tokenHash
    ? crypto.createHash('sha256').update(`wobble-admin-csrf:${tokenHash}`).digest('base64url')
    : '';
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function cookieForAdminSession(token, { secure = true, maxAgeMs = ADMIN_SESSION_TTL_MS } = {}) {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

function clearAdminSessionCookie({ secure = true } = {}) {
  const attributes = [
    `${ADMIN_SESSION_COOKIE}=`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0'
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
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

function capabilitiesFor(role) {
  return [...(ROLE_CAPABILITIES[role] || [])];
}

function hasCapability(role, capability) {
  return Boolean(ROLE_CAPABILITIES[role]?.includes(capability));
}

function serializeAuditDetail(detail) {
  if (detail == null) return null;
  let serialized;
  try {
    serialized = JSON.stringify(detail);
  } catch {
    return JSON.stringify({ unavailable: true, reason: 'not-json-serializable' });
  }
  if (serialized == null) return null;
  if (serialized.length <= MAX_AUDIT_DETAIL) return serialized;
  return JSON.stringify({
    truncated: true,
    originalLength: serialized.length
  });
}

function parseAuditDetail(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { unavailable: true, reason: 'invalid-stored-json' };
  }
}

class AdminAuthService {
  constructor({ db, sessionTtlMs = ADMIN_SESSION_TTL_MS } = {}) {
    if (!db) throw new Error('AdminAuthService requires an open database');
    this.db = db;
    this.sessionTtlMs = sessionTtlMs;
    migrateDatabase(db);
    this.statements = prepare(db);
  }

  createUser({ name, role, actor = null, now = Date.now() } = {}) {
    const displayName = normalizeName(name);
    const normalizedRole = normalizeRole(role);
    if (!displayName) return { ok: false, reason: 'invalid-name' };
    if (!normalizedRole) return { ok: false, reason: 'invalid-role', roles: ADMIN_ROLES };
    const id = crypto.randomUUID();
    const accessCode = generateAccessCode();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.insertUser.run(id, displayName, normalizedRole, hashSecret(accessCode), now);
      this.audit({
        actor,
        action: 'admin.user.create',
        targetType: 'admin-user',
        targetId: id,
        detail: { role: normalizedRole },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      ok: true,
      user: { id, name: displayName, role: normalizedRole, createdAt: now, disabledAt: null },
      accessCode
    };
  }

  listUsers() {
    return this.statements.users.all().map(row => ({
      id: row.id,
      name: row.display_name,
      role: row.role,
      createdAt: Number(row.created_at),
      disabledAt: row.disabled_at == null ? null : Number(row.disabled_at)
    }));
  }

  rotateAccessCode(adminUserId, { actor = null, now = Date.now() } = {}) {
    const id = String(adminUserId || '').trim();
    const user = this.statements.user.get(id);
    if (!user) return { ok: false, reason: 'unknown-admin' };
    const accessCode = generateAccessCode();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.updateSecret.run(hashSecret(accessCode), id);
      this.statements.deleteUserSessions.run(id);
      this.audit({
        actor,
        action: 'admin.user.rotate-access',
        targetType: 'admin-user',
        targetId: id,
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, accessCode };
  }

  setDisabled(adminUserId, disabled, { actor = null, now = Date.now() } = {}) {
    const id = String(adminUserId || '').trim();
    if (!this.statements.user.get(id)) return { ok: false, reason: 'unknown-admin' };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.setDisabled.run(disabled ? now : null, id);
      if (disabled) this.statements.deleteUserSessions.run(id);
      this.audit({
        actor,
        action: disabled ? 'admin.user.disable' : 'admin.user.enable',
        targetType: 'admin-user',
        targetId: id,
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true };
  }

  login(accessCode, now = Date.now()) {
    this.cleanup(now);
    const secretHash = hashSecret(accessCode);
    if (!secretHash) return null;
    const user = this.statements.userBySecret.get(secretHash);
    if (!user || user.disabled_at != null) return null;
    const token = generateSessionToken();
    const tokenHash = hashSession(token);
    const expiresAt = now + this.sessionTtlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.statements.insertSession.run(tokenHash, user.id, now, now, expiresAt);
      this.statements.trimUserSessions.run(user.id, user.id, MAX_ADMIN_SESSIONS_PER_USER);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return {
      token,
      csrf: csrfFromSessionHash(tokenHash),
      expiresAt,
      user: { id: user.id, name: user.display_name, role: user.role },
      capabilities: capabilitiesFor(user.role)
    };
  }

  resolveSession(token, now = Date.now()) {
    const tokenHash = hashSession(token);
    if (!tokenHash) return null;
    const row = this.statements.session.get(tokenHash);
    if (!row) return null;
    if (row.expires_at <= now || row.disabled_at != null) {
      this.statements.deleteSession.run(tokenHash);
      return null;
    }
    this.statements.touchSession.run(now, tokenHash);
    return {
      tokenHash,
      csrf: csrfFromSessionHash(tokenHash),
      expiresAt: Number(row.expires_at),
      user: { id: row.id, name: row.display_name, role: row.role },
      capabilities: capabilitiesFor(row.role)
    };
  }

  verifyCsrf(session, value) {
    return Boolean(session?.csrf && safeEqual(session.csrf, value));
  }

  logout(token) {
    const tokenHash = hashSession(token);
    if (!tokenHash) return false;
    return this.statements.deleteSession.run(tokenHash).changes > 0;
  }

  cleanup(now = Date.now()) {
    return this.statements.expireSessions.run(now).changes;
  }

  audit({ actor = null, action, targetType = null, targetId = null, detail = null, now = Date.now() } = {}) {
    const safeAction = String(action || '')
      .trim()
      .slice(0, 120);
    if (!safeAction) return false;
    const actorName = normalizeName(actor?.name) || 'system';
    const actorRole = ADMIN_ROLES.includes(actor?.role) ? actor.role : 'system';
    this.statements.insertAudit.run(
      actor?.id || null,
      actorName,
      actorRole,
      safeAction,
      targetType == null ? null : String(targetType).slice(0, 80),
      targetId == null ? null : String(targetId).slice(0, 160),
      serializeAuditDetail(detail),
      now
    );
    return true;
  }

  recentAudit(limit = 100) {
    const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 100));
    return this.statements.audit.all(safeLimit).map(row => ({
      id: Number(row.id),
      adminUserId: row.admin_user_id || null,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      action: row.action,
      targetType: row.target_type || null,
      targetId: row.target_id || null,
      detail: parseAuditDetail(row.detail_json),
      createdAt: Number(row.created_at)
    }));
  }
}

function prepare(db) {
  return {
    insertUser: db.prepare(`
      INSERT INTO admin_users (id, display_name, role, access_secret_hash, created_at, disabled_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `),
    users: db.prepare(`
      SELECT id, display_name, role, created_at, disabled_at
      FROM admin_users
      ORDER BY disabled_at IS NOT NULL, role, display_name, id
    `),
    user: db.prepare('SELECT id, display_name, role, disabled_at FROM admin_users WHERE id = ?'),
    userBySecret: db.prepare(`
      SELECT id, display_name, role, disabled_at
      FROM admin_users
      WHERE access_secret_hash = ?
    `),
    updateSecret: db.prepare('UPDATE admin_users SET access_secret_hash = ? WHERE id = ?'),
    setDisabled: db.prepare('UPDATE admin_users SET disabled_at = ? WHERE id = ?'),
    insertSession: db.prepare(`
      INSERT INTO admin_sessions (token_hash, admin_user_id, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    session: db.prepare(`
      SELECT s.expires_at, u.id, u.display_name, u.role, u.disabled_at
      FROM admin_sessions s
      JOIN admin_users u ON u.id = s.admin_user_id
      WHERE s.token_hash = ?
    `),
    touchSession: db.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?'),
    deleteUserSessions: db.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?'),
    expireSessions: db.prepare('DELETE FROM admin_sessions WHERE expires_at <= ?'),
    trimUserSessions: db.prepare(`
      DELETE FROM admin_sessions
      WHERE admin_user_id = ?
        AND token_hash NOT IN (
          SELECT token_hash
          FROM admin_sessions
          WHERE admin_user_id = ?
          ORDER BY last_seen_at DESC, created_at DESC, token_hash DESC
          LIMIT ?
        )
    `),
    insertAudit: db.prepare(`
      INSERT INTO admin_audit_events
        (admin_user_id, actor_name, actor_role, action, target_type, target_id, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    audit: db.prepare(`
      SELECT id, admin_user_id, actor_name, actor_role, action, target_type, target_id, detail_json, created_at
      FROM admin_audit_events
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
  };
}

module.exports = {
  AdminAuthService,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  MAX_ADMIN_SESSIONS_PER_USER,
  ADMIN_ROLES,
  ROLE_CAPABILITIES,
  capabilitiesFor,
  hasCapability,
  hashSecret,
  hashSession,
  cookieForAdminSession,
  clearAdminSessionCookie,
  parseCookies
};
