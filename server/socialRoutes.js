'use strict';

const express = require('express');
const { REPORT_REASONS } = require('./socialSafety');

const keysOnly = (body, allowed) =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).every(key => allowed.has(key))
    : false;

function statusFor(reason) {
  if (reason === 'unknown-account') return 404;
  if (reason === 'not-recent-partner') return 403;
  return 400;
}

function installSocialRoutes({ app, socialSafety, requireSession }) {
  if (!app || !socialSafety || typeof requireSession !== 'function') {
    throw new Error('Social routes требуют app, SocialSafety и requireSession');
  }
  const json = express.json({ limit: '4kb' });

  app.post('/api/social/avoid', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!keysOnly(req.body, new Set(['targetAccountId']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = socialSafety.avoid({
      accountId: session.accountId,
      targetAccountId: req.body?.targetAccountId
    });
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok) return res.status(statusFor(result.reason)).json({ ok: false, error: result.reason });
    return res.json({ ok: true, avoided: true, created: result.created });
  });

  app.post('/api/social/avoids', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, players: socialSafety.listAvoided(session.accountId) });
  });

  app.post('/api/social/unavoid', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!keysOnly(req.body, new Set(['targetAccountId']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = socialSafety.unavoid({
      accountId: session.accountId,
      targetAccountId: req.body?.targetAccountId
    });
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok) return res.status(statusFor(result.reason)).json({ ok: false, error: result.reason });
    return res.json({ ok: true, avoided: false, removed: result.removed });
  });

  app.post('/api/social/report', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!keysOnly(req.body, new Set(['targetAccountId', 'reason']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    const result = socialSafety.report({
      accountId: session.accountId,
      targetAccountId: req.body?.targetAccountId,
      reason: req.body?.reason
    });
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok) {
      return res.status(statusFor(result.reason)).json({
        ok: false,
        error: result.reason,
        ...(result.reason === 'invalid-reason' ? { allowedReasons: REPORT_REASONS } : {})
      });
    }
    return res.json({
      ok: true,
      accepted: result.accepted,
      duplicate: result.duplicate,
      reportCount: result.reportCount
    });
  });
}

module.exports = { installSocialRoutes, keysOnly };
