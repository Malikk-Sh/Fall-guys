import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitStagedRecoveryCode,
  confirmRecoveryCode,
  currentAccount,
  forgetAccountChecked,
  listAccountSessions,
  prepareRecoveryCode,
  rememberAccount,
  revokeAccountSession,
  revokeOtherAccountSessions,
  stageRecoveryCode,
  switchAccount
} from '../client/core/account.js';

function memoryStorage() {
  let value = null;
  let failWrites = false;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      if (failWrites) throw new Error('storage unavailable');
      value = next;
    },
    failWrites: () => {
      failWrites = true;
    }
  };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchImpl = async (path, init) => {
    const body = JSON.parse(init.body || '{}');
    calls.push({ path, body, credentials: init.credentials });
    const result = await handlers[path](body);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.data
    };
  };
  return { fetchImpl, calls };
}

test('account client lists and revokes sessions without ever handling the cookie bearer', async () => {
  const server = fakeServer({
    '/api/auth/sessions': () => ({
      status: 200,
      data: {
        ok: true,
        sessions: [
          { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', current: true, lastSeenAt: 1, expiresAt: 2 },
          { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', current: false, lastSeenAt: 1, expiresAt: 2 }
        ]
      }
    }),
    '/api/auth/sessions/revoke': body => ({
      status: 200,
      data: { ok: true, removed: body.sessionId === 'bbbbbbbbbbbbbbbbbbbbbbbb' }
    }),
    '/api/auth/sessions/revoke-others': () => ({ status: 200, data: { ok: true, revoked: 2 } })
  });

  const sessions = await listAccountSessions({ fetchImpl: server.fetchImpl });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.equal(
    (await revokeAccountSession('bbbbbbbbbbbbbbbbbbbbbbbb', { fetchImpl: server.fetchImpl })).removed,
    true
  );
  assert.equal((await revokeOtherAccountSessions({ fetchImpl: server.fetchImpl })).revoked, 2);
  assert.ok(server.calls.every(call => call.credentials === 'same-origin'));
  assert.equal(
    server.calls.some(call => 'token' in call.body || 'cookie' in call.body),
    false
  );
});

test('staged recovery keeps the active code and never changes the selected account', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'A', secret: 'OLD-A' }, storage);
  rememberAccount({ id: 'b', name: 'B', secret: 'OLD-B' }, storage);
  switchAccount('b', storage);

  const staged = stageRecoveryCode('a', 'NEW-A', Date.now() + 60_000, storage);
  assert.equal(staged.persisted, true);
  assert.equal(currentAccount(storage).id, 'b');
  const accountA = staged.state.accounts.find(account => account.id === 'a');
  assert.equal(accountA.secret, 'OLD-A');
  assert.equal(accountA.pendingRecovery.secret, 'NEW-A');

  const committed = commitStagedRecoveryCode('a', storage);
  assert.equal(committed.persisted, true);
  assert.equal(currentAccount(storage).id, 'b');
  const savedA = committed.state.accounts.find(account => account.id === 'a');
  assert.equal(savedA.secret, 'NEW-A');
  assert.equal(savedA.pendingRecovery, undefined);
});

test('checked logout detects a localStorage write failure instead of pretending the code was removed', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'A', secret: 'KEEP-ME' }, storage);
  storage.failWrites();

  const forgotten = forgetAccountChecked('a', storage);
  assert.equal(forgotten.persisted, false);
  assert.equal(currentAccount(storage).secret, 'KEEP-ME');
});

test('recovery prepare and confirm are separate same-origin requests', async () => {
  const replacement = 'replacement-code-for-test';
  const server = fakeServer({
    '/api/auth/recovery/rotate/prepare': () => ({
      status: 200,
      data: { ok: true, secret: replacement, expiresAt: Date.now() + 60_000 }
    }),
    '/api/auth/recovery/rotate/confirm': body => ({
      status: 200,
      data: { ok: true, confirmed: true, alreadyConfirmed: false, revokedSessions: 3, echoed: body.secret }
    })
  });

  const prepared = await prepareRecoveryCode({ fetchImpl: server.fetchImpl });
  assert.equal(prepared.secret, replacement);
  const confirmed = await confirmRecoveryCode(prepared.secret, { fetchImpl: server.fetchImpl });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.revokedSessions, 3);
  assert.deepEqual(
    server.calls.map(call => [call.path, call.body]),
    [
      ['/api/auth/recovery/rotate/prepare', {}],
      ['/api/auth/recovery/rotate/confirm', { secret: replacement }]
    ]
  );
});
