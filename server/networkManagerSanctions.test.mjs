import test from 'node:test';
import assert from 'node:assert/strict';

class FakeWebSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.closed = false;
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

globalThis.WebSocket = FakeWebSocket;

const { NetworkManager, LINK_STATE } = await import('../client/net/NetworkManager.js');

test('a sanctioned account cannot degrade to the ordinary anonymous handshake', async () => {
  const messages = [];
  const sanction = { reason: 'griefing', expiresAt: Date.now() + 60_000, permanent: false };
  const ui = {
    accountToken: async () => ({ blocked: true, sanction }),
    status: message => messages.push(['status', message]),
    error: message => messages.push(['error', message])
  };
  const manager = new NetworkManager(ui);
  const socket = new FakeWebSocket();
  manager.ws = socket;
  manager.pendingWelcome = { id: 'anonymous-id', token: 'anonymous-resume' };

  await manager.authenticateSocket();

  assert.equal(manager.accessBlocked, true);
  assert.equal(manager.handshakeReady, false);
  assert.equal(manager.id, null, 'anonymous welcome must never be adopted');
  assert.equal(manager.sessionToken, null, 'anonymous resume token must never be saved');
  assert.equal(socket.sent.length, 0, 'no room/auth traffic is sent after the sanction decision');
  assert.equal(socket.closed, true);
  assert.equal(manager.linkState, LINK_STATE.FAILED);
  assert.equal(manager.send('create', { name: 'Bypass' }), false);
  assert.ok(messages.some(([, message]) => String(message).includes('ограничен')));
});

test('server-side ACCOUNT_SANCTIONED error hard-blocks reconnect instead of adopting welcome', () => {
  const ui = { status() {}, error() {}, accountToken: async () => null };
  const manager = new NetworkManager(ui);
  const socket = new FakeWebSocket();
  manager.ws = socket;
  manager.pendingWelcome = { id: 'anonymous-id', token: 'anonymous-resume' };
  manager.resumeInFlight = true;
  manager.handleMessage({ type: 'error', code: 'ACCOUNT_SANCTIONED' });

  assert.equal(manager.accessBlocked, true);
  assert.equal(manager.handshakeReady, false);
  assert.equal(manager.id, null);
  assert.equal(socket.closed, true);
});
