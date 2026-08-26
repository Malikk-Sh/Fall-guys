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
const { evaluateMovementParity } = require('./shadowMovementParityEvidence');

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
    },
    // Живой клиент нумерует свои пакеты, и измерение считает снимок свежим именно по этому номеру:
    // состояния, которые сервер пишет сам (возрождение), его не двигают.
    lastSequence: 0
  };
}

// Контроллер заводится только после первого принятого ввода — ровно как у живого клиента,
// который шлёт CLIENT_INPUT на 30 Гц.
let nextSequence = 0;
function tick(runtime, room, player, count = 1, startNow = 1000, { freshClient = true } = {}) {
  const rooms = new Map([[room.matchId, room]]);
  room.players = new Map([['p1', player]]);
  for (let step = 0; step < count; step++) {
    // Новый пакет от клиента: номер растёт. `freshClient: false` моделирует обратное — либо тот же
    // снимок, растянутый на несколько тиков, либо состояние, записанное самим сервером.
    if (freshClient) player.lastSequence = (player.lastSequence ?? -1) + 1;
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

// Первое наблюдение за игроком измерение считает постановкой: `grounded` у только что
// поставленного ещё не пересчитан, и ярлык опоры ничего не сообщает. Тестам, которым нужны
// выборки, поэтому нужен прогрев — один снимок на месте и один со сдвигом, после которого латч
// отпускает и измерение идёт как обычно.
function warmUp(runtime, room, player, now) {
  tick(runtime, room, player, 1, now);
  player.last = { ...player.last, x: player.last.x + 0.01 };
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);
  return now + 2 * SERVER_SIMULATION_DT * 1000;
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
  // Считается он ОТДЕЛЬНО от `worldMissing`: тот означает «геометрия не построилась», то есть отказ,
  // и порог по нему строгий ноль. У кооператива геометрии нет по устройству, а не по ошибке.
  assert.equal(shadowGroundContact.worldMissing, 0, 'кооператив не отказ геометрии');
  assert.ok(shadowGroundContact.worldUnsupportedMode > 0);
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

  // Снимок старше тика: за это время подвижные опоры успевают уехать. Время снимка приносит сам
  // клиент полем `courseTime` — момент приёма для этого не годится. Расхождение берём в пределах
  // допуска: дальше сервер клиенту не верит (см. отдельную проверку ниже).
  warmUp(runtime, room, player, room.startedAt);
  const now = room.startedAt + 4000;
  player.lastAt = now - 300;
  player.lastCourseTime = 3.7;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const probe = controller.probeWorld;
  const live = controller.world;
  assert.ok(probe && live && probe !== live, 'у замера обязан быть свой мир');
  assert.ok(probe.dynamic.length, 'на трассе обязаны быть подвижные опоры');

  const expected = createShadowCourseWorld(spec);
  expected.advance(3.7);
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
  warmUp(runtime, room, player, room.startedAt);
  const measured = runtime.metrics().shadowGroundContact.groundModel.samples;
  player.lastAt = room.startedAt + 100;

  // Три тика подряд с одним и тем же снимком: 66 мс рассылки против 33 мс тика — обычное дело.
  tick(runtime, room, player, 3, room.startedAt + 200, { freshClient: false });
  assert.equal(runtime.metrics().shadowGroundContact.groundModel.samples, measured);

  // Новый пакет от клиента — новая выборка.
  tick(runtime, room, player, 1, room.startedAt + 400);
  assert.equal(runtime.metrics().shadowGroundContact.groundModel.samples, measured + 1);
});

// Возрождение пишет сервер, а не клиент, и в доказательства такое состояние идти не должно.
//
// Игрок ставится на чекпоинт с `state: 'air'` и нулевой скоростью раньше, чем исправленный клиент
// пришлёт свой снимок. Опора под чекпоинтом при этом находится — и получилось бы расхождение из
// ничего. При пороге в строгий ноль одно возрождение навсегда закрыло бы паритет столкновений.
test('состояние, записанное сервером при возрождении, доказательством не считается', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const start = recordRaceCourse(spec).platforms[0];

  // Сначала обычный обмен: клиент прислал снимок, измерение его учло.
  warmUp(runtime, room, player, room.startedAt);
  const before = runtime.metrics().shadowGroundContact.groundModel.samples;
  assert.ok(before > 0, 'обычный клиентский снимок в выборку идёт');

  // А теперь ровно то, что пишет сервер: точка чекпоинта, «воздух», нули, номер пакета НЕ растёт.
  player.last = {
    x: start.x,
    y: supportTop(start) + PLAYER_FOOT,
    z: start.z,
    vx: 0,
    vy: 0,
    vz: 0,
    state: 'air'
  };
  player.lastAt = room.startedAt + 500;
  tick(runtime, room, player, 4, room.startedAt + 600, { freshClient: false });

  const { groundModel } = runtime.metrics().shadowGroundContact;
  assert.equal(groundModel.samples, before, 'решение сервера — не наблюдение за клиентом');
  assert.equal(groundModel.serverGroundedOnly, 0, 'и уж точно не расхождение');
});

