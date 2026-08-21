import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GAME_MODE, ROOM_STATE } = require('../shared/protocol.js');
const { createCourseSpec } = require('../shared/courseSpec.js');
const { ShadowInputRuntime, SERVER_SIMULATION_DT } = require('./shadowInputRuntime');
const { PLAYER_FOOT } = require('../shared/playerDimensions.js');
const { recordRaceCourse } = require('../shared/courseColliderRecorder.js');
const { supportTop } = require('../shared/courseCollision.js');

const spec = createCourseSpec(20260821, 'normal');

function raceRoom() {
  return { mode: GAME_MODE.RACE, state: ROOM_STATE.PLAYING, matchId: 'match-1', spec };
}

// Клиент, стоящий на стартовой площадке и никуда не двигающийся.
function standingPlayer() {
  const start = recordRaceCourse(spec).platforms[0];
  return {
    bot: false,
    checkpoint: 0,
    finished: false,
    last: {
      x: start.x,
      y: supportTop(start) + PLAYER_FOOT,
      z: start.z,
      vy: 0,
      state: 'ground',
      sequence: 0
    }
  };
}

// Контроллер заводится только после первого принятого ввода — ровно как у живого клиента,
// который шлёт CLIENT_INPUT на 30 Гц.
let nextSequence = 0;
function tick(runtime, room, player, count = 1, startNow = 1000) {
  const rooms = new Map([[room.matchId, room]]);
  room.players = new Map([['p1', player]]);
  for (let step = 0; step < count; step++) {
    runtime.accept({
      player,
      room,
      message: {
        matchId: room.matchId,
        sequence: nextSequence,
        clientTick: nextSequence,
        moveX: 0,
        moveZ: 0,
        cameraYaw: 0,
        jumpPressed: false,
        jumpHeld: false,
        divePressed: false
      }
    });
    nextSequence += 1;
    runtime.tick(rooms, startNow + step * SERVER_SIMULATION_DT * 1000);
  }
}

test('свободная траектория считается и остаётся на полу под стоящим игроком', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  const player = standingPlayer();
  tick(runtime, room, player, 30);

  const { shadowGroundContact } = runtime.metrics();
  assert.ok(shadowGroundContact.samples > 0, 'измерение обязано идти на живом тике');
  assert.equal(shadowGroundContact.worldMissing, 0, 'у гонки обязан быть свой мир');
  assert.equal(
    shadowGroundContact.clientGroundedOnly,
    0,
    'сервер обязан сам находить тот же пол, а не считать игрока висящим в воздухе'
  );
  assert.ok(shadowGroundContact.agreementRate > 0.9);
});

test('свободная траектория не подглядывает в клиента', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  const player = standingPlayer();
  tick(runtime, room, player, 10);

  // Клиента телепортируем далеко в сторону. Свободная траектория обязана остаться там, где её
  // привела собственная симуляция: если бы она брала позицию у клиента, расхождение осталось бы
  // нулевым и мерить снова было бы нечего.
  player.last = { ...player.last, x: player.last.x + 40, z: player.last.z - 40 };
  tick(runtime, room, player, 10, 1000 + 10 * SERVER_SIMULATION_DT * 1000);

  const { shadowGroundContact } = runtime.metrics();
  assert.ok(
    shadowGroundContact.freeTrajectoryError.max > 10,
    'отрыв от уехавшего клиента обязан быть виден в измерении'
  );
});

test('кооперативу мир не строится, и это видно в счётчике, а не в падении', () => {
  const runtime = new ShadowInputRuntime();
  const room = { mode: GAME_MODE.COOP, state: ROOM_STATE.PLAYING, matchId: 'coop-1', spec };
  const player = standingPlayer();
  tick(runtime, room, player, 5);

  const { shadowGroundContact } = runtime.metrics();
  assert.ok(shadowGroundContact.worldMissing > 0);
  assert.equal(shadowGroundContact.samples, 0, 'без мира измерять нечего');
});

test('измерение не трогает авторитетное shadow-состояние', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  const player = standingPlayer();
  tick(runtime, room, player, 20);

  const snapshot = runtime.snapshot(player);
  assert.ok(snapshot, 'у игрока обязан остаться обычный shadow-снимок');
  // Авторитетное состояние по-прежнему держится за клиентский контакт, поэтому стоящий игрок
  // остаётся на своей высоте: переключения не произошло.
  assert.ok(Math.abs(snapshot.state.position.y - player.last.y) < 0.5);
});
