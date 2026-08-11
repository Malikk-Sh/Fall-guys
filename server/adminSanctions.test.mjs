import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { AdminAuthService } = require('./adminAuth');
const { AdminControlService } = require('./adminControl');
const { PlayerSanctions } = require('./playerSanctions');
const { installAdminRoutes } = require('./adminRoutes');

function setup() {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
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
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('target', 'Target Player', 'hash', 1, 1);
  const adminAuth = new AdminAuthService({ db });
  const sanctions = new PlayerSanctions({ db });
  const revoked = [];
  const disconnected = [];
  const control = new AdminControlService({
    db,
    adminAuth,
    health: () => ({ ok: true }),
    gameplay: { summary: () => ({ days: 7, from: '2026-08-05', dropped: 0, rows: [] }) },
    sanctions,
    auth: {
      revokeAccountSessions: accountId => {
        revoked.push(accountId);
        return 2;
      }
    },
    disconnectAccount: accountId => {
      disconnected.push(accountId);
      return 1;
    }
  });
  return { db, adminAuth, sanctions, control, revoked, disconnected };
}

async function start() {
  const context = setup();
  const app = express();
  installAdminRoutes({
    app,
    adminAuth: context.adminAuth,
    control: context.control,
    enabled: true,
    secureCookies: false
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { ...context, server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, adminAuth, role) {
  const created = adminAuth.createUser({ name: `${role} sanctions`, role, now: 100 });
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

function post(base, route, loginState, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      Cookie: loginState.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': loginState.payload.csrf
    },
    body: JSON.stringify(body)
  });
}

test('moderators can issue temporary bans but permanent sanctions remain owner-only', async t => {
  const ctx = await start();
  t.after(() => {
    ctx.server.close();
    ctx.db.close();
  });
  const moderator = await login(ctx.base, ctx.adminAuth, 'moderator');

  const temp = await post(ctx.base, '/api/admin/sanctions/apply', moderator, {
    targetAccountId: 'target',
    kind: 'ban',
    reason: 'griefing',
    note: 'Repeated deliberate obstruction confirmed.',
    durationMs: 60 * 60 * 1000,
    permanent: false
  });
  assert.equal(temp.status, 200);
  const tempBody = await temp.json();
  assert.equal(tempBody.sanction.active, true);
  assert.equal(tempBody.revokedSessions, 2);
  assert.equal(tempBody.disconnectedSockets, 1);
  assert.deepEqual(ctx.revoked, ['target']);
  assert.deepEqual(ctx.disconnected, ['target']);

  const tooLong = await post(ctx.base, '/api/admin/sanctions/apply', moderator, {
    targetAccountId: 'target',
    kind: 'ban',
    reason: 'griefing',
    note: 'Moderator must not issue a 30-day ban.',
    durationMs: 30 * 24 * 60 * 60 * 1000,
    permanent: false
  });
  assert.equal(tooLong.status, 403);
  assert.equal((await tooLong.json()).error, 'sanction-duration-forbidden');

  const permanent = await post(ctx.base, '/api/admin/sanctions/apply', moderator, {
    targetAccountId: 'target',
    kind: 'ban',
    reason: 'exploit-cheat',
    note: 'Moderator cannot permanently ban.',
    durationMs: null,
    permanent: true
  });
  assert.equal(permanent.status, 403);
  assert.equal((await permanent.json()).error, 'permanent-sanction-owner-only');

  const revoke = await post(ctx.base, '/api/admin/sanctions/revoke', moderator, {
    sanctionId: tempBody.sanction.id,
    note: 'Temporary restriction removed after review.'
  });
  assert.equal(revoke.status, 200);
});

test('owner can issue and revoke permanent bans and every change is audited', async t => {
  const ctx = await start();
  t.after(() => {
    ctx.server.close();
    ctx.db.close();
  });
  const owner = await login(ctx.base, ctx.adminAuth, 'owner');
  const moderator = await login(ctx.base, ctx.adminAuth, 'moderator');

  const permanent = await post(ctx.base, '/api/admin/sanctions/apply', owner, {
    targetAccountId: 'target',
    kind: 'ban',
    reason: 'exploit-cheat',
    note: 'Permanent restriction after confirmed exploit abuse.',
    durationMs: null,
    permanent: true
  });
  assert.equal(permanent.status, 200);
  const body = await permanent.json();
  assert.equal(body.sanction.permanent, true);

  const moderatorRevoke = await post(ctx.base, '/api/admin/sanctions/revoke', moderator, {
    sanctionId: body.sanction.id,
    note: 'Moderator must not revoke permanent ban.'
  });
  assert.equal(moderatorRevoke.status, 403);
  assert.equal((await moderatorRevoke.json()).error, 'permanent-sanction-owner-only');

  const ownerRevoke = await post(ctx.base, '/api/admin/sanctions/revoke', owner, {
    sanctionId: body.sanction.id,
    note: 'Owner approved the appeal.'
  });
  assert.equal(ownerRevoke.status, 200);
  assert.equal((await ownerRevoke.json()).sanction.status, 'revoked');

  const actions = ctx.adminAuth.recentAudit(50).map(event => event.action);
  assert.ok(actions.includes('player.sanction.apply'));
  assert.ok(actions.includes('player.sanction.revoke'));
});