// Подвижная опора в доказательства не идёт: её фазу к моменту снимка восстановить нечем.
//
// В `PLAYER_STATE` клиентского времени нет вовсе, а `lastAt` — момент приёма пакета. За время
// задержки платформа уезжает, и сравнение старой позиции игрока с новой позицией опоры дало бы
// расхождение из ничего.
test('выборка на подвижной опоре не засчитывается, а откладывается отдельно', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  tick(runtime, room, player, 1, room.startedAt);

  const controller = runtime.controllers.get(player);
  const before = runtime.metrics().shadowGroundContact.groundModel;

  // Позицию опоры берём на то же время матча, на котором её увидит замер.
  const at = SERVER_SIMULATION_DT;
  const expected = createShadowCourseWorld(spec);
  expected.advance(at);
  const moving = expected.dynamic[0];
  assert.ok(moving, 'на трассе обязана быть подвижная опора');

  player.last = {
    ...player.last,
    x: moving.x,
    y: supportTop(moving) + PLAYER_FOOT,
    z: moving.z,
    vy: 0,
    state: 'ground'
  };
  // Перестановка через полтрассы — не возрождение: проверяем другое, поэтому подставляем новую
  // позицию как уже известную. Обнулять её нельзя — тогда тик считался бы первым наблюдением, и
  // выборка отложилась бы как постановка.
  controller.lastClientPosition = { x: player.last.x, y: player.last.y, z: player.last.z };
  tick(runtime, room, player, 1, room.startedAt + at * 1000);

  const after = runtime.metrics().shadowGroundContact.groundModel;
  assert.equal(after.samples, before.samples, 'в согласие такая выборка не идёт');
  assert.equal(after.dynamicSkipped, before.dynamicSkipped + 1, 'но и не теряется молча');
});

// Только что поставленный игрок про опору не свидетельствует.
//
// `Player.respawn` и `Player.teleport` переносят позицию и обнуляют скорость, но `grounded` не
// пересчитывают — это сделает следующий шаг физики. Один кадр игрок помечен воздухом, стоя над
// самым полом, и замер видел в этом расхождение геометрии. Собственный поиск опоры клиента в той же
// точке при этом находит ту же опору: подпись на прогоне ботов была 51 случай из 51 с `vy = 0` и
// неподвижной позицией на высоте чекпоинта.
test('кадр сразу после постановки в доказательства не идёт', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  const start = recordRaceCourse(spec).platforms[0];
  tick(runtime, room, player, 2, room.startedAt);
  const before = runtime.metrics().shadowGroundContact.groundModel;

  // Возврат на чекпоинт: скачок позиции, «воздух», нулевая скорость — и над самой опорой.
  const placed = {
    x: start.x,
    y: supportTop(start) + PLAYER_FOOT + 0.266,
    z: start.z - 30,
    vx: 0,
    vy: 0,
    vz: 0,
    state: 'air'
  };
  player.last = placed;
  tick(runtime, room, player, 1, room.startedAt + 2 * SERVER_SIMULATION_DT * 1000);

  // Пока игрок стоит на месте постановки, выборки откладываются.
  player.last = { ...placed };
  tick(runtime, room, player, 2, room.startedAt + 3 * SERVER_SIMULATION_DT * 1000);
  const during = runtime.metrics().shadowGroundContact.groundModel;
  assert.equal(during.samples, before.samples, 'шага физики ещё не было — свидетельствовать нечем');
  assert.equal(during.serverGroundedOnly, before.serverGroundedOnly, 'и расхождением это не считается');
  assert.ok(during.placedSkipped > 0, 'пропуск обязан быть виден в счётчике');

  // Клиент сдвинулся — значит шаг прошёл, и выборки снова идут.
  player.last = { ...placed, y: placed.y - 0.05, vy: -0.8 };
  tick(runtime, room, player, 1, room.startedAt + 5 * SERVER_SIMULATION_DT * 1000);
  assert.ok(
    runtime.metrics().shadowGroundContact.groundModel.samples > before.samples,
    'после первого же шага измерение возобновляется'
  );
});

// Подвижная опора сверяется, когда клиент прислал время трассы, и откладывается, когда не прислал.
test('courseTime возвращает подвижные опоры в доказательства', () => {
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const at = 3;

  // Позиция опоры на том самом моменте трассы, который клиент и сообщает.
  const expected = createShadowCourseWorld(spec);
  expected.advance(at);
  const moving = expected.dynamic[0];
  assert.ok(moving, 'на трассе обязана быть подвижная опора');

  const onMovingPlatform = runtime => {
    const player = standingPlayer();
    warmUp(runtime, room, player, room.startedAt);
    const controller = runtime.controllers.get(player);
    player.last = {
      ...player.last,
      x: moving.x,
      y: supportTop(moving) + PLAYER_FOOT,
      z: moving.z,
      vy: 0,
      state: 'ground'
    };
    controller.lastClientPosition = { x: player.last.x, y: player.last.y, z: player.last.z };
    return player;
  };

  // Без времени трассы сверять нечем: момент приёма для подвижной опоры не годится.
  const without = new ShadowInputRuntime();
  const a = onMovingPlatform(without);
  const beforeA = without.metrics().shadowGroundContact.groundModel;
  tick(without, room, a, 1, room.startedAt + at * 1000);
  const afterA = without.metrics().shadowGroundContact.groundModel;
  assert.equal(afterA.samples, beforeA.samples);
  assert.equal(afterA.dynamicSkipped, beforeA.dynamicSkipped + 1);

  // С временем трассы мир доводится ровно до момента снимка, и выборка идёт в согласие.
  const withTime = new ShadowInputRuntime();
  const b = onMovingPlatform(withTime);
  const beforeB = withTime.metrics().shadowGroundContact.groundModel;
  b.lastCourseTime = at;
  tick(withTime, room, b, 1, room.startedAt + at * 1000);
  const afterB = withTime.metrics().shadowGroundContact.groundModel;
  assert.equal(afterB.dynamicSkipped, beforeB.dynamicSkipped, 'откладывать больше нечего');
  assert.equal(afterB.samples, beforeB.samples + 1, 'выборка засчитана');
  assert.equal(afterB.serverGroundedOnly, 0, 'и опора совпала');
});

