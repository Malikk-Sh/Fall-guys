'use strict';

const express = require('express');

function keysOnly(body, allowed) {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? Object.keys(body).every(key => allowed.has(key))
    : false;
}

function installAdminReliabilityRoutes({ app, requireAdmin, reliability } = {}) {
  if (!app || typeof requireAdmin !== 'function') {
    throw new Error('Admin reliability routes require app and requireAdmin()');
  }
  const json = express.json({ limit: '4kb' });

  app.post('/api/admin/reliability', json, (req, res) => {
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
        reliability: reliability.report({ period: req.body?.period })
      });
    } catch {
      return res.status(503).json({ ok: false, error: 'reliability-unavailable' });
    }
  });
}

module.exports = { installAdminReliabilityRoutes, keysOnly };
