import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService } = require('./auth');
const { NetworkIdentity } = require('./networkIdentity');

test('socket identity accepts issued WST but never a recovery code', () => {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db });
  const identity = new NetworkIdentity();
  identity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = accounts.create('Boundary');

  assert.deepEqual(identity.authenticate({}, account.secret), { ok: false, reason: 'invalid-ticket' });

  const ws = {};
  const ticket = auth.createSocketTicket(account.id).token;
  assert.deepEqual(identity.authenticate(ws, ticket), { ok: true, accountId: account.id });
  assert.equal(ws.accountId, account.id);
  db.close();
});
