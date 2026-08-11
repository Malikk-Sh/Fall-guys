import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService, SESSION_COOKIE, hashToken, publicSessionId } = require('./auth');
const { AccountSelfService, RECOVERY_ROTATION_TTL_MS } = require('./accountSelfService');
const { installAuthRoutes } = require('./authRoutes');

function fresh() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db });
  const selfService = new AccountSelfService({ db, auth });
  return { db, accounts, auth, selfService };
}

async function listen(app) {
  const server = await new Promise(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function cookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function install(app, context) {
  return installAuthRoutes({
    app,
    accounts: context.accounts,
    auth: context.auth,
    google: { enabled: false, clientId: null },
    secureCookies: false,
    accountPayload: account => ({
      ok: true,
      account: { id: account.id, name: account.name },
      records: [],
      progress: null,
      profile: null,
      inventory: null
    })
  });
}

test('session self-service exposes opaque ids and can revoke only another session', () => {
  const context = fresh();
  const account = context.accounts.create('Devices');
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const other = context.auth.createSession(account.id, now + 10);

  const sessions = context.auth.listSessions(account.id, current.token, now + 20);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.match(sessions[0].id, /^[a-f0-9]{24}$/);
  assert.equal(sessions[0].id, publicSessionId(hashToken(current.token)));
  assert.equal(
    sessions.some(item => item.id === current.token),
    false,
    'raw bearer never leaves AuthService'
  );

  assert.deepEqual(
    context.auth.revokeAccountSession({
      accountId: account.id,
      sessionId: sessions[0].id,
      currentToken: current.token
    }),
    { ok: false, reason: 'current-session' }
  );

  const otherPublic = sessions.find(item => !item.current);
  assert.deepEqual(
    context.auth.revokeAccountSession({
      accountId: account.id,
      sessionId: otherPublic.id,
      currentToken: current.token
    }),
    { ok: true, removed: true }
  );
  assert.equal(context.auth.resolveSession(other.token, now + 30), null);
  assert.equal(context.auth.resolveSession(current.token, now + 30).accountId, account.id);
  context.db.close();
});

test('recovery rotation is staged, atomic on confirm and idempotent after a lost response', () => {
  const context = fresh();
  const account = context.accounts.create('Recovery');
  const oldSecret = account.secret;
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const otherA = context.auth.createSession(account.id, now + 1);
  const otherB = context.auth.createSession(account.id, now + 2);

  const prepared = context.selfService.prepareRecoveryCode({ accountId: account.id, now: now + 20 });
  assert.match(prepared.secret, /^WOBBLE-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
  assert.equal(
    context.accounts.login(oldSecret).id,
    account.id,
    'prepare keeps the old recovery code active'
  );
  assert.equal(
    context.auth.resolveSession(otherA.token).accountId,
    account.id,
    'prepare revokes no sessions'
  );

  const confirmed = context.selfService.confirmRecoveryCode({
    accountId: account.id,
    currentToken: current.token,
    secret: prepared.secret,
    now: now + 100
  });
  assert.deepEqual(confirmed, {
    ok: true,
    confirmed: true,
    alreadyConfirmed: false,
    revokedSessions: 2
  });
  assert.equal(context.accounts.login(oldSecret), null);
  assert.equal(context.accounts.login(prepared.secret).id, account.id);
  assert.equal(context.auth.resolveSession(current.token).accountId, account.id);
  assert.equal(context.auth.resolveSession(otherA.token), null);
  assert.equal(context.auth.resolveSession(otherB.token), null);

  assert.deepEqual(
    context.selfService.confirmRecoveryCode({
      accountId: account.id,
      currentToken: current.token,
      secret: prepared.secret,
      now: now + 200
    }),
    { ok: true, confirmed: true, alreadyConfirmed: true, revokedSessions: 0 },
    'retry after an ambiguous response is safe'
  );
  context.db.close();
});

test('expired prepared recovery code never invalidates the active code', () => {
  const context = fresh();
  const account = context.accounts.create('Expiry');
  const oldSecret = account.secret;
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const prepared = context.selfService.prepareRecoveryCode({ accountId: account.id, now });

  assert.deepEqual(
    context.selfService.confirmRecoveryCode({
      accountId: account.id,
      currentToken: current.token,
      secret: prepared.secret,
      now: now + RECOVERY_ROTATION_TTL_MS + 1
    }),
    { ok: false, reason: 'rotation-expired' }
  );
  assert.equal(context.accounts.login(oldSecret).id, account.id);
  assert.equal(context.accounts.login(prepared.secret), null);
  context.db.close();
});

test('HTTP staged recovery requires a session and keeps the old code until confirm', async () => {
  const context = fresh();
  const account = context.accounts.create('HTTP Self Service');
  const oldSecret = account.secret;
  const current = context.auth.createSession(account.id);
  const other = context.auth.createSession(account.id);
  const app = express();
  install(app, context);
  const server = await listen(app);

  try {
    const denied = await fetch(`${server.url}/api/auth/recovery/rotate/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(denied.status, 401);

    const preparedResponse = await fetch(`${server.url}/api/auth/recovery/rotate/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: '{}'
    });
    assert.equal(preparedResponse.status, 200);
    assert.match(preparedResponse.headers.get('cache-control') || '', /no-store/);
    const prepared = await preparedResponse.json();
    assert.equal(context.accounts.login(oldSecret).id, account.id);
    assert.equal(context.auth.resolveSession(other.token).accountId, account.id);

    const confirm = await fetch(`${server.url}/api/auth/recovery/rotate/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ secret: prepared.secret })
    });
    assert.equal(confirm.status, 200);
    assert.match(confirm.headers.get('cache-control') || '', /no-store/);
    const confirmed = await confirm.json();
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.alreadyConfirmed, false);
    assert.equal(confirmed.revokedSessions, 1);
    assert.equal(context.accounts.login(oldSecret), null);
    assert.equal(context.accounts.login(prepared.secret).id, account.id);
    assert.equal(context.auth.resolveSession(other.token), null);
    assert.equal(context.auth.resolveSession(current.token).accountId, account.id);

    const retry = await fetch(`${server.url}/api/auth/recovery/rotate/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ secret: prepared.secret })
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).alreadyConfirmed, true);
  } finally {
    await server.close();
    context.db.close();
  }
});
