// Бот как участник комнаты.
//
// Проверяется не поведение бота на трассе — для этого есть raceBot.test.mjs, — а то, что остальной
// сервер продолжает работать, не зная о ботах: рассылка не спотыкается об участника без сокета,
// матч завершается, комната закрывается, когда ушли ЛЮДИ, а не когда опустел список.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { preloadBots, spawnBots, resetBots, stepBots, clearBots, MAX_BOTS_PER_ROOM } = require('./roomBots');
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

test('повторный вызов добавляет новую партию вместо фиксированного набора', () => {
  const r = room();
  assert.equal(spawnBots(r, { count: 2 }), 2);
  assert.equal(spawnBots(r, { count: 2 }), 2);
  assert.equal(r.players.size, 4);
  assert.deepEqual([...r.players.keys()], ['bot:0', 'bot:1', 'bot:2', 'bot:3']);
  clearBots(r);
});

test('count 0 убирает ровно одного последнего бота', () => {
  const r = room();
  spawnBots(r, { count: 3 });
  assert.equal(spawnBots(r, { count: 0 }), -1);
  assert.equal(r.players.size, 2);
  assert.equal(r.players.has('bot:2'), false);
  assert.equal(r.bots.list.length, 2);
  assert.equal(r.bots.field.bots.length, 2);
  clearBots(r);
});

test('последний минус освобождает общую трассу и обнуляет room.bots', () => {
  const r = room();
  spawnBots(r, { count: 1 });
  assert.equal(spawnBots(r, { count: 0 }), -1);
  assert.equal(r.players.size, 0);
  assert.equal(r.bots, null);
  assert.equal(spawnBots(r, { count: 0 }), 0, 'из пустой комнаты удалять нечего');
});

test('боты занимают разные места стартовой решётки', () => {
  const r = room();
  spawnBots(r, { count: 4 });
  const starts = r.bots.list.map(({ bot }) => `${bot.position.x.toFixed(3)}:${bot.position.z.toFixed(3)}`);
  assert.equal(new Set(starts).size, 4, starts.join(', '));
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

test('перезапуск возвращает дошедшего бота на старт', () => {
  const started = Date.now() - 100;
  const r = room({ startedAt: started });
  spawnBots(r, { count: 1, skill: 'sharp' });
  let now = started;
  for (let tick = 0; tick < 3000; tick += 1) {
    now += 66;
    stepBots(r, { now });
  }
  const [player] = [...r.players.values()];
  assert.equal(player.finished, true, 'бот должен был дойти');

  // Реванш: комната та же, забег новый.
  r.startedAt = Date.now();
  assert.equal(resetBots(r), 1);
  assert.equal(player.finished, false, 'иначе бот «финиширует» на первом же тике нового забега');
  assert.equal(player.time, null);
  assert.equal(r.players.get('bot:0').ready, true);
  clearBots(r);
});

test('смена трассы пересобирает ботов под новую', () => {
  const r = room();
  spawnBots(r, { count: 2, skill: ['rookie', 'sharp'] });
  const before = r.bots.course;
  // Хост сменил сложность: прежняя геометрия боту больше не годится — он бежал бы по плитам,
  // которых на новой трассе нет.
  r.spec = createCourseSpec(8888, 'chaos');
  assert.equal(resetBots(r), 2);
  assert.equal(r.bots.spec, r.spec);
  assert.notEqual(r.bots.course, before, 'трасса ботов должна быть пересобрана');
  assert.deepEqual(
    r.bots.list.map(entry => entry.bot.skill.id),
    ['rookie', 'sharp'],
    'уровни соперников после смены настроек те же'
  );
  assert.equal(r.players.size, 2);
  clearBots(r);
});

test('перезапуск без ботов безопасен', () => {
  const r = room();
  assert.equal(resetBots(r), 0);
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

test('последовательные +1 сохраняют тот же микс уровней', () => {
  const r = room();
  for (let index = 0; index < 3; index += 1)
    spawnBots(r, { count: 1, skill: ['rookie', 'steady', 'sharp'] });
  assert.deepEqual(
    r.bots.list.map(entry => entry.bot.skill.id),
    ['rookie', 'steady', 'sharp']
  );
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
