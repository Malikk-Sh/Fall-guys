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
  infrastructure = null,
  operations = null,
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

  app.post('/api/admin/players/search', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['query', 'limit']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = control.playerSearch(req.body?.query, { limit: req.body?.limit });
    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.reason,
        ...(result.minLength ? { minLength: result.minLength } : {}),
        ...(result.maxLength ? { maxLength: result.maxLength } : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/players/detail', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = control.playerDetail(req.body.accountId, { actor: resolved.session.user });
    if (!result.ok) {
      const status = result.reason === 'unknown-account' ? 404 : 400;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    return res.json(result);
  });

  app.post('/api/admin/incidents/player', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'incidents.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId', 'limit'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.incidentTimeline !== 'function') {
      return res.status(503).json({ ok: false, error: 'incident-diagnostics-unavailable' });
    }
    const result = control.incidentTimeline(req.body.accountId, {
      actor: resolved.session.user,
      limit: req.body.limit
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'incident-read-forbidden'
            ? 403
            : result.reason === 'incident-diagnostics-unavailable'
              ? 503
              : 400;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    return res.json(result);
  });

  app.post('/api/admin/players/logout', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.sessions.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId', 'note'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.playerLogout !== 'function') {
      return res.status(503).json({ ok: false, error: 'player-support-actions-unavailable' });
    }
    const result = control.playerLogout({
      targetAccountId: req.body.accountId,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable' ||
                result.reason === 'support-logout-incomplete'
              ? 503
              : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {}),
        ...(result.reason === 'support-logout-incomplete'
          ? {
              accountId: result.accountId,
              revokedSessions: result.revokedSessions,
              revokedSocketTickets: result.revokedSocketTickets,
              revokedReconnectSessions: result.revokedReconnectSessions,
              disconnectedSockets: result.disconnectedSockets,
              failedSteps: result.failedSteps
            }
          : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/players/rename', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.name.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId', 'name', 'note'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.playerRename !== 'function') {
      return res.status(503).json({ ok: false, error: 'player-support-actions-unavailable' });
    }
    const result = control.playerRename({
      targetAccountId: req.body.accountId,
      name: req.body.name,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable'
              ? 503
              : result.reason === 'no-change'
                ? 409
                : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {})
      });
    }
    return res.json(result);
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

  app.post('/api/admin/sanctions/apply', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'sanctions.write');
    if (!resolved) return undefined;
    if (
      !keysOnly(
        req.body,
        new Set(['targetAccountId', 'kind', 'reason', 'note', 'durationMs', 'permanent'])
      ) ||
      !req.body?.targetAccountId
    ) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.sanctionApply !== 'function') {
      return res.status(503).json({ ok: false, error: 'sanctions-unavailable' });
    }
    const result = control.sanctionApply({
      targetAccountId: req.body.targetAccountId,
      kind: req.body.kind,
      reason: req.body.reason,
      note: req.body.note,
      durationMs: req.body.durationMs,
      permanent: req.body.permanent === true,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const forbidden = new Set([
        'sanctions-forbidden',
        'sanction-duration-forbidden',
        'permanent-sanction-owner-only'
      ]);
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'active-ban-exists'
            ? 409
            : result.reason === 'sanctions-unavailable'
              ? 503
              : forbidden.has(result.reason)
                ? 403
                : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxDurationMs ? { maxDurationMs: result.maxDurationMs } : {}),
        ...(result.allowedKinds ? { allowedKinds: result.allowedKinds } : {}),
        ...(result.allowedReasons ? { allowedReasons: result.allowedReasons } : {}),
        ...(result.active ? { active: result.active } : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/sanctions/revoke', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'sanctions.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['sanctionId', 'note'])) || !req.body?.sanctionId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.sanctionRevoke !== 'function') {
      return res.status(503).json({ ok: false, error: 'sanctions-unavailable' });
    }
    const result = control.sanctionRevoke({
      sanctionId: req.body.sanctionId,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-sanction'
          ? 404
          : result.reason === 'permanent-sanction-owner-only' || result.reason === 'sanctions-forbidden'
            ? 403
            : result.reason === 'sanctions-unavailable'
              ? 503
              : result.reason === 'sanction-not-active'
                ? 409
                : 400;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    return res.json(result);
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
    adminAuth.audit({
      actor,
      action: 'ops.operation.requested',
      targetType: 'operation',
      targetId: operation
    });

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
    adminAuth.audit({
      actor,
      action: accepted ? 'ops.operation.accepted' : 'ops.operation.completed',
      targetType: 'operation',
      targetId: operation,
      detail: {
        durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
      }
    });
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
    return res.json({ ok: true, events: adminAuth.recentAudit(req.body?.limit) });
  });

  return { requireAdmin, tokenFrom };
}

module.exports = { installAdminRoutes, LOGIN_ATTEMPTS, LOGIN_WINDOW_MS, keysOnly };
