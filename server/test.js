const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeName,
  safeDifficulty,
  createCourseSpec,
  spawnFor,
  validateState,
  canFinish
} = require('./gameRules');
const { originAllowed } = require('./index');

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
