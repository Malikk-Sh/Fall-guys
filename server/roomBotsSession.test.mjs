// Бот в живой комнате: голосование на итогах, смена настроек, реванш.
//
// roomBots.test.mjs проверяет бота в отрыве от сервера — здесь наоборот: бот заведён настоящим
// сообщением от настоящего хоста, и проверяется, что комната вокруг него продолжает работать.
// Все три случая пришли из разбора и выглядели одинаково снаружи: игрок нажимает кнопку, а комната
// не отвечает.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { server, rooms, gameplay, resetRateLimits, shutdown: shutdownServer } = require('./index');
const { ROOM_STATE } = require('../shared/protocol.js');
const { preloadBots } = require('./roomBots');

// Модель бота грузится асинхронно; без явного ожидания проверка ботов молча превратилась бы в
// проверку их отсутствия.
await preloadBots();

const WAIT_MS = 10_000;
const MATCH_ID = '0123456789abcdef0123456789abcdef';

class Client {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      this.messages.push(message);
      for (const waiter of [...this.waiters])
        if (waiter.match(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
    });
  }
  wait(type, predicate = () => true) {
    const existing = this.messages.find(m => m.type === type && predicate(m));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`Не дождались ${type}; было: ${JSON.stringify(this.messages.map(m => m.type))}`)),
        WAIT_MS
      );
      this.waiters.push({
        match: message => {
          if (message.type !== type || !predicate(message)) return false;
          clearTimeout(timer);
          return true;
        },
        resolve
      });
    });
  }
  send(type, data = {}) {
    this.ws.send(JSON.stringify({ type, ...data }));
  }
  close() {
    return new Promise(resolve => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 500);
      this.ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
  }
}

const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stop = () => new Promise(resolve => server.close(resolve));
const urlFor = () => `ws://127.0.0.1:${server.address().port}/ws`;
const settle = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

// Приватная комната гонки с ботами, заведёнными так же, как их заводит игрок, — кнопкой.
async function roomWithBots(url, { count = 3 } = {}) {
  const host = new Client(url);
  await host.wait('hello');
  host.send('create', { name: 'Хозяин', mode: 'race' });
  const created = await host.wait('lobby', m => m.players.length === 1);
  host.send('addBots', { count });
  await host.wait('lobby', m => m.players.filter(player => player.bot).length === count);
  const room = rooms.get(created.code);
  return { host, room };
}

// Довести комнату до экрана итогов.
//
// Настоящий забег здесь не нужен и только мешал бы: он занимает десятки секунд и проверяет совсем
// другое — движение и его аудит. Проверяется решение НА итогах, поэтому комната ставится в это
// состояние прямо, а голос подаётся обычным сообщением через сокет.
function pretendResults(room) {
  room.state = ROOM_STATE.RESULTS;
  room.matchId = MATCH_ID;
  room.startedAt = Date.now() - 30_000;
  room.resultsDeadline = Date.now() + 20_000;
  for (const player of room.players.values()) {
    player.finished = true;
    player.time = 30_000;
    player.resultChoice = null;
  }
}

test.beforeEach(() => {
  resetRateLimits();
  rooms.clear();
});

test('молчание ботов не держит игрока на экране итогов', async t => {
  await listen();
  const { host, room } = await roomWithBots(urlFor());
  t.after(async () => {
    await host.close();
    await stop();
  });

  pretendResults(room);
  host.send('returnLobby', { matchId: MATCH_ID });
  await settle();

  // Бот не нажмёт кнопку никогда. Пока он числился в голосующих, выбор человека ждал истечения
  // двадцатисекундного срока: игрок нажимал «в лобби» и смотрел на неподвижный экран.
  assert.equal(room.state, ROOM_STATE.LOBBY, 'решение человека должно быть исполнено сразу');
});

test('реванш с ботами возможен, и боты бегут заново', async t => {
  await listen();
  const { host, room } = await roomWithBots(urlFor());
  t.after(async () => {
    await host.close();
    await stop();
  });

  pretendResults(room);
  const before = room.bots.list.map(entry => entry.bot.name);
  host.send('rematch', { matchId: MATCH_ID });
  await settle();

  // Раньше этот исход был недостижим в принципе: единогласия с участником, который не голосует, не
  // бывает, а по истечении срока комната уходит в лобби.
  assert.equal(room.state, ROOM_STATE.COUNTDOWN, 'реванш обязан начаться');
  assert.deepEqual(
    room.bots.list.map(entry => entry.bot.name),
    before,
    'соперники после реванша те же'
  );
  for (const entry of room.bots.list) {
    assert.equal(entry.bot.finished, false, 'бот остался стоять на ленте с прошлого забега');
    assert.equal(room.players.get(entry.id).finished, false);
  }
});

test('смена сложности не запирает старт с ботами', async t => {
  await listen();
  const { host, room } = await roomWithBots(urlFor());
  t.after(async () => {
    await host.close();
    await stop();
  });

  host.send('configure', { difficulty: 'chaos' });
  const lobby = await host.wait('lobby', m => m.difficulty === 'chaos' || m.spec?.difficulty === 'chaos');
  assert.ok(lobby, 'сложность должна была смениться');

  // Сброс готовности всем подряд гасил кнопку «начать» насовсем: бот не пришлёт «готов» никогда,
  // а сервер на попытку старта отвечал бы NOT_READY.
  for (const player of room.players.values()) {
    if (player.bot) assert.equal(player.ready, true, 'бот обязан остаться готовым');
  }
  // Трасса сменилась — боты должны бежать по новой, а не по геометрии прежней.
  assert.equal(room.bots.spec, room.spec, 'боты остались на прежней трассе');
  assert.equal(room.spec.difficulty, 'chaos');

  host.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(player => player.ready));
  host.send('start');
  const started = await host.wait('start');
  assert.ok(started.at, 'старт обязан состояться');
});

test('бот не попадает в продуктовую статистику', async t => {
  await listen();
  const { host, room } = await roomWithBots(urlFor());
  t.after(async () => {
    await host.close();
    await stop();
  });

  const samples = metric => {
    gameplay.flush();
    return gameplay
      .summary({ days: 1, limit: 1000 })
      .rows.filter(row => row.metric === metric && row.mode === 'race')
      .reduce((sum, row) => sum + row.samples, 0);
  };
  const before = samples('match_started');

  host.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(player => player.ready));
  host.send('start');
  await host.wait('start');
  await settle();

  // Устройства у бота нет, и его события легли бы на desktop — то есть сдвинули бы и воронку
  // подбора, и разрезы по устройствам ровно там, где комнаты добираются ботами.
  assert.equal(
    samples('match_started') - before,
    1,
    `в матче ${room.players.size} участников, но начал его один человек`
  );
});

test('переход в кооператив распускает ботов, а не отказывает хосту', async t => {
  await listen();
  const { host, room } = await roomWithBots(urlFor());
  t.after(async () => {
    await host.close();
    await stop();
  });

  // Кооператив рассчитан на двоих, и трое ботов в комнате упирались в этот предел: хост получал
  // «в комнате должно быть не больше двух игроков», хотя игрок в ней был один.
  host.send('configure', { mode: 'coop' });
  await settle();

  assert.equal(room.mode, 'coop');
  assert.equal(room.bots, null, 'боты в кооперативе не участвуют');
  assert.equal([...room.players.values()].filter(player => player.bot).length, 0);
  const errors = host.messages.filter(message => message.type === 'error');
  assert.deepEqual(errors, [], `хост получил отказ: ${JSON.stringify(errors)}`);
});

test.after(() => shutdownServer('test', { exitProcess: false }));
