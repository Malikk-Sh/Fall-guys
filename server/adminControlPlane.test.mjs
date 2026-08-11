import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { installAdminRoutes } = require('./adminRoutes');

test('admin access code is one-time visible, sessions are hashed and role capabilities stay bounded', () => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db, sessionTtlMs: 10_000 });
  const created = auth.createUser({ name: 'Malik', role: 'owner', now: 100 });
  assert.equal(created.ok, true);
  assert.match(created.accessCode, /^WADMIN\./);
  assert.equal(db.prepare('SELECT access_secret_hash FROM admin_users').get().access_secret_hash.includes('WADMIN'), false);

  const login = auth.login(created.accessCode, 200);
  assert.ok(login);
  assert.equal(login.user.role, 'owner');
  assert.equal(hasCapability(login.user.role, 'ops.execute'), true);
  assert.equal(auth.verifyCsrf(login, login.csrf), true);
  assert.equal(auth.verifyCsrf(login, 'wrong'), false);
  assert.equal(db.prepare('SELECT token_hash FROM admin_sessions').get().token_hash.includes('WAS.'), false);

  const session = auth.resolveSession(login.token, 300);
  assert.equal(session.user.id, created.user.id);
  auth.audit({ actor: session.user, action: 'test.read', targetType: 'test', targetId: '1', now: 400 });
  assert.equal(auth.recentAudit()[0].action, 'test.read');

  const rotated = auth.rotateAccessCode(created.user.id);
  assert.equal(rotated.ok, true);
  assert.equal(auth.resolveSession(login.token, 500), null, 'rotation revokes prior admin sessions');
  assert.equal(auth.login(created.accessCode, 500), null, 'old access code stops working');
  const newLogin = auth.login(rotated.accessCode, 500);
  assert.ok(newLogin);

  assert.equal(auth.setDisabled(created.user.id, true, 600).ok, true);
  assert.equal(auth.resolveSession(newLogin.token, 700), null);
  assert.equal(auth.login(rotated.accessCode, 700), null);
  db.close();
});

test('admin HTTP API requires session, capability and CSRF for authenticated operations', async t => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db });
  const created = auth.createUser({ name: 'Viewer', role: 'viewer' });
  const app = express();
  const control = {
    overview: () => ({ health: { ok: true }, accounts: { total: 0, active24h: 0 } }),
    analytics: () => ({ rows: [] }),
    moderationQueue: () => ({ ok: true, cases: [] })
  };
  installAdminRoutes({ app, adminAuth: auth, control, enabled: true, secureCookies: false, clientIp: () => 'test' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const loginResponse = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: created.accessCode })
  });
  assert.equal(loginResponse.status, 200);
  const login = await loginResponse.json();
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];
  assert.ok(login.csrf);

  const missingCsrf = await fetch(`${base}/api/admin/dashboard`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(missingCsrf.status, 403);

  const dashboard = await fetch(`${base}/api/admin/dashboard`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': login.csrf
    },
    body: '{}'
  });
  assert.equal(dashboard.status, 200);

  const analytics = await fetch(`${base}/api/admin/analytics`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': login.csrf
    },
    body: '{}'
  });
  assert.equal(analytics.status, 403, 'viewer cannot read analytics');
});
