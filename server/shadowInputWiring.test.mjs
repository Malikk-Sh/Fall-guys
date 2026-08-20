import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('./shadowInputPreload');
const WebSocket = require('ws');
const { PROTOCOL_VERSION } = require('../shared/protocol.js');
const { server, rooms, resetRateLimits } = require('./index');

const WAIT_MS = 10_000;

class TestClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  wait(type, predicate = () => true) {
    const existing = this.messages.find(message => message.type === type && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), WAIT_MS);
      this.waiters.push({
        match: message => {
          if (message.type !== type || !predicate(message)) return false;
          clearTimeout(timer);
          return true;
        },
        resolve
      });
    });
  }

  send(type, data = {}) {
    this.ws.send(JSON.stringify({ type, ...data }));
  }

  close() {
    return new Promise(resolve => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 500);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const closeServer = () => new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

test('live CLIENT_INPUT feeds the 30 Hz shadow runtime without mutating legacy player state', async t => {
  resetRateLimits();
  rooms.clear();
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new TestClient(url);
  const second = new TestClient(url);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    rooms.clear();
    await closeServer();
  });

  const [firstHello] = await Promise.all([first.wait('hello'), second.wait('hello')]);
  first.send('findCoop', {
    name: 'Shadow A',
    chapterId: 'ch1',
    protocolVersion: PROTOCOL_VERSION
  });
  await first.wait('matchmakingWaiting');
  second.send('findCoop', {
    name: 'Shadow B',
    chapterId: 'ch1',
    protocolVersion: PROTOCOL_VERSION
  });
  const [firstStart, secondStart] = await Promise.all([first.wait('start'), second.wait('start')]);
  assert.equal(firstStart.matchId, secondStart.matchId);

  const room = [...rooms.values()].find(item => item.matchId === firstStart.matchId);
  const player = room.players.get(firstHello.id);
  assert.ok(player);
  assert.equal(
    await waitFor(() => bridge.attachedCount() >= 2),
    true,
    'bridge attaches to active player sockets before input is sampled'
  );

  const legacyBefore = structuredClone(player.last);
  const metricsBefore = bridge.runtime.metrics();
  first.send('input', {
    matchId: firstStart.matchId,
    sequence: 0,
    clientTick: 0,
    moveX: 0.25,
    moveZ: 1,
    jumpPressed: true,
    jumpHeld: true,
    divePressed: false,
    cameraYaw: 0.5
  });

  assert.equal(
    await waitFor(() => bridge.runtime.metrics().processed > metricsBefore.processed),
    true,
    'fixed shadow tick consumes the live input'
  );
  const shadow = bridge.runtime.snapshot(player);
  assert.equal(shadow.lastProcessedInput, 0);
  assert.equal(shadow.matchId, firstStart.matchId);
  assert.deepEqual(player.last, legacyBefore, 'shadow simulation never replaces legacy authoritative state');

  const acknowledgement = await first.wait(
    'snapshot',
    message =>
      message.matchId === firstStart.matchId &&
      message.lastProcessedInput === 0 &&
      message.shadowPlayerState !== undefined
  );
  assert.equal(acknowledgement.lastProcessedInput, 0);
  assert.ok(Number.isSafeInteger(acknowledgement.serverTick));
  assert.ok(acknowledgement.serverTick >= shadow.lastServerTick);
  assert.ok(acknowledgement.shadowPlayerState);
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.position.x));
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.position.y));
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.position.z));
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.velocity.x));
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.velocity.y));
  assert.ok(Number.isFinite(acknowledgement.shadowPlayerState.velocity.z));
  assert.equal(typeof acknowledgement.shadowPlayerState.grounded, 'boolean');
  assert.equal(
    second.messages.some(
      message =>
        message.type === 'snapshot' &&
        (message.lastProcessedInput !== undefined || message.shadowPlayerState !== undefined)
    ),
    false,
    'shadow acknowledgement and simulation state stay personalized to their owner'
  );

  const staleBefore = bridge.runtime.metrics().rejected.staleSequence;
  first.send('input', {
    matchId: firstStart.matchId,
    sequence: 0,
    clientTick: 0,
    moveX: 0,
    moveZ: 0,
    jumpPressed: false,
    jumpHeld: false,
    divePressed: false,
    cameraYaw: 0
  });
  assert.equal(
    await waitFor(() => bridge.runtime.metrics().rejected.staleSequence > staleBefore),
    true,
    'replayed input is diagnostic-only and rejected by ordering'
  );
});
