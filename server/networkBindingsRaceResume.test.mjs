import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNetwork } from '../client/net/networkBindings.js';
import { GAME_MODE } from '../shared/protocol.js';
import { raceSpawnFor } from '../shared/raceGrid.js';

// Resume должен продолжить забег с серверной позиции, но checkpoint-0 spawn остаётся той же
// персональной клеткой стартовой решётки. Иначе первое локальное падение после reconnect на кадр
// возвращает игрока в общий центр, пока не придёт серверная correction.
test('resume гонки сохраняет grid spawn до первого checkpoint', async () => {
  const handlers = new Map();
  const game = {
    net: {
      id: 'me',
      on: (type, handler) => handlers.set(type, handler)
    },
    latestBoard: [{ id: 'old' }],
    finishedPlace: 2,
    finishedTime: 123,
    resultsPending: true,
    async startRace(mode, spec, at, slots) {
      this.started = { mode, spec, at, slots };
      this.player = {
        spawn: { ...spec.start },
        position: { ...spec.start },
        respawn(position = null) {
          this.position = position
            ? { x: position.x, y: position.y, z: position.z }
            : { ...this.spawn };
        }
      };
    },
    restoreRun(resumed) {
      // Настоящий restoreRun телепортирует в авторитетную позицию, но spawn не меняет.
      this.player.respawn(resumed.position);
    }
  };

  bindNetwork(game);

  const originalSpec = { start: { x: 0, y: 1.2, z: 7 }, finishZ: -80 };
  const slots = { other: 0, me: 1 };
  const resumed = {
    position: { x: 2.5, y: 1.2, z: -14 },
    checkpoint: 0,
    finished: false,
    nextSequence: 7
  };

  await handlers.get('start')({
    mode: GAME_MODE.RACE,
    spec: originalSpec,
    at: 10_000,
    slots,
    resumed
  });

  const expectedSpawn = raceSpawnFor(originalSpec, slots.me, Object.keys(slots).length);
  assert.equal(game.started.mode, 'multi');
  assert.deepEqual(
    game.started.spec.start,
    expectedSpawn,
    'Player создаётся сразу в своей grid-клетке'
  );
  assert.deepEqual(game.player.spawn, expectedSpawn, 'resume не должен терять checkpoint-0 spawn');
  assert.deepEqual(
    game.player.position,
    resumed.position,
    'после restore игрок остаётся там, где его видел сервер'
  );

  game.player.respawn();
  assert.deepEqual(
    game.player.position,
    expectedSpawn,
    'следующий локальный respawn возвращает в ту же клетку'
  );
  assert.deepEqual(game.latestBoard, [], 'новый start по-прежнему сбрасывает доску прошлого матча');
  assert.equal(game.finishedPlace, null);
  assert.equal(game.finishedTime, null);
  assert.equal(game.resultsPending, false);
});
