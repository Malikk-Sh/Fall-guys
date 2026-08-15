import test from 'node:test';
import assert from 'node:assert/strict';
import { bindNetwork } from '../client/net/networkBindings.js';
import { GAME_MODE } from '../shared/protocol.js';
import { raceSpawnFor } from '../shared/raceGrid.js';

// Resume должен продолжить забег с серверной позиции, но checkpoint-0 spawn остаётся той же
// персональной клеткой стартовой решётки. Иначе уход другого игрока переиндексирует slot'ы, и
// reconnect поставит оставшегося в уже другую клетку.
test('resume гонки сохраняет match-start grid spawn после изменения состава', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    }
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  });

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
          this.position = position ? { x: position.x, y: position.y, z: position.z } : { ...this.spawn };
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
  const matchId = 'race-grid-resume';
  const initialSlots = { other: 0, me: 1, third: 2 };
  const expectedSpawn = raceSpawnFor(originalSpec, initialSlots.me, Object.keys(initialSlots).length);

  await handlers.get('start')({
    mode: GAME_MODE.RACE,
    matchId,
    spec: originalSpec,
    at: 10_000,
    slots: initialSlots
  });
  assert.deepEqual(game.player.spawn, expectedSpawn, 'первый старт запоминает исходную grid-клетку');

  // Первый участник ушёл: серверная карта оставшихся slot'ов стала компактнее. Если пересчитать
  // клетку по ней, наш игрок переедет — именно это и было регрессией.
  const resumedSlots = { me: 0, third: 1 };
  const recomputed = raceSpawnFor(originalSpec, resumedSlots.me, Object.keys(resumedSlots).length);
  assert.notDeepEqual(recomputed, expectedSpawn, 'подготовка обязана действительно менять клетку');

  const resumed = {
    position: { x: 2.5, y: 1.2, z: -14 },
    checkpoint: 0,
    finished: false,
    nextSequence: 7
  };
  await handlers.get('start')({
    mode: GAME_MODE.RACE,
    matchId,
    spec: originalSpec,
    at: 10_000,
    slots: resumedSlots,
    resumed
  });

  assert.equal(game.started.mode, 'multi');
  assert.deepEqual(
    game.started.spec.start,
    expectedSpawn,
    'resume строит Player из исходной match-start клетки, а не из переиндексированного slot'
  );
  assert.deepEqual(game.player.spawn, expectedSpawn, 'checkpoint-0 spawn остаётся исходным');
  assert.deepEqual(
    game.player.position,
    resumed.position,
    'после restore игрок остаётся там, где его видел сервер'
  );

  game.player.respawn();
  assert.deepEqual(
    game.player.position,
    expectedSpawn,
    'следующий локальный respawn возвращает в исходную клетку'
  );
  assert.deepEqual(game.latestBoard, [], 'новый start по-прежнему сбрасывает доску прошлого матча');
  assert.equal(game.finishedPlace, null);
  assert.equal(game.finishedTime, null);
  assert.equal(game.resultsPending, false);
});
