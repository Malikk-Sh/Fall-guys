import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const { createRaceServerCheckpointAdvance } = require('./raceServerCheckpointAdvance');

function room(overrides = {}) {
  return {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'm1',
    ...overrides
  };
}

function player(overrides = {}) {
  return {
    id: 'p1',
    bot: false,
    finished: false,
    checkpoint: 1,
    ...overrides
  };
}

function result(source, { applied = false, checkpoint = 1 } = {}) {
  return Object.freeze({
    source,
    applied,
    previousCheckpoint: 1,
    checkpoint,
    fallbackReason: source === AUTHORITY_SOURCE.LEGACY ? 'shadow-unavailable' : null
  });
}

function fixture({ source = AUTHORITY_SOURCE.SHADOW, nextResult } = {}) {
  const calls = [];
  const checkpointApplier = {
    apply(options) {
      calls.push(options);
      if (nextResult instanceof Error) throw nextResult;
      return nextResult ?? result(AUTHORITY_SOURCE.SHADOW);
    }
  };
  const matchGuard = {
    sourceFor() {
      if (source instanceof Error) throw source;
      return source;
    }
  };
  return {
    calls,
    advance: createRaceServerCheckpointAdvance({ matchGuard, checkpointApplier })
  };
}

test('legacy and unlatched matches never consult the checkpoint applier', () => {
  const legacy = fixture({ source: AUTHORITY_SOURCE.LEGACY });
  assert.equal(legacy.advance.apply({ room: room(), player: player(), now: 500 }), null);
  assert.equal(legacy.calls.length, 0);
  assert.equal(legacy.advance.metrics().legacySkipped, 1);

  const unlatched = fixture({ source: null });
  assert.equal(unlatched.advance.apply({ room: room(), player: player(), now: 500 }), null);
  assert.equal(unlatched.calls.length, 0);
  assert.equal(unlatched.advance.metrics().unlatchedSkipped, 1);
});

test('latched shadow match advances checkpoints directly from the server tick', () => {
  const currentRoom = room();
  const racer = player();
  const nextResult = result(AUTHORITY_SOURCE.SHADOW, { applied: true, checkpoint: 2 });
  const { advance, calls } = fixture({ nextResult });

  assert.equal(advance.apply({ room: currentRoom, player: racer, now: 500 }), nextResult);
  assert.deepEqual(calls, [{ room: currentRoom, player: racer, now: 500 }]);
  assert.deepEqual(advance.metrics(), {
    attempts: 1,
    applied: 1,
    unchanged: 0,
    fallbacks: 0,
    legacySkipped: 0,
    unlatchedSkipped: 0,
    errors: 0
  });
});

test('unchanged shadow decisions and guarded fallbacks are distinguished', () => {
  const unchanged = fixture({ nextResult: result(AUTHORITY_SOURCE.SHADOW) });
  assert.ok(unchanged.advance.apply({ room: room(), player: player(), now: 500 }));
  assert.equal(unchanged.advance.metrics().unchanged, 1);

  const fallback = fixture({ nextResult: result(AUTHORITY_SOURCE.LEGACY) });
  assert.ok(fallback.advance.apply({ room: room(), player: player(), now: 500 }));
  assert.equal(fallback.advance.metrics().fallbacks, 1);
});

test('non-race, non-playing, bot and finished players are ignored', () => {
  const { advance, calls } = fixture();

  assert.equal(
    advance.apply({ room: room({ mode: GAME_MODE.COOP }), player: player(), now: 500 }),
    null
  );
  assert.equal(
    advance.apply({ room: room({ state: ROOM_STATE.RESULTS }), player: player(), now: 500 }),
    null
  );
  assert.equal(advance.apply({ room: room(), player: player({ bot: true }), now: 500 }), null);
  assert.equal(advance.apply({ room: room(), player: player({ finished: true }), now: 500 }), null);
  assert.equal(calls.length, 0);
});

test('guard and applier failures stay contained', () => {
  const guardFailure = fixture({ source: new Error('lease unavailable') });
  assert.equal(guardFailure.advance.apply({ room: room(), player: player(), now: 500 }), null);
  assert.equal(guardFailure.advance.metrics().errors, 1);

  const applyFailure = fixture({ nextResult: new Error('candidate unavailable') });
  assert.equal(applyFailure.advance.apply({ room: room(), player: player(), now: 500 }), null);
  assert.equal(applyFailure.advance.metrics().errors, 1);

  applyFailure.advance.reset();
  assert.equal(applyFailure.advance.metrics().attempts, 0);
  assert.equal(Object.isFrozen(applyFailure.advance.metrics()), true);
});