// Время трассы приходит от клиента, а клиент не источник истины.
//
// Само поле безобидно — читает его только диагностика, — но метрики паритета общие на процесс, и
// подставленное значение навело бы платформу на чужую фазу: испортило бы доказательства или,
// наоборот, приукрасило их. Поэтому оно принимается лишь в пределах допуска от собственного времени
// сервера, а за ним не берётся вовсе.
test('время трассы, не сходящееся с серверным, во внимание не принимается', () => {
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const at = 3;
  const expected = createShadowCourseWorld(spec);
  expected.advance(at);
  const moving = expected.dynamic[0];

  const onMovingPlatform = (runtime, courseTime) => {
    const player = standingPlayer();
    warmUp(runtime, room, player, room.startedAt);
    const controller = runtime.controllers.get(player);
    player.last = {
      ...player.last,
      x: moving.x,
      y: supportTop(moving) + PLAYER_FOOT,
      z: moving.z,
      vy: 0,
      state: 'ground'
    };
    player.lastCourseTime = courseTime;
    controller.lastClientPosition = { x: player.last.x, y: player.last.y, z: player.last.z };
    tick(runtime, room, player, 1, room.startedAt + at * 1000);
    return runtime.metrics().shadowGroundContact.groundModel;
  };

  // Заявленное время расходится с серверным на минуту — верить нечему.
  const lying = onMovingPlatform(new ShadowInputRuntime(), at + 60);
  assert.equal(lying.dynamicSkipped, 1, 'подвижная опора отложена, как будто поля нет');

  // И отрицательное время тоже не берётся.
  const negative = onMovingPlatform(new ShadowInputRuntime(), -5);
  assert.equal(negative.dynamicSkipped, 1);

  // А сошедшееся — принимается.
  const honest = onMovingPlatform(new ShadowInputRuntime(), at);
  assert.equal(honest.dynamicSkipped, 0, 'сошедшемуся времени верим');
});

// Разрыв в пакетах — не постановка, и доказательства из-за него не должны пропадать насовсем.
//
// Постановка распознаётся по скачку позиции, а скачок не отличает возрождение от обычного бега,
// потерявшего несколько снимков. Остановись игрок после такого разрыва — его округлённая позиция
// совпадала бы с «точкой постановки» сколь угодно долго.
test('откладывание после скачка ограничено и само отпускает', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  warmUp(runtime, room, player, room.startedAt);
  const start = runtime.metrics().shadowGroundContact.groundModel;
  const before = start.samples;
  // Прогрев сам тратит пропуск на первое наблюдение, поэтому считаем ПРИРОСТ от скачка.
  const skippedBefore = start.placedSkipped;

  // Разрыв: игрок «перепрыгнул» дальше порога, хотя никакого возрождения не было.
  const far = { ...player.last, z: player.last.z - 30 };
  player.last = far;
  tick(runtime, room, player, 1, room.startedAt + 2 * SERVER_SIMULATION_DT * 1000);

  // И замер на месте — позиция не меняется. Пропуски обязаны кончиться.
  let now = room.startedAt + 3 * SERVER_SIMULATION_DT * 1000;
  for (let step = 0; step < 8; step++) {
    player.last = { ...far };
    tick(runtime, room, player, 1, now);
    now += SERVER_SIMULATION_DT * 1000;
  }

  const model = runtime.metrics().shadowGroundContact.groundModel;
  const skippedByJump = model.placedSkipped - skippedBefore;
  assert.ok(skippedByJump > 0, 'первые снимки после скачка откладываются');
  assert.ok(skippedByJump <= 2, 'но не бесконечно: запас ограничен');
  assert.ok(model.samples > before, 'дальше доказательства снова идут, а не пропадают');
});

test('кадр постановки не попадает и в отрыв траектории', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  tick(runtime, room, player, 2, room.startedAt);
  const before = runtime.metrics().shadowGroundContact.freeTrajectoryError.count;

  // Возврат на чекпоинт: скачок, затем тот же снимок ещё раз.
  const placed = { ...player.last, z: player.last.z - 40, vy: 0, state: 'air' };
  player.last = placed;
  tick(runtime, room, player, 1, room.startedAt + 2 * SERVER_SIMULATION_DT * 1000);
  player.last = { ...placed };
  tick(runtime, room, player, 1, room.startedAt + 3 * SERVER_SIMULATION_DT * 1000);

  assert.equal(
    runtime.metrics().shadowGroundContact.freeTrajectoryError.count,
    before,
    'непригодный как свидетельство кадр не должен смещать и доли превышения отрыва'
  );
});

