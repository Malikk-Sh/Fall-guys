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
const { createShadowCourseWorld } = require('./shadowCourseWorld');

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
  room.startedAt = 1000;
  const player = standingPlayer();
  tick(runtime, room, player, 10, room.startedAt);

  // Клиента уводим в сторону — но ПОСТЕПЕННО, шагами меньше порога возврата на чекпоинт. Разом
  // телепортировать нельзя: такой скачок измерение справедливо считает возрождением и сбрасывает
  // якорь, а проверить надо другое — что свободная траектория идёт своей симуляцией и не
  // подставляет себе клиентскую позицию. Подглядывай она — расхождение осталось бы нулевым.
  let now = room.startedAt + 10 * SERVER_SIMULATION_DT * 1000;
  for (let step = 0; step < 10; step++) {
    player.last = { ...player.last, x: player.last.x + 2, z: player.last.z - 2 };
    tick(runtime, room, player, 1, now);
    now += SERVER_SIMULATION_DT * 1000;
  }

  const { shadowGroundContact } = runtime.metrics();
  assert.equal(shadowGroundContact.clientTeleports, 0, 'шаги по 2 единицы возвратом не считаются');
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

// Время матча, а не показания часов.
//
// Клиент считает фазы подвижных опор и препятствий от секунд с начала забега. Сервер обязан
// подставлять в те же формулы то же число. В первой редакции сюда уходил `Date.now() / 1000`, то
// есть эпоха Unix: опоры расставлялись по произвольным точкам своего размаха, и измерение паритета
// показывало бы расхождение геометрии там, где расходились часы.
test('мир двигается по времени матча, а не по показаниям часов', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  const startedAt = 1_760_000_000_000;
  room.startedAt = startedAt;
  const player = standingPlayer();

  const matchSeconds = 6;
  const now = startedAt + matchSeconds * 1000;
  tick(runtime, room, player, 1, now);

  const world = runtime.controllers.get(player).world;
  assert.ok(world.dynamic.length, 'на этой трассе обязаны быть подвижные опоры');

  // Эталон: тот же мир, доведённый до того же момента МАТЧА.
  const expected = createShadowCourseWorld(spec);
  expected.advance(matchSeconds);
  world.dynamic.forEach((platform, index) => {
    const axis = platform.motion.axis;
    assert.equal(platform[axis], expected.dynamic[index][axis], `опора ${index} по оси ${axis}`);
  });

  // И то же самое, посчитанное от эпохи, обязано быть ДРУГИМ — иначе проверка ничего не значит.
  const byClock = createShadowCourseWorld(spec);
  byClock.advance(now / 1000);
  const differs = world.dynamic.some((platform, index) => {
    const axis = platform.motion.axis;
    return Math.abs(platform[axis] - byClock.dynamic[index][axis]) > 1e-6;
  });
  assert.ok(differs, 'подстановка эпохи обязана давать заметно другую трассу');
});

test('без времени старта измерение откатывается на счётчик тиков, а не на эпоху', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  const player = standingPlayer();
  // startedAt нет вовсе: комната ещё не проставила старт.
  tick(runtime, room, player, 4, 1_760_000_000_000);

  const world = runtime.controllers.get(player).world;
  const platform = world.dynamic[0];
  const axis = platform.motion.axis;
  const withinSwing = Math.abs(platform[axis] - platform.motion.origin) <= platform.motion.range + 1e-9;
  assert.ok(withinSwing, 'опора обязана остаться в пределах своего размаха');
  // Счётчик тиков — маленькое число, поэтому опора недалеко ушла от старта своей синусоиды.
  const expected = createShadowCourseWorld(spec);
  expected.advance(4 / 30);
  assert.equal(platform[axis], expected.dynamic[0][axis]);
});

// Горизонт измерения.
//
// Свободная траектория меряется отрезками, а не от старта до финиша. Без этого один возврат
// клиента на чекпоинт разводил её навсегда: замер на ботах дал среднее расхождение 1123 единицы
// при пороге 0.3, хотя высота стояния совпадала до 0.0002. Сравнивались бегущий игрок и точка,
// продолжавшая падать в пустоту.
test('якорь свободной траектории сбрасывается раз в горизонт', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();

  tick(runtime, room, player, 10, room.startedAt);
  assert.equal(runtime.metrics().shadowGroundContact.reanchors, 0, 'до горизонта сбросов нет');

  tick(runtime, room, player, 70, room.startedAt + 10 * SERVER_SIMULATION_DT * 1000);
  assert.ok(runtime.metrics().shadowGroundContact.reanchors >= 2, 'за 80 тиков горизонт пройден дважды');
});

test('возврат клиента на чекпоинт — не расхождение симуляций', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  tick(runtime, room, player, 6, room.startedAt);

  const before = runtime.metrics().shadowGroundContact;
  // Телепорт на десятки единиц: так выглядит возрождение на чекпоинте.
  player.last = { ...player.last, x: player.last.x + 30, z: player.last.z - 30 };
  tick(runtime, room, player, 1, room.startedAt + 6 * SERVER_SIMULATION_DT * 1000);

  const after = runtime.metrics().shadowGroundContact;
  assert.equal(after.clientTeleports, 1, 'скачок обязан быть распознан как возврат');
  assert.equal(
    after.freeTrajectoryError.count,
    before.freeTrajectoryError.count,
    'тик возврата в статистику расхождения не попадает'
  );
});

test('состояния без опоры не считаются расхождением, а выносятся отдельно', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();

  // Сбитый лежит НА полу, но снапшот помечает его knockdown: опора оттуда не читается.
  player.last = { ...player.last, state: 'knockdown' };
  tick(runtime, room, player, 5, room.startedAt);

  const metrics = runtime.metrics().shadowGroundContact;
  assert.equal(metrics.samples, 0, 'ненаблюдаемые тики в знаменатель согласия не входят');
  assert.equal(metrics.groundedMismatch, 0, 'и расхождением они тоже не являются');
  assert.equal(metrics.groundStateUnknown, 5);

  // А `air` и `ground` наблюдаемы и в статистику идут.
  player.last = { ...player.last, state: 'ground' };
  tick(runtime, room, player, 5, room.startedAt + 5 * SERVER_SIMULATION_DT * 1000);
  assert.equal(runtime.metrics().shadowGroundContact.samples, 5);
});
