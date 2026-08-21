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

// Импульс препятствия несёт не только толчок, но и сбивание.
//
// Клиент применяет его через `Course.interact` → `player.knockDown`. Пока свободная траектория
// сбивание игнорировала, каждое попадание разводило её с клиентом на полторы секунды: клиент терял
// управление, а серверная симуляция бежала дальше. Замер на ботах показывал это прямо —
// расхождение начиналось на первом же попадании, knockdownTimer 1.383 против нуля.
test('сбивание от препятствия доходит до свободной траектории', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  // Заметно позже старта: выдержка между попаданиями считается от времени МАТЧА, и в самом его
  // начале любой удар отсекается как «слишком ранний повтор».
  const now = room.startedAt + 5000;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const world = controller.world;
  const bumper = world.obstacles.find(o => o.type === 'bumper');
  assert.ok(bumper, 'на трассе обязан быть бампер');

  // Ставим свободную траекторию вплотную к бамперу — так, чтобы следующий шаг дал попадание.
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.freeState.knockdownTimer = 0;
  controller.freeState.knockdownImmunity = 0;
  controller.lastClientPosition = null;

  const before = runtime.metrics().shadowGroundContact.impulses;
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);

  assert.ok(runtime.metrics().shadowGroundContact.impulses > before, 'удар обязан случиться');
  assert.ok(
    controller.freeState.knockdownTimer > 0,
    'после удара свободная траектория обязана быть сбита, как и клиент'
  );
});

// Паритет попаданий: сопоставление событий вместо расстояния.
test('сбивание у клиента и удар у сервера сходятся в одно событие', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const bumper = controller.world.obstacles.find(o => o.type === 'bumper');
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.lastClientPosition = null;

  // Клиент в тот же момент помечен сбитым — событие обязано сойтись в пару.
  player.last = { ...player.last, state: 'knockdown' };
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);

  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.serverHits, 1);
  assert.equal(hitParity.clientHits, 1);
  assert.equal(hitParity.matched, 1);
  assert.equal(hitParity.serverOnly, 0);
});

test('затянувшееся сбивание клиента считается одним событием, а не полусотней', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  player.last = { ...player.last, state: 'knockdown' };
  tick(runtime, room, player, 40, room.startedAt);

  // Считается ПЕРЕХОД в сбивание, а не каждый тик в нём.
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.clientHits, 1);
});

test('удар у сервера без сбивания у клиента остаётся односторонним', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const bumper = controller.world.obstacles.find(o => o.type === 'bumper');
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.lastClientPosition = null;
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);

  // Пока допуск не истёк, событие ещё ждёт пару и в итог не входит.
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.serverOnly, 0);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1);

  // За допуском оно закрывается как выдуманный сервером удар.
  tick(runtime, room, player, 15, now + 2 * SERVER_SIMULATION_DT * 1000);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.serverOnly, 1);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.matched, 0);
});

test('сброс якоря не стирает идущее сбивание', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  tick(runtime, room, player, 1, room.startedAt);

  const controller = runtime.controllers.get(player);
  controller.freeState.knockdownTimer = 1.2;
  controller.freeState.knockdownImmunity = 0.4;

  // Прогоняем через горизонт: якорь обязан сброситься, а сбивание — уцелеть.
  tick(runtime, room, player, 40, room.startedAt + SERVER_SIMULATION_DT * 1000);
  assert.ok(runtime.metrics().shadowGroundContact.reanchors > 0, 'якорь обязан был сброситься');
  assert.ok(
    controller.freeState.knockdownTimer > 0 || controller.freeState.knockdownImmunity > 0,
    'сбивание переживает сброс якоря: иначе сервер снова уязвим к тому же препятствию'
  );
});

// Модель мира спрашивается В ТОЧКЕ КЛИЕНТА, и это отделяет геометрию от дрейфа.
//
// Поиск опоры у клиента и сервера — один код на численно одинаковых записях, поэтому разойтись они
// могут только из-за разных позиций. Пока вопрос задавался там, куда пришла свободная траектория,
// метрика отвечала сразу на два вопроса, и дрейф забивал геометрию: 94.6 % против 99.64 % на одних
// и тех же прогонах.
test('модель мира не зависит от того, куда уехала свободная траектория', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  tick(runtime, room, player, 5, room.startedAt);

  // Уводим свободную траекторию далеко под трассу — там опоры нет вовсе.
  const controller = runtime.controllers.get(player);
  controller.freeState.position.y -= 200;
  tick(runtime, room, player, 5, room.startedAt + 5 * SERVER_SIMULATION_DT * 1000);

  const { shadowGroundContact } = runtime.metrics();
  // Клиент всё это время стоит на стартовой площадке, и модель мира обязана это подтверждать.
  assert.equal(shadowGroundContact.groundModel.serverGroundedOnly, 0);
  assert.equal(shadowGroundContact.groundModel.clientGroundedOnly, 0);
  assert.equal(shadowGroundContact.groundModel.agreementRate, 1);
  // А замер по траектории обязан этот провал увидеть — иначе проверка ничего не значит.
  assert.ok(shadowGroundContact.clientGroundedOnly > 0, 'дрейф обязан быть виден в справочной величине');
});

