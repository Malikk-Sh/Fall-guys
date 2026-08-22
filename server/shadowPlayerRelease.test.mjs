import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bridge = require('./shadowInputPreload');
const WebSocket = require('ws');
const { PROTOCOL_VERSION } = require('../shared/protocol.js');
const { server, rooms, resetRateLimits } = require('./index');

const WAIT_MS = 10_000;

class TestClient {
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
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), WAIT_MS);
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
const closeServer = () => new Promise(resolve => server.close(resolve));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, timeout = WAIT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

// Отдельным файлом, а не рядом с остальной проводкой: мост останавливается по закрытию сервера
// (`core.server.once('close', stop)`), поэтому второй такой тест в том же процессе гонял бы уже
// остановленный мост и проходил бы вхолостую.
test('ушедший игрок отпускается мостом, а не остаётся висеть в WeakMap', async t => {
  // `dropPlayer` убирает игрока из комнаты немедленно, а контроллеры лежат в WeakMap и не
  // перечисляются. Без внешнего закрытия сопоставление ударов ушедшего осталось бы незакрытым, а
  // незакрытое не входит ни в односторонние счётчики, ни в знаменатель доли совпадений — паритет
  // выглядел бы лучше, чем он есть.
  //
  // Проверяется здесь именно ПРОВОДКА: сам `runtime.release` проверен отдельно, но в бою он
  // работает, только если мост замечает уход.
  resetRateLimits();
  rooms.clear();
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new TestClient(url);
  const second = new TestClient(url);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    rooms.clear();
    await closeServer();
  });

  const [firstHello] = await Promise.all([first.wait('hello'), second.wait('hello')]);
  first.send('findCoop', { name: 'Leaver', chapterId: 'ch1', protocolVersion: PROTOCOL_VERSION });
  await first.wait('matchmakingWaiting');
  second.send('findCoop', { name: 'Stayer', chapterId: 'ch1', protocolVersion: PROTOCOL_VERSION });
  const [start] = await Promise.all([first.wait('start'), second.wait('start')]);

  const room = [...rooms.values()].find(item => item.matchId === start.matchId);
  const player = room.players.get(firstHello.id);
  assert.ok(player, 'игрок обязан быть в комнате до ухода');

  // Мост подключается к сокетам не мгновенно: без ожидания ввод ушёл бы мимо теневого слоя.
  assert.equal(await waitFor(() => bridge.attachedCount() >= 2), true, 'мост обязан подключиться к сокетам');

  // Контроллер заводится по первому вводу — до него отпускать нечего.
  first.send('input', {
    matchId: start.matchId,
    sequence: 0,
    clientTick: 0,
    moveX: 0,
    moveZ: 1,
    jumpPressed: false,
    jumpHeld: false,
    divePressed: false,
    cameraYaw: 0
  });
  assert.equal(
    await waitFor(() => bridge.runtime.controllers.get(player) !== undefined),
    true,
    'ввод обязан завести контроллер, иначе тест проверял бы пустоту'
  );

  first.send('leave');
  assert.equal(
    await waitFor(() => room.players.get(firstHello.id) !== player),
    true,
    'ядро обязано убрать игрока из комнаты'
  );

  // Мост замечает уход разницей множеств на своём тике.
  assert.equal(
    await waitFor(() => bridge.runtime.controllers.get(player) === undefined),
    true,
    'мост обязан отпустить контроллер ушедшего игрока'
  );
});
