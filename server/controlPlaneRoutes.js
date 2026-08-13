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

const GAME_ROUTE_CAPABILITIES = Object.freeze({
  '/api/admin/dashboard': 'dashboard.read',
  '/api/admin/analytics': 'analytics.read',
  '/api/admin/players/search': 'player-support.read',
  '/api/admin/players/detail': 'player-support.read',
  '/api/admin/incidents/player': 'incidents.read',
  '/api/admin/players/logout': 'player-support.sessions.write',
  '/api/admin/players/rename': 'player-support.name.write',
  '/api/admin/moderation/queue': 'moderation.read',
  '/api/admin/moderation/case': 'moderation.read',
  '/api/admin/moderation/transition': 'moderation.write',
  '/api/admin/sanctions/apply': 'sanctions.write',
  '/api/admin/sanctions/revoke': 'sanctions.write'
});

const keysOnly = (body, allowed) =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).every(key => allowed.has(key))
    : false;

function installControlPlaneRoutes({
  app,
  adminAuth,
  gameClient,
  infrastructure,
  reliability,
  operations,
  build,
  enabled = false,
  loginRateLimitKey = req => req.socket.remoteAddress || 'local-proxy',
  loginAttempts = LOGIN_ATTEMPTS,
  secureCookies = process.env.NODE_ENV === 'production'
} = {}) {
  if (!app || !adminAuth || !gameClient) {
    throw new Error('Control plane routes require app, adminAuth and gameClient');
  }
  const json = express.json({ limit: '16kb' });
  const logins = new BoundedIpRateLimiter({ windowMs: LOGIN_WINDOW_MS, maxEntries: 5000 });
  const unavailable = res => res.status(404).json({ ok: false, error: 'not-found' });
  const tokenFrom = req => parseCookies(req.headers.cookie)[ADMIN_SESSION_COOKIE] || '';

  const requireAdmin = (req, res, capability, { csrf = true } = {}) => {
    if (!enabled) {
      unavailable(res);
      return null;
    }
    let session;
    const token = tokenFrom(req);
    try {
      session = adminAuth.resolveSession(token);
    } catch {
      return res.status(503).json({ ok: false, error: 'control-database-unavailable' });
    }
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
    let login;
    try {
      login = adminAuth.login(req.body.accessCode);
    } catch {
      return res.status(503).json({ ok: false, error: 'control-database-unavailable' });
    }
    if (!login) return res.status(401).json({ ok: false, error: 'invalid-access-code' });
    res.setHeader(
      'Set-Cookie',
      cookieForAdminSession(login.token, {
        secure: secureCookies,
        maxAgeMs: Math.max(0, login.expiresAt - Date.now())
      })
    );
    res.setHeader('Cache-Control', 'no-store');
    try {
      adminAuth.audit({ actor: login.user, action: 'admin.login' });
    } catch {
      // Login already committed. Audit failure must not invalidate the new authenticated session.
    }
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
    return res.json({
      ok: true,
      admin: resolved.session.user,
      capabilities: resolved.session.capabilities,
      csrf: resolved.session.csrf,
      expiresAt: resolved.session.expiresAt
    });
  });

  app.post('/api/admin/logout', json, (req, res) => {
    const resolved = requireAdmin(req, res, null);
    if (!resolved) return undefined;
    try {
      adminAuth.audit({ actor: resolved.session.user, action: 'admin.logout' });
      adminAuth.logout(resolved.token);
    } catch {
      return res.status(503).json({ ok: false, error: 'control-database-unavailable' });
    }
    res.setHeader('Set-Cookie', clearAdminSessionCookie({ secure: secureCookies }));
    return res.json({ ok: true });
  });

  app.post('/api/admin/control/status', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'dashboard.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const game = await gameClient.status().catch(() => null);
    let operationsStatus = null;
    try {
      operationsStatus = operations?.status?.() || null;
    } catch {
      operationsStatus = null;
    }
    return res.json({
      ok: true,
      control: {
        ok: true,
        build: build || null,
        uptimeSeconds: Math.max(0, Math.round(process.uptime()))
      },
      game: game
        ? {
            reachable: true,
            ok: Boolean(game.ready),
            ready: Boolean(game.ready),
            version: game.version || null,
            commit: game.commit || null,
            release: game.release || null,
            uptimeSeconds: Number(game.uptime || 0),
            load: game.load || null,
            capacity: game.capacity || null
          }
        : { reachable: false, ok: false, ready: false },
      maintenance: Boolean(operationsStatus?.maintenance),
      operationsAvailable: Boolean(operationsStatus?.available)
    });
  });

  app.post('/api/admin/infrastructure', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'infrastructure.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!infrastructure || typeof infrastructure.snapshot !== 'function') {
      return res.status(503).json({ ok: false, error: 'infrastructure-unavailable' });
    }
    try {
      return res.json({ ok: true, infrastructure: await infrastructure.snapshot() });
    } catch {
      return res.status(503).json({ ok: false, error: 'infrastructure-unavailable' });
    }
  });

  app.post('/api/admin/reliability', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'reliability.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['period']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!reliability || typeof reliability.report !== 'function') {
      return res.status(503).json({ ok: false, error: 'reliability-unavailable' });
    }
    try {
      return res.json({
        ok: true,
        reliability: await reliability.report({ period: req.body?.period })
      });
    } catch {
      return res.status(503).json({ ok: false, error: 'reliability-unavailable' });
    }
  });

  app.post('/api/admin/operations/status', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'ops.execute');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!operations || typeof operations.status !== 'function') {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
    try {
      const status = operations.status();
      return res.json({
        ok: true,
        available: Boolean(status.available),
        maintenance: Boolean(status.maintenance),
        operations: status.operations || []
      });
    } catch {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
  });

  app.post('/api/admin/operations/run', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'ops.execute');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['operation', 'confirmation']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!operations || typeof operations.status !== 'function' || typeof operations.run !== 'function') {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
    const operation = String(req.body?.operation || '').trim();
    let status;
    try {
      status = operations.status();
    } catch {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
    if (!status.operations?.some(item => item?.id === operation)) {
      return res.status(400).json({ ok: false, error: 'unknown-operation' });
    }
    if (req.body?.confirmation !== operation) {
      return res.status(400).json({ ok: false, error: 'operation-confirmation-required' });
    }

    const actor = resolved.session.user;
    try {
      adminAuth.audit({
        actor,
        action: 'ops.operation.requested',
        targetType: 'operation',
        targetId: operation
      });
    } catch {
      return res.status(503).json({ ok: false, error: 'control-database-unavailable' });
    }

    let result;
    try {
      result = await operations.run(operation);
    } catch {
      result = { ok: false, reason: 'helper-error' };
    }
    const safeReasons = new Set([
      'helper-unavailable',
      'helper-timeout',
      'helper-error',
      'helper-closed',
      'helper-invalid-response',
      'helper-response-too-large',
      'helper-response-mismatch',
      'operation-busy',
      'operation-timeout',
      'operation-failed',
      'restart-cooldown'
    ]);
    if (!result?.ok) {
      const reason = safeReasons.has(result?.reason) ? result.reason : 'helper-error';
      try {
        adminAuth.audit({
          actor,
          action: 'ops.operation.failed',
          targetType: 'operation',
          targetId: operation,
          detail: {
            reason,
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
          }
        });
      } catch {
        // The operation result is authoritative even if the audit database becomes unavailable later.
      }
      const httpStatus = reason === 'operation-busy' || reason === 'restart-cooldown' ? 409 : 503;
      return res.status(httpStatus).json({
        ok: false,
        error: reason,
        ...(reason === 'restart-cooldown' && Number.isFinite(Number(result?.retryAfterMs))
          ? { retryAfterMs: Math.max(0, Number(result.retryAfterMs)) }
          : {})
      });
    }

    const accepted = Boolean(result.accepted);
    try {
      adminAuth.audit({
        actor,
        action: accepted ? 'ops.operation.accepted' : 'ops.operation.completed',
        targetType: 'operation',
        targetId: operation,
        detail: {
          durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
        }
      });
    } catch {
      // Do not turn a completed privileged operation into a false failure after the fact.
    }
    return res.json({
      ok: true,
      operation,
      accepted,
      durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
    });
  });

  app.post('/api/admin/audit', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'audit.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['limit']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    try {
      return res.json({ ok: true, events: adminAuth.recentAudit(req.body?.limit) });
    } catch {
      return res.status(503).json({ ok: false, error: 'control-database-unavailable' });
    }
  });

  for (const [path, capability] of Object.entries(GAME_ROUTE_CAPABILITIES)) {
    app.post(path, json, async (req, res) => {
      const resolved = requireAdmin(req, res, capability);
      if (!resolved) return undefined;
      const upstream = await gameClient.adminRequest(path, {
        body: req.body,
        cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(resolved.token)}`,
        csrf: req.headers['x-wobble-admin-csrf'] || ''
      });
      return res.status(upstream.statusCode).json(upstream.payload);
    });
  }

  app.use('/api/admin', (_req, res) => res.status(404).json({ ok: false, error: 'admin-route-not-found' }));

  return { requireAdmin, tokenFrom };
}

module.exports = {
  installControlPlaneRoutes,
  GAME_ROUTE_CAPABILITIES,
  LOGIN_ATTEMPTS,
  LOGIN_WINDOW_MS,
  keysOnly
};