// Первое наблюдение за игроком — тоже постановка.
//
// Скачку в этот момент взяться неоткуда: предыдущей позиции ещё нет, поэтому распознавание по
// расстоянию тут не срабатывает. Но на старте игрок так же ПОСТАВЛЕН на площадку, а не пришёл на
// неё шагом, и `grounded` пересчитает лишь следующий кадр. На прогоне ботов это давало ровно один
// случай «пол из ниоткуда» на забег, всегда на первом тике.
test('первый снимок игрока доказательством об опоре не считается', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();
  const start = recordRaceCourse(spec).platforms[0];

  // Ровно то, что видно на старте: игрок над площадкой, помечен воздухом, скорости нет.
  player.last = {
    ...player.last,
    y: supportTop(start) + PLAYER_FOOT + 0.266,
    vy: 0,
    state: 'air'
  };
  tick(runtime, room, player, 2, room.startedAt);

  const model = runtime.metrics().shadowGroundContact.groundModel;
  assert.equal(model.serverGroundedOnly, 0, 'постановка на старт — не расхождение геометрии');
  assert.ok(model.placedSkipped > 0, 'пропуск обязан быть виден');
  // И возвратом на чекпоинт первое наблюдение считаться не должно.
  assert.equal(runtime.metrics().shadowGroundContact.clientTeleports, 0);
});

// Не всякое первое наблюдение — постановка.
//
// Контроллер заводится по первому `CLIENT_INPUT`, а не в начале матча, и клиент вполне может успеть
// шагнуть раньше: браузер снимает ввод рядом с `Player.step`, а состояние уходит до того, как
// `net.tick()` вытолкнет ввод. Тогда первый снимок — законное состояние на опоре, и выбрасывать его
// значило бы терять настоящее доказательство, а у стоящего игрока ещё и следующее.
test('первый снимок просимулированного игрока в доказательства идёт', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1000;
  const player = standingPlayer();

  // Обычный игрок на опоре: скорость есть, помечен `ground` — на постановку не похож.
  player.last = { ...player.last, vx: 1.2, vy: 0, vz: -3.4, state: 'ground' };
  tick(runtime, room, player, 1, room.startedAt);

  const model = runtime.metrics().shadowGroundContact.groundModel;
  assert.equal(model.samples, 1, 'просимулированное состояние — полноценное свидетельство');
  assert.equal(model.placedSkipped, 0, 'и откладывать его не за что');
});

test('удар по одному игроку не закрывается сбиванием другого', () => {
  // Ожидания сопоставления живут у КАЖДОГО игрока свои. Пока набор был один на весь runtime, а
  // измерение вызывалось на каждого игрока отдельно, удар сервера по игроку A мог закрыться
  // сбиванием игрока B, оказавшимся рядом по времени.
  //
  // Ошибка приукрашивающая: чужая пара повышает долю совпадений и снижает число выдуманных ударов,
  // то есть двигает доказательства в сторону открытия ворот. На одном игроке её не видно вовсе —
  // именно поэтому замер на ботах её не поймал бы, сколько его ни гоняй.
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const now = room.startedAt + 5000;

  const struck = standingPlayer();
  const downed = standingPlayer();
  const rooms = new Map([[room.matchId, room]]);
  room.players = new Map([
    ['struck', struck],
    ['downed', downed]
  ]);

  // Оба игрока живые: контроллеры заводятся по первому вводу.
  for (const [id, player] of room.players) {
    runtime.accept({
      player,
      room,
      message: {
        matchId: room.matchId,
        sequence: 0,
        clientTick: 0,
        moveX: 0,
        moveZ: 0,
        cameraYaw: 0,
        jumpPressed: false,
        jumpHeld: false,
        divePressed: false
      }
    });
    assert.ok(runtime.controllers.get(player), `контроллер игрока ${id} обязан существовать`);
  }
  runtime.tick(rooms, now);

  // Сервер бьёт ПЕРВОГО игрока, а сбивание видно у ВТОРОГО. Пары здесь нет ни у кого.
  const controller = runtime.controllers.get(struck);
  const bumper = controller.world.obstacles.find(o => o.type === 'bumper');
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.lastClientPosition = null;
  downed.last = { ...downed.last, state: 'knockdown' };

  for (let step = 1; step <= 16; step++) {
    for (const player of room.players.values()) player.lastSequence += 1;
    runtime.tick(rooms, now + step * SERVER_SIMULATION_DT * 1000);
  }

  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.serverHits, 1, 'сервер ударил ровно одного игрока');
  assert.equal(hitParity.clientHits, 1, 'сбивание видно ровно у одного игрока');
  assert.equal(hitParity.matched, 0, 'события разных игроков совпадением быть не могут');
  assert.equal(hitParity.serverOnly, 1, 'удар без своей пары обязан остаться выдуманным');
  assert.equal(hitParity.clientOnly, 1, 'сбивание без своей пары обязано остаться прозеванным');
});

