import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { AUTHORITY_SOURCE } = require('./raceProgressAuthoritySelector');
const {
  createRaceServerAutoFinish,
  finiteStateFor,
  validFinishedSnapshot
} = require('./raceServerAutoFinish');

function room(overrides = {}) {
  return {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'm1',
    startedAt: 1000,
    ...overrides
  };
}

function player(overrides = {}) {
  return {
    id: 'p1',
    bot: false,
    finished: false,
    lastSequence: 7,
    last: {
      x: 1,
      y: 2,
      z: -30,
      ry: 0.25,
      vx: 3,
      vy: -1,
      vz: -7,
      state: 'air',
      id: 'p1'
    },
    ws: { emit() {} },
    ...overrides
  };
}

function finishedSnapshot(overrides = {}) {
  return {
    matchId: 'm1',
    progress: { checkpoint: 5, finished: true },
    finishServerTime: 5000,
    ...overrides
  };
}

function fixture({ source = AUTHORITY_SOURCE.SHADOW, snapshot = finishedSnapshot() } = {}) {
  const emitted = [];
  const runtimeService = { snapshot: () => snapshot };
  const matchGuard = { sourceFor: () => source };
  const autoFinish = createRaceServerAutoFinish({ runtimeService, matchGuard });
  const racer = player({
    ws: {
      emit(event, raw) {
        emitted.push([event, JSON.parse(raw.toString())]);
      }
    }
  });
  return { autoFinish, emitted, racer };
}

test('finiteStateFor strips server-only fields and keeps protocol state', () => {
  assert.deepEqual(finiteStateFor(player()), {
    x: 1,
    y: 2,
    z: -30,
    ry: 0.25,
    vx: 3,
    vz: -7,
    vy: -1,
    state: 'air'
  });
  assert.equal(finiteStateFor(player({ last: { x: 1 } })), null);
});

test('validFinishedSnapshot requires same match and server-owned finish time', () => {
  const currentRoom = room();
  assert.equal(validFinishedSnapshot(finishedSnapshot(), currentRoom), true);
  assert.equal(validFinishedSnapshot(finishedSnapshot({ matchId: 'm2' }), currentRoom), false);
  assert.equal(
    validFinishedSnapshot(finishedSnapshot({ progress: { finished: false } }), currentRoom),
    false
  );
  assert.equal(validFinishedSnapshot(finishedSnapshot({ finishServerTime: 999 }), currentRoom), false);
});

test('legacy and unlatched matches never receive a synthetic finish', () => {
  const legacy = fixture({ source: AUTHORITY_SOURCE.LEGACY });
  assert.equal(legacy.autoFinish.apply({ room: room(), player: legacy.racer }), null);
  assert.equal(legacy.emitted.length, 0);
  assert.equal(legacy.autoFinish.metrics().legacySkipped, 1);

  const unlatched = fixture({ source: null });
  assert.equal(unlatched.autoFinish.apply({ room: room(), player: unlatched.racer }), null);
  assert.equal(unlatched.emitted.length, 0);
  assert.equal(unlatched.autoFinish.metrics().unlatchedSkipped, 1);
});

test('finished shadow evidence emits one server-generated FINISH through the existing core pipeline', () => {
  const { autoFinish, emitted, racer } = fixture();
  const message = autoFinish.apply({ room: room(), player: racer });

  assert.equal(message.type, 'finish');
  assert.equal(message.matchId, 'm1');
  assert.equal(message.sequence, 8);
  assert.deepEqual(message.state, {
    x: 1,
    y: 2,
    z: -30,
    ry: 0.25,
    vx: 3,
    vz: -7,
    vy: -1,
    state: 'air'
  });
  assert.deepEqual(emitted, [['message', message]]);
  assert.equal(autoFinish.metrics().candidates, 1);
  assert.equal(autoFinish.metrics().emitted, 1);
});

test('the same authoritative finish evidence is emitted at most once', () => {
  const { autoFinish, emitted, racer } = fixture();
  assert.ok(autoFinish.apply({ room: room(), player: racer }));
  assert.equal(autoFinish.apply({ room: room(), player: racer }), null);
  assert.equal(emitted.length, 1);
  assert.equal(autoFinish.metrics().duplicateSuppressed, 1);
});

test('new match finish evidence may emit again for the same player object', () => {
  let snapshot = finishedSnapshot();
  const emitted = [];
  const autoFinish = createRaceServerAutoFinish({
    runtimeService: { snapshot: () => snapshot },
    matchGuard: { sourceFor: () => AUTHORITY_SOURCE.SHADOW }
  });
  const racer = player({
    ws: {
      emit(_event, raw) {
        emitted.push(JSON.parse(raw.toString()));
      }
    }
  });

  assert.ok(autoFinish.apply({ room: room(), player: racer }));
  snapshot = finishedSnapshot({ matchId: 'm2', finishServerTime: 9000 });
  assert.ok(
    autoFinish.apply({
      room: room({ matchId: 'm2', startedAt: 6000 }),
      player: racer
    })
  );
  assert.deepEqual(
    emitted.map(message => message.matchId),
    ['m1', 'm2']
  );
});

test('invalid shadow snapshots and invalid legacy state fail closed', () => {
  const invalidSnapshot = fixture({ snapshot: finishedSnapshot({ finishServerTime: null }) });
  assert.equal(invalidSnapshot.autoFinish.apply({ room: room(), player: invalidSnapshot.racer }), null);
  assert.equal(invalidSnapshot.autoFinish.metrics().invalidSnapshot, 1);

  const invalidState = fixture();
  invalidState.racer.last.x = Number.NaN;
  assert.equal(invalidState.autoFinish.apply({ room: room(), player: invalidState.racer }), null);
  assert.equal(invalidState.autoFinish.metrics().invalidState, 1);
});

test('non-race, non-playing, bot and already-finished players are ignored', () => {
  const { autoFinish, emitted, racer } = fixture();
  assert.equal(autoFinish.apply({ room: room({ mode: GAME_MODE.COOP }), player: racer }), null);
  assert.equal(autoFinish.apply({ room: room({ state: ROOM_STATE.RESULTS }), player: racer }), null);
  assert.equal(autoFinish.apply({ room: room(), player: { ...racer, bot: true } }), null);
  assert.equal(autoFinish.apply({ room: room(), player: { ...racer, finished: true } }), null);
  assert.equal(emitted.length, 0);
});

test('emit failures are contained and reset clears attempt suppression', () => {
  const autoFinish = createRaceServerAutoFinish({
    runtimeService: { snapshot: () => finishedSnapshot() },
    matchGuard: { sourceFor: () => AUTHORITY_SOURCE.SHADOW }
  });
  const racer = player({
    ws: {
      emit() {
        throw new Error('closed');
      }
    }
  });

  assert.equal(autoFinish.apply({ room: room(), player: racer }), null);
  assert.equal(autoFinish.metrics().emitFailures, 1);
  assert.equal(autoFinish.apply({ room: room(), player: racer }), null);
  assert.equal(autoFinish.metrics().duplicateSuppressed, 1);

  autoFinish.reset();
  assert.equal(autoFinish.metrics().emitFailures, 0);
  assert.equal(autoFinish.apply({ room: room(), player: racer }), null);
  assert.equal(autoFinish.metrics().emitFailures, 1);
});
