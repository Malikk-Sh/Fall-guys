import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { C2S, GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const {
  legacyProgressProposal,
  createRaceProgressAuthorityBoundaryProbe
} = require('./raceProgressAuthorityBoundaryProbe');

function room(overrides = {}) {
  return {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'm1',
    startedAt: 1_000,
    spec: { segmentCount: 3 },
    ...overrides
  };
}

function player(overrides = {}) {
  return {
    id: 'p1',
    checkpoint: 1,
    finished: false,
    lastSequence: 3,
    receivedAt: 1_200,
    last: { x: 0, y: 0, z: -20 },
    ...overrides
  };
}

test('state proposal mirrors validated checkpoint before legacy mutation', () => {
  const raceRoom = room();
  const racer = player();
  const before = structuredClone(racer);
  const proposal = legacyProgressProposal({
    room: raceRoom,
    player: racer,
    message: { type: C2S.PLAYER_STATE, matchId: 'm1', sequence: 4, state: {} },
    now: 1_300,
    validate: () => ({ ok: true, checkpoint: 2, state: { x: 0, y: 0, z: -40 } })
  });

  assert.deepEqual(proposal, { checkpoint: 2, finished: false });
  assert.deepEqual(racer, before);
  assert.equal(Object.isFrozen(proposal), true);
});

test('state proposal respects the core sequence, countdown and receive-rate gates', () => {
  const raceRoom = room();
  const racer = player();
  const validate = () => ({ ok: true, checkpoint: 2, state: {} });

  assert.equal(
    legacyProgressProposal({
      room: raceRoom,
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 3, state: {} },
      now: 1_300,
      validate
    }),
    null
  );
  assert.equal(
    legacyProgressProposal({
      room: raceRoom,
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 4, state: {} },
      now: 1_220,
      validate
    }),
    null
  );
  assert.equal(
    legacyProgressProposal({
      room: room({ startedAt: 2_000 }),
      player: racer,
      message: { type: C2S.PLAYER_STATE, sequence: 4, state: {} },
      now: 1_600,
      validate
    }),
    null
  );
});

test('finish proposal evaluates canFinish against projected validated state', () => {
  const raceRoom = room();
  const racer = player({ checkpoint: 2 });
  const before = structuredClone(racer);
  let projected = null;
  const proposal = legacyProgressProposal({
    room: raceRoom,
    player: racer,
    message: { type: C2S.FINISH, matchId: 'm1', sequence: 4, state: {} },
    now: 1_300,
    validate: () => ({
      ok: true,
      checkpoint: 3,
      state: { x: 0, y: 0, z: -80, state: 'ground' }
    }),
    finishAllowed: candidate => {
      projected = candidate;
      return true;
    }
  });

  assert.deepEqual(proposal, { checkpoint: 3, finished: true });
  assert.equal(projected.checkpoint, 3);
  assert.equal(projected.last.id, 'p1');
  assert.equal(projected.last.z, -80);
  assert.deepEqual(racer, before);
});

test('finish proposal preserves core behavior when the embedded state is rejected', () => {
  const racer = player({ checkpoint: 3 });
  let projected = null;
  const proposal = legacyProgressProposal({
    room: room(),
    player: racer,
    message: { type: C2S.FINISH, sequence: 4, state: {} },
    now: 1_300,
    validate: () => ({ ok: false, reason: 'speed' }),
    finishAllowed: candidate => {
      projected = candidate;
      return true;
    }
  });

  assert.deepEqual(proposal, { checkpoint: 3, finished: true });
  assert.equal(projected, racer);
});

test('proposal ignores non-race, stale-match and unsupported boundaries', () => {
  const racer = player();
  const state = { type: C2S.PLAYER_STATE, matchId: 'm1', sequence: 4, state: {} };

  assert.equal(
    legacyProgressProposal({ room: room({ mode: GAME_MODE.COOP }), player: racer, message: state }),
    null
  );
  assert.equal(
    legacyProgressProposal({ room: room(), player: racer, message: { ...state, matchId: 'old' } }),
    null
  );
  assert.equal(
    legacyProgressProposal({ room: room(), player: racer, message: { type: C2S.PRESENCE, sequence: 4 } }),
    null
  );
});

test('probe routes an explicit pre-mutation proposal through the decision adapter', () => {
  const calls = [];
  const probe = createRaceProgressAuthorityBoundaryProbe({
    proposalFor: options => {
      calls.push(['proposal', options.player.checkpoint]);
      return Object.freeze({ checkpoint: 2, finished: false });
    },
    decision: {
      decide: options => {
        calls.push(['decision', options.legacyProgress.checkpoint]);
        return {
          ok: true,
          source: 'shadow',
          fallbackReason: null,
          progress: { checkpoint: 3, finished: false }
        };
      }
    }
  });
  const racer = player();
  const before = structuredClone(racer);
  const result = probe.observe({
    room: room(),
    player: racer,
    message: { type: C2S.PLAYER_STATE, sequence: 4 }
  });

  assert.deepEqual(calls, [
    ['proposal', 1],
    ['decision', 2]
  ]);
  assert.deepEqual(result.legacyProgress, { checkpoint: 2, finished: false });
  assert.deepEqual(result.progress, { checkpoint: 3, finished: false });
  assert.equal(result.source, 'shadow');
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(racer, before);
  assert.deepEqual(probe.metrics(), {
    samples: 1,
    stateSamples: 1,
    finishSamples: 0,
    selectedLegacy: 0,
    selectedShadow: 1,
    invalidDecisions: 0,
    fallbackReasons: {}
  });
});

test('probe records fail-closed fallback reasons and can reset', () => {
  const probe = createRaceProgressAuthorityBoundaryProbe({
    proposalFor: () => ({ checkpoint: 3, finished: true }),
    decision: {
      decide: ({ legacyProgress }) => ({
        ok: true,
        source: 'legacy',
        fallbackReason: 'shadow-not-ready',
        progress: legacyProgress
      })
    }
  });

  probe.observe({ room: room(), player: player(), message: { type: C2S.FINISH } });
  assert.deepEqual(probe.metrics(), {
    samples: 1,
    stateSamples: 0,
    finishSamples: 1,
    selectedLegacy: 1,
    selectedShadow: 0,
    invalidDecisions: 0,
    fallbackReasons: { 'shadow-not-ready': 1 }
  });
  probe.reset();
  assert.equal(probe.metrics().samples, 0);
});

test('probe rejects missing collaborators', () => {
  assert.throws(() => createRaceProgressAuthorityBoundaryProbe({ decision: null }), TypeError);
  assert.throws(
    () => createRaceProgressAuthorityBoundaryProbe({ decision: { decide() {} }, proposalFor: null }),
    TypeError
  );
});