test('конец матча закрывает ожидания, а не оставляет их висеть', () => {
  // Когда финиширует последний игрок, ядро переводит комнату в RESULTS СИНХРОННО
  // (`checkMatchEnd` → `finishMatch`), поэтому следующий тик пропускает комнату по состоянию и до
  // ветки финиша игрока не доходит. Незакрытое ожидание в знаменатель доли совпадений не входит,
  // значит паритет выглядел бы лучше, чем он есть.
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

  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1, 'удар ждёт пару');
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.serverOnly, 0);

  // Матч кончился. Комната больше не активна, и тиков по игроку не будет.
  room.state = ROOM_STATE.RESULTS;
  runtime.tick(new Map([[room.matchId, room]]), now + 2 * SERVER_SIMULATION_DT * 1000);

  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.serverOnly, 1, 'ожидание обязано закрыться выдуманным ударом');
  assert.equal(hitParity.pending, 0);
});

test('сбивание в финишном пакете успевает попасть в пару', () => {
  // Проверка финиша у клиента (`client/game/Player.js`) сбитого не исключает: игрока может занести
  // за финишную плоскость лёжа, и тогда финишный пакет — первый снимок со сбиванием. Ветка финиша
  // `consume` не вызывает, поэтому без отдельного наблюдения такое сбивание пропало бы, а ждущий
  // пары удар сервера закрылся бы как выдуманный, хотя пара у него была.
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
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1);

  // Финиш приходит вместе с первым снимком, где игрок сбит.
  player.finished = true;
  player.last = { ...player.last, state: 'knockdown' };
  runtime.tick(new Map([[room.matchId, room]]), now + 2 * SERVER_SIMULATION_DT * 1000);

  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.clientHits, 1, 'сбивание из финишного снимка обязано быть замечено');
  assert.equal(hitParity.matched, 1, 'и обязано сойтись с ждущим ударом сервера');
  assert.equal(hitParity.serverOnly, 0, 'иначе удар записался бы в выдуманные при живой паре');
});

test('ушедший игрок закрывает свои ожидания, а не уносит их с собой', () => {
  // `dropPlayer` удаляет игрока из комнаты немедленно — по `LEAVE_ROOM`, по обрыву, по исключению.
  // Контроллер после этого лежит в WeakMap и недостижим, поэтому закрытие обязано идти снаружи.
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
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1);

  assert.equal(runtime.release(player), true);
  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.serverOnly, 1, 'ожидание ушедшего обязано стать выдуманным ударом');
  assert.equal(hitParity.pending, 0);
  assert.equal(runtime.controllers.get(player), undefined, 'контроллер обязан быть отпущен');

  // Повторный отпуск ничего не досчитывает: иначе один удар считался бы дважды.
  assert.equal(runtime.release(player), false);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.serverOnly, 1);
});

// Удар, замеченный уже на выходе игрока, отметить его собственным временем нечем — и он обязан быть
// ПОСЧИТАН как невыровненный.
//
// Иначе `clientStamp` врёт в самую опасную сторону: показывает «выровнено всё», пока такие удары
// молча подмешивают в гистограмму возраст снимка. Показатель, который нельзя проверить на полноту,
// хуже отсутствующего — по нему как раз и будут решать, верить ли `matchDelay`.
// Свободная траектория идёт ПОЗАДИ игрока ровно на возраст снимка минус тик.
//
// Это не дефект, а следствие намеренного устройства: якорь ставится по запоздавшему снимку, и
// именно поэтому постоянная часть задержки уходит из замера отрыва — обе стороны запаздывают
// одинаково (см. `freeTrajectoryError`). Но у ВРЕМЕНИ УДАРА последствие обратное: мир доводится до
// текущего момента, а траектория идёт позади — значит до препятствий она доходит позже, и
// `matchDelay` получает известное смещение вверх.
//
// Закон записан тестом, потому что по нему читают боевые данные: без него остаточное смещение в
// `matchDelay` принимают за расхождение физики. Первое же боевое чтение после выравнивания дало
// +1.47 тика, что сходится с предсказанием (возраст 3.5 → отставание 2.5) за вычетом остатка
// дискретности рассылки (−1).
//
// ГРАНИЦА УТВЕРЖДЕНИЯ, и она узкая: здесь равномерный прямой бег с постоянной скоростью. Ровно на
// такой траектории якорь, продвинутый текущим вводом, и есть сдвинутая во времени копия клиентской.
// Стоит игроку разогнаться, повернуть, прыгнуть или сменить ввод внутри запоздавшего промежутка —
// копия перестаёт быть точной, и смещение уже не обязано равняться `возраст − 1`. Переносить это
// число на боевые данные, где игрока бьют и подбрасывают, можно только как оценку порядка.
test('свободная траектория отстаёт на возраст снимка минус тик — на равномерном прямом беге', () => {
  const speed = 7.7; // RUN_SPEED: столько же, сколько даёт ввод свободной траектории
  const startPlatform = recordRaceCourse(spec).platforms[0];
  const floorY = supportTop(startPlatform) + PLAYER_FOOT;

  const lagFor = ageTicks => {
    const runtime = new ShadowInputRuntime();
    const room = raceRoom();
    room.startedAt = 1_760_000_000_000;
    const player = standingPlayer();
    const rooms = new Map([[room.matchId, room]]);
    room.players = new Map([['p1', player]]);
    const history = [];
    const lags = [];

    for (let step = 0; step < 120; step++) {
      const matchTime = step * SERVER_SIMULATION_DT;
      const trueZ = startPlatform.z - speed * matchTime;
      history.push({ z: trueZ, courseTime: matchTime });
      // Снимок, дошедший до сервера, старше на `ageTicks`.
      const seen = history[Math.max(0, history.length - 1 - ageTicks)];
      player.lastSequence = (player.lastSequence ?? -1) + 1;
      player.last = {
        x: startPlatform.x,
        y: floorY,
        z: seen.z,
        vx: 0,
        vy: 0,
        vz: -speed,
        state: 'ground'
      };
      player.lastCourseTime = seen.courseTime;
      runtime.accept({
        player,
        room,
        message: {
          matchId: room.matchId,
          sequence: nextSequence,
          clientTick: nextSequence,
          moveX: 0,
          moveZ: 1,
          cameraYaw: 0,
          jumpPressed: false,
          jumpHeld: false,
          divePressed: false
        }
      });
      nextSequence += 1;
      runtime.tick(rooms, room.startedAt + step * SERVER_SIMULATION_DT * 1000);

      const controller = runtime.controllers.get(player);
      // Разгон до беговой скорости занимает около секунды — до него сравнивать нечего.
      if (controller && step > 40) lags.push(controller.freeState.position.z - trueZ);
    }
    const mean = lags.reduce((sum, value) => sum + value, 0) / lags.length;
    return mean / (speed * SERVER_SIMULATION_DT);
  };

  for (const age of [0, 1, 2, 3, 4, 6]) {
    const lag = lagFor(age);
    assert.ok(
      Math.abs(lag - (age - 1)) < 0.05,
      `при возрасте ${age} отставание обязано быть ${age - 1} тика, а получено ${lag.toFixed(2)}`
    );
  }
});

