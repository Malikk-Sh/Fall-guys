import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const {
  AdminAuthService,
  MAX_ADMIN_SESSIONS_PER_USER,
  hasCapability
} = require('./adminAuth');
const { installAdminRoutes } = require('./adminRoutes');

test('admin access code is one-time visible, sessions are hashed and role capabilities stay bounded', () => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db, sessionTtlMs: 10_000 });
  const created = auth.createUser({ name: 'Malik', role: 'owner', now: 100 });
  assert.equal(created.ok, true);
  assert.match(created.accessCode, /^WADMIN\./);
  assert.equal(
    db.prepare('SELECT access_secret_hash FROM admin_users').get().access_secret_hash.includes('WADMIN'),
    false
  );

  const login = auth.login(created.accessCode, 200);
  assert.ok(login);
  assert.equal(login.user.role, 'owner');
  assert.equal(hasCapability(login.user.role, 'ops.execute'), true);
  assert.equal(auth.verifyCsrf(login, login.csrf), true);
  assert.equal(auth.verifyCsrf(login, 'wrong'), false);
  assert.equal(db.prepare('SELECT token_hash FROM admin_sessions').get().token_hash.includes('WAS.'), false);

  const session = auth.resolveSession(login.token, 300);
  assert.equal(session.user.id, created.user.id);
  auth.audit({
    actor: session.user,
    action: 'test.large-detail',
    targetType: 'test',
    targetId: '1',
    detail: { payload: 'x'.repeat(5000) },
    now: 400
  });
  const largeAudit = auth.recentAudit()[0];
  assert.equal(largeAudit.action, 'test.large-detail');
  assert.equal(largeAudit.detail.truncated, true);
  assert.equal(largeAudit.detail.originalLength > 4000, true);

  const rotated = auth.rotateAccessCode(created.user.id, { now: 500 });
  assert.equal(rotated.ok, true);
  assert.equal(auth.resolveSession(login.token, 500), null, 'rotation revokes prior admin sessions');
  assert.equal(auth.login(created.accessCode, 500), null, 'old access code stops working');
  const newLogin = auth.login(rotated.accessCode, 500);
  assert.ok(newLogin);

  assert.equal(auth.setDisabled(created.user.id, true, { now: 600 }).ok, true);
  assert.equal(auth.resolveSession(newLogin.token, 700), null);
  assert.equal(auth.login(rotated.accessCode, 700), null);
  db.close();
});

test('admin login prunes expired sessions and bounds live sessions per administrator', () => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db, sessionTtlMs: 1000 });
  const created = auth.createUser({ name: 'Operator', role: 'operator', now: 0 });

  for (let index = 0; index < MAX_ADMIN_SESSIONS_PER_USER + 5; index += 1) {
    assert.ok(auth.login(created.accessCode, 100 + index));
  }
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM admin_sessions WHERE admin_user_id = ?').get(created.user.id)
      .count,
    MAX_ADMIN_SESSIONS_PER_USER
  );

  assert.ok(auth.login(created.accessCode, 5000));
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM admin_sessions WHERE admin_user_id = ?').get(created.user.id)
      .count,
    1,
    'a later login cleans every expired session before creating the new one'
  );
  db.close();
});

test('admin user mutations roll back when their mandatory audit event cannot be stored', () => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db });
  const created = auth.createUser({ name: 'Owner', role: 'owner', now: 100 });
  const originalLogin = auth.login(created.accessCode, 200);
  assert.ok(originalLogin);

  db.exec(`
    CREATE TRIGGER reject_admin_audit
    BEFORE INSERT ON admin_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit blocked');
    END;
  `);

  assert.throws(() => auth.rotateAccessCode(created.user.id, { now: 300 }), /audit blocked/);
  assert.ok(auth.login(created.accessCode, 310), 'failed rotation keeps the old access code valid');
  assert.ok(auth.resolveSession(originalLogin.token, 320), 'failed rotation keeps existing sessions');

  assert.throws(() => auth.setDisabled(created.user.id, true, { now: 400 }), /audit blocked/);
  assert.equal(auth.listUsers()[0].disabledAt, null, 'failed disable leaves the administrator enabled');

  assert.throws(() => auth.createUser({ name: 'Second', role: 'viewer', now: 500 }), /audit blocked/);
  assert.equal(auth.listUsers().length, 1, 'failed create does not leave an unaudited administrator');
  db.close();
});

test('admin HTTP API requires session, capability, CSRF and a non-spoofable throttle key', async t => {
  const db = openDatabase(':memory:');
  const auth = new AdminAuthService({ db });
  const created = auth.createUser({ name: 'Viewer', role: 'viewer' });
  const app = express();
  const control = {
    overview: () => ({ health: { ok: true }, accounts: { total: 0, active24h: 0 } }),
    analytics: () => ({ rows: [] }),
    moderationQueue: () => ({ ok: true, cases: [] })
  };
  installAdminRoutes({
    app,
    adminAuth: auth,
    control,
    enabled: true,
    secureCookies: false,
    loginAttempts: 2
  });
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
  assert.match(loginResponse.headers.get('set-cookie'), /Path=\/api\/admin/);
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

  const failedLogin = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '198.51.100.10'
    },
    body: JSON.stringify({ accessCode: 'wrong' })
  });
  assert.equal(failedLogin.status, 401);

  const spoofedLogin = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': '203.0.113.77'
    },
    body: JSON.stringify({ accessCode: 'wrong-again' })
  });
  assert.equal(spoofedLogin.status, 429, 'changing X-Forwarded-For does not create a new throttle bucket');
});
