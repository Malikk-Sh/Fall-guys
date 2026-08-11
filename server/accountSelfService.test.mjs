import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService, SESSION_COOKIE, hashToken, publicSessionId } = require('./auth');
const { AccountSelfService } = require('./accountSelfService');
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

test('rotating recovery code invalidates the old code and other persistent sessions atomically', () => {
  const context = fresh();
  const account = context.accounts.create('Recovery');
  const oldSecret = account.secret;
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const otherA = context.auth.createSession(account.id, now + 1);
  const otherB = context.auth.createSession(account.id, now + 2);

  const rotated = context.selfService.rotateRecoveryCode({
    accountId: account.id,
    currentToken: current.token,
    now: now + 100
  });
  assert.match(rotated.secret, /^WOBBLE-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
  assert.equal(rotated.revokedSessions, 2);
  assert.equal(context.accounts.login(oldSecret), null);
  assert.equal(context.accounts.login(rotated.secret).id, account.id);
  assert.equal(context.auth.resolveSession(current.token).accountId, account.id);
  assert.equal(context.auth.resolveSession(otherA.token), null);
  assert.equal(context.auth.resolveSession(otherB.token), null);
  context.db.close();
});

test('HTTP self-service requires the HttpOnly session and keeps the current browser signed in', async () => {
  const context = fresh();
  const account = context.accounts.create('HTTP Self Service');
  const oldSecret = account.secret;
  const current = context.auth.createSession(account.id);
  const other = context.auth.createSession(account.id);
  const app = express();
  install(app, context);
  const server = await listen(app);

  try {
    const denied = await fetch(`${server.url}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(denied.status, 401);

    const listed = await fetch(`${server.url}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: '{}'
    });
    assert.equal(listed.status, 200);
    assert.match(listed.headers.get('cache-control') || '', /no-store/);
    const sessions = (await listed.json()).sessions;
    assert.equal(sessions.length, 2);
    const currentSession = sessions.find(item => item.current);
    const otherSession = sessions.find(item => !item.current);

    const currentRevoke = await fetch(`${server.url}/api/auth/sessions/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ sessionId: currentSession.id })
    });
    assert.equal(currentRevoke.status, 409);
    assert.equal((await currentRevoke.json()).error, 'current-session');

    const revoke = await fetch(`${server.url}/api/auth/sessions/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ sessionId: otherSession.id })
    });
    assert.equal(revoke.status, 200);
    assert.equal((await revoke.json()).removed, true);
    assert.equal(context.auth.resolveSession(other.token), null);

    const third = context.auth.createSession(account.id);
    const rotate = await fetch(`${server.url}/api/auth/recovery/rotate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: '{}'
    });
    assert.equal(rotate.status, 200);
    assert.match(rotate.headers.get('cache-control') || '', /no-store/);
    const rotated = await rotate.json();
    assert.equal(rotated.revokedSessions, 1);
    assert.equal(context.accounts.login(oldSecret), null);
    assert.equal(context.accounts.login(rotated.secret).id, account.id);
    assert.equal(context.auth.resolveSession(third.token), null);
    assert.equal(context.auth.resolveSession(current.token).accountId, account.id);

    const after = await fetch(`${server.url}/api/auth/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: '{}'
    });
    const afterSessions = (await after.json()).sessions;
    assert.deepEqual(
      afterSessions.map(item => item.current),
      [true]
    );
  } finally {
    await server.close();
    context.db.close();
  }
});