test('высота стояния меряется по опоре в точке клиента, а не по уехавшей траектории', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  tick(runtime, room, player, 3, room.startedAt);

  const controller = runtime.controllers.get(player);
  controller.freeState.position.y += 50;
  tick(runtime, room, player, 3, room.startedAt + 3 * SERVER_SIMULATION_DT * 1000);

  const { heightError } = runtime.metrics().shadowGroundContact;
  assert.ok(heightError.count > 0, 'высота обязана меряться');
  assert.equal(heightError.max, 0, 'клиент стоит на своей опоре, и сервер находит ту же высоту');
});

// Модель мира обязана спрашивать теми же правилами, по которым живёт клиент.
test('быстрый подъём не считается опорой: порог тот же, что у клиента', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();

  // Игрок над самой площадкой, но летит вверх быстрее допустимого для контакта. Клиент в этот
  // момент в воздухе, и сервер обязан ответить так же. `supportIndexAt` сам по себе пропускает
  // подъём до 2.2 — если спрашивать только его, тут получился бы «пол из ниоткуда».
  player.last = { ...player.last, state: 'air', vy: 2.0 };
  tick(runtime, room, player, 5, room.startedAt);

  const { groundModel } = runtime.metrics().shadowGroundContact;
  assert.ok(groundModel.samples > 0);
  assert.equal(groundModel.serverGroundedOnly, 0, 'подъём быстрее 1.5 опорой не считается');
});

test('свип-тест меряется кадром клиента, а не серверным тиком', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  const top = supportTop(recordRaceCourse(spec).platforms[0]);

  // Клиент обязан реально падать между отсчётами, иначе растягивать свипу нечего и проверка
  // становится пустой. Скорость 8.9 ед/с даёт за серверный тик 0.297, за кадр клиента 0.148.
  const fall = 8.9 / 30;
  player.last = { ...player.last, y: top + 0.097, vy: -8.9, state: 'air' };
  tick(runtime, room, player, 1, room.startedAt);
  const before = runtime.metrics().shadowGroundContact.groundModel.serverGroundedOnly;

  // Следующий отсчёт: игрок ниже верха на 0.2. Прошлый СЕТЕВОЙ отсчёт был на 0.297 выше, то есть
  // выше верха, и растянутый свип нашёл бы здесь опору. Свип длиной в кадр клиента даёт
  // top - 0.052 и опоры не находит — а клиент как раз в воздухе.
  player.last = { ...player.last, y: top + 0.097 - fall };
  tick(runtime, room, player, 1, room.startedAt + SERVER_SIMULATION_DT * 1000);

  const after = runtime.metrics().shadowGroundContact.groundModel.serverGroundedOnly;
  assert.equal(after, before, 'свип не должен захватывать кадр, которого клиент не проходил');
});

// Устаревший снапшот против подвижной опоры.
//
// Позиции рассылаются раз в 66 мс, тик идёт на 30 Гц, сверху сетевая задержка. Спрашивать про опору
// в старой точке у платформы, уже уехавшей к текущему тику, значит сравнивать разные моменты. На
// ботах этого не видно вовсе — там задержки нет, — поэтому проверка нужна отдельная.
test('опора спрашивается у мира на момент снапшота, а не текущего тика', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();

  // Снапшот на секунду старше тика: за это время подвижные опоры успевают уехать.
  const now = room.startedAt + 4000;
  player.lastAt = now - 1000;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const probe = controller.probeWorld;
  const live = controller.world;
  assert.ok(probe && live && probe !== live, 'у замера обязан быть свой мир');
  assert.ok(probe.dynamic.length, 'на трассе обязаны быть подвижные опоры');

  const expected = createShadowCourseWorld(spec);
  expected.advance(3);
  probe.dynamic.forEach((platform, index) => {
    const axis = platform.motion.axis;
    assert.equal(platform[axis], expected.dynamic[index][axis], `опора ${index} на момент снапшота`);
  });
  // А мир свободной траектории обязан стоять на времени ТИКА — иначе перенос опорой поедет.
  const atTick = createShadowCourseWorld(spec);
  atTick.advance(4);
  const axis = live.dynamic[0].motion.axis;
  assert.equal(live.dynamic[0][axis], atTick.dynamic[0][axis]);
});

test('один и тот же снапшот не засчитывается дважды', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  player.lastAt = room.startedAt + 100;

  // Три тика подряд с одним и тем же снапшотом: 66 мс рассылки против 33 мс тика — обычное дело.
  tick(runtime, room, player, 3, room.startedAt + 200);
  assert.equal(runtime.metrics().shadowGroundContact.groundModel.samples, 1);

  // Новый снапшот — новая выборка.
  player.lastAt = room.startedAt + 300;
  tick(runtime, room, player, 1, room.startedAt + 400);
  assert.equal(runtime.metrics().shadowGroundContact.groundModel.samples, 2);
});
