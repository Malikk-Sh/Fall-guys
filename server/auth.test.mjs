import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService, hashToken, SOCKET_TICKET_TTL_MS } = require('./auth');

function setup(options = {}) {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db, ...options });
  return { db, accounts, auth };
}

test('recovery credential превращается в отдельную persistent session', () => {
  const { db, accounts, auth } = setup({ sessionTtlMs: 10_000 });
  const created = accounts.create('Session Player');
  const now = 100_000;
  const session = auth.createSession(created.id, now);

  assert.ok(session.token.length > 30);
  assert.notEqual(session.token, created.secret);
  assert.equal(auth.resolveSession(session.token, now + 100).accountId, created.id);
  assert.equal(
    db.prepare('SELECT account_id FROM account_sessions WHERE token_hash = ?').get(hashToken(session.token))
      .account_id,
    created.id
  );
  assert.equal(auth.resolveSession(session.token, now + 20_000), null, 'истёкшая session удаляется');
  db.close();
});

test('logout отзывает только текущую session', () => {
  const { db, accounts, auth } = setup();
  const created = accounts.create('Multi Session');
  const first = auth.createSession(created.id);
  const second = auth.createSession(created.id);
  assert.equal(auth.revokeSession(first.token), true);
  assert.equal(auth.resolveSession(first.token), null);
  assert.equal(auth.resolveSession(second.token).accountId, created.id);
  db.close();
});

test('provider subject нельзя привязать к двум Wobble accounts', () => {
  const { db, accounts, auth } = setup();
  const a = accounts.create('A');
  const b = accounts.create('B');
  assert.equal(auth.linkIdentity({ provider: 'google', subject: 'google-sub', accountId: a.id }).accountId, a.id);
  assert.equal(auth.linkIdentity({ provider: 'google', subject: 'google-sub', accountId: b.id }), null);
  assert.equal(auth.identity('google', 'google-sub').accountId, a.id);
  assert.equal(auth.identities(a.id)[0].provider, 'google');
  db.close();
});

test('WebSocket получает короткий ticket, а не recovery code', () => {
  const { db, accounts, auth } = setup();
  const created = accounts.create('Network');
  const now = 500_000;
  const ticket = auth.createSocketTicket(created.id, now);

  assert.match(ticket.token, /^WST\./);
  assert.notEqual(ticket.token, created.secret);
  assert.equal(auth.resolveSocketTicket(ticket.token, now + SOCKET_TICKET_TTL_MS - 1).accountId, created.id);
  assert.equal(auth.resolveSocketTicket(ticket.token, now + SOCKET_TICKET_TTL_MS + 1), null);
  db.close();
});
