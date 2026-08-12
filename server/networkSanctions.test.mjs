import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkIdentity } = require('./networkIdentity');

function socket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.closed = null;
  ws.close = (code, reason) => {
    ws.closed = { code, reason };
    ws.readyState = 2;
    ws.emit('close');
  };
  return ws;
}

test('sanction policy blocks both fresh socket auth and resume binding', () => {
  const identity = new NetworkIdentity();
  identity.configure(
    ticket => (ticket === 'ticket' ? { accountId: 'blocked-player' } : null),
    accountId => accountId !== 'blocked-player'
  );

  const fresh = socket();
  assert.deepEqual(identity.authenticate(fresh, 'ticket'), { ok: false, reason: 'blocked-account' });
  assert.equal(fresh.accountId, undefined);
  assert.equal(fresh.accountAccessDeniedAccountId, 'blocked-player');

  const resumed = socket();
  assert.equal(identity.bindResumedPlayer(resumed, { accountId: 'blocked-player' }), false);
  assert.equal(resumed.accountId, undefined);
});

test('disconnectAccount closes every tracked socket for one account only', () => {
  const identity = new NetworkIdentity();
  identity.configure(ticket => ({ accountId: ticket }));
  const first = socket();
  const second = socket();
  const other = socket();
  assert.equal(identity.authenticate(first, 'player-a').ok, true);
  assert.equal(identity.authenticate(second, 'player-a').ok, true);
  assert.equal(identity.authenticate(other, 'player-b').ok, true);

  assert.equal(identity.disconnectAccount('player-a'), 2);
  assert.deepEqual(first.closed, { code: 4003, reason: 'account-sanctioned' });
  assert.deepEqual(second.closed, { code: 4003, reason: 'account-sanctioned' });
  assert.equal(other.closed, null);
  assert.equal(identity.disconnectAccount('player-a'), 0);
});
