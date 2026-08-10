import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService } = require('./auth');
const { NetworkIdentity } = require('./networkIdentity');

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db });
  const identity = new NetworkIdentity();
  identity.configure(ticket => auth.consumeSocketTicket(ticket));
  return { db, accounts, auth, identity };
}

test('socket auth consumes WST once and binds accountId to one WebSocket', () => {
  const { db, accounts, auth, identity } = setup();
  const account = accounts.create('Socket Player');
  const ticket = auth.createSocketTicket(account.id).token;
  const ws = {};

  assert.deepEqual(identity.authenticate(ws, ticket), { ok: true, accountId: account.id });
  assert.equal(ws.accountId, account.id);
  assert.equal(identity.accountForSocket(ws, accounts).id, account.id);

  const replay = identity.authenticate({}, ticket);
  assert.deepEqual(replay, { ok: false, reason: 'invalid-ticket' });
  db.close();
});

test('повторный AUTH не может сменить account уже привязанного WebSocket', () => {
  const { db, accounts, auth, identity } = setup();
  const first = accounts.create('First');
  const second = accounts.create('Second');
  const ws = {};

  assert.equal(identity.authenticate(ws, auth.createSocketTicket(first.id).token).ok, true);
  const secondTicket = auth.createSocketTicket(second.id).token;
  assert.deepEqual(identity.authenticate(ws, secondTicket), { ok: false, reason: 'already-bound' });
  assert.equal(ws.accountId, first.id);

  // Ticket второго account не был принят этим сокетом и остаётся пригоден для своего соединения.
  assert.equal(identity.authenticate({}, secondTicket).accountId, second.id);
  db.close();
});

test('resume наследует accountId игрока и отклоняет конфликтующую socket identity', () => {
  const identity = new NetworkIdentity();
  const player = { accountId: 'acc-1' };
  const reconnect = {};
  assert.equal(identity.bindResumedPlayer(reconnect, player), true);
  assert.equal(reconnect.accountId, 'acc-1');

  const conflict = { accountId: 'acc-2' };
  assert.equal(identity.bindResumedPlayer(conflict, player), false);
  assert.equal(conflict.accountId, 'acc-2');
});
