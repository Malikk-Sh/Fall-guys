// Бот как участник комнаты.
//
// Проверяется не поведение бота на трассе — для этого есть raceBot.test.mjs, — а то, что остальной
// сервер продолжает работать, не зная о ботах: рассылка не спотыкается об участника без сокета,
// матч завершается, комната закрывается, когда ушли ЛЮДИ, а не когда опустел список.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preloadBots, spawnBots, stepBots, clearBots, MAX_BOTS_PER_ROOM } = require('./roomBots');
const { createCourseSpec } = require('./gameRules');

await preloadBots();

function room(overrides = {}) {
  return {
    code: 'TEST1',
    mode: 'race',
    state: 'PLAYING',
    spec: createCourseSpec(7777, 'normal'),
    players: new Map(),
    startedAt: Date.now() - 1000,
    bots: null,
    ...overrides
  };
}

test('бот появляется участником без сокета и сразу готов', () => {
  const r = room();
  assert.equal(spawnBots(r, { count: 3, skill: 'steady' }), 3);
  const bots = [...r.players.values()];
  assert.equal(bots.length, 3);
  for (const bot of bots) {
    assert.equal(bot.bot, true);
    assert.equal(bot.ws, null, 'сокета у бота быть не должно');
    assert.equal(bot.ready, true, 'иначе комната не сможет стартовать');
    // Аккаунта нет намеренно: правило «строка таблицы рекордов требует подтверждённой личности»
    // распространяется на бота само собой, без отдельной проверки на ботов.
    assert.equal(bot.accountId, null);
    assert.equal(bot.anonymousId, null);
  }
  clearBots(r);
});

test('имена ботов в одной комнате не повторяются', () => {
  const r = room();
  spawnBots(r, { count: 6 });
  const names = [...r.players.values()].map(player => player.name);
  assert.equal(new Set(names).size, names.length, `повтор: ${names.join(', ')}`);
  clearBots(r);
});

test('потолок ботов на комнату соблюдается', () => {
  const r = room();
  assert.equal(spawnBots(r, { count: 99 }), MAX_BOTS_PER_ROOM);
  clearBots(r);
});

test('повторный вызов не плодит ботов в той же комнате', () => {
  const r = room();
  assert.equal(spawnBots(r, { count: 2 }), 2);
  assert.equal(spawnBots(r, { count: 2 }), 0, 'вторая партия не должна появиться');
  assert.equal(r.players.size, 2);
  clearBots(r);
});

test('до старта бот стоит на месте', () => {
  const r = room({ startedAt: Date.now() + 5000 });
  spawnBots(r, { count: 1 });
  stepBots(r, { now: Date.now() });
  const [player] = [...r.players.values()];
  assert.equal(player.last, null, 'отсчёт идёт и боту тоже');
  clearBots(r);
});

test('шаг двигает бота и отдаёт состояние в форме живого игрока', () => {
  const started = Date.now() - 100;
  const r = room({ startedAt: started });
  spawnBots(r, { count: 1 });
  let now = started;
  for (let tick = 0; tick < 30; tick += 1) {
    now += 66;
    stepBots(r, { now });
  }
  const [player] = [...r.players.values()];
  assert.ok(player.last, 'состояние должно появиться');
  for (const key of ['x', 'y', 'z', 'ry', 'vx', 'vz', 'checkpoint']) {
    assert.ok(key in player.last, `в состоянии нет поля ${key}`);
  }
  assert.ok(player.last.z < 7, `бот не сдвинулся: z=${player.last.z}`);
  clearBots(r);
});

test('дошедший бот сообщает о финише ровно один раз', () => {
  const started = Date.now() - 100;
  const r = room({ startedAt: started });
  spawnBots(r, { count: 1, skill: 'sharp' });
  const finished = [];
  let now = started;
  // Гонка идёт до трёх минут игрового времени — с запасом на самый неудачный забег.
  for (let tick = 0; tick < 3000; tick += 1) {
    now += 66;
    stepBots(r, { now, onFinish: player => finished.push(player.id) });
  }
  assert.equal(finished.length, 1, `сообщений о финише: ${finished.length}`);
  const [player] = [...r.players.values()];
  assert.equal(player.finished, true);
  assert.ok(player.time > 0, 'время финиша должно быть положительным');
  clearBots(r);
});

test('уборка снимает ботов со счёта комнаты', () => {
  const r = room();
  spawnBots(r, { count: 4 });
  assert.equal(r.players.size, 4);
  assert.equal(clearBots(r), 4);
  assert.equal(r.players.size, 0);
  assert.equal(r.bots, null);
  assert.equal(clearBots(r), 0, 'повторная уборка безопасна');
});

test('перегрузка сервера не заставляет бота отставать от своего времени', () => {
  // Цикл рассылки прореживается при нагрузке. Если бот шагает фиксированное число раз за вызов,
  // он начинает отставать от собственных часов; шаг считается от времени, а не от числа вызовов.
  const started = Date.now() - 100;
  const dense = room({ startedAt: started });
  const sparse = room({ startedAt: started });
  spawnBots(dense, { count: 1, skill: 'sharp' });
  spawnBots(sparse, { count: 1, skill: 'sharp' });

  let now = started;
  for (let tick = 0; tick < 90; tick += 1) {
    now += 66;
    stepBots(dense, { now });
  }
  // Тот же промежуток времени, но втрое меньше вызовов.
  now = started;
  for (let tick = 0; tick < 30; tick += 1) {
    now += 198;
    stepBots(sparse, { now });
  }

  const [a] = [...dense.players.values()];
  const [b] = [...sparse.players.values()];
  assert.ok(
    Math.abs(a.last.z - b.last.z) < 6,
    `редкие вызовы увели бота: плотно z=${a.last.z}, редко z=${b.last.z}`
  );
  clearBots(dense);
  clearBots(sparse);
});

test('список уровней раздаётся ботам по кругу, а не достаётся одному', () => {
  const r = room();
  spawnBots(r, { count: 3, skill: ['rookie', 'steady', 'sharp'] });
  const levels = r.bots.list.map(entry => entry.bot.skill.id);
  assert.deepEqual(levels, ['rookie', 'steady', 'sharp']);
  clearBots(r);
});

test('один уровень на всех по-прежнему допустим', () => {
  const r = room();
  spawnBots(r, { count: 2, skill: 'sharp' });
  assert.deepEqual(
    r.bots.list.map(entry => entry.bot.skill.id),
    ['sharp', 'sharp']
  );
  clearBots(r);
});
