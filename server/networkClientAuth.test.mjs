import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkManager } from '../client/net/NetworkManager.js';
import { C2S, S2C } from '../shared/protocol.js';

function storageStub() {
  const values = new Map();
  return {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key)
  };
}

test('NetworkManager sends one WST AUTH before queued room command', async () => {
  const previousStorage = globalThis.sessionStorage;
  const previousWebSocket = globalThis.WebSocket;
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storageStub(),
    configurable: true,
    writable: true
  });
  globalThis.WebSocket = { OPEN: 1 };

  try {
    const sent = [];
    let ticketCalls = 0;
    const ui = {
      status: () => {},
      error: () => {},
      toast: () => {},
      accountToken: async () => {
        ticketCalls += 1;
        return 'WST.client-one-time-ticket-1234567890';
      }
    };
    const net = new NetworkManager(ui);
    net.ws = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
    net.pendingWelcome = { id: 'socket-player', token: 'room-session' };
    net.authInFlight = false;
    net.handshakeReady = false;
    net.queue.push(JSON.stringify({ type: C2S.CREATE_ROOM, name: 'Queued' }));

    await net.authenticateSocket();
    assert.equal(ticketCalls, 1);
    assert.deepEqual(sent, [{ type: C2S.AUTH, ticket: 'WST.client-one-time-ticket-1234567890' }]);
    assert.equal(net.handshakeReady, false);

    net.handleMessage({ type: S2C.AUTHENTICATED, accountId: 'acc-1' });
    assert.equal(net.handshakeReady, true);
    assert.equal(sent[1].type, C2S.CREATE_ROOM);
    assert.equal(Object.hasOwn(sent[1], 'accountToken'), false);
  } finally {
    if (previousStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousStorage;
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});
