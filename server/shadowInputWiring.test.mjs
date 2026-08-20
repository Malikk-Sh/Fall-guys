import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('./shadowInputPreload');
const WebSocket = require('ws');
const { PROTOCOL_VERSION } = require('../shared/protocol.js');
const gameRules = require('./gameRules');
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

test('live shadow bridge follows the socket while legacy gameplay remains default authority', async t => {
  resetRateLimits();
  rooms.clear();
  assert.equal(
    gameRules.canFinish,
    bridge.finishAuthorityCoreBridge.canFinish,
    'preload installs the guarded finish gate before core captures gameRules'
  );
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
  assert.equal(
    bridge.finishAuthorityCoreBridge.managesPlayer(player),
    true,
    'active human player receives the bounded authoritative finish-time seam'
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
  assert.equal(
    acknowledgement.raceAuthoritySource,
    null,
    'co-op never advertises an authoritative race reconciliation source'
  );
  assert.equal(
    acknowledgement.movementAuthoritySource,
    null,
    'co-op never advertises an authoritative movement source'
  );
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
        (message.lastProcessedInput !== undefined ||
          message.shadowPlayerState !== undefined ||
          message.raceAuthoritySource !== undefined ||
          message.movementAuthoritySource !== undefined)
    ),
    false,
    'shadow acknowledgement, simulation state and authority marker stay personalized to their owner'
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

  first.send('create', {
    name: 'Shadow Race',
    mode: 'race',
    protocolVersion: PROTOCOL_VERSION
  });
  const isRaceLobby = message => message.mode === 'race' && message.players.length === 1;
  const raceLobby = await first.wait('lobby', isRaceLobby);
  const raceRoom = rooms.get(raceLobby.code);
  const racePlayer = raceRoom.players.get(firstHello.id);
  assert.ok(racePlayer, 'same socket identity enters the new race room');

  first.send('ready', { ready: true });
  const raceReady = message => {
    if (message.code !== raceLobby.code) return false;
    return message.players.some(item => item.id === firstHello.id && item.ready);
  };
  await first.wait('lobby', raceReady);
  first.send('start');
  const isNewRaceStart = message => message.mode === 'race' && message.matchId !== firstStart.matchId;
  const raceStart = await first.wait('start', isNewRaceStart);
  assert.equal(raceRoom.matchId, raceStart.matchId);
  assert.equal(
    await waitFor(() => bridge.finishAuthorityCoreBridge.managesPlayer(racePlayer)),
    true,
    'reused socket installs finish timing on the current race player object'
  );

  const checkpointMetricsBefore = bridge.checkpointAuthorityApplier.metrics();
  await sleep(Math.max(0, raceStart.at - Date.now() - 250));
  const state = racePlayer.last;
  first.send('state', {
    matchId: raceStart.matchId,
    sequence: 0,
    state: {
      x: state.x,
      y: state.y,
      z: state.z,
      ry: state.ry,
      vx: state.vx,
      vy: state.vy || 0,
      vz: state.vz,
      state: state.state
    }
  });

  assert.equal(
    await waitFor(() => racePlayer.lastSequence === 0),
    true,
    'core accepts a state after the socket moves to a new room'
  );
  const checkpointAuthorityObserved = () => {
    const current = bridge.checkpointAuthorityApplier.metrics();
    return current.attempts > checkpointMetricsBefore.attempts;
  };
  assert.equal(
    await waitFor(checkpointAuthorityObserved),
    true,
    'post-core checkpoint authority runs for the current race player on the reused socket'
  );
  const checkpointMetrics = bridge.checkpointAuthorityApplier.metrics();
  assert.ok(checkpointMetrics.legacyDecisions > checkpointMetricsBefore.legacyDecisions);
  assert.equal(checkpointMetrics.appliedAdvances, checkpointMetricsBefore.appliedAdvances);
  assert.equal(racePlayer.checkpoint, 0, 'default authority never rewrites the legacy checkpoint');

  first.send('input', {
    matchId: raceStart.matchId,
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
    await waitFor(() => {
      const raceShadow = bridge.runtime.snapshot(racePlayer);
      return raceShadow?.matchId === raceStart.matchId && raceShadow.lastProcessedInput === 0;
    }),
    true,
    'new race input creates a match-scoped owner shadow snapshot'
  );

  const legacyAuthoritySnapshot = await first.wait(
    'snapshot',
    message => message.matchId === raceStart.matchId && message.raceAuthoritySource === 'legacy'
  );
  assert.equal(
    legacyAuthoritySnapshot.raceAuthoritySource,
    'legacy',
    'owner snapshot exposes the match-scoped authority lease before reconciliation can cut over'
  );

  // The movement lease is granted on the fixed server tick, so it can trail the race lease by a
  // tick or two on a busy runner. Wait for the marker instead of assuming both land together.
  const legacyMovementSnapshot = await first.wait(
    'snapshot',
    message => message.matchId === raceStart.matchId && message.movementAuthoritySource === 'legacy'
  );
  assert.equal(
    legacyMovementSnapshot.movementAuthoritySource,
    'legacy',
    'owner snapshot exposes the match-scoped movement lease so the client cannot reconcile movement'
  );
  const movementAuthority = bridge.movementAuthorityMetrics();
  assert.ok(movementAuthority.decisions > 0, 'the fixed tick evaluates movement authority');
  assert.equal(movementAuthority.shadow, 0, 'default parity evidence never grants shadow movement');
  assert.equal(movementAuthority.errors, 0, 'movement authority evaluation stays free of errors');
});