// Часы клиента ВПЕРЕДИ серверных выравниванием не считаются.
//
// `trustedCourseTime` пускает расхождение в обе стороны на полсекунды. Отрицательный возраст
// означает разъехавшиеся часы, а не свежий снимок: прижать его к нулю и объявить выровненным
// значило бы мерить по приёму и одновременно уверять, что мерили по клиенту.
function pairAfterServerHit(courseTime, anchorCourseTime = 4.95) {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;
  // Время трассы нужно уже здесь: якорь свободной траектории ставится на первом же тике, и его
  // возраст запоминается тогда же. Без него возраст якоря неизвестен — и записывать его нечем.
  player.lastCourseTime = anchorCourseTime;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  const bumper = controller.world.obstacles.find(o => o.type === 'bumper');
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.lastClientPosition = null;
  // Свежее время трассы подставляется ДО тика серверного удара: возраст якоря уже зафиксирован, и
  // здесь начинается расхождение между ним и возрастом текущего снимка.
  player.lastCourseTime = courseTime;
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1, 'подготовка: серверный удар ждёт');

  // Клиент сообщает о сбивании.
  player.last = { ...player.last, state: 'knockdown' };
  tick(runtime, room, player, 1, now + 2 * SERVER_SIMULATION_DT * 1000);
  return runtime.metrics().shadowGroundContact.hitParity;
}

// Возраст записывается по ТОЙ ЖЕ совокупности, что и гистограмма.
//
// Из него вычитают смещение `matchDelay`, а вычитать величину, посчитанную по другим событиям,
// значит получить ложный остаток: игрок с большой задержкой и без единой совпавшей пары задрал бы
// средний возраст, ничего не добавив в гистограмму. Та же ошибка знаменателя, что была у
// `clientStamp`, — и здесь её быть не должно.
test('возраст якоря считается по образцам гистограммы, а не по всем снимкам', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;

  // Десяток тиков без единого удара: снимки идут, возраст у них есть, но в гистограмму ничего не
  // попадает — и в счётчике возраста тоже не должно.
  player.lastCourseTime = 4.8;
  tick(runtime, room, player, 10, now);
  const quiet = runtime.metrics().shadowGroundContact.hitParity;
  assert.equal(quiet.matchDelay.samples, 0, 'подготовка: ударов не было');
  assert.equal(
    quiet.anchorAge.known + quiet.anchorAge.unknown,
    0,
    'без образцов гистограммы возраст не копится'
  );
});

// Записывается возраст ЯКОРЯ, а не возраст снимка самого удара.
//
// Смещение серверного удара по времени задано тем снимком, по которому поставлена свободная
// траектория, — а ставится она раз в тридцать тиков. Если задержка за это время изменилась, возраст
// снимка удара уже другой, и вычитание не той величины даёт выдуманный остаток в любую сторону.
// Якорь, поставленный СЕРВЕРОМ, возраста не имеет — и не должен его выдумывать.
//
// При возрождении `server/index.js` перезаписывает `player.last` точкой чекпоинта, а
// `lastCourseTime` оставляет от прошлого клиентского снимка. Разность с застывшим временем растёт, и
// приписать её якорю значило бы отравить `anchorAge` на весь горизонт — то есть ровно ту величину,
// которую из `matchDelay` потом вычитают. Отличается это точно: номер пакета растёт только на
// клиентских сообщениях, а возрождение его не трогает.
test('якорь по серверной постановке возраста не получает', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;
  player.lastCourseTime = 4.95;
  tick(runtime, room, player, 1, now);

  const controller = runtime.controllers.get(player);
  assert.ok(Number.isFinite(controller.anchorAgeTicks), 'подготовка: по клиентскому пакету возраст есть');

  // Возрождение: сервер пишет `player.last` сам, номер пакета не трогает, время трассы застывает.
  const rooms = new Map([[room.matchId, room]]);
  room.players = new Map([['p1', player]]);
  player.last = { ...player.last, z: player.last.z - 40, state: 'air' };
  runtime.tick(rooms, now + SERVER_SIMULATION_DT * 1000);

  assert.equal(controller.anchorAgeTicks, null, 'серверная постановка обязана оставить возраст неизвестным');
});

