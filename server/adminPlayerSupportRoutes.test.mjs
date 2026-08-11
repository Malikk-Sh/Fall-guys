import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { AdminControlService } = require('./adminControl');
const { installAdminRoutes } = require('./adminRoutes');

function prepare() {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      course_key TEXT NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      achieved_at INTEGER NOT NULL,
      verification_version INTEGER NOT NULL,
      match_id TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO accounts
      (id, display_name, secret_hash, created_at, last_seen_at, pending_secret_hash, pending_secret_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('support-player', 'Support Player', 'DO-NOT-EXPOSE', 100, 500, null, null);
  const adminAuth = new AdminAuthService({ db });
  const control = new AdminControlService({
    db,
    adminAuth,
    health: () => ({ ok: true }),
    gameplay: { summary: () => ({ days: 7, from: '2026-08-01', dropped: 0, rows: [] }) }
  });
  const app = express();
  installAdminRoutes({ app, adminAuth, control, enabled: true, secureCookies: false });
  return { db, adminAuth, app };
}

async function start(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, adminAuth, role) {
  const created = adminAuth.createUser({ name: `${role} test`, role, now: 1000 });
  assert.equal(created.ok, true);
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: created.accessCode })
  });
  assert.equal(response.status, 200);
  return {
    user: created.user,
    payload: await response.json(),
    cookie: response.headers.get('set-cookie').split(';', 1)[0]
  };
}

async function post(base, path, loginState, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      Cookie: loginState.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': loginState.payload.csrf
    },
    body: JSON.stringify(body)
  });
}

test('owner and operator can inspect player support while moderator cannot', async t => {
  const { db, adminAuth, app } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  assert.equal(hasCapability('owner', 'player-support.read'), true);
  assert.equal(hasCapability('operator', 'player-support.read'), true);
  assert.equal(hasCapability('moderator', 'player-support.read'), false);

  const operator = await login(base, adminAuth, 'operator');
  const search = await post(base, '/api/admin/players/search', operator, {
    query: 'Support',
    limit: 10
  });
  assert.equal(search.status, 200);
  assert.deepEqual(
    (await search.json()).results.map(item => item.id),
    ['support-player']
  );

  const detail = await post(base, '/api/admin/players/detail', operator, {
    accountId: 'support-player'
  });
  assert.equal(detail.status, 200);
  const player = (await detail.json()).player;
  assert.equal(player.account.name, 'Support Player');
  assert.equal(JSON.stringify(player).includes('DO-NOT-EXPOSE'), false);
  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.view');
  assert.ok(audit);
  assert.equal(audit.adminUserId, operator.user.id);
  assert.equal(audit.targetId, 'support-player');

  const moderator = await login(base, adminAuth, 'moderator');
  const forbidden = await post(base, '/api/admin/players/search', moderator, { query: 'Support' });
  assert.equal(forbidden.status, 403);
});

test('player support routes reject malformed payloads and unknown accounts', async t => {
  const { db, adminAuth, app } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });
  const owner = await login(base, adminAuth, 'owner');

  const tooShort = await post(base, '/api/admin/players/search', owner, { query: 'x' });
  assert.equal(tooShort.status, 400);
  assert.equal((await tooShort.json()).error, 'invalid-query');

  const extra = await post(base, '/api/admin/players/search', owner, {
    query: 'Support',
    unexpected: true
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error, 'invalid-payload');

  const missing = await post(base, '/api/admin/players/detail', owner, { accountId: 'missing' });
  assert.equal(missing.status, 404);
});
