const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeName,
  safeDifficulty,
  createCourseSpec,
  spawnFor,
  validateState,
  canFinish,
  leaderboard,
  verifyCheckpointTime,
  verifyMovement,
  MIN_CHECKPOINT_INTERVAL_MS
} = require('./gameRules');
const {
  originAllowed,
  positiveInt,
  capacityStatus,
  loadStatus,
  rotateEventLoopWindow,
  createEventCounters,
  trackEvent
} = require('./index');
const { coopSpec } = require('../shared/coopChapters.js');
const { validateCoopEvent, findCatapult } = require('./coopRules');

test('player names preserve safe international characters and stay bounded', () => {
  assert.equal(safeName('<b>Малик 🚀</b>'), 'bМалик b');
  assert.equal(safeName('x'.repeat(40)).length, 16);
  assert.equal(safeName('   '), 'Wobbler');
});
test('course specs are deterministic and difficulty changes length', () => {
  assert.deepEqual(createCourseSpec(42, 'normal'), createCourseSpec(42, 'normal'));
  assert.equal(createCourseSpec(42, 'easy').segmentCount, 5);
  assert.equal(createCourseSpec(42, 'chaos').finishZ, -139);
  assert.equal(safeDifficulty('impossible'), 'normal');
});
test('checkpoint spawns remain behind the checkpoint line', () => {
  const spec = createCourseSpec(7, 'normal');
  assert.deepEqual(spawnFor(spec, 0), spec.start);
  assert.equal(spawnFor(spec, 3).z, spec.checkpoints[2] + 3.1);
});
test('state validation rejects teleports and derives checkpoints server-side', () => {
  const spec = createCourseSpec(3, 'easy'),
    player = { last: { ...spec.start }, lastAt: 1000, checkpoint: 0 };
  assert.equal(
    validateState(player, { x: 20, y: 20, z: -80, ry: 0, vx: 0, vz: 0, state: 'air' }, spec, 1100).ok,
    false
  );

  // Законный переход через первую арку: подошли вплотную и шагнули за неё.
  const near = { last: { x: 0, y: 1, z: spec.checkpoints[0] + 1 }, lastAt: 1000, checkpoint: 0 };
  const valid = validateState(
    near,
    { x: 0, y: 1, z: spec.checkpoints[0] - 1, ry: 0, vx: 0, vz: -7, state: 'ground' },
    spec,
    1100
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.checkpoint, 1);
});

// Раньше чекпоинты снимались циклом while по условию «оказался за чертой». Одно состояние,
// формально уложившееся в лимит скорости, засчитывало сразу несколько арок — а лимит был щедрым:
// пауза между пакетами поднимала его до тридцати единиц при длине сегмента восемнадцать.
test('один пакет не может засчитать два чекпоинта', () => {
  const spec = createCourseSpec(3, 'easy');
  // Вплотную перед первой аркой; до второй отсюда двадцать единиц.
  const player = { last: { x: 0, y: 1, z: spec.checkpoints[0] + 1 }, lastAt: 1000, checkpoint: 0 };
  const beyondSecond = {
    x: 0,
    y: 1,
    z: spec.checkpoints[1] - 1,
    ry: 0,
    vx: 0,
    vz: -9,
    state: 'ground'
  };
  // Пауза в пять секунд раньше поднимала потолок шага до тридцати единиц. Теперь он ограничен
  // сверху независимо от длительности паузы, и такой скачок не проходит вовсе.
  const result = validateState(player, beyondSecond, spec, 6000);
  assert.equal(result.ok, false, 'скачок через две арки обязан отклоняться');
  assert.equal(result.reason, 'speed');
});

// Чекпоинт — это пересечение арки, а не факт нахождения за ней. Разница существенна: «оказался
// за чертой» засчитывается тому, кто там просто появился, а пересечение требует, чтобы сервер
// видел игрока и до арки, и после.
test('позиция за аркой без пересечения не даёт чекпоинт', () => {
  const spec = createCourseSpec(3, 'easy');
  const line = spec.checkpoints[0];
  const player = { last: { x: 0, y: 1, z: line - 1 }, lastAt: 1000, checkpoint: 0 };
  const result = validateState(
    player,
    { x: 0, y: 1, z: line - 1.5, ry: 0, vx: 0, vz: -7, state: 'ground' },
    spec,
    1100
  );
  assert.equal(result.ok, true, 'сам шаг законный');
  assert.equal(result.checkpoint, 0, 'без пересечения чекпоинт не выдаётся');
});

