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
const { ROOM_STATE } = require('../shared/protocol.js');
const { preloadBots } = require('./roomBots');

// Модель бота грузится асинхронно. Живой сервер успевает сделать это до первого игрока; тест
// обязан дождаться явно, иначе проверка добора молча превращается в проверку его отсутствия.
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

  // Срок старта заводится уже первому вошедшему.
  //
  // Раньше он появлялся только со вторым, и это выглядело логично — считать нечего, пока не с кем
  // соревноваться. На пустом сервере это означало бесконечность: срок, который не заведётся, не
  // истечёт, и одинокий игрок не увидел бы гонки никогда. Теперь ожидание всегда конечно, а чем оно
  // закончится — людьми или ботами, — решает следующий тест.
  assert.equal(firstWait.players, 1);
  assert.ok(firstWait.startsAt > Date.now(), 'ожидание обязано быть конечным даже для одиночки');

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
  // Срок, заведённый первым, вторым не сдвигается.
  assert.equal(secondWait.startsAt, firstWait.startsAt, 'подошедший не отодвигает старт');
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
  // Срок заведён первым игроком и НЕ сдвигается следующими: иначе поток входящих отодвигал бы
  // старт бесконечно, и первый пришедший ждал бы дольше всех.
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

test('оборвавшийся не считается собравшимся: гонка не стартует в одиночку', async t => {
  await listen();
  const url = urlFor();
  const first = await findRace(url);
  await first.wait('matchmakingWaiting');
  const second = await findRace(url);
  await second.wait('matchmakingWaiting');
  const [room] = matchmadeRooms();
  assert.equal(room.players.size, 2);

  // Второй обрывается. В комнате он остаётся ещё тридцать секунд — столько даётся на возврат.
  const [, dropped] = [...room.players.values()];
  dropped.disconnectedAt = Date.now();

  // Срок набора истёк ровно в этот момент.
  room.fillDeadline = Date.now() - 1;
  await new Promise(resolve => setTimeout(resolve, 200));

  t.after(async () => {
    await first.close();
    await second.close();
    await stop();
  });

  // Оборвавшийся числится в комнате ещё тридцать секунд, но собравшимся не считается: добор
  // считает ЖИВЫХ. На связи один — значит недостающих соперников выдаёт не список, а боты.
  const humans = [...room.players.values()].filter(player => !player.bot);
  const bots = [...room.players.values()].filter(player => player.bot);
  assert.equal(humans.length, 2, 'оборвавшийся остаётся в комнате до истечения окна возврата');
  assert.ok(bots.length >= 1, 'к единственному живому должны выйти боты');

  // Раньше здесь проверялось, что забег НЕ начинается. Тогда это было единственной защитой от
  // одиночного результата в таблице рекордов; сейчас защита живёт в самой таблице — строка требует
  // подтверждённой личности, — и запирать игрока в лобби больше незачем.
  assert.notEqual(room.state, ROOM_STATE.LOBBY, 'с ботами забег начинается');
});

test('без единого живого игрока боты никого не запускают', async t => {
  await listen();
  const url = urlFor();
  const client = await findRace(url);
  await client.wait('matchmakingWaiting');
  const [room] = matchmadeRooms();

  // Единственный игрок оборвался, не дождавшись старта.
  for (const player of room.players.values()) player.disconnectedAt = Date.now();
  room.fillDeadline = Date.now() - 1;
  await new Promise(resolve => setTimeout(resolve, 200));

  t.after(async () => {
    await client.close();
    await stop();
  });

  // Гонка ботов между собой не нужна никому: смотреть её некому.
  assert.equal([...room.players.values()].filter(player => player.bot).length, 0);
  assert.equal(room.state, ROOM_STATE.LOBBY);
});

test('в публичную комнату нельзя войти по коду', async t => {
  await listen();
  const url = urlFor();
  const searcher = await findRace(url);
  const waiting = await searcher.wait('matchmakingWaiting');

  const outsider = new Client(url);
  await outsider.wait('hello');
  outsider.send('join', { name: 'Outsider', code: waiting.roomCode });
  const error = await outsider.wait('error');

  t.after(async () => {
    await searcher.close();
    await outsider.close();
    await stop();
  });

  assert.match(error.message, /Найти гонку/);
  assert.equal(matchmadeRooms()[0].players.size, 1);
});

test('хост публичной комнаты не может запустить гонку сам', async t => {
  await listen();
  const url = urlFor();
  const client = await findRace(url);
  await client.wait('matchmakingWaiting');

  // Первый вошедший — хост комнаты и уже отмечен готовым. Без запрета он уехал бы в гонку один.
  client.send('start');
  const error = await client.wait('error');

  t.after(async () => {
    await client.close();
    await stop();
  });

  assert.match(error.message, /соберутся соперники/);
  assert.equal(matchmadeRooms()[0].state, ROOM_STATE.LOBBY);
});

test('«любая сложность» подсаживает к тем, кто уже ждёт', async t => {
  await listen();
  const url = urlFor();
  // Кто-то ждёт на «хаосе».
  const picky = await findRace(url, 'chaos');
  const pickyWait = await picky.wait('matchmakingWaiting');
  // Пришедшему всё равно — он должен попасть к нему, а не завести третью комнату на 'normal'.
  const any = await findRace(url, '');
  const anyWait = await any.wait('matchmakingWaiting');

  t.after(async () => {
    await picky.close();
    await any.close();
    await stop();
  });

  assert.equal(anyWait.roomCode, pickyWait.roomCode);
  assert.equal(matchmadeRooms().length, 1);
  assert.equal(matchmadeRooms()[0].spec.difficulty, 'chaos');
});

test('одинокий игрок не ждёт вечно: к нему выходят боты', async t => {
  await listen();
  const url = urlFor();
  const client = await findRace(url);
  const waiting = await client.wait('matchmakingWaiting');

  t.after(async () => {
    await client.close();
    await stop();
  });

  // Срок набора заводится с ПЕРВОГО вошедшего. Раньше он появлялся только когда соберутся двое, и
  // на пустом сервере не наступал никогда: срок, который не заведётся, не истечёт.
  assert.ok(waiting.startsAt > Date.now(), 'срок набора должен быть заведён сразу');

  const [room] = matchmadeRooms();
  // Промотаем ожидание: срок истёк, а людей так и не прибавилось.
  room.fillDeadline = Date.now() - 1;
  await new Promise(resolve => setTimeout(resolve, 300));

  const bots = [...room.players.values()].filter(player => player.bot);
  assert.ok(bots.length >= 1, 'боты должны были выйти на старт');
  assert.equal(
    [...room.players.values()].filter(player => !player.bot).length,
    1,
    'живой игрок остаётся один'
  );
  // Гонка началась, а не ушла на новый круг ожидания.
  assert.notEqual(room.state, ROOM_STATE.LOBBY, 'забег должен был начаться');
  // Уровни ботов перемешаны: одинаковые бежали бы плотной группой.
  assert.ok(new Set(bots.map(bot => bot.name)).size === bots.length, 'имена ботов не должны повторяться');
});

test('пришедшие люди отменяют добор: ботов звать незачем', async t => {
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
  room.fillDeadline = Date.now() - 1;
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.equal(
    [...room.players.values()].filter(player => player.bot).length,
    0,
    'при двух живых боты не нужны'
  );
});

test.after(() => shutdownServer('test', { exitProcess: false }));
