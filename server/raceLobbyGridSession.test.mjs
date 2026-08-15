// Сквозные регрессии стартовой решётки и управления ботами в приватной гонке.
//
// Геометрия отдельно проверяется в roomBots/raceGrid unit-тестах; здесь важна граница протокола:
// клиент нажимает +/−, сервер меняет настоящую комнату, а старт/respawn остаются авторитетными.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { server, rooms, resetRateLimits, shutdown: shutdownServer } = require('./index');
const { preloadBots } = require('./roomBots');

await preloadBots();

const WAIT_MS = 10_000;

class Client {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.match(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  wait(type, predicate = () => true) {
    const existing = this.messages.find(message => message.type === type && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Не дождались ${type}; было: ${JSON.stringify(this.messages)}`)),
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

async function privateRace(url, bots = 0) {
  const host = new Client(url);
  const hello = await host.wait('hello');
  host.send('create', { name: 'Хозяин', mode: 'race' });
  const lobby = await host.wait('lobby', message => message.players.length === 1);
  const room = rooms.get(lobby.code);
  if (bots > 0) {
    host.send('addBots', { count: bots });
    await host.wait('lobby', message => message.players.filter(player => player.bot).length === bots);
  }
  return { host, hello, room };
}

function dummyPlayer(room, index) {
  const id = `dummy:${index}`;
  room.players.set(id, {
    id,
    name: `Dummy ${index}`,
    ready: true,
    finished: false,
    time: null,
    resultChoice: null,
    color: 0,
    loadout: null,
    slot: room.players.size,
    joinOrder: room.nextJoinOrder++,
    disconnectedAt: null,
    away: false,
    bot: false,
    ws: null,
    checkpoint: 0,
    last: null
  });
}

test.beforeEach(() => {
  resetRateLimits();
  rooms.clear();
});

test('минус удаляет бота даже из полностью занятой комнаты', async t => {
  await listen();
  const { host, room } = await privateRace(urlFor(), 1);
  t.after(async () => {
    await host.close();
    await stop();
  });

  // Хост + бот + 14 серверных участников = полный лимит 16. Именно здесь старая проверка free<=0
  // ошибочно запрещала удаление, хотя операция должна не занимать, а освобождать место.
  for (let index = 0; index < 14; index += 1) dummyPlayer(room, index);
  assert.equal(room.players.size, 16);

  host.send('addBots', { count: 0 });
  const lobby = await host.wait(
    'lobby',
    message => message.players.length === 15 && message.players.every(player => !player.bot)
  );

  assert.equal(lobby.players.length, 15);
  assert.equal(room.bots, null);
  assert.equal(
    host.messages.some(message => message.type === 'error' && message.code === 'ROOM_FULL'),
    false,
    'удаление не должно зависеть от свободных мест'
  );
});

test('во время countdown сервер публикует разные grid positions для людей и ботов', async t => {
  await listen();
  const { host, room } = await privateRace(urlFor(), 3);
  t.after(async () => {
    await host.close();
    await stop();
  });

  host.send('ready', { ready: true });
  await host.wait('lobby', message => message.players.every(player => player.ready));
  host.send('start');
  await host.wait('start');

  const starts = [...room.players.values()].map(player => `${player.last.x.toFixed(3)}:${player.last.z.toFixed(3)}`);
  assert.equal(new Set(starts).size, room.players.size, starts.join(', '));

  for (const entry of room.bots.list) {
    const publicState = room.players.get(entry.id).last;
    assert.equal(entry.bot.position.x, publicState.x);
    assert.equal(entry.bot.position.z, publicState.z);
  }
});

test('respawn до первого checkpoint возвращает игрока в его собственную клетку', async t => {
  await listen();
  const { host, room } = await privateRace(urlFor(), 3);
  t.after(async () => {
    await host.close();
    await stop();
  });

  host.send('ready', { ready: true });
  await host.wait('lobby', message => message.players.every(player => player.ready));
  host.send('start');
  const start = await host.wait('start');

  const player = room.players.get(room.host);
  assert.ok(player.raceSpawn, 'сервер обязан сохранить клетку checkpoint 0');
  host.send('respawn', { matchId: start.matchId });
  const correction = await host.wait('correction', message => message.reason === 'respawn');

  assert.equal(correction.position.x, player.raceSpawn.x);
  assert.equal(correction.position.y, player.raceSpawn.y);
  assert.equal(correction.position.z, player.raceSpawn.z);
});

test.after(() => shutdownServer('test', { exitProcess: false }));
