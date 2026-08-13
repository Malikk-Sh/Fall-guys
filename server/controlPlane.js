'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService } = require('./adminAuth');
const { AdminOperationsClient } = require('./adminOperationsClient');
const { buildIdentity } = require('./buildInfo');
const { ControlPlaneGameClient } = require('./controlPlaneGameClient');
const { ControlPlaneInfrastructure } = require('./controlPlaneInfrastructure');
const { ServiceReliabilityReader } = require('./serviceReliabilityReader');
const { installControlPlaneRoutes } = require('./controlPlaneRoutes');

const app = express();
const adminPath = path.join(__dirname, '..', 'client', 'admin');
const host = '127.0.0.1';
const port = Number.parseInt(process.env.CONTROL_PORT || '3001', 10);
const databaseFile = process.env.LEADERBOARD_DB || '/var/lib/wobble/leaderboard.db';
const enabled = process.env.ADMIN_PANEL_ENABLED === '1';

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error('CONTROL_PORT must be a valid TCP port');
}
if (databaseFile !== ':memory:' && !fs.existsSync(databaseFile)) {
  throw new Error(`Refusing to create the gameplay database from control plane: ${databaseFile}`);
}

const db = openDatabase(databaseFile);
db.exec('PRAGMA busy_timeout = 3000');
const adminAuth = new AdminAuthService({ db, migrate: false });
const gameClient = new ControlPlaneGameClient({ port: process.env.PORT || 3000 });
const operations = new AdminOperationsClient();
const infrastructure = new ControlPlaneInfrastructure({ gameClient });
const reliability = new ServiceReliabilityReader({ db, liveHealth: () => gameClient.health() });
const build = buildIdentity();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'"
    ].join('; ')
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/health/control', (req, res) => {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
    return res.status(404).json({ ok: false, error: 'not-found' });
  }
  return res.json({
    ok: true,
    service: 'wobble-control',
    version: build.version,
    commit: build.commit,
    release: build.release || null,
    uptime: Math.max(0, Math.round(process.uptime()))
  });
});

app.get('/admin', (_req, res) => res.redirect(308, '/admin/'));
app.use(
  '/admin',
  express.static(adminPath, {
    index: 'index.html',
    setHeaders: res => res.setHeader('Cache-Control', 'no-cache, must-revalidate')
  })
);

installControlPlaneRoutes({
  app,
  adminAuth,
  gameClient,
  infrastructure,
  reliability,
  operations,
  build,
  enabled,
  secureCookies: process.env.ADMIN_COOKIE_SECURE
    ? process.env.ADMIN_COOKIE_SECURE !== '0'
    : process.env.NODE_ENV === 'production'
});

const server = app.listen(port, host, () => {
  console.log(
    JSON.stringify({
      event: 'control_plane_started',
      host,
      port,
      version: build.version,
      commit: build.commit,
      release: build.release || null
    })
  );
});

let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 5000);
  timer.unref?.();
  server.close(() => {
    try {
      db.close();
    } finally {
      clearTimeout(timer);
      process.exit(0);
    }
  });
  console.log(JSON.stringify({ event: 'control_plane_stopping', signal }));
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server };
