import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { Accounts } = require('./accounts');
const { AuthService } = require('./auth');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { AdminControlService } = require('./adminControl');
const { installAdminRoutes } = require('./adminRoutes');

function prepare({ reconnectFailure = false } = {}) {
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
    `INSERT INTO accounts
      (id, display_name, secret_hash, created_at, last_seen_at, pending_secret_hash, pending_secret_created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('support-player', 'Support Player', 'DO-NOT-EXPOSE', 100, 500, null, null);
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db });
  const disconnected = [];
  const reconnectRevocations = [];
  const incidentEvents = [];
  const adminAuth = new AdminAuthService({ db });
  const control = new AdminControlService({
    db,
    adminAuth,
    accounts,
    auth,
    incidents: {
      record: event => {
        incidentEvents.push(event);
        return true;
      }
    },
    disconnectAccount: (accountId, options) => {
      disconnected.push({ accountId, options });
      return accountId === 'support-player' ? 2 : 0;
    },
    connectionCount: accountId => (accountId === 'support-player' ? 2 : 0),
    revokeReconnectSessions: accountId => {
      reconnectRevocations.push(accountId);
      if (reconnectFailure) throw new Error('injected reconnect cleanup failure');
      return accountId === 'support-player' ? 1 : 0;
    },
    health: () => ({ ok: true }),
    gameplay: { summary: () => ({ days: 7, from: '2026-08-01', dropped: 0, rows: [] }) }
  });
  const app = express();
  installAdminRoutes({ app, adminAuth, control, enabled: true, secureCookies: false });
  return { db, adminAuth, app, auth, accounts, disconnected, reconnectRevocations, incidentEvents };
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

test('owner, operator and moderator can inspect player support while viewer cannot', async t => {
  const { db, adminAuth, app } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  assert.equal(hasCapability('owner', 'player-support.read'), true);
  assert.equal(hasCapability('operator', 'player-support.read'), true);
  assert.equal(hasCapability('moderator', 'player-support.read'), true);
  assert.equal(hasCapability('operator', 'player-support.sessions.write'), true);
  assert.equal(hasCapability('operator', 'player-support.name.write'), false);
  assert.equal(hasCapability('moderator', 'player-support.sessions.write'), false);
  assert.equal(hasCapability('moderator', 'player-support.name.write'), true);

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
  const moderatorSearch = await post(base, '/api/admin/players/search', moderator, { query: 'Support' });
  assert.equal(moderatorSearch.status, 200);

  const viewer = await login(base, adminAuth, 'viewer');
  const forbidden = await post(base, '/api/admin/players/search', viewer, { query: 'Support' });
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

test('support actions enforce split capabilities, revoke every login path and audit mutations', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const sessionA = auth.createSession('support-player', 10_000);
  const sessionB = auth.createSession('support-player', 10_100);
  const ticket = auth.createSocketTicket('support-player', 10_200);
  assert.ok(sessionA && sessionB && ticket);

  const operator = await login(base, adminAuth, 'operator');
  const logout = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Игрок попросил завершить все входы'
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), {
    ok: true,
    accountId: 'support-player',
    revokedSessions: 2,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2
  });
  assert.equal(auth.resolveSession(sessionA.token, 10_300), null);
  assert.equal(auth.resolveSession(sessionB.token, 10_300), null);
  assert.equal(auth.consumeSocketTicket(ticket.token, 10_300), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected[0].accountId, 'support-player');
  assert.equal(disconnected[0].options.reason, 'support-logout');
  assert.equal(incidentEvents.length, 1);
  assert.equal(incidentEvents[0].accountId, 'support-player');
  assert.equal(incidentEvents[0].kind, 'support');
  assert.equal(incidentEvents[0].code, 'forced-logout');

  const logoutAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.ok(logoutAudit);
  assert.deepEqual(logoutAudit.detail, {
    note: 'Игрок попросил завершить все входы',
    revokedSessions: 2,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    complete: true,
    failedSteps: []
  });

  const moderator = await login(base, adminAuth, 'moderator');
  const moderatorLogout = await post(base, '/api/admin/players/logout', moderator, {
    accountId: 'support-player',
    note: 'Не должно пройти'
  });
  assert.equal(moderatorLogout.status, 403);

  const operatorRename = await post(base, '/api/admin/players/rename', operator, {
    accountId: 'support-player',
    name: 'Clean Name',
    note: 'Не должно пройти'
  });
  assert.equal(operatorRename.status, 403);

  const rename = await post(base, '/api/admin/players/rename', moderator, {
    accountId: 'support-player',
    name: 'Clean Name',
    note: 'Исправлено имя по жалобе'
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'Clean Name');
  assert.equal(
    db.prepare('SELECT display_name FROM accounts WHERE id = ?').get('support-player').display_name,
    'Clean Name'
  );

  const invalidName = await post(base, '/api/admin/players/rename', moderator, {
    accountId: 'support-player',
    name: '<script>',
    note: 'Проверка валидации'
  });
  assert.equal(invalidName.status, 400);
  assert.equal((await invalidName.json()).error, 'invalid-player-name');

  const renameAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.rename');
  assert.ok(renameAudit);
  assert.equal(renameAudit.detail.fromName, 'Support Player');
  assert.equal(renameAudit.detail.toName, 'Clean Name');
  assert.equal(renameAudit.detail.note, 'Исправлено имя по жалобе');
});

test('support logout reports partial cleanup failures instead of claiming success', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare({
    reconnectFailure: true
  });
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const session = auth.createSession('support-player', 20_000);
  const ticket = auth.createSocketTicket('support-player', 20_100);
  assert.ok(session && ticket);
  const operator = await login(base, adminAuth, 'operator');

  const response = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Проверка частичного сбоя очистки'
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'support-logout-incomplete',
    accountId: 'support-player',
    revokedSessions: 1,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 0,
    disconnectedSockets: 2,
    failedSteps: ['reconnect-sessions']
  });

  assert.equal(auth.resolveSession(session.token, 20_200), null);
  assert.equal(auth.consumeSocketTicket(ticket.token, 20_200), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'later cleanup steps still run after an earlier local failure');
  assert.deepEqual(incidentEvents, [], 'partial cleanup must not claim forced-logout completion');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.deepEqual(audit.detail, {
    note: 'Проверка частичного сбоя очистки',
    revokedSessions: 1,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 0,
    disconnectedSockets: 2,
    complete: false,
    failedSteps: ['reconnect-sessions']
  });
});

test('support logout continues local cleanup when HTTP session revocation fails', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations, incidentEvents } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const session = auth.createSession('support-player', 30_000);
  const ticket = auth.createSocketTicket('support-player', 30_100);
  assert.ok(session && ticket);
  auth.revokeAccountSessions = () => {
    throw new Error('injected durable session failure');
  };
  const operator = await login(base, adminAuth, 'operator');

  const response = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Проверка отказа хранилища сессий'
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'support-logout-incomplete',
    accountId: 'support-player',
    revokedSessions: 0,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    failedSteps: ['http-sessions']
  });

  assert.ok(auth.resolveSession(session.token, 30_200), 'failed durable path is reported, not hidden');
  assert.equal(auth.consumeSocketTicket(ticket.token, 30_200), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'all process-local cleanup still runs');
  assert.deepEqual(incidentEvents, [], 'durable cleanup failure must not claim logout completion');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.deepEqual(audit.detail, {
    note: 'Проверка отказа хранилища сессий',
    revokedSessions: 0,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    complete: false,
    failedSteps: ['http-sessions']
  });
});
