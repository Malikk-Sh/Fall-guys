import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { shadowRaceProgressCandidate } = require('./shadowRaceProgressCandidate');

function raceRoom() {
  return {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'match-a',
    spec: { segmentCount: 2, checkpoints: [-18, -36] }
  };
}

function shadowSnapshot(overrides = {}) {
  return {
    matchId: 'match-a',
    lastServerTick: 12,
    lastProcessedInput: 7,
    progress: {
      checkpoint: 1,
      finished: false,
      finishServerTick: null
    },
    ...overrides
  };
}

test('current race shadow progress becomes an immutable read-only candidate', () => {
  const room = raceRoom();
  const player = { id: 'p1' };
  const snapshot = shadowSnapshot();
  const runtimeService = { snapshot: value => (value === player ? snapshot : null) };
  const before = structuredClone(snapshot);

  const candidate = shadowRaceProgressCandidate({ room, player, runtimeService });
  assert.deepEqual(candidate, {
    matchId: 'match-a',
    serverTick: 12,
    lastProcessedInput: 7,
    checkpoint: 1,
    finished: false,
    finishServerTick: null
  });
  assert.equal(Object.isFrozen(candidate), true);
  assert.deepEqual(snapshot, before, 'candidate inspection never mutates the runtime snapshot');
});

test('candidate rejects stale matches, co-op and inactive room states', () => {
  const player = { id: 'p1' };
  const runtimeService = { snapshot: () => shadowSnapshot() };

  const stale = raceRoom();
  stale.matchId = 'match-b';
  assert.equal(shadowRaceProgressCandidate({ room: stale, player, runtimeService }), null);

  const coop = raceRoom();
  coop.mode = GAME_MODE.COOP;
  assert.equal(shadowRaceProgressCandidate({ room: coop, player, runtimeService }), null);

  const lobby = raceRoom();
  lobby.state = ROOM_STATE.LOBBY;
  assert.equal(shadowRaceProgressCandidate({ room: lobby, player, runtimeService }), null);
});

test('candidate requires a real processed input and an advanced server tick', () => {
  const room = raceRoom();
  const player = { id: 'p1' };
  const noInput = { snapshot: () => shadowSnapshot({ lastProcessedInput: -1 }) };
  const noTick = { snapshot: () => shadowSnapshot({ lastServerTick: -1 }) };

  assert.equal(shadowRaceProgressCandidate({ room, player, runtimeService: noInput }), null);
  assert.equal(shadowRaceProgressCandidate({ room, player, runtimeService: noTick }), null);
});

test('candidate validates checkpoint and finish invariants before exposing progress', () => {
  const room = raceRoom();
  const player = { id: 'p1' };

  const tooFar = {
    snapshot: () => shadowSnapshot({ progress: { checkpoint: 3, finished: false, finishServerTick: null } })
  };
  assert.equal(shadowRaceProgressCandidate({ room, player, runtimeService: tooFar }), null);

  const earlyFinish = {
    snapshot: () => shadowSnapshot({ progress: { checkpoint: 1, finished: true, finishServerTick: 12 } })
  };
  assert.equal(shadowRaceProgressCandidate({ room, player, runtimeService: earlyFinish }), null);

  const complete = {
    snapshot: () => shadowSnapshot({ progress: { checkpoint: 2, finished: true, finishServerTick: 11 } })
  };
  const candidate = shadowRaceProgressCandidate({ room, player, runtimeService: complete });
  assert.equal(candidate.finished, true);
  assert.equal(candidate.checkpoint, 2);
  assert.equal(candidate.finishServerTick, 11);
});

test('candidate treats shadow service failures as unavailable diagnostics', () => {
  const room = raceRoom();
  const player = { id: 'p1' };
  const runtimeService = {
    snapshot() {
      throw new Error('shadow unavailable');
    }
  };

  assert.equal(shadowRaceProgressCandidate({ room, player, runtimeService }), null);
});