test('возраст берётся у якоря траектории, а не у снимка удара', () => {
  // Якорь ставится по СТАРОМУ снимку (возраст около 6 тиков), а удар приходит со свежим (около 2).
  const parity = pairAfterServerHit(5.0, 4.8);
  assert.equal(parity.matched, 1, 'подготовка: пара обязана сойтись');
  assert.equal(parity.anchorAge.known, 1);
  assert.ok(
    parity.anchorAge.meanAgeTicks > 4,
    `обязан быть записан возраст якоря (около 6), а записано ${parity.anchorAge.meanAgeTicks}`
  );
  // Задержка ТОГО ЖЕ образца лежит рядом — только по этой паре остаток и считается честно.
  assert.equal(parity.anchorAge.meanDelayTicks, parity.matchDelay.meanTicks);

  // А образец, у которого возраст якоря неизвестен, обязан быть ПОСЧИТАН отдельно, а не выпасть
  // молча: иначе средние двух величин описывали бы разные совокупности, и остаток вышел бы
  // выдуманным. Время трассы на два метра мимо серверного доверия не проходит вовсе.
  const untrusted = pairAfterServerHit(5.0, 3.0);
  assert.equal(untrusted.matched, 1, 'подготовка: пара обязана сойтись и здесь');
  assert.equal(untrusted.anchorAge.known, 0, 'возраст такого якоря неизвестен');
  assert.equal(untrusted.anchorAge.unknown, 1, 'но образец обязан быть посчитан');
  assert.equal(
    untrusted.anchorAge.known + untrusted.anchorAge.unknown,
    untrusted.matchDelay.samples,
    'сумма обязана сходиться с числом образцов гистограммы'
  );
});

test('снимок из прошлого выравнивает пару, снимок из будущего — нет', () => {
  // Время матча на этом тике — около 5.067 с.
  const behind = pairAfterServerHit(5.0);
  assert.equal(behind.matched, 1, 'подготовка: пара обязана сойтись');
  assert.equal(behind.clientStamp.aligned, 1, 'снимок из прошлого — обычный случай, он выровнен');
  assert.equal(behind.clientStamp.unaligned, 0);
  // И возраст ЯКОРЯ пришёл вместе с этим самым образцом.
  assert.equal(behind.anchorAge.known, 1, 'возраст якоря обязан записаться у совпавшей пары');
  assert.equal(behind.anchorAge.unknown, 0);
  assert.ok(
    behind.anchorAge.meanAgeTicks >= 0,
    `возраст обязан быть неотрицательным, а он ${behind.anchorAge.meanAgeTicks}`
  );

  const ahead = pairAfterServerHit(5.2);
  assert.equal(ahead.matched, 1, 'подготовка: пара обязана сойтись и здесь');
  assert.equal(ahead.clientStamp.aligned, 0, 'часы впереди сервера выравниванием не считаются');
  assert.equal(ahead.clientStamp.unaligned, 1);

  // И без времени трассы вовсе — тоже невыровнено, а не «выровнено по умолчанию».
  const missing = pairAfterServerHit(undefined);
  assert.equal(missing.matched, 1);
  assert.equal(missing.clientStamp.unaligned, 1);
});

test('удар, найденный при отпуске игрока, помечает пару как невыровненную', () => {
  const runtime = new ShadowInputRuntime();
  const room = raceRoom();
  room.startedAt = 1_760_000_000_000;
  const player = standingPlayer();
  const now = room.startedAt + 5000;
  tick(runtime, room, player, 1, now);

  // Серверный удар: ставим свободную траекторию в бампер, как в проверке отпуска выше.
  const controller = runtime.controllers.get(player);
  const bumper = controller.world.obstacles.find(o => o.type === 'bumper');
  controller.freeState.position.x = bumper.x;
  controller.freeState.position.y = bumper.y;
  controller.freeState.position.z = bumper.z;
  controller.lastClientPosition = null;
  tick(runtime, room, player, 1, now + SERVER_SIMULATION_DT * 1000);
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.pending, 1, 'подготовка: удар ждёт пару');
  assert.equal(runtime.metrics().shadowGroundContact.hitParity.matchDelay.samples, 0);

  // Клиент прислал сбивание последним, что успел, — и ушёл. Отметить это своим временем нечем.
  player.last = { ...player.last, state: 'knockdown' };
  assert.equal(runtime.release(player), true);

  const { hitParity } = runtime.metrics().shadowGroundContact;
  assert.equal(hitParity.matched, 1, 'подготовка: пара обязана сойтись');
  assert.equal(hitParity.matchDelay.samples, 1, 'и попасть в гистограмму');
  assert.equal(hitParity.clientStamp.unaligned, 1, 'образец обязан быть помечен невыровненным');
  assert.equal(hitParity.clientStamp.aligned, 0);
  // Знаменатель обязан совпадать с содержимым гистограммы — ради этого счёт и переехал на выдачу
  // задержки.
  assert.equal(hitParity.clientStamp.aligned + hitParity.clientStamp.unaligned, hitParity.matchDelay.samples);
});

