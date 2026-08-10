import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkManager } from '../client/net/NetworkManager.js';
import { C2S, PROTOCOL_VERSION } from '../shared/protocol.js';

const stubUi = () => ({
  status: () => {},
  error: () => {},
  toast: () => {}
});

test('findCoop не передаёт account credential в quick matchmaking', () => {
  const previousStorage = globalThis.sessionStorage;
  const previousWebSocket = globalThis.WebSocket;
  const storage = new Map();

  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    configurable: true,
    writable: true
  });
  globalThis.WebSocket = { OPEN: 1 };

  try {
    const sent = [];
    const net = new NetworkManager(stubUi());
    net.ws = { readyState: 1, send: payload => sent.push(JSON.parse(payload)) };
    net.handshakeReady = true;
    net.connect = () => {};

    // Даже если старый вызывающий код попытается подложить accountToken, новый NetworkManager
    // намеренно не принимает его в своей сигнатуре и не сериализует в FIND_COOP.
    net.findCoop({
      name: 'Malik',
      playerId: 'player-1',
      accountToken: 'must-not-leave-socket-auth',
      chapterId: 'ch7'
    });

    assert.deepEqual(sent, [
      {
        type: C2S.FIND_COOP,
        name: 'Malik',
        playerId: 'player-1',
        chapterId: 'ch7',
        protocolVersion: PROTOCOL_VERSION
      }
    ]);
    assert.equal(Object.hasOwn(sent[0], 'accountToken'), false);
  } finally {
    if (previousStorage === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousStorage;
    if (previousWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previousWebSocket;
  }
});
