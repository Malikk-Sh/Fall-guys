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

const keysOnly = (body, allowed) =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).every(key => allowed.has(key))
    : false;

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
    if (!keysOnly(req.body, new Set(['accessCode']))) {
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
    if (!keysOnly(req.body, new Set(['days', 'limit', 'mode', 'course', 'device']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    return res.json({
      ok: true,
      analytics: control.analytics({
        days: req.body?.days,
        limit: req.body?.limit,
        mode: req.body?.mode,
        course: req.body?.course,
        device: req.body?.device
      })
    });
  });

  app.post('/api/admin/moderation/queue', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'moderation.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['status', 'limit']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = control.moderationQueue({
      status: req.body?.status || 'open',
      limit: req.body?.limit || 50
    });
    if (!result.ok) return res.status(400).json({ ok: false, error: result.reason });
    return res.json(result);
  });

  app.post('/api/admin/moderation/case', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'moderation.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['targetAccountId'])) || !req.body.targetAccountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const item = control.moderationCase(req.body.targetAccountId);
    if (!item) return res.status(404).json({ ok: false, error: 'moderation-case-not-found' });
    return res.json({ ok: true, case: item });
  });

  app.post('/api/admin/moderation/transition', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'moderation.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['targetAccountId', 'status', 'note', 'expectedRevision']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = control.moderationTransition({
      targetAccountId: req.body?.targetAccountId,
      status: req.body?.status,
      note: req.body?.note,
      expectedRevision: req.body?.expectedRevision,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status = result.reason === 'no-reports' ? 404 : result.reason === 'case-changed' ? 409 : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.allowedStatuses ? { allowedStatuses: result.allowedStatuses } : {}),
        ...(result.case ? { case: result.case } : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/audit', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'audit.read');
    if (!resolved) return undefined;
    return res.json({ ok: true, events: adminAuth.recentAudit(req.body?.limit) });
  });

  return { requireAdmin, tokenFrom };
}

module.exports = { installAdminRoutes, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, keysOnly };
