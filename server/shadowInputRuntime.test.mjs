import test from 'node:test';
import assert from 'node:assert/strict';

import runtimeModule from './shadowInputRuntime.js';
import { ROOM_STATE } from '../shared/protocol.js';

const {
  SERVER_SIMULATION_DT,
  SERVER_SIMULATION_HZ,
  SERVER_SIMULATION_INTERVAL_MS,
  RollingErrorStats,
  ShadowInputRuntime,
  heldInputFromBatch
} = runtimeModule;

const input = (sequence, overrides = {}) => ({
  type: 'input',
  matchId: 'match-a',
  sequence,
  clientTick: sequence + 10,
  moveX: 0.25,
  moveZ: -0.5,
  jumpPressed: false,
  jumpHeld: false,
  divePressed: false,
  cameraYaw: 0.7,
  ...overrides
});

function fixture({ state = ROOM_STATE.PLAYING, startedAt = 0 } = {}) {
  const player = {
    id: 'p1',
    last: { x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0, state: 'ground' },
    finished: false,
    bot: false
  };
  const room = {
    matchId: 'match-a',
    state,
    startedAt,
    players: new Map([[player.id, player]])
  };
  return { player, room, rooms: new Map([['ROOM', room]]) };
}

test('shadow runtime is fixed at the planned 30 Hz cadence', () => {
  assert.equal(SERVER_SIMULATION_HZ, 30);
  assert.equal(SERVER_SIMULATION_DT, 1 / 30);
  assert.equal(SERVER_SIMULATION_INTERVAL_MS, 1000 / 30);
});

test('a WebSocket burst becomes one fixed simulation step and preserves input edges', () => {
  const seen = [];
  const runtime = new ShadowInputRuntime({
    step: (state, command, _context, dt) => {
      seen.push({ command: { ...command }, dt });
      return {
        state: {
          ...state,
          position: { ...state.position, x: state.position.x + 1 },
          velocity: { ...state.velocity }
        },
        events: []
      };
    }
  });
  const { player, room, rooms } = fixture();

  assert.ok(runtime.accept({ player, room, message: input(1, { jumpPressed: true }) }).accepted);
  assert.ok(
    runtime.accept({
      player,
      room,
      message: input(2, { moveX: 0.8, jumpHeld: true, divePressed: true })
    }).accepted
  );

  runtime.tick(rooms, 1000);

  assert.equal(seen.length, 1, 'arrival burst must not create extra physics steps');
  assert.equal(seen[0].dt, SERVER_SIMULATION_DT);
  assert.equal(seen[0].command.moveX, 0.8, 'latest held axis wins');
  assert.equal(seen[0].command.jumpPressed, true, 'jump edge from skipped command survives the batch');
  assert.equal(seen[0].command.divePressed, true, 'dive edge survives the batch');
  assert.equal(runtime.snapshot(player).lastProcessedInput, 2);
  assert.equal(runtime.metrics().processed, 2);
  assert.equal(runtime.metrics().simulatedSteps, 1);

  runtime.tick(rooms, 1034);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].command.moveX, 0.8, 'held input persists without a new packet');
  assert.equal(seen[1].command.jumpPressed, false, 'pressed edge is consumed once');
  assert.equal(seen[1].command.divePressed, false, 'pressed edge is consumed once');
});

test('countdown drains ordering state without replaying old action edges at the start gate', () => {
  const seen = [];
  const runtime = new ShadowInputRuntime({
    step: (state, command) => {
      seen.push({ ...command });
      return { state, events: [] };
    }
  });
  const { player, room, rooms } = fixture({ state: ROOM_STATE.COUNTDOWN, startedAt: 5000 });

  runtime.accept({
    player,
    room,
    message: input(3, { moveZ: 1, jumpPressed: true, jumpHeld: true, divePressed: true })
  });
  runtime.tick(rooms, 4000);
  assert.equal(seen.length, 0);
  assert.equal(runtime.snapshot(player).lastProcessedInput, 3);

  runtime.tick(rooms, 5000);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].moveZ, 1);
  assert.equal(seen[0].jumpHeld, true);
  assert.equal(seen[0].jumpPressed, false);
  assert.equal(seen[0].divePressed, false);
});

test('match change creates a fresh input ordering domain', () => {
  const runtime = new ShadowInputRuntime();
  const { player, room } = fixture();

  assert.ok(runtime.accept({ player, room, message: input(8) }).accepted);
  assert.equal(runtime.accept({ player, room, message: input(8) }).reason, 'stale-sequence');

  room.matchId = 'match-b';
  const next = input(0, { matchId: 'match-b', clientTick: 0 });
  assert.ok(runtime.accept({ player, room, message: next }).accepted);
  assert.equal(runtime.snapshot(player).matchId, 'match-b');
});

test('queue ordering failures stay diagnostics, not gameplay mutations', () => {
  const runtime = new ShadowInputRuntime();
  const { player, room } = fixture();
  const before = structuredClone(player.last);

  assert.ok(runtime.accept({ player, room, message: input(2) }).accepted);
  assert.equal(runtime.accept({ player, room, message: input(1) }).reason, 'stale-sequence');
  assert.equal(
    runtime.accept({ player, room, message: input(3, { clientTick: 1 }) }).reason,
    'stale-client-tick'
  );
  assert.equal(
    runtime.accept({ player, room, message: input(4, { matchId: 'other' }) }).reason,
    'match-mismatch'
  );

  assert.deepEqual(player.last, before, 'shadow input must never rewrite legacy authoritative state');
  assert.deepEqual(runtime.metrics().rejected, {
    staleSequence: 1,
    staleClientTick: 1,
    queueFull: 0,
    matchMismatch: 1,
    invalidOrdering: 0
  });
});

test('legacy comparison publishes bounded mean, p95 and max diagnostics', () => {
  const stats = new RollingErrorStats(3);
  for (const value of [1, 2, 3, 20]) assert.ok(stats.record(value));
  assert.equal(stats.record(NaN), false);

  const snapshot = stats.snapshot();
  assert.equal(snapshot.count, 4);
  assert.equal(snapshot.mean, 6.5);
  assert.equal(snapshot.max, 20);
  assert.equal(snapshot.recentSamples, 3);
  assert.equal(snapshot.p95, 20);
});

test('batch input helper uses latest held state but ORs edge actions', () => {
  const batch = [
    input(1, { moveX: 0.1, jumpPressed: true }),
    input(2, { moveX: 0.9, jumpPressed: false, divePressed: true, jumpHeld: true })
  ];
  assert.deepEqual(heldInputFromBatch(batch), {
    moveX: 0.9,
    moveZ: -0.5,
    cameraYaw: 0.7,
    jumpPressed: true,
    jumpHeld: true,
    divePressed: true
  });
});
