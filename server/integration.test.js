const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { server } = require('./index');

class TestClient {
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
  wait(type, predicate = () => true, timeout = 2500) {
    const existing = this.messages.find(message => message.type === type && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeout);
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

// Сервер — модульный синглтон, поэтому тесты поднимают и гасят его по очереди, а не параллельно.
const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const shutdown = () => new Promise(resolve => server.close(resolve));

test('игрок возвращается в свою комнату после обрыва связи', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  let host = new TestClient(url);
  const guest = new TestClient(url);

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const [hostHello] = await Promise.all([host.wait('hello'), guest.wait('hello')]);
  assert.ok(hostHello.token, 'сервер обязан выдать токен сессии в hello');

  host.send('create', { name: 'Хост' });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: 'Гость', code: created.code });
  await guest.wait('lobby', m => m.players.length === 2);

  // Имитируем разрыв: рвём соединение без сообщения leave.
  host.ws.terminate();

  // Напарник должен увидеть, что игрок не на связи, но слот за ним сохранён.
  const dropped = await guest.wait(
    'lobby',
    m => m.players.length === 2 && m.players.some(p => !p.online),
    3000
  );
  assert.equal(dropped.players.length, 2, 'слот отвалившегося игрока держится, а не освобождается сразу');

  // Возвращаемся по токену прошлой сессии.
  host = new TestClient(url);
  await host.wait('hello');
  host.send('resume', { token: hostHello.token });

  const resumed = await host.wait('resumed', () => true, 3000);
  assert.equal(resumed.id, hostHello.id, 'после возврата идентификатор игрока должен сохраниться');

  const back = await guest.wait('lobby', m => m.players.length === 2 && m.players.every(p => p.online), 3000);
  assert.equal(back.code, created.code, 'игрок вернулся именно в свою комнату');
  assert.equal(back.host, hostHello.id, 'права хоста остались за вернувшимся игроком');
});

test('возврат по неизвестному токену корректно отклоняется', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const client = new TestClient(url);
  t.after(async () => {
    await client.close();
    await shutdown();
  });

  await client.wait('hello');
  client.send('resume', { token: 'нет-такого-токена' });
  await client.wait('resumeFailed', () => true, 2000);

  // Отказ не должен ломать соединение: обычный сценарий после него обязан работать.
  client.send('create', { name: 'Новичок' });
  const lobby = await client.wait('lobby', m => m.players.length === 1);
  assert.equal(lobby.players[0].name, 'Новичок');
});

test('two players share lobby configuration and deterministic start spec', async t => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/ws`,
    host = new TestClient(url),
    guest = new TestClient(url);
  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await new Promise(resolve => server.close(resolve));
  });
  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: 'Host', difficulty: 'easy' });
  const created = await host.wait('lobby', message => message.players.length === 1);
  assert.equal(created.difficulty, 'easy');
  guest.send('join', { name: 'Guest', code: created.code });
  await Promise.all([
    host.wait('lobby', message => message.players.length === 2),
    guest.wait('lobby', message => message.players.length === 2)
  ]);
  host.send('configure', { difficulty: 'chaos' });
  const configured = await host.wait('lobby', message => message.difficulty === 'chaos');
  assert.equal(
    configured.players.every(player => !player.ready),
    true
  );
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait(
    'lobby',
    message => message.players.length === 2 && message.players.every(player => player.ready)
  );
  host.send('start');
  const [hostStart, guestStart] = await Promise.all([host.wait('start'), guest.wait('start')]);
  assert.deepEqual(hostStart.spec, guestStart.spec);
  assert.equal(hostStart.spec.segmentCount, 7);
  assert.ok(hostStart.at > Date.now());
});

// Свёрнутая игра и неподвижный персонаж выглядят одинаково, а значат разное: в первом случае
// напарника есть смысл подождать, во втором — нет. Проверяем, что разница доезжает до напарника.
test('свёрнутая игра доходит до напарника и снимается при возвращении', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const host = new TestClient(url);
  const guest = new TestClient(url);

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: 'Хост', mode: 'coop' });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: 'Гость', code: created.code });
  await guest.wait('lobby', m => m.players.length === 2);

  host.send('presence', { away: true });

  const event = await guest.wait('presence', () => true, 2000);
  assert.equal(event.away, true, 'напарник должен получить событие «отошёл»');
  assert.notEqual(event.id, undefined, 'событие обязано называть, кто именно отошёл');

  const awayLobby = await guest.wait('lobby', m => m.players.some(p => p.id === event.id && p.away), 2000);
  const awayPlayer = awayLobby.players.find(p => p.id === event.id);
  assert.equal(awayPlayer.away, true, 'состав комнаты тоже помечает отошедшего');
  assert.equal(awayPlayer.online, true, 'отошёл — это не то же самое, что потерял связь');

  host.send('presence', { away: false });
  const back = await guest.wait('presence', m => m.away === false, 2000);
  assert.equal(back.id, event.id, 'вернулся тот же игрок');
  await guest.wait('lobby', m => m.players.every(p => !p.away), 2000);
});