// Потолок шага не должен ломать законное падение с потерей пакетов: секунда свободного падения
// при гравитации 22.5 — это около тринадцати единиц по вертикали плюс бег по горизонтали.
test('падение с потерей пакетов не считается телепортом', () => {
  const spec = createCourseSpec(3, 'easy');
  const player = { last: { x: 0, y: 12, z: -10 }, lastAt: 1000, checkpoint: 0 };
  const falling = { x: 4, y: -1, z: -16, ry: 0, vx: 4, vz: -6, state: 'air' };
  const result = validateState(player, falling, spec, 2000);
  assert.equal(result.ok, true, 'секунда падения обязана проходить проверку');
});
test('finish requires every server checkpoint and the finish plane', () => {
  const spec = createCourseSpec(9, 'easy'),
    player = { checkpoint: spec.segmentCount, last: { z: spec.finishZ - 0.2, y: 1 }, finished: false };
  assert.equal(canFinish(player, spec), true);
  player.checkpoint--;
  assert.equal(canFinish(player, spec), false);
});

test('слишком быстро пройденный сегмент помечается как неподтверждённый', () => {
  const player = { checkpoint: 0, checkpointAt: 1000 };
  const suspicious = verifyCheckpointTime(player, 1, 1000 + MIN_CHECKPOINT_INTERVAL_MS - 1);
  assert.equal(suspicious.reason, 'segment-too-fast');
  assert.equal(suspicious.checkpoint, 1);

  player.checkpoint = 1;
  const honest = verifyCheckpointTime(player, 2, player.checkpointAt + MIN_CHECKPOINT_INTERVAL_MS);
  assert.equal(honest, null);
  assert.equal(player.checkpointAt, 1000 + MIN_CHECKPOINT_INTERVAL_MS * 2 - 1);
});

test('таблица результатов отделяет подтверждённые времена', () => {
  const room = {
    players: new Map([
      ['trusted', { id: 'trusted', name: 'Честный', time: 2000, color: 1, finished: true }],
      [
        'fast',
        {
          id: 'fast',
          name: 'Слишком быстрый',
          time: 1000,
          color: 2,
          finished: true,
          verificationReasons: ['segment-too-fast', 'observed-speed']
        }
      ]
    ])
  };
  const board = leaderboard(room);
  assert.equal(board[0].verified, false);
  assert.equal(board[0].verificationReason, 'segment-too-fast');
  assert.deepEqual(board[0].verificationReasons, ['segment-too-fast', 'observed-speed']);
  assert.equal(board[1].verified, true);
  assert.equal(board[1].verificationReason, null);
});

test('проверка движения отличает честный бег, speedhack и невозможное ускорение', () => {
  const player = {
    last: { x: 0, y: 1, z: 0, vx: 0, vz: -8 },
    lastAt: 1000
  };
  assert.deepEqual(
    verifyMovement(player, { x: 0, y: 1, z: -0.8, ry: 0, vx: 0, vy: 0, vz: -8, state: 'ground' }, 1100),
    []
  );

  const speedhack = verifyMovement(
    player,
    { x: 0, y: 1, z: -4, ry: 0, vx: 0, vy: 0, vz: -30, state: 'ground' },
    1100
  );
  assert.ok(speedhack.includes('reported-speed'));
  assert.ok(speedhack.includes('observed-speed'));
  assert.ok(speedhack.includes('horizontal-acceleration'));

  const dive = verifyMovement(
    player,
    { x: 0, y: 2, z: -1, ry: 0, vx: 0, vy: 3, vz: -10.8, state: 'dive' },
    1050
  );
  assert.equal(dive.includes('horizontal-acceleration'), false, 'штатный dive получает больший лимит');
});

test('катапульта проверяется по авторитетной геометрии главы', () => {
  const spec = coopSpec('ch2');
  const catapult = findCatapult(spec, 'c1');
  const launcher = {
    id: 'launcher',
    last: { x: catapult.x, y: 1.4, z: catapult.slamZ },
    lastLaunchAt: 0
  };
  const rider = { id: 'rider', last: { x: catapult.x, y: 1.4, z: catapult.launchZ } };
  const room = {
    spec,
    players: new Map([
      [launcher.id, launcher],
      [rider.id, rider]
    ])
  };
  const message = {
    action: 'launch',
    objectId: catapult.id,
    vector: { x: 0, y: catapult.power, z: -catapult.power * catapult.forward }
  };

  const valid = validateCoopEvent(room, launcher, message, 2_000);
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.relay.vector, message.vector);

  launcher.lastLaunchAt = 0;
  assert.equal(
    validateCoopEvent(room, launcher, { ...message, objectId: 'несуществующая' }, 2_000).reason,
    'неизвестная катапульта'
  );
  assert.equal(
    validateCoopEvent(room, launcher, { ...message, vector: { x: 20, y: 20, z: 0 } }, 2_000).reason,
    'неверный импульс катапульты'
  );

  launcher.last = { ...launcher.last, z: catapult.slamZ + 10 };
  assert.equal(validateCoopEvent(room, launcher, message, 3_000).reason, 'инициатор не у катапульты');
});

