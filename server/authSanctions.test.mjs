import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService, cookieForSession } = require('./auth');
const { AdminAuthService } = require('./adminAuth');
const { PlayerSanctions } = require('./playerSanctions');
const { installAuthRoutes } = require('./authRoutes');

async function setup() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const created = accounts.create('Blocked Player', 100);
  const auth = new AuthService({ db });
  const adminAuth = new AdminAuthService({ db });
  const moderator = adminAuth.createUser({ name: 'Moderator', role: 'moderator', now: 110 });
  const sanctions = new PlayerSanctions({ db });
  const app = express();
  installAuthRoutes({
    app,
    accounts,
    auth,
    sanctions,
    google: { enabled: false, clientId: null },
    accountPayload: account => ({ ok: true, account: { id: account.id, name: account.name } }),
    secureCookies: false
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    db,
    accounts,
    created,
    auth,
    sanctions,
    moderator,
    server,
    base: `http://127.0.0.1:${server.address().port}`
  };
}

test('an active ban blocks existing sessions and recovery login without leaking moderator note', async t => {
  const ctx = await setup();
  t.after(() => {
    ctx.server.close();
    ctx.db.close();
  });

  const session = ctx.auth.createSession(ctx.created.id, Date.now());
  assert.ok(session);
  const applied = ctx.sanctions.apply({
    accountId: ctx.created.id,
    kind: 'ban',
    reason: 'griefing',
    note: 'Internal moderation evidence must never be public.',
    createdByAdminId: ctx.moderator.user.id,
    durationMs: 60 * 60 * 1000,
    now: Date.now()
  });
  assert.equal(applied.ok, true);

  const sessionResponse = await fetch(`${ctx.base}/api/auth/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieForSession(session.token, { secure: false }).split(';', 1)[0]
    },
    body: '{}'
  });
  assert.equal(sessionResponse.status, 403);
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionBody.error, 'account-sanctioned');
  assert.equal(sessionBody.sanction.reason, 'griefing');
  assert.equal(sessionBody.sanction.permanent, false);
  assert.equal(JSON.stringify(sessionBody).includes('Internal moderation evidence'), false);
  assert.match(sessionResponse.headers.get('set-cookie') || '', /Max-Age=0/);
  assert.equal(ctx.auth.listSessions(ctx.created.id, '').length, 0);

  const recoveryResponse = await fetch(`${ctx.base}/api/auth/recovery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: ctx.created.secret })
  });
  assert.equal(recoveryResponse.status, 403);
  const recoveryBody = await recoveryResponse.json();
  assert.deepEqual(recoveryBody.sanction, sessionBody.sanction);
});
