// Подбор в онлайн-гонку.
//
// Проверяется не «нашлась пара», как в кооперативе, а сборка группы: двое попадают в одну комнату,
// третий подсаживается к ним, полная комната стартует не дожидаясь срока, а комната, из которой
// все ушли, никого не запускает.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { server, rooms, resetRateLimits, shutdown: shutdownServer } = require('./index');

const WAIT_MS = 10_000;

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
          reject(
            new Error(`Не дождались ${type}; получено: ${JSON.stringify(this.messages.map(m => m.type))}`)
          ),
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

async function findRace(url, difficulty = 'normal') {
  const client = new Client(url);
  await client.wait('hello');
  client.send('findRace', { name: 'Racer', difficulty });
  return client;
}

function matchmadeRooms() {
  return [...rooms.values()].filter(room => room.matchmade);
}

// Комнаты — модульное состояние, и закрытый сокет не убирает игрока сразу: у него есть тридцать
// секунд на переподключение, всё это время комната жива. Без явной очистки каждый следующий тест
// считал бы чужие комнаты своими.
test.beforeEach(() => {
  resetRateLimits();
  rooms.clear();
});

test('двое ищущих гонку попадают в одну комнату и получают срок старта', async t => {
  await listen();
  const url = urlFor();
  const first = await findRace(url);
  const firstWait = await first.wait('matchmakingWaiting');
  t.after(async () => {
    await first.close();
  });

  // Первый ждёт один: срока старта ещё нет, считать его не с кем.
  assert.equal(firstWait.players, 1);
  assert.equal(firstWait.startsAt, null);

  const second = await findRace(url);
  const secondWait = await second.wait('matchmakingWaiting');
  t.after(async () => {
    await second.close();
    await stop();
  });

  // Оба оказались в ОДНОЙ комнате, а не в двух своих.
  assert.equal(matchmadeRooms().length, 1);
  assert.equal(secondWait.roomCode, firstWait.roomCode);
  assert.equal(secondWait.players, 2);
  // Минимум собран — срок набора появился.
  assert.ok(secondWait.startsAt > Date.now(), 'срок старта должен быть в будущем');
});

test('разные сложности не смешиваются', async t => {
  await listen();
  const url = urlFor();
  const easy = await findRace(url, 'easy');
  const easyWait = await easy.wait('matchmakingWaiting');
  const chaos = await findRace(url, 'chaos');
  const chaosWait = await chaos.wait('matchmakingWaiting');
  t.after(async () => {
    await easy.close();
    await chaos.close();
    await stop();
  });

  assert.notEqual(easyWait.roomCode, chaosWait.roomCode);
  assert.equal(matchmadeRooms().length, 2);
  const difficulties = matchmadeRooms()
    .map(room => room.spec.difficulty)
    .sort();
  assert.deepEqual(difficulties, ['chaos', 'easy']);
});

test('третий игрок подсаживается к уже ждущей паре и не продлевает срок', async t => {
  await listen();
  const url = urlFor();
  const first = await findRace(url);
  await first.wait('matchmakingWaiting');
  const second = await findRace(url);
  const secondWait = await second.wait('matchmakingWaiting');
  const third = await findRace(url);
  const thirdWait = await third.wait('matchmakingWaiting');
  t.after(async () => {
    await first.close();
    await second.close();
    await third.close();
    await stop();
  });

  assert.equal(matchmadeRooms().length, 1);
  assert.equal(thirdWait.roomCode, secondWait.roomCode);
  assert.equal(thirdWait.players, 3);
  // Срок заведён вторым игроком и НЕ сдвинут третьим: иначе поток входящих отодвигал бы старт
  // бесконечно, и первый пришедший ждал бы дольше всех.
  assert.equal(thirdWait.startsAt, secondWait.startsAt);
});

test('отмена подбора выводит из комнаты и распускает пустую', async t => {
  await listen();
  const url = urlFor();
  const client = await findRace(url);
  await client.wait('matchmakingWaiting');
  assert.equal(matchmadeRooms().length, 1);

  client.send('cancelMatchmaking');
  const cancelled = await client.wait('matchmakingWaiting', m => m.cancelled === true);
  t.after(async () => {
    await client.close();
    await stop();
  });

  assert.equal(cancelled.cancelled, true);
  assert.equal(matchmadeRooms().length, 0, 'опустевшая комната не должна оставаться висеть');
});

test('отыгравшая публичная комната перестаёт принимать случайных игроков', async t => {
  await listen();
  const url = urlFor();
  const first = await findRace(url);
  await first.wait('matchmakingWaiting');
  const second = await findRace(url);
  await second.wait('matchmakingWaiting');
  t.after(async () => {
    await first.close();
    await second.close();
    await stop();
  });

  const [room] = matchmadeRooms();
  assert.ok(room, 'комната подбора должна была появиться');

  // Матч отыгран и все вернулись в лобби.
  const { resetLobby } = require('./index');
  resetLobby(room);

  assert.equal(room.matchmade, false, 'после забега комната больше не публичная');
  assert.equal(room.fillDeadline, null);
  assert.equal(matchmadeRooms().length, 0);
});

test.after(() => shutdownServer('test', { exitProcess: false }));