test('проверка источника при апгрейде сокета', () => {
  // Запросы без Origin пропускаем: этот заголовок ставят только браузеры, а Node-клиенты,
  // мобильные обёртки и тесты его не шлют.
  assert.equal(originAllowed(undefined, 'game.example'), true);
  assert.equal(originAllowed('', 'game.example'), true);

  // Свой же хост — разрешён.
  assert.equal(originAllowed('https://game.example', 'game.example'), true);

  // Чужой сайт, встроивший игру к себе, — отклоняется.
  assert.equal(originAllowed('https://evil.example', 'game.example'), false);

  // Локальная разработка работает всегда, иначе отладку пришлось бы каждый раз настраивать.
  assert.equal(originAllowed('http://localhost:5173', 'game.example'), true);
  assert.equal(originAllowed('http://127.0.0.1:8080', 'game.example'), true);

  // Мусор вместо адреса — отклоняется, а не роняет сервер.
  assert.equal(originAllowed('не-адрес', 'game.example'), false);
});

test('глобальные пределы нагрузки имеют безопасные значения и явное состояние', () => {
  assert.equal(positiveInt('42', 10), 42);
  assert.equal(positiveInt('0', 10), 10);
  assert.equal(positiveInt('много', 10), 10);

  const available = capacityStatus({ socketCount: 1, activeMatches: 1, maxSockets: 2, maxMatches: 2 });
  assert.equal(available.socketsFull, false);
  assert.equal(available.matchesFull, false);

  const full = capacityStatus({ socketCount: 2, activeMatches: 3, maxSockets: 2, maxMatches: 3 });
  assert.equal(full.socketsFull, true);
  assert.equal(full.matchesFull, true);
});

test('состояние нагрузки показывает задержку event loop и память', () => {
  const healthy = loadStatus({
    lagMs: 12.34,
    memory: { heapUsed: 10 * 1024 * 1024, heapTotal: 20 * 1024 * 1024, rss: 30 * 1024 * 1024 }
  });
  assert.deepEqual(healthy, {
    eventLoopP95Ms: 12.3,
    heapUsedMb: 10,
    heapTotalMb: 20,
    rssMb: 30,
    overloaded: false
  });

  assert.equal(loadStatus({ lagMs: 10_000, memory: process.memoryUsage() }).overloaded, true);
});

// Гистограмма monitorEventLoopDelay копит выборки с момента enable() и никогда не забывает. Без
// сброса её перцентиль — это перцентиль по всему аптайму, и детектор перегрузки глохнет тем сильнее,
// чем дольше работает сервер: замерено, что пять секунд устойчивой блокировки поднимают p95 до
// 160 мс на свежем процессе и не двигают его вообще уже после тридцати секунд работы.
//
// Тест держится за наблюдаемое следствие, а не за внутренности: после окна с блокировкой задержка
// видна, после следующего спокойного окна — нет. Без reset() второе не выполняется.
test('задержка event loop измеряется окнами и забывает прошлую перегрузку', async () => {
  const settle = () => new Promise(resolve => setTimeout(resolve, 120));

  await settle();
  rotateEventLoopWindow(); // начинаем с чистого окна, что бы ни оставили прошлые тесты

  // Нагрузка воспроизводится так же, как выглядит настоящая: серия блокировок с уступкой между
  // ними. Одна длинная блокировка не годится — пока поток занят, монитор не записывает ничего, и в
  // окне остаётся ровно одна задержанная выборка, то есть до 95-го перцентиля она не дотягивает.
  //
  // Настоящее число тоже подделывать нельзя: подставленное значение проверяло бы арифметику
  // loadStatus, а не то, что гистограмма действительно очищается между окнами.
  const busyUntil = Date.now() + 900;
  while (Date.now() < busyUntil) {
    const spin = Date.now() + 150;
    while (Date.now() < spin) {
      /* держим поток занятым */
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }

  const busy = rotateEventLoopWindow();
  assert.ok(busy > 100, `окно с блокировкой обязано показать задержку, получено ${busy} мс`);

  await settle();
  const quiet = rotateEventLoopWindow();
  assert.ok(
    quiet < busy / 4,
    `следующее окно обязано забыть прошлую перегрузку, получено ${quiet} мс после ${busy} мс`
  );
  assert.equal(loadStatus({ lagMs: quiet, memory: process.memoryUsage() }).overloaded, false);
});

test('анонимные продуктовые события ограничены фиксированным набором', () => {
  const events = createEventCounters();
  assert.equal(trackEvent(events, 'roomCreated'), true);
  assert.equal(trackEvent(events, 'checkpointReached', 3), true);
  assert.equal(trackEvent(events, 'имя-игрока'), false, 'произвольные и персональные ключи запрещены');
  assert.equal(events.roomCreated, 1);
  assert.equal(events.checkpointReached, 3);
  assert.equal(Object.hasOwn(events, 'имя-игрока'), false);
});
