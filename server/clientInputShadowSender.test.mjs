import test from 'node:test';
import assert from 'node:assert/strict';

import { C2S, S2C } from '../shared/protocol.js';
import {
  CLIENT_INPUT_INTERVAL_MS,
  ClientInputShadowSender,
  installClientInputShadowBridge
} from '../client/net/clientInputShadowBridge.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function network(matchId = 'match-a') {
  return {
    matchId,
    finishSentFor: null,
    accessBlocked: false,
    versionMismatch: false,
    handshakeReady: true,
    ws: { readyState: 1 },
    sent: [],
    raw(payload) {
      this.sent.push(structuredClone(payload));
    }
  };
}

function input({ moveX = 0, moveZ = 0, jump = false, jumpHeld = false, dive = false } = {}) {
  return {
    jumpQueued: jump,
    diveQueued: dive,
    movement: () => ({ x: moveX, forward: moveZ, magnitude: Math.hypot(moveX, moveZ) }),
    isHeld: action => action === 'jump' && jumpHeld
  };
}

test('30 Hz sender latches one-shot actions until a network sample is emitted', () => {
  let now = 0;
  const sender = new ClientInputShadowSender({ storage: new MemoryStorage(), now: () => now });
  const net = network();
  sender.beginMatch(net.matchId);

  sender.capture(input({ moveX: 0.25, moveZ: 1, jump: true, jumpHeld: true }), 0.5);
  const first = sender.flush(net);
  assert.equal(first.type, C2S.CLIENT_INPUT);
  assert.equal(first.sequence, 0);
  assert.equal(first.clientTick, 0);
  assert.equal(first.jumpPressed, true);
  assert.equal(first.jumpHeld, true);
  assert.equal(first.divePressed, false);
  assert.equal(first.moveX, 0.25);
  assert.equal(first.moveZ, 1);

  sender.capture(input({ moveX: -0.5, moveZ: 0.25, dive: true }), -0.75);
  now = CLIENT_INPUT_INTERVAL_MS / 2;
  assert.equal(sender.flush(net), false, 'no second packet inside the 30 Hz interval');

  // A later physics step has already consumed the dive edge locally, but the sender must retain it.
  sender.capture(input({ moveX: -0.4, moveZ: 0.5, dive: false }), -0.5);
  now = CLIENT_INPUT_INTERVAL_MS + 0.01;
  const second = sender.flush(net);
  assert.equal(second.sequence, 1);
  assert.equal(second.clientTick, 1);
  assert.equal(second.jumpPressed, false);
  assert.equal(second.divePressed, true);
  assert.equal(second.moveX, -0.4, 'continuous movement uses the newest physics sample');
  assert.equal(second.moveZ, 0.5);
});

test('disconnected input never becomes a packet backlog and keeps one pending edge', () => {
  let now = 0;
  const sender = new ClientInputShadowSender({ storage: new MemoryStorage(), now: () => now });
  const net = network();
  sender.beginMatch(net.matchId);
  sender.capture(input({ moveZ: 1, jump: true }), 0);

  net.handshakeReady = false;
  assert.equal(sender.flush(net), false);
  now += CLIENT_INPUT_INTERVAL_MS * 4;
  sender.capture(input({ moveX: 1, moveZ: 0, jump: false }), 0.2);
  assert.equal(sender.flush(net), false);
  assert.equal(net.sent.length, 0);

  net.handshakeReady = true;
  const resumed = sender.flush(net);
  assert.equal(net.sent.length, 1, 'reconnect emits one current command, not queued historical samples');
  assert.equal(resumed.sequence, 0, 'failed sends do not advance ordering');
  assert.equal(resumed.jumpPressed, true, 'the one pending jump edge survives the disconnect');
  assert.equal(resumed.moveX, 1, 'continuous intent is refreshed to the newest sample');
  assert.equal(resumed.moveZ, 0);
});

test('cursor survives reload-style recreation for the same match and resets for a new match', () => {
  const storage = new MemoryStorage();
  let now = 0;
  const firstSender = new ClientInputShadowSender({ storage, now: () => now });
  const firstNet = network('match-a');
  firstSender.beginMatch(firstNet.matchId);
  firstSender.capture(input({ moveZ: 1 }), 0);
  assert.equal(firstSender.flush(firstNet).sequence, 0);

  now += CLIENT_INPUT_INTERVAL_MS + 1;
  const reloadedSender = new ClientInputShadowSender({ storage, now: () => now });
  const resumedNet = network('match-a');
  reloadedSender.beginMatch(resumedNet.matchId);
  reloadedSender.capture(input({ moveX: 0.5 }), 0.1);
  const resumed = reloadedSender.flush(resumedNet);
  assert.equal(resumed.sequence, 1);
  assert.equal(resumed.clientTick, 1);

  const nextNet = network('match-b');
  reloadedSender.beginMatch(nextNet.matchId);
  assert.equal(reloadedSender.flush(nextNet), false, 'a new match cannot replay the previous sample');
  reloadedSender.capture(input({ dive: true }), 0);
  const next = reloadedSender.flush(nextNet);
  assert.equal(next.sequence, 0);
  assert.equal(next.clientTick, 0);
  assert.equal(next.divePressed, true);
});

test('prototype bridge captures input before Player consumes it and installs idempotently', () => {
  const now = 0;
  const sender = new ClientInputShadowSender({ storage: new MemoryStorage(), now: () => now });

  class FakePlayer {
    step(_dt, currentInput) {
      this.consumedJump = currentInput.jumpQueued;
      currentInput.jumpQueued = false;
    }
  }

  class FakeNetwork {
    constructor() {
      Object.assign(this, network(null));
      this.baseTicks = 0;
    }

    handleMessage(message) {
      if (message.type === S2C.MATCH_START) this.matchId = message.matchId;
    }

    tick() {
      this.baseTicks += 1;
    }
  }

  installClientInputShadowBridge({ PlayerClass: FakePlayer, NetworkClass: FakeNetwork, sender });
  installClientInputShadowBridge({ PlayerClass: FakePlayer, NetworkClass: FakeNetwork, sender });

  const net = new FakeNetwork();
  net.handleMessage({ type: S2C.MATCH_START, matchId: 'match-live' });
  const controls = input({ moveZ: 1, jump: true, jumpHeld: true });
  const player = new FakePlayer();
  player.step(1 / 60, controls, 0.3, 0);
  assert.equal(player.consumedJump, true);
  assert.equal(controls.jumpQueued, false, 'local physics consumed the original edge');

  net.tick();
  assert.equal(net.baseTicks, 1, 'existing network tick still executes exactly once');
  assert.equal(net.sent.length, 1, 'idempotent installation does not duplicate network samples');
  assert.equal(net.sent[0].jumpPressed, true, 'shadow sender observed the edge before local consumption');
  assert.equal(net.sent[0].jumpHeld, true);
  assert.equal(net.sent[0].cameraYaw, 0.3);
});