test('кооператив не выдаёт себя за сломанную геометрию', () => {
  // `maxWorldMissingSamples` требует строгий ноль и означает «матч, у которого геометрия не
  // построилась, доказательством быть не может». Кооператив не сломанная сборка: безголовой
  // геометрии у него нет вовсе, потому что главы рукотворные.
  //
  // Метрики общие на процесс, а один процесс держит комнаты обоих режимов. Пока оба случая шли в
  // один счётчик, любой кооперативный матч закрывал паритет столкновений НАВСЕГДА — и не потому,
  // что паритет плох, а потому, что рядом играли в другой режим.
  const runtime = new ShadowInputRuntime();
  const coop = {
    mode: GAME_MODE.COOP,
    state: ROOM_STATE.PLAYING,
    matchId: 'coop-1',
    spec: { chapterId: 'ch1' },
    startedAt: 1_760_000_000_000,
    players: new Map()
  };
  const player = standingPlayer();
  coop.players.set('c', player);
  const rooms = new Map([[coop.matchId, coop]]);
  runtime.accept({
    player,
    room: coop,
    message: {
      matchId: coop.matchId,
      sequence: 0,
      clientTick: 0,
      moveX: 0,
      moveZ: 0,
      cameraYaw: 0,
      jumpPressed: false,
      jumpHeld: false,
      divePressed: false
    }
  });
  for (let step = 1; step <= 12; step++) {
    player.lastSequence += 1;
    runtime.tick(rooms, coop.startedAt + step * SERVER_SIMULATION_DT * 1000);
  }

  const metrics = runtime.metrics().shadowGroundContact;
  assert.equal(metrics.worldMissing, 0, 'кооператив не отказ геометрии');
  assert.ok(metrics.worldUnsupportedMode > 0, 'но и молчать о нём нельзя: паритет там не проверен');
  assert.ok(
    !evaluateMovementParity(metrics).reasons.includes('world-missing'),
    'кооператив не должен закрывать паритет столкновений'
  );
});

test('гонка со сломанной геометрией по-прежнему закрывает паритет', () => {
  // Обратная сторона: разделение не должно превратиться в способ спрятать настоящий отказ.
  const runtime = new ShadowInputRuntime();
  const broken = {
    mode: GAME_MODE.RACE,
    state: ROOM_STATE.PLAYING,
    matchId: 'race-broken',
    // Именно ОТСУТСТВИЕ спеки: сломанный `segmentCount` мир всё равно строит, и настоящим отказом
    // это не является. Проверять надо тот случай, который действительно оставляет гонку без пола.
    spec: null,
    startedAt: 1_760_000_000_000,
    players: new Map()
  };
  const player = standingPlayer();
  broken.players.set('p', player);
  const rooms = new Map([[broken.matchId, broken]]);
  runtime.accept({
    player,
    room: broken,
    message: {
      matchId: broken.matchId,
      sequence: 0,
      clientTick: 0,
      moveX: 0,
      moveZ: 0,
      cameraYaw: 0,
      jumpPressed: false,
      jumpHeld: false,
      divePressed: false
    }
  });
  for (let step = 1; step <= 12; step++) {
    player.lastSequence += 1;
    runtime.tick(rooms, broken.startedAt + step * SERVER_SIMULATION_DT * 1000);
  }

  const metrics = runtime.metrics().shadowGroundContact;
  assert.ok(metrics.worldMissing > 0, 'гоночная комната без геометрии — именно отказ');
  assert.equal(metrics.worldUnsupportedMode, 0);
  assert.ok(evaluateMovementParity(metrics).reasons.includes('world-missing'));
});

test('неизвестный режим закрывает ворота, а не проходит как неприменимый', () => {
  // Прошлая редакция делила режимы надвое, и всё, что не гонка, шло в неприменимость. Неизвестный
  // режим тем самым переставал блокировать ворота — при том, что геометрия ему могла быть положена
  // и просто не строиться. Умолчание обязано стоять на стороне отказа.
  const runtime = new ShadowInputRuntime();
  const room = {
    mode: 'режим-которого-нет',
    state: ROOM_STATE.PLAYING,
    matchId: 'unknown-1',
    spec,
    startedAt: 1_760_000_000_000,
    players: new Map()
  };
  const player = standingPlayer();
  room.players.set('p', player);
  const rooms = new Map([[room.matchId, room]]);
  runtime.accept({
    player,
    room,
    message: {
      matchId: room.matchId,
      sequence: 0,
      clientTick: 0,
      moveX: 0,
      moveZ: 0,
      cameraYaw: 0,
      jumpPressed: false,
      jumpHeld: false,
      divePressed: false
    }
  });
  for (let step = 1; step <= 12; step++) {
    player.lastSequence += 1;
    runtime.tick(rooms, room.startedAt + step * SERVER_SIMULATION_DT * 1000);
  }

  const metrics = runtime.metrics().shadowGroundContact;
  assert.ok(metrics.worldMissing > 0, 'неизвестный режим обязан считаться отказом');
  assert.equal(metrics.worldUnsupportedMode, 0, 'неприменимость только для явно перечисленных');
  assert.ok(evaluateMovementParity(metrics).reasons.includes('world-missing'));
});
