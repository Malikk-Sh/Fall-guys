import test from 'node:test';
import assert from 'node:assert/strict';

import { ReconciliationTelemetry } from '../client/net/ReconciliationTelemetry.js';
import { createPlayerSimulationState } from '../shared/playerSimulation.js';
import { S2C } from '../shared/protocol.js';
import {
  ClientInputShadowSender,
  installClientInputShadowBridge,
  simulationStateError
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

function network(matchId = null) {
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

function controls() {
  return {
    jumpQueued: true,
    diveQueued: false,
    movement: () => ({ x: 0, forward: 1, magnitude: 1 }),
    isHeld: action => action === 'jump'
  };
}

test('simulation state error reports correction deltas without mutating either state', () => {
  const predicted = createPlayerSimulationState({
    position: { x: 3, y: 4, z: 0 },
    velocity: { x: 1, y: 2, z: 2 },
    grounded: false
  });
  const local = createPlayerSimulationState({
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true
  });
  const predictedBefore = structuredClone(predicted);
  const localBefore = structuredClone(local);

  assert.deepEqual(simulationStateError(predicted, local), {
    positionDelta: { x: 3, y: 4, z: 0 },
    velocityDelta: { x: 1, y: 2, z: 2 },
    positionError: 5,
    horizontalPositionError: 3,
    verticalPositionError: 4,
    velocityError: 3,
    groundedMismatch: true
  });
  assert.deepEqual(predicted, predictedBefore);
  assert.deepEqual(local, localBefore);
  assert.equal(simulationStateError({ position: {} }, local), null);
});

test('reconciliation telemetry keeps bounded p95 samples and whole-match aggregate stats', () => {
  const telemetry = new ReconciliationTelemetry({ sampleLimit: 3 });
  telemetry.reset('match-a');

  for (let tick = 0; tick < 4; tick++) {
    const value = tick + 1;
    assert.equal(
      telemetry.record({
        serverTick: tick,
        error: {
          positionError: value,
          horizontalPositionError: value / 2,
          verticalPositionError: tick % 2,
          velocityError: value + 1,
          groundedMismatch: tick % 2 === 0
        }
      }),
      true
    );
  }

  assert.equal(
    telemetry.record({
      serverTick: 3,
      error: {
        positionError: 99,
        horizontalPositionError: 99,
        verticalPositionError: 99,
        velocityError: 99,
        groundedMismatch: true
      }
    }),
    false,
    'duplicate server tick cannot double-count reconciliation telemetry'
  );
  assert.equal(telemetry.record({ serverTick: 4, historyGap: true }), true);

  assert.deepEqual(telemetry.snapshot(), {
    matchId: 'match-a',
    lastServerTick: 4,
    replayAttempts: 5,
    historyGaps: 1,
    historyGapRate: 0.2,
    localComparisons: 4,
    groundedMismatches: 2,
    groundedMismatchRate: 0.5,
    positionError: { count: 4, mean: 2.5, p95: 4, max: 4, recentSamples: 3 },
    horizontalPositionError: { count: 4, mean: 1.25, p95: 2, max: 2, recentSamples: 3 },
    verticalPositionError: { count: 4, mean: 0.5, p95: 1, max: 1, recentSamples: 3 },
    velocityError: { count: 4, mean: 3.5, p95: 5, max: 5, recentSamples: 3 }
  });

  telemetry.reset('match-b');
  assert.deepEqual(telemetry.snapshot(), {
    matchId: 'match-b',
    lastServerTick: -1,
    replayAttempts: 0,
    historyGaps: 0,
    historyGapRate: 0,
    localComparisons: 0,
    groundedMismatches: 0,
    groundedMismatchRate: 0,
    positionError: { count: 0, mean: 0, p95: 0, max: 0, recentSamples: 0 },
    horizontalPositionError: { count: 0, mean: 0, p95: 0, max: 0, recentSamples: 0 },
    verticalPositionError: { count: 0, mean: 0, p95: 0, max: 0, recentSamples: 0 },
    velocityError: { count: 0, mean: 0, p95: 0, max: 0, recentSamples: 0 }
  });
});

test('shadow replay compares prediction against the latest sampled local physics state', () => {
  const sender = new ClientInputShadowSender({ storage: new MemoryStorage(), now: () => 50 });
  sender.beginMatch('match-a');
  assert.equal(
    sender.observeLocalPlayer(
      {
        physics: { x: 1, y: 2, z: 3 },
        velocity: { x: 0.5, y: 0, z: -0.5 },
        grounded: true
      },
      48
    ),
    true
  );

  const baseline = createPlayerSimulationState({
    position: { x: 2, y: 4, z: 3 },
    velocity: { x: 1.5, y: 0, z: 0.5 },
    grounded: false
  });
  assert.equal(sender.replayFromShadow('match-a', baseline, 7, -1), true);
  const replay = sender.shadowReplayState();
  assert.equal(replay.localSampleAt, 48);
  assert.deepEqual(replay.localError.positionDelta, { x: 1, y: 2, z: 0 });
  assert.equal(replay.localError.positionError, Math.sqrt(5));
  assert.equal(replay.localError.horizontalPositionError, 1);
  assert.equal(replay.localError.verticalPositionError, 2);
  assert.equal(replay.localError.velocityError, Math.sqrt(2));
  assert.equal(replay.localError.groundedMismatch, true);

  const diagnostics = sender.reconciliationDiagnostics();
  assert.equal(diagnostics.matchId, 'match-a');
  assert.equal(diagnostics.replayAttempts, 1);
  assert.equal(diagnostics.historyGaps, 0);
  assert.equal(diagnostics.localComparisons, 1);
  assert.equal(diagnostics.groundedMismatches, 1);
  assert.equal(diagnostics.positionError.count, 1);
  assert.equal(diagnostics.positionError.mean, Math.sqrt(5));
  assert.equal(diagnostics.horizontalPositionError.mean, 1);
  assert.equal(diagnostics.verticalPositionError.mean, 2);
  assert.equal(diagnostics.velocityError.mean, Math.sqrt(2));

  sender.beginMatch('match-b');
  assert.equal(sender.shadowReplayState(), null, 'match boundary clears stale reconciliation diagnostics');
  assert.equal(sender.reconciliationDiagnostics().matchId, 'match-b');
  assert.equal(sender.reconciliationDiagnostics().replayAttempts, 0);
});

test('prototype bridge samples local state after the existing player step and never applies replay', () => {
  const sender = new ClientInputShadowSender({ storage: new MemoryStorage(), now: () => 100 });

  class FakePlayer {
    constructor() {
      this.finished = false;
      this.remote = false;
      this.physics = { x: 0, y: 1, z: 0 };
      this.velocity = { x: 0, y: 0, z: 0 };
      this.grounded = true;
    }

    step(_dt, input) {
      this.physics.x += 1;
      this.velocity.x = 2;
      input.jumpQueued = false;
    }
  }

  class FakeNetwork {
    constructor() {
      Object.assign(this, network());
    }

    handleMessage(message) {
      if (message.type === S2C.MATCH_START) this.matchId = message.matchId;
    }

    tick() {}
  }

  installClientInputShadowBridge({ PlayerClass: FakePlayer, NetworkClass: FakeNetwork, sender });
  const net = new FakeNetwork();
  net.handleMessage({ type: S2C.MATCH_START, matchId: 'match-live' });
  const player = new FakePlayer();
  const input = controls();
  player.step(1 / 60, input, 0, 0);
  net.tick();
  assert.equal(net.sent.length, 1);

  const shadowPlayerState = createPlayerSimulationState({
    position: { x: 2, y: 1, z: 0 },
    velocity: { x: 3, y: 0, z: 0 },
    grounded: true
  });
  net.handleMessage({
    type: S2C.SNAPSHOT,
    matchId: 'match-live',
    lastProcessedInput: 0,
    serverTick: 9,
    shadowPlayerState,
    players: []
  });

  const replay = sender.shadowReplayState();
  assert.deepEqual(replay.localError.positionDelta, { x: 1, y: 0, z: 0 });
  assert.deepEqual(replay.localError.velocityDelta, { x: 1, y: 0, z: 0 });
  assert.equal(replay.localError.positionError, 1);
  assert.equal(replay.localError.velocityError, 1);
  assert.equal(sender.reconciliationDiagnostics().positionError.mean, 1);
  assert.equal(sender.reconciliationDiagnostics().velocityError.mean, 1);
  assert.deepEqual(player.physics, { x: 1, y: 1, z: 0 }, 'diagnostics never move the local player');
  assert.deepEqual(player.velocity, { x: 2, y: 0, z: 0 }, 'diagnostics never change local velocity');
});
