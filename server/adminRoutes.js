'use strict';

const express = require('express');
const { BoundedIpRateLimiter } = require('./ipRateLimiter');
const {
  ADMIN_SESSION_COOKIE,
  hasCapability,
  parseCookies,
  cookieForAdminSession,
  clearAdminSessionCookie
} = require('./adminAuth');

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPTS = 60;

function installAdminRoutes({
  app,
  adminAuth,
  control,
  enabled = false,
  loginRateLimitKey = req => req.socket.remoteAddress || 'local-proxy',
  loginAttempts = LOGIN_ATTEMPTS,
  secureCookies = process.env.NODE_ENV === 'production'
} = {}) {
  if (!app || !adminAuth || !control) throw new Error('Admin routes require app, adminAuth and control');
  const json = express.json({ limit: '8kb' });
  const logins = new BoundedIpRateLimiter({ windowMs: LOGIN_WINDOW_MS, maxEntries: 5000 });

  const unavailable = res => res.status(404).json({ ok: false, error: 'not-found' });
  const tokenFrom = req => parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE] || '';

  const requireAdmin = (req, res, capability, { csrf = true } = {}) => {
    if (!enabled) {
      unavailable(res);
      return null;
    }
    const token = tokenFrom(req);
    const session = adminAuth.resolveSession(token);
    if (!session) {
      res.setHeader('Set-Cookie', clearAdminSessionCookie({ secure: secureCookies }));
      res.status(401).json({ ok: false, error: 'admin-session-required' });
      return null;
    }
    if (capability && !hasCapability(session.user.role, capability)) {
      res.status(403).json({ ok: false, error: 'admin-forbidden' });
      return null;
    }
    if (csrf && !adminAuth.verifyCsrf(session, req.headers['x-wobble-admin-csrf'])) {
      res.status(403).json({ ok: false, error: 'admin-csrf' });
      return null;
    }
    res.setHeader('Cache-Control', 'no-store');
    return { token, session };
  };

  app.post('/api/admin/login', json, (req, res) => {
    if (!enabled) return unavailable(res);
    if (logins.limited(loginRateLimitKey(req), loginAttempts)) {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    if (!req.body || Object.keys(req.body).some(key => key !== 'accessCode')) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const login = adminAuth.login(req.body.accessCode);
    if (!login) return res.status(401).json({ ok: false, error: 'invalid-access-code' });
    res.setHeader(
      'Set-Cookie',
      cookieForAdminSession(login.token, {
        secure: secureCookies,
        maxAgeMs: Math.max(0, login.expiresAt - Date.now())
      })
    );
    res.setHeader('Cache-Control', 'no-store');
    adminAuth.audit({ actor: login.user, action: 'admin.login' });
    return res.json({
      ok: true,
      admin: login.user,
      capabilities: login.capabilities,
      csrf: login.csrf,
      expiresAt: login.expiresAt
    });
  });

  app.post('/api/admin/session', json, (req, res) => {
    const resolved = requireAdmin(req, res, null, { csrf: false });
    if (!resolved) return undefined;
    const { session } = resolved;
    return res.json({
      ok: true,
      admin: session.user,
      capabilities: session.capabilities,
      csrf: session.csrf,
      expiresAt: session.expiresAt
    });
  });

  app.post('/api/admin/logout', json, (req, res) => {
    const resolved = requireAdmin(req, res, null);
    if (!resolved) return undefined;
    adminAuth.audit({ actor: resolved.session.user, action: 'admin.logout' });
    adminAuth.logout(resolved.token);
    res.setHeader('Set-Cookie', clearAdminSessionCookie({ secure: secureCookies }));
    return res.json({ ok: true });
  });

  app.post('/api/admin/dashboard', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'dashboard.read');
    if (!resolved) return undefined;
    return res.json({ ok: true, overview: control.overview() });
  });

  app.post('/api/admin/analytics', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'analytics.read');
    if (!resolved) return undefined;
    const days = Number.parseInt(req.body?.days, 10);
    const limit = Number.parseInt(req.body?.limit, 10);
    return res.json({
      ok: true,
      analytics: control.analytics({
        days: Number.isSafeInteger(days) && days > 0 ? Math.min(days, 90) : 7,
        limit: Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200
      })
    });
  });

  app.post('/api/admin/moderation/queue', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'moderation.read');
    if (!resolved) return undefined;
    const result = control.moderationQueue({
      status: req.body?.status || 'open',
      limit: req.body?.limit || 50
    });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });
    return res.json(result);
  });

  app.post('/api/admin/audit', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'audit.read');
    if (!resolved) return undefined;
    return res.json({ ok: true, events: adminAuth.recentAudit(req.body?.limit) });
  });

  return { requireAdmin, tokenFrom };
}

module.exports = { installAdminRoutes, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS };
