import test from 'node:test';
import assert from 'node:assert/strict';

import runtimeModule from './shadowInputRuntime.js';
import { GAME_MODE, ROOM_STATE } from '../shared/protocol.js';

const { ShadowInputRuntime } = runtimeModule;

const command = (matchId, sequence = 0) => ({
  type: 'input',
  matchId,
  sequence,
  clientTick: sequence,
  moveX: 0,
  moveZ: 1,
  jumpPressed: false,
  jumpHeld: false,
  divePressed: false,
  cameraYaw: 0
});

function raceFixture() {
  const player = {
    id: 'p1',
    last: { x: 0, y: 1, z: -17, vx: 0, vy: 0, vz: 0, state: 'ground' },
    checkpoint: 0,
    finished: false,
    bot: false
  };
  const room = {
    matchId: 'match-a',
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    startedAt: 0,
    spec: { checkpoints: [-18], finishZ: -31 },
    players: new Map([[player.id, player]])
  };
  return { player, room, rooms: new Map([['ROOM', room]]) };
}

test('fixed-step race progress is derived from shadow state without mutating legacy authority', () => {
  const runtime = new ShadowInputRuntime({
    step: state => ({
      state: {
        ...state,
        position: {
          ...state.position,
          z: state.position.z > -18 ? -19 : -32
        }
      },
      events: []
    })
  });
  const { player, room, rooms } = raceFixture();
  const before = structuredClone({
    last: player.last,
    checkpoint: player.checkpoint,
    finished: player.finished
  });

  assert.ok(runtime.accept({ player, room, message: command(room.matchId) }).accepted);
  runtime.tick(rooms, 1000);
  assert.deepEqual(runtime.snapshot(player).progress, {
    checkpoint: 1,
    finished: false,
    finishServerTick: null
  });

  runtime.tick(rooms, 1034);
  assert.deepEqual(runtime.snapshot(player).progress, {
    checkpoint: 1,
    finished: true,
    finishServerTick: 2
  });
  assert.deepEqual(
    { last: player.last, checkpoint: player.checkpoint, finished: player.finished },
    before,
    'shadow progress must never write legacy checkpoint, finish or position'
  );

  assert.deepEqual(runtime.metrics().shadowRaceProgress, {
    checkpointEvents: 1,
    finishEvents: 1,
    comparisons: 2,
    checkpointMismatchSamples: 2,
    finishMismatchSamples: 1,
    shadowAheadSamples: 2,
    legacyAheadSamples: 0,
    checkpointMismatchRate: 1,
    finishMismatchRate: 0.5
  });
});

test('a new match creates a fresh server-owned race progress domain', () => {
  const runtime = new ShadowInputRuntime();
  const { player, room } = raceFixture();

  assert.ok(runtime.accept({ player, room, message: command('match-a', 5) }).accepted);
  const first = runtime.snapshot(player);
  first.progress.checkpoint = 1;
  assert.equal(
    runtime.snapshot(player).progress.checkpoint,
    0,
    'snapshots expose copies, not controller state'
  );

  room.matchId = 'match-b';
  assert.ok(runtime.accept({ player, room, message: command('match-b', 0) }).accepted);
  assert.deepEqual(runtime.snapshot(player).progress, {
    checkpoint: 0,
    finished: false,
    finishServerTick: null
  });
});

test('co-op controllers do not run race progress rules', () => {
  const runtime = new ShadowInputRuntime({
    step: state => ({ state, events: [] })
  });
  const { player, room, rooms } = raceFixture();
  room.mode = GAME_MODE.COOP;

  assert.ok(runtime.accept({ player, room, message: command(room.matchId) }).accepted);
  runtime.tick(rooms, 1000);
  assert.equal(runtime.snapshot(player).progress, null);
  assert.equal(runtime.metrics().shadowRaceProgress.comparisons, 0);
});

test('legacy finish records one final diagnostic comparison without advancing shadow simulation', () => {
  const runtime = new ShadowInputRuntime({
    step: state => ({ state, events: [] })
  });
  const { player, room, rooms } = raceFixture();

  assert.ok(runtime.accept({ player, room, message: command(room.matchId) }).accepted);
  runtime.tick(rooms, 1000);
  assert.equal(runtime.metrics().simulatedSteps, 1);

  player.checkpoint = 1;
  player.finished = true;
  runtime.tick(rooms, 1034);
  runtime.tick(rooms, 1068);

  const diagnostics = runtime.metrics().shadowRaceProgress;
  assert.equal(runtime.metrics().simulatedSteps, 1, 'legacy-finished players stop shadow movement');
  assert.equal(diagnostics.comparisons, 2, 'finished legacy state is compared once');
  assert.equal(diagnostics.checkpointMismatchSamples, 1);
  assert.equal(diagnostics.finishMismatchSamples, 1);
  assert.equal(diagnostics.legacyAheadSamples, 1);
});
