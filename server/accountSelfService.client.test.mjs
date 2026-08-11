import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listAccountSessions,
  revokeAccountSession,
  revokeOtherAccountSessions,
  rotateRecoveryCode,
  logoutAccount
} from '../client/core/account.js';

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

test('recovery rotation returns the one-time replacement code and logout stays session-only', async () => {
  const replacement = 'replacement-code-for-test';
  const server = fakeServer({
    '/api/auth/recovery/rotate': () => ({
      status: 200,
      data: { ok: true, secret: replacement, revokedSessions: 3 }
    }),
    '/api/auth/logout': () => ({ status: 200, data: { ok: true } })
  });

  const rotated = await rotateRecoveryCode({ fetchImpl: server.fetchImpl });
  assert.equal(rotated.secret, replacement);
  assert.equal(rotated.revokedSessions, 3);
  assert.equal(await logoutAccount({ fetchImpl: server.fetchImpl }), true);
  assert.deepEqual(
    server.calls.map(call => [call.path, call.body]),
    [
      ['/api/auth/recovery/rotate', {}],
      ['/api/auth/logout', {}]
    ]
  );
});
