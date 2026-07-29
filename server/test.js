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
  const valid = validateState(
    player,
    { x: 0, y: 1, z: -19, ry: 0, vx: 0, vz: -7, state: 'ground' },
    spec,
    3000
  );
  assert.equal(valid.ok, true);
  assert.equal(valid.checkpoint, 1);
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
