const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

// Сколько ждать ответа сервера. Ни один тест здесь не проверяет скорость ответа — только то, что он
// приходит и какой, — поэтому срок один на всех и с запасом.
const WAIT_MS = 10_000;
const { VERIFICATION_VERSION } = require('./verifiedLeaderboard');
const { SEGMENT_LENGTH, FIRST_SEGMENT_CENTER } = require('../shared/courseSpec.js');
const {
  server,
  accounts,
  gameplay,
  rooms,
  resetRateLimits,
  setResultsTimeout,
  expireDisconnectedPlayers,
  expireSessions,
  SESSION_TTL_MS,
  shutdown: shutdownServer
} = require('./index');

class TestClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.sequence = 0;
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'start') this.sequence = message.resumed?.nextSequence ?? 0;
      // Поправка: сервер не принял присланное положение и говорит, где видит игрока в последний
      // раз. Настоящий клиент продолжает движение отсюда — см. takeCorrection.
      if (message.type === 'correction') this.correction = message.position;
      this.messages.push(message);
      for (const waiter of [...this.waiters])
        if (waiter.match(message)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
    });
  }
  // Забрать поправку, если она приходила. Одноразово: повторно применять одно и то же положение
  // значило бы топтаться на месте.
  takeCorrection() {
    const correction = this.correction;
    this.correction = null;
    return correction;
  }

  wait(type, predicate = () => true, timeout = WAIT_MS) {
    const existing = this.messages.find(message => message.type === type && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      // В сообщении об ошибке — вся переписка клиента. Без неё «Timed out waiting for lobby»
      // означает лишь «чего-то не пришло», и разбираться приходится вслепую.
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Timed out waiting for ${type}; получено: ${JSON.stringify(this.messages.map(m => m.type))}`
            )
          ),
        timeout
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
    if ((type === 'state' || type === 'finish') && data.sequence === undefined) {
      data = { ...data, sequence: this.sequence++ };
    }
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
// Ограничение «не больше сорока комнатных операций с адреса за минуту» защищает живой сервер, но
// весь набор ходит с одного 127.0.0.1 и за минуту создаёт комнат больше. Перешагнув порог, тест
// получал отказ вместо лобби и ждал сообщения, которого уже не будет.
test.beforeEach(() => resetRateLimits());

const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const shutdown = () => new Promise(resolve => server.close(resolve));

// Довести клиента до финишной черты по-настоящему: сервер проверяет позицию, и телепорт он
// отвергнет. Шаги подобраны под серверное правило скорости (3.2 + dt*18 за пакет) и под
// ограничение «не чаще раза в 32 мс».
const STATE_STEP = 3.2;
const STATE_GAP_MS = 55;

test('matchmaking соединяет двух старейших совместимых игроков и сразу запускает кооп', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const first = new TestClient(url);
  const second = new TestClient(url);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
    await shutdown();
  });
  await Promise.all([first.wait('hello'), second.wait('hello')]);

  first.send('findCoop', { name: 'Первый', chapterId: 'ch9', protocolVersion: 9 });
  await first.wait('matchmakingWaiting');
  second.send('findCoop', { name: 'Второй', chapterId: 'ch9', protocolVersion: 9 });

  const [firstStart, secondStart] = await Promise.all([first.wait('start'), second.wait('start')]);
  assert.equal(firstStart.mode, 'coop');
  assert.equal(firstStart.spec.chapterId, 'ch9');
  assert.equal(firstStart.matchId, secondStart.matchId);
  const room = [...rooms.values()].find(item => item.matchId === firstStart.matchId);
  assert.equal(room.players.size, 2);
  assert.deepEqual(
    [...room.players.values()].map(player => player.name),
    ['Первый', 'Второй']
  );
  gameplay.flush();
  const queueMetrics = new Set(gameplay.summary({ days: 1, limit: 1000 }).rows.map(row => row.metric));
  for (const metric of ['queue_enter', 'match_found', 'matchmaking_wait_ms', 'chapter_started']) {
    assert.ok(queueMetrics.has(metric), `воронка записывает ${metric}`);
  }
});

test('свёрнутый игрок удаляется из matchmaking и не достаётся следующей паре', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const away = new TestClient(url);
  const second = new TestClient(url);
  const third = new TestClient(url);
  t.after(async () => {
    await Promise.all([away.close(), second.close(), third.close()]);
    await shutdown();
  });
  await Promise.all([away.wait('hello'), second.wait('hello'), third.wait('hello')]);
  away.send('findCoop', { name: 'Отошёл', chapterId: 'ch1', protocolVersion: 9 });
  await away.wait('matchmakingWaiting');
  away.send('presence', { away: true });
  const cancelled = await away.wait('matchmakingWaiting', message => message.cancelled === true);
  assert.equal(cancelled.reason, 'away');

  second.send('findCoop', { name: 'Второй', chapterId: 'ch1', protocolVersion: 9 });
  await second.wait('matchmakingWaiting');
  third.send('findCoop', { name: 'Третий', chapterId: 'ch1', protocolVersion: 9 });
  const [secondStart, thirdStart] = await Promise.all([second.wait('start'), third.wait('start')]);
  assert.equal(secondStart.matchId, thirdStart.matchId);
  assert.equal(
    away.messages.some(message => message.type === 'start'),
    false
  );
});

test('быстрый кооп-пинг безопасно ретранслируется напарнику', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');
  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await new Promise(resolve => setTimeout(resolve, 3000));
  host.send('coopPing', { matchId: started.matchId, command: 'help' });
  const ping = await guest.wait('coopPing', message => message.command === 'help', WAIT_MS);
  assert.equal(ping.id, host.messages.find(message => message.type === 'hello').id);
  assert.equal(ping.matchId, started.matchId);
  assert.equal(typeof ping.at, 'number');
});

// Шаг сделан заведомо меньше серверного разрешения (3.2 + dt*18 за пакет), но одного этого мало.
//
// Пакеты изредка слипаются: два setTimeout(55) на занятой машине срабатывают в пределах 32 мс, и
// второй сервер отбрасывает как слишком частый. Следующий шаг оказывается вдвое длиннее
// разрешённого, сервер его не принимает и присылает поправку — а прогонщик, поправку
// игнорирующий, продолжает считать от своего z. Разрыв растёт с каждым пакетом, забег встаёт
// навсегда, и тест ждёт результатов, которых уже не будет.
//
// Отсюда была вся неустойчивость набора: падал не какой-то один тест, а тот, которому не повезло
// со слипанием, — на разных прогонах разный.
async function runToFinish(client, spec, matchId, { stopBefore = 0, from = spec.start.z, to = null } = {}) {
  let z = from;
  const target = to ?? spec.finishZ - 1;
  const at = value => ({ x: 0, y: spec.start.y, z: value, ry: 0, vx: 0, vz: -8, state: 'ground' });
  while (z > target) {
    z = Math.max(target, z - STATE_STEP);
    client.send('state', { matchId, state: at(z) });
    await new Promise(resolve => setTimeout(resolve, STATE_GAP_MS));
    const correction = client.takeCorrection();
    if (correction) z = correction.z;
  }
  if (stopBefore) return z;
  // Финальная позиция едет ВНУТРИ finish — именно так её теперь отправляет клиент.
  client.send('finish', { matchId, state: at(z), clientTime: 1000 });
  return z;
}

// Забег, который проходит проверку на честность, а не только доезжает до финиша.
//
// runToFinish выше шлёт 3.2 единицы за 55 мс — это 58 единиц в секунду. Коопу это сходит с рук:
// движение там не проверяется вовсе — геометрия главы серверу неизвестна, — и в таблицу глав
// попадает время, которое он измерил сам. Гонке не сходит: там проверено каждое положение.
//
// Темп здесь равен беговой скорости персонажа: RUN_SPEED = 7.7, шлём 8. Раньше стояло 18 единиц в
// секунду при заявленных восьми — то есть забег, который сервер считал честным, шёл вдвое быстрее
// бега и втрое расходился с собственными словами о скорости. Пройти его тогда было можно только
// потому, что потолок наблюдаемой скорости приходилось держать на 22: сервер не знал состояния
// персонажа и один потолок обслуживал и бег, и отброс бампером. Теперь у «на земле» свой потолок,
// и подделка на этом месте не проходит — что и обнаружилось этим тестом.
//
// Быстрее не сделать: честный забег упирается ровно в тот же предел, что и живой игрок, и время
// теста задаётся длиной трассы, а не тем, как часто мы шлём пакеты.
const HONEST_SPEED = 8;
const HONEST_GAP_MS = 66;
const HONEST_STEP = (HONEST_SPEED * HONEST_GAP_MS) / 1000;

async function runHonestly(client, spec, matchId, { step = HONEST_STEP } = {}) {
  let z = spec.start.z;
  const target = spec.finishZ - 1;
  const at = value => ({
    x: 0,
    y: spec.start.y,
    z: value,
    ry: 0,
    vx: 0,
    vz: -HONEST_SPEED,
    state: 'ground'
  });
  while (z > target) {
    z = Math.max(target, z - step);
    client.send('state', { matchId, state: at(z) });
    await new Promise(resolve => setTimeout(resolve, HONEST_GAP_MS));
    const correction = client.takeCorrection();
    if (correction) z = correction.z;
  }
  client.send('finish', { matchId, state: at(z), clientTime: 1000 });
  return z;
}

// Ждём конца обратного отсчёта: до него сервер игнорирует состояния.
const waitForStart = at => new Promise(resolve => setTimeout(resolve, Math.max(0, at - Date.now()) + 150));

// Готовая комната из двух игроков с начатым матчем.
async function startedRoom(url, mode = 'coop') {
  const host = new TestClient(url);
  const guest = new TestClient(url);
  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: 'Хост', mode });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: 'Гость', code: created.code });
  await host.wait('lobby', m => m.players.length === 2);
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(p => p.ready));
  host.send('start');
  const started = await host.wait('start');
  await waitForStart(started.at);
  return { host, guest, started, code: created.code };
}

test('не вернувшийся после grace period игрок учитывается как abandonment', async t => {
  await listen();
  // Integration tests share the in-process room registry. Expire disconnected players left by
  // earlier scenarios before taking this test's metric baseline, otherwise the deliberate
  // future timestamp below would correctly sweep them too and make the delta non-local.
  expireDisconnectedPlayers(Date.now() + 30_001);
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');
  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const room = [...rooms.values()].find(item => item.matchId === started.matchId);
  const guestId = guest.messages.find(message => message.type === 'hello').id;
  const abandonSamples = () => {
    gameplay.flush();
    return gameplay
      .summary({ days: 1, limit: 1000 })
      .rows.filter(row => row.metric === 'match_abandoned' && row.mode === 'coop')
      .reduce((sum, row) => sum + row.samples, 0);
  };
  const before = abandonSamples();

  guest.ws.terminate();
  const deadline = Date.now() + 2000;
  while (!room.players.get(guestId)?.disconnectedAt && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const disconnectedAt = room.players.get(guestId)?.disconnectedAt;
  assert.ok(disconnectedAt, 'server noticed the socket disconnect');

  expireDisconnectedPlayers(disconnectedAt + 30_001);
  assert.equal(room.players.has(guestId), false);
  assert.equal(abandonSamples(), before + 1);
});

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

  const resumed = await host.wait('resumed', () => true, WAIT_MS);
  assert.equal(resumed.id, hostHello.id, 'после возврата идентификатор игрока должен сохраниться');

  const back = await guest.wait(
    'lobby',
    m => m.players.length === 2 && m.players.every(p => p.online),
    WAIT_MS
  );
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
  const firstSnapshot = await host.wait('snapshot', message => message.sequence === 0);
  const secondSnapshot = await host.wait('snapshot', message => message.sequence === 1);
  assert.equal(firstSnapshot.matchId, hostStart.matchId);
  assert.ok(secondSnapshot.serverTime >= firstSnapshot.serverTime);
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

// Обрыв посреди забега раньше проходил молча: оставшийся доигрывал главу один, получал время
// и не знал, что половину препятствий за напарника не проходил никто. Теперь сервер снимает
// зачёт и говорит об этом вслух — и тому, кто остался, и в итогах матча.
test('обрыв связи снимает зачёт с забега', async t => {
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
  await host.wait('lobby', m => m.players.length === 2);

  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(p => p.ready));
  host.send('start');
  const started = await host.wait('start');

  // До обрыва отметки нет: ровно идущий забег ничего не теряет.
  assert.equal(
    host.messages.some(m => m.type === 'unranked'),
    false,
    'пока оба на связи, зачёт снимать не с чего'
  );

  guest.ws.terminate();
  const notice = await host.wait('unranked', () => true, WAIT_MS);
  assert.equal(notice.reason, 'disconnect', 'причина должна доезжать до игрока');
  assert.equal(notice.matchId, started.matchId, 'отметка относится к текущему забегу');

  const before = host.messages.filter(m => m.type === 'unranked').length;
  host.send('presence', { away: true });
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(
    host.messages.filter(m => m.type === 'unranked').length,
    before,
    'зачёт снимается один раз за матч, а не на каждое событие'
  );
});

// Отметка должна доезжать не только уведомлением, но и в самих итогах: игрок может свернуть
// игру в момент обрыва и увидеть только карточку финиша.
test('итоги матча несут отметку «без зачёта»', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'race');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  // Гость выходит сам — это тоже снимает зачёт, но с другой причиной.
  guest.send('leave');
  const notice = await host.wait('unranked', () => true, WAIT_MS);
  assert.equal(notice.reason, 'left', 'добровольный выход отличается от обрыва');

  // Оставшийся доходит до финиша по-настоящему: телепорт сервер бы не принял.
  await runToFinish(host, started.spec, started.matchId);
  const results = await host.wait('results', () => true, WAIT_MS);
  assert.equal(results.unranked, 'left', 'итоги обязаны нести отметку и её причину');
});

// --- Регрессии жизненного цикла матча ---------------------------------------------------------
//
// Всё, что ниже, воспроизводит сбои, которые игрок видел как «ошибка сервера, когда второй
// доходит до конца» и «окно голосования не держится».

// Главный симптом. Порядок доставки в WebSocket строгий: клиент шлёт `finish`, сервер тут же
// переводит комнату в RESULTS, а следующий кадр того же клиента уже отправил `state`. Пакет
// приходит через миллисекунды и раньше получал WRONG_STATE со штрафом за нарушение протокола.
test('хвостовой state после финиша второго игрока не вызывает ошибку', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  // Оба идут до конца; в коопе глава засчитывается, только когда дошли оба.
  const lastZ = await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', m => m.id === host.messages.find(x => x.type === 'hello').id, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);

  // И сразу вдогонку — то самое опоздавшее состояние.
  guest.send('state', {
    matchId: started.matchId,
    state: { x: 0, y: started.spec.start.y, z: lastZ, ry: 0, vx: 0, vz: -8, state: 'ground' }
  });

  const results = await Promise.all([
    host.wait('results', () => true, WAIT_MS),
    guest.wait('results', () => true, WAIT_MS)
  ]);
  assert.equal(results.length, 2, 'итоги должны прийти обоим');

  await new Promise(resolve => setTimeout(resolve, 400));
  for (const [name, client] of [
    ['хост', host],
    ['гость', guest]
  ]) {
    const errors = client.messages.filter(m => m.type === 'error');
    assert.deepEqual(errors, [], `${name} не должен получать ошибок протокола: ${JSON.stringify(errors)}`);
    assert.equal(client.ws.readyState, WebSocket.OPEN, `соединение ${name} обязано остаться живым`);
    assert.equal(
      client.messages.filter(m => m.type === 'results').length,
      1,
      `${name} должен получить ровно одни итоги`
    );
  }
});

// Повторный финиш приходит при переподключении и при повторной попытке после отказа. Он не
// должен ни удваивать итоги, ни считаться нарушением.
test('повторный finish идемпотентен', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  const finishesAfterFirst = host.messages.filter(m => m.type === 'finish').length;

  host.send('finish', {
    matchId: started.matchId,
    state: {
      x: 0,
      y: started.spec.start.y,
      z: started.spec.finishZ - 1,
      ry: 0,
      vx: 0,
      vz: -8,
      state: 'ground'
    },
    clientTime: 1000
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    host.messages.filter(m => m.type === 'finish').length,
    finishesAfterFirst,
    'второй финиш не должен порождать новых сообщений'
  );
  assert.deepEqual(
    host.messages.filter(m => m.type === 'error'),
    [],
    'и не должен быть нарушением'
  );
  void guest;
});

// Голос за реванш больше не распускает комнату в одиночку. Раньше первый же голос — особенно
// голос хоста — мгновенно уводил обоих в лобби, и второй просто не успевал нажать кнопку.
test('первый голос за реванш не закрывает экран результатов', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, WAIT_MS), guest.wait('results', () => true, WAIT_MS)]);

  // Голосует хост — тот, кто раньше мог решать за всех.
  host.send('rematch', { matchId: started.matchId });
  const afterFirst = await guest.wait('lobby', m => m.players.some(p => p.choice === 'rematch'), WAIT_MS);
  assert.equal(afterFirst.state, 'RESULTS', 'комната обязана остаться на результатах');
  assert.equal(afterFirst.players.filter(p => p.choice === 'rematch').length, 1, 'засчитан ровно один голос');
  assert.ok(afterFirst.resultsDeadline, 'клиенту нужен срок, чтобы показать отсчёт');

  // И только второй голос запускает забег. Именно ЗАБЕГ, а не возврат в лобби: иначе кнопка
  // «реванш» делала бы ровно то же, что «в лобби», и голосовать было бы не за что.
  guest.send('rematch', { matchId: started.matchId });
  // Предикат обязан отсекать матч, который уже был: в истории клиента лежит `start` первого
  // забега, и ожидание «любого start» нашло бы его, ничего на самом деле не проверив.
  const restart = await guest.wait('start', m => m.matchId !== started.matchId, WAIT_MS);
  assert.notEqual(restart.matchId, started.matchId, 'у реванша свой matchId');
  assert.equal(restart.spec.seed, started.spec.seed, 'реванш идёт по той же трассе');
});

test('два голоса за следующую главу сохраняют пару и запускают её без лобби', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  const results = await host.wait('results', m => m.matchId === started.matchId, WAIT_MS);
  assert.equal(results.hasNextChapter, true);
  const messagesAfterResults = host.messages.length;

  host.send('nextChapter', { matchId: started.matchId });
  const waiting = await guest.wait(
    'lobby',
    m => m.state === 'RESULTS' && m.players.some(player => player.choice === 'next'),
    WAIT_MS
  );
  assert.equal(waiting.chapterId, 'ch1');

  guest.send('nextChapter', { matchId: started.matchId });
  const [hostNext, guestNext] = await Promise.all([
    host.wait('start', m => m.matchId !== started.matchId, WAIT_MS),
    guest.wait('start', m => m.matchId !== started.matchId, WAIT_MS)
  ]);
  assert.equal(hostNext.spec.chapterId, 'ch2');
  assert.equal(guestNext.matchId, hostNext.matchId);
  assert.deepEqual(Object.keys(hostNext.slots).sort(), Object.keys(started.slots).sort());
  gameplay.flush();
  const funnelMetrics = new Set(gameplay.summary({ days: 1, limit: 1000 }).rows.map(row => row.metric));
  for (const metric of ['chapter_started', 'chapter_completed', 'next_chapter_vote', 'pair_continued']) {
    assert.ok(funnelMetrics.has(metric), `воронка записывает ${metric}`);
  }
  assert.equal(
    host.messages
      .slice(messagesAfterResults)
      .some(message => message.type === 'lobby' && message.state === 'LOBBY'),
    false,
    'между главами не должно быть обычного лобби'
  );
});

// Разошедшиеся голоса вешали комнату намертво: «все за реванш» и «все за лобби» — оба условия
// ложны, а переголосовать было нельзя. Обе кнопки погашены, выхода нет.
test('разные голоса на результатах не вешают комнату', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, WAIT_MS), guest.wait('results', () => true, WAIT_MS)]);

  // Историю чистим намеренно: в ней уже лежат состояния LOBBY, полученные до старта забега,
  // и ожидание нашло бы их, ничего на самом деле не проверив.
  guest.messages.length = 0;
  host.send('rematch', { matchId: started.matchId });
  guest.send('returnLobby', { matchId: started.matchId });

  // Несогласие разрешается в пользу лобби: заставлять играть ещё раз того, кто уже уходит, нельзя.
  const lobby = await guest.wait('lobby', m => m.state === 'LOBBY', WAIT_MS);
  assert.equal(lobby.matchId, null, 'новый забег начинать не за что');
  assert.equal(
    lobby.players.every(p => !p.choice),
    true,
    'выборы сброшены'
  );
});

// Пара, где один просто отложил телефон, запирала второго на карточке итогов навсегда: ни одна
// кнопка ничего не меняла, пока не оборвётся связь. Срок ожидания решает это без обрыва.
test('истечение срока на результатах уводит комнату в лобби', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  // Двадцать секунд в прогоне тестов ждать незачем — важно поведение, а не длительность.
  setResultsTimeout(1500);
  t.after(async () => {
    setResultsTimeout(20_000);
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, WAIT_MS), guest.wait('results', () => true, WAIT_MS)]);

  // Голосует только один, второй молчит. Молчание не должно толковаться как согласие на реванш.
  host.messages.length = 0;
  host.send('rematch', { matchId: started.matchId });

  const lobby = await host.wait('lobby', m => m.state === 'LOBBY', 6000);
  assert.equal(lobby.matchId, null, 'по таймауту уходим в лобби, а не в новый забег');
  assert.equal(
    lobby.players.every(p => !p.choice),
    true,
    'выборы сброшены'
  );
});

// Передумать — нормальное поведение. Запрет на смену выбора и был причиной тупика.
test('выбор на результатах можно поменять', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, WAIT_MS), guest.wait('results', () => true, WAIT_MS)]);

  // Хост сначала за лобби, потом передумал.
  host.send('returnLobby', { matchId: started.matchId });
  await guest.wait('lobby', m => m.players.some(p => p.choice === 'lobby'), WAIT_MS);
  host.send('rematch', { matchId: started.matchId });
  guest.send('rematch', { matchId: started.matchId });

  // Предикат обязан отсекать матч, который уже был: в истории клиента лежит `start` первого
  // забега, и ожидание «любого start» нашло бы его, ничего на самом деле не проверив.
  const restart = await guest.wait('start', m => m.matchId !== started.matchId, WAIT_MS);
  assert.notEqual(restart.matchId, started.matchId, 'смена выбора привела к реваншу');
});

// Кнопка реванша не должна работать как скрытое «завершить матч досрочно».
test('реванш во время забега отклоняется и матч не завершает', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  host.send('rematch', { matchId: started.matchId });
  const error = await host.wait('error', () => true, 2000);
  assert.equal(error.code, 'WRONG_STATE', 'во время забега голосовать не за что');

  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(
    guest.messages.some(m => m.type === 'results'),
    false,
    'матч обязан продолжаться'
  );
});

// Запоздавшее закрытие старого сокета не должно выкидывать игрока, который уже вернулся.
test('закрытие старого сокета после resume не отключает новый', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const guest = new TestClient(url);
  let host = new TestClient(url);

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const [hostHello] = await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: 'Хост', mode: 'coop' });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: 'Гость', code: created.code });
  await guest.wait('lobby', m => m.players.length === 2);

  // Возвращаемся с НОВОГО сокета, не закрывая старый: так бывает, когда клиент переподключился
  // раньше, чем сервер заметил обрыв.
  const oldWs = host.ws;
  host = new TestClient(url);
  await host.wait('hello');
  host.send('resume', { token: hostHello.token });
  const resumed = await host.wait('resumed', () => true, WAIT_MS);
  assert.equal(resumed.id, hostHello.id, 'идентификатор должен сохраниться');
  assert.ok(resumed.token, 'токен обязан вернуться клиенту, иначе следующий обрыв не восстановится');

  // Теперь добиваем старое соединение.
  oldWs.terminate();
  await new Promise(resolve => setTimeout(resolve, 400));

  const lobby = await guest.wait('lobby', m => m.players.every(p => p.online), WAIT_MS);
  assert.equal(lobby.players.length, 2, 'оба игрока на месте');
  assert.equal(host.ws.readyState, WebSocket.OPEN, 'новое соединение должно остаться живым');

  // И новое соединение продолжает работать.
  host.send('ready', { ready: true });
  await guest.wait('lobby', m => m.players.some(p => p.id === hostHello.id && p.ready), WAIT_MS);
});

// Вернувшийся на экран результатов должен получить сами результаты, а не пустую комнату.
test('переподключение на экране результатов возвращает итоги', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');
  let back = null;

  t.after(async () => {
    await Promise.all([host.close(), guest.close(), back ? back.close() : Promise.resolve()]);
    await shutdown();
  });

  const guestHello = guest.messages.find(m => m.type === 'hello');
  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  const original = await guest.wait('results', () => true, WAIT_MS);

  guest.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token: guestHello.token });
  await back.wait('resumed', () => true, WAIT_MS);

  const restored = await back.wait('results', () => true, WAIT_MS);
  assert.equal(restored.matchId, original.matchId, 'итоги должны быть те же самые');
  assert.deepEqual(restored.board, original.board, 'и с тем же составом доски');
});

// Финальная позиция внутри finish не подчиняется ограничению «не чаще раза в 32 мс».
//
// Отдельным пакетом она попадала в это окно примерно в половине случаев и терялась молча: финиш
// проверялся по точке ПЕРЕД лентой и отклонялся. Игрок видел «Финиш не засчитан» после честно
// пройденной трассы. Тест воспроизводит именно этот момент — состояние прямо перед финишем.
test('финиш принимается, даже если позиция пришла миллисекунду назад', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'race');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const spec = started.spec;
  const at = z => ({ x: 0, y: spec.start.y, z, ry: 0, vx: 0, vz: -8, state: 'ground' });

  // Доходим почти до конца обычным потоком позиций.
  const stopped = await runToFinish(host, spec, started.matchId, { stopBefore: 1 });
  assert.ok(stopped <= spec.finishZ - 1, 'подготовка: игрок должен стоять у ленты');

  // А теперь — состояние и финиш подряд, без паузы. Ровно так это и происходит в игре.
  host.send('state', { matchId: started.matchId, state: at(spec.finishZ - 2) });
  host.send('finish', { matchId: started.matchId, state: at(spec.finishZ - 3), clientTime: 1234 });

  const finished = await host.wait('finish', () => true, 4000);
  assert.equal(finished.id, host.messages.find(m => m.type === 'hello').id);
  assert.equal(
    host.messages.some(m => m.type === 'finishRejected'),
    false,
    'финиш обязан быть принят с первого раза'
  );
});

// Если один уже проголосовал, а второй оборвался, решение обязано довестись до конца.
// Раньше пересчёт происходил только при получении голоса, а повторно голосовать первый не может —
// его голос уже учтён. Комната зависала на результатах навсегда.
test('обрыв второго игрока после голоса не подвешивает комнату', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await host.wait('results', () => true, WAIT_MS);

  // Голосует только хост.
  host.send('rematch', { matchId: started.matchId });
  await host.wait(
    'lobby',
    m => m.state === 'RESULTS' && m.players.some(p => p.choice === 'rematch'),
    WAIT_MS
  );

  // Второй обрывается, так и не проголосовав.
  //
  // Историю чистим намеренно: в ней уже есть состояния LOBBY, полученные до старта забега, и
  // ожидание нашло бы их, ничего на самом деле не проверив.
  host.messages.length = 0;
  guest.ws.terminate();

  const lobby = await host.wait('lobby', m => m.state === 'LOBBY', 4000);
  assert.equal(lobby.matchId, null, 'комната обязана вернуться в лобби, а не зависнуть');
  assert.equal(
    lobby.players.every(p => !p.choice),
    true,
    'голоса сброшены под новый забег'
  );
});

// Возвращение в идущий забег — это продолжение, а не начало заново. Сервер помнит, где игрок
// находится и что с ним, и обязан это прислать: иначе клиент строит уровень с нуля и ставит
// персонажа на старт, а сервер продолжает видеть его в середине главы.
test('возвращение в идущий забег отдаёт позицию и состояние игрока', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');
  let back = null;

  t.after(async () => {
    await Promise.all([host.close(), guest.close(), back ? back.close() : Promise.resolve()]);
    await shutdown();
  });

  const hostHello = host.messages.find(m => m.type === 'hello');
  // Уходим в середину главы.
  const middle = await runToFinish(host, started.spec, started.matchId, { stopBefore: 1 });
  assert.ok(middle < started.spec.start.z, 'подготовка: игрок должен уйти со старта');

  host.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token: hostHello.token });
  await back.wait('resumed', () => true, WAIT_MS);

  const restart = await back.wait('start', () => true, WAIT_MS);
  assert.ok(restart.resumed, 'возвращение обязано нести состояние игрока');
  assert.ok(
    restart.resumed.position.z < started.spec.start.z - 5,
    `игрока нельзя возвращать на старт: сервер видит его на z=${restart.resumed.position.z}`
  );
  assert.equal(restart.resumed.finished, false);
  assert.equal(typeof restart.resumed.checkpoint, 'number');
  void guest;
});

// Финишировавший, у которого оборвалась связь, не должен снова оказаться на трассе: сервер уже
// считает его дошедшим и второй финиш не примет.
test('финишировавший возвращается в ожидание, а не на трассу', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');
  let back = null;

  t.after(async () => {
    await Promise.all([host.close(), guest.close(), back ? back.close() : Promise.resolve()]);
    await shutdown();
  });

  const hostHello = host.messages.find(m => m.type === 'hello');
  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);

  host.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token: hostHello.token });
  await back.wait('resumed', () => true, WAIT_MS);

  const restart = await back.wait('start', () => true, WAIT_MS);
  assert.equal(restart.resumed.finished, true, 'сервер обязан сказать, что игрок уже дошёл');
  void guest;
});

// Запас отклонений принадлежит ЗАБЕГУ, а не игроку.
//
// Он не сбрасывался при старте матча и копился через реванши. Отклонения — это удары препятствий,
// три-пять за забег; на четвёртом подряд забеге в той же комнате честный игрок приносил с собой
// израсходованный запас и терял зачёт ни за что. Найдено чтением кода: сброс полей игрока в
// beginCountdown перечислял всё, кроме этого.
//
// Проверяется на кооперативе, потому что там до реванша можно дойти быстро. После появления
// CoopMovementAudit у режимов независимые буферы аномалий, но жизненный цикл у них общий:
// beginCountdown обязан очищать co-op историю так же строго, как race.
test('запас отклонений сбрасывается при старте нового забега', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started, code } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await runToFinish(host, started.spec, started.matchId);
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, WAIT_MS), guest.wait('results', () => true, WAIT_MS)]);

  const player = [...rooms.get(code).players.values()][0];
  assert.ok(
    Object.values(player.coopMovementAnomalies || {}).some(count => count > 0),
    'подготовка: быстрый co-op прогон обязан оставить audit-отклонения'
  );

  host.send('rematch', { matchId: started.matchId });
  guest.send('rematch', { matchId: started.matchId });
  await guest.wait('start', m => m.matchId !== started.matchId, WAIT_MS);

  assert.deepEqual(
    player.coopMovementAnomalies,
    {},
    'новый co-op забег обязан начинаться с полным запасом audit-бюджета'
  );
  assert.deepEqual(
    player.coopMovementHistory,
    [],
    'co-op история движения прошлого забега к новому не относится'
  );
});

// Потерянный пакет не должен останавливать забег насовсем.
//
// Сервер отбрасывает состояния, приходящие чаще раза в 32 мс, и не принимает шаг длиннее
// разрешённого. Вместе это ловушка: два слипшихся пакета — второй отброшен — следующий шаг вдвое
// длиннее — не принят — и дальше не принимается ни один, потому что сервер по-прежнему видит
// игрока там, где видел до слипания. Забег встаёт навсегда.
//
// Выход из ловушки — поправка: сервер сообщает последнее признанное положение, и продолжать надо
// от него. Здесь слипание устраивается намеренно, а забег обязан дойти до финиша, продолжая с той
// точки, где споткнулся, — не начиная сначала, иначе проверялось бы не то.
test('забег продолжается после отброшенного пакета, если следовать поправке', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const start = started.spec.start.z;
  const at = z => ({ x: 0, y: started.spec.start.y, z, ry: 0, vx: 0, vz: -8, state: 'ground' });
  // Два пакета подряд без паузы: второй сервер обязан отбросить как слишком частый.
  host.send('state', { matchId: started.matchId, state: at(start - 3.2) });
  host.send('state', { matchId: started.matchId, state: at(start - 6.4) });
  await new Promise(resolve => setTimeout(resolve, 120));
  // Шаг от положения, которого сервер не видел, — он его не примет и пришлёт поправку.
  host.send('state', { matchId: started.matchId, state: at(start - 9.6) });
  const correction = await host.wait('correction', () => true, WAIT_MS);
  assert.equal(correction.reason, 'movement', 'сервер обязан сказать, где он видит игрока');
  assert.ok(correction.position.z > start - 6.4, 'поправка указывает на последнее принятое место');

  // Продолжаем с того места, где споткнулись. Без учёта поправки отсюда не выбраться.
  await runToFinish(host, started.spec, started.matchId, { from: start - 9.6 });
  await host.wait('finish', () => true, WAIT_MS);
  await runToFinish(guest, started.spec, started.matchId);
  const results = await host.wait('results', () => true, WAIT_MS);
  assert.equal(results.board.length, 2, 'оба обязаны дойти, несмотря на потерянный пакет');
});

// Ушедший напарник не должен запирать оставшегося.
//
// Кооперативная глава засчитывается, когда дошли все, кто на связи. Условие «все» легко починить
// так, что оставшийся один перестанет его выполнять, — и тогда он доиграет главу до финиша, а
// матч не завершится: ни результатов, ни лобби, ни выхода. Ровно на это жаловались игроки.
test('оставшийся один доигрывает кооп-главу и получает результаты', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  // Напарник выходит посреди главы — именно выходит, а не теряет связь: слот освобождается сразу.
  guest.send('leave', {});
  await host.wait('lobby', m => m.players.length === 1, WAIT_MS);

  await runToFinish(host, started.spec, started.matchId);
  const results = await host.wait('results', () => true, WAIT_MS);
  assert.equal(results.mode, 'coop');
  assert.equal(results.board.length, 1, 'в итогах остаётся один дошедший');
  assert.equal(results.unranked, 'left', 'глава, доигранная в одиночку, рекордом не считается');
});

// Сквозная проверка таблицы рекордов: от honest-финиша в гонке до строки, которую увидит игрок в
// лобби. По частям это покрыто модульными тестами, но между ними два стыка, где легко разойтись, —
// анонимный идентификатор доходит от клиента до записи, а место и отставание считаются по той же
// трассе, что и забег.
test('честный забег попадает в таблицу рекордов вместе со своим местом', async t => {
  await listen();
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = new TestClient(url);
  const guest = new TestClient(url);

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  // Лёгкая трасса — самая короткая: честный забег нельзя ускорить, он упирается в тот же предел
  // скорости, что и живой игрок, и каждый лишний сегмент добавляет к тесту по секунде.
  host.send('create', { name: 'Хост', playerId: 'x'.repeat(32), mode: 'race', difficulty: 'easy' });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: 'Гость', playerId: 'y'.repeat(32), code: created.code });
  await host.wait('lobby', m => m.players.length === 2);
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(p => p.ready));
  host.send('start');
  const started = await host.wait('start');
  await waitForStart(started.at);

  // Оба бегут одновременно, как в настоящей гонке: последовательный прогон удвоил бы время теста
  // без единой новой проверки.
  await Promise.all([
    runHonestly(host, started.spec, started.matchId),
    runHonestly(guest, started.spec, started.matchId, { step: HONEST_STEP * 0.9 })
  ]);
  const results = await host.wait('results', () => true, WAIT_MS);
  assert.ok(
    results.trusted,
    `подготовка: оба забега должны пройти проверку (${results.unranked}, ${JSON.stringify(results.board.map(e => e.verificationReasons))})`
  );

  const seed = started.spec.seed;
  const difficulty = started.spec.difficulty;
  const ask = async playerId => {
    const params = new URLSearchParams({ seed, difficulty, limit: '10' });
    if (playerId) params.set('playerId', playerId);
    const response = await fetch(`http://127.0.0.1:${port}/leaderboard?${params}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const anonymous = await ask(null);
  assert.equal(anonymous.entries.length, 2, 'оба финиша попали в таблицу');
  assert.equal(anonymous.standing, null, 'без идентификатора места нет');
  assert.equal(anonymous.verificationVersion, VERIFICATION_VERSION, 'версия проверки отдаётся клиенту');
  assert.ok(anonymous.entries[0].time <= anonymous.entries[1].time, 'таблица отсортирована по времени');
  // Ключ чужой строки не должен уезжать клиенту: иначе перезаписать её сможет любой, кто эту
  // страницу открыл.
  assert.ok(
    anonymous.entries.every(entry => !('playerId' in entry)),
    'идентификаторы игроков наружу не отдаются'
  );

  const mine = await ask('x'.repeat(32));
  assert.equal(mine.entries.filter(entry => entry.self).length, 1, 'своя строка ровно одна');
  assert.equal(mine.standing.total, 2);
  assert.ok(mine.standing.place === 1 || mine.standing.place === 2);
  assert.equal(
    mine.standing.place === 1,
    mine.standing.gap === null,
    'отставание есть у всех, кроме первого'
  );

  const stranger = await ask('z'.repeat(32));
  assert.equal(stranger.standing, null, 'у не пробегавшего трассу места нет');

  // Время забега попадает и в метрики — с отметкой, можно ли ему верить. Без этого измерения
  // одно жульничество на три секунды утащило бы за собой среднее по всей трассе.
  const times = gameplay
    .summary({ days: 1, limit: 1000 })
    .rows.filter(row => row.metric === 'finish_time' && row.course === difficulty);
  const verified = times.find(row => row.detail === 'verified');
  assert.ok(verified, 'проверенное время записано отдельной строкой');
  assert.ok(verified.samples >= 2, 'оба честных финиша учтены');
  assert.ok(verified.average > 0, 'у времени есть среднее — в отличие от простого счётчика');
});

// Сессия для переподключения не должна протухать под играющим человеком.
//
// Срок ставился при входе и обновлялся только на обрыве и на возвращении, но НЕ во время игры. У
// любого, кто играет дольше минуты, сессия тихо протухала посреди матча, и перезагрузка страницы
// уводила его в главное меню вместо своей комнаты. Поймано браузерным тестом: он перезагружает
// страницу гостя как раз около этой границы и падал через раз.
test('сессия не протухает, пока игрок на связи', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest } = await startedRoom(url, 'coop');
  let back = null;

  // Все клиенты закрываются в ОДНОМ хуке и до shutdown: server.close ждёт, пока закроются
  // соединения, и живой сокет в отдельном хуке подвесил бы весь прогон.
  t.after(async () => {
    await Promise.all([host.close(), guest.close(), back ? back.close() : Promise.resolve()]);
    await shutdown();
  });

  const token = host.messages.find(m => m.type === 'hello').token;
  assert.ok(token, 'подготовка: сервер обязан выдать токен');

  // Проматываем время далеко за срок жизни сессии — так же, как это сделал бы сервер через час игры.
  expireSessions(Date.now() + SESSION_TTL_MS * 10);

  // Возвращаемся по тому же токену: сессия обязана быть на месте.
  host.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token });
  const resumed = await back.wait('resumed', () => true, WAIT_MS);
  assert.ok(resumed, 'игрок обязан вернуться в свою комнату');
});

// Ради этого метрики и заводились: «падений 4312» не отвечает ни на один вопрос, а «падают на
// мосту вдвое чаще, чем на пружинах» — отвечает.
//
// Проверяется поэтому не то, что счётчик увеличился, а что событие связано с ПРАВИЛЬНЫМ местом.
// Счётчик, который считает верно, но всё сваливает в одну кучу, выглядит рабочим и врёт.
test('падение записывается на том препятствии, где случилось', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest, started } = await startedRoom(url, 'race');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const spec = started.spec;
  const centerOf = index => FIRST_SEGMENT_CENTER - SEGMENT_LENGTH * index;
  // Набор общий на весь процесс, и падения бывали в других тестах: считаем прирост, а не итог.
  const fallsAt = detail =>
    gameplay
      .summary({ days: 1, limit: 1000 })
      .rows.filter(row => row.metric === 'fall' && row.detail === detail)
      .reduce((sum, row) => sum + row.samples, 0);

  const first = 1;
  const second = 4;
  assert.ok(second < spec.segmentCount, 'подготовка: на трассе должно хватать сегментов');
  const firstType = spec.segments[first].type;
  const secondType = spec.segments[second].type;
  assert.notEqual(firstType, secondType, 'подготовка: генератор не повторяет типы, иначе замер слеп');

  const beforeFirst = fallsAt(firstType);
  const beforeSecond = fallsAt(secondType);

  // Возрождений за забег несколько, и они отличаются только порядком: предикат по одному лишь
  // reason нашёл бы предыдущее сообщение и вернулся, не дождавшись нового.
  const respawns = () => host.messages.filter(m => m.type === 'correction' && m.reason === 'respawn').length;
  async function fallHere() {
    const seen = respawns();
    host.send('respawn', { matchId: started.matchId });
    await host.wait('correction', m => m.reason === 'respawn' && respawns() > seen);
    return host.takeCorrection();
  }

  await runToFinish(host, spec, started.matchId, { stopBefore: 1, to: centerOf(first) });
  const from = await fallHere();

  assert.equal(fallsAt(firstType) - beforeFirst, 1, `падение засчитано типу «${firstType}»`);
  assert.equal(fallsAt(secondType) - beforeSecond, 0, 'и не засчитано соседнему');

  // Второе падение — дальше по трассе. Возрождение вернуло игрока на чекпоинт, оттуда и бежим.
  await runToFinish(host, spec, started.matchId, { stopBefore: 1, from: from.z, to: centerOf(second) });
  await fallHere();

  assert.equal(fallsAt(secondType) - beforeSecond, 1, `второе падение засчитано типу «${secondType}»`);
  assert.equal(fallsAt(firstType) - beforeFirst, 1, 'первое от этого не удвоилось');

  const row = gameplay
    .summary({ days: 1, limit: 1000 })
    .rows.find(item => item.metric === 'fall' && item.detail === secondType);
  assert.equal(row.mode, 'race');
  assert.equal(row.course, spec.difficulty, 'сложность — отдельное измерение: на «хаосе» падают иначе');
  assert.equal(row.device, 'desktop', 'устройство определено, а не оставлено пустым');
});

// Кооперативная глава попадает в competitive-таблицу только после server-side movement audit.
// Этот тест намеренно использует runHonestly, а не быстрый функциональный runToFinish: последний
// движется примерно в семь раз быстрее персонажа и теперь правильно снимает зачёт. Проверяется
// полный production boundary: серверное время + допустимое движение + строки обоих напарников.
test('пройденная кооп-глава попадает в таблицу глав', async t => {
  await listen();
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/ws`;
  const host = new TestClient(url);
  const guest = new TestClient(url);

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  const hostAccount = accounts.create('Аня');
  const guestAccount = accounts.create('Боря');

  // Auth V2 больше не принимает recovery credential внутри room-команд. Этот integration test
  // повторяет настоящий production boundary: HttpOnly session выдаёт короткий WST, сокет один раз
  // поглощает его, а CREATE/JOIN после этого вообще ничего не знают об account credential.
  const { AuthService } = require('./auth');
  const { networkIdentity } = require('./networkIdentity');
  const socketAuth = new AuthService({ db: accounts.db });
  networkIdentity.configure(ticket => socketAuth.consumeSocketTicket(ticket));
  t.after(() => networkIdentity.reset());

  host.send('auth', { ticket: socketAuth.createSocketTicket(hostAccount.id).token });
  guest.send('auth', { ticket: socketAuth.createSocketTicket(guestAccount.id).token });
  await Promise.all([host.wait('authenticated'), guest.wait('authenticated')]);

  host.send('create', {
    name: 'Аня',
    playerId: 'подменённый-id',
    mode: 'coop'
  });
  const created = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', {
    name: 'Боря',
    playerId: 'ещё-один-подменённый-id',
    code: created.code
  });
  await host.wait('lobby', m => m.players.length === 2);
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(p => p.ready));
  host.send('start');
  const started = await host.wait('start');
  await waitForStart(started.at);

  await Promise.all([
    runHonestly(host, started.spec, started.matchId),
    runHonestly(guest, started.spec, started.matchId)
  ]);
  const results = await host.wait('results', () => true, WAIT_MS);
  assert.equal(results.mode, 'coop');
  assert.ok(results.trusted, `подготовка: глава обязана засчитаться (${results.unranked})`);
  assert.equal(accounts.progress(hostAccount.id).stats.coopMatchesCompleted, 1);
  assert.equal(accounts.progress(guestAccount.id).chapters[0].chapterId, 'ch1');

  const chapter = started.spec.chapterId || started.spec.id;
  const ask = async playerId => {
    const params = new URLSearchParams({ chapter, limit: '10' });
    if (playerId) params.set('playerId', playerId);
    const response = await fetch(`http://127.0.0.1:${port}/leaderboard/coop?${params}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const board = await ask(null);
  assert.equal(board.mode, 'coop');
  assert.equal(
    board.movementVerified,
    true,
    'competitive co-op board обязан сообщать о server-side movement verification'
  );

  // Проверяется своя пара, а не размер таблицы: база — общий синглтон на весь набор, и главу до
  // этого теста успевают пройти другие. Ждать здесь ровно двух строк значило бы написать тест,
  // который ломается от появления соседнего.
  const mine = await ask(hostAccount.id);
  const partner = await ask(guestAccount.id);
  assert.ok(mine.standing, 'своя строка в таблице главы есть');
  assert.ok(partner.standing, 'у напарника тоже');
  assert.ok(mine.standing.total >= 2, 'в таблице как минимум оба');
  assert.equal(mine.entries.filter(entry => entry.self).length <= 1, true, 'своя строка не двоится');

  // Время серверное. Клиент в этом забеге ничего похожего не присылал: runToFinish сообщает
  // clientTime 1000, а сервер меряет от старта комнаты, и на прохождение уходят секунды.
  assert.ok(
    mine.standing.time > 1500 && partner.standing.time > 1500,
    `время меряет сервер, а не клиент (${mine.standing.time}, ${partner.standing.time})`
  );

  const wrong = await fetch(`http://127.0.0.1:${port}/leaderboard/coop?chapter=не-глава`);
  assert.equal(wrong.status, 400, 'выдуманная глава — отказ, а не пустая таблица');
});

// ВНИМАНИЕ: этот тест обязан оставаться ПОСЛЕДНИМ в файле.
//
// Выключение — процессное событие: оно снимает флаг готовности, останавливает рассылку снапшотов
// и закрывает приём подключений на весь оставшийся процесс. Тесты идут по порядку в одном
// процессе, поэтому всё, что объявлено ниже, уже не поднимется. Новые тесты добавляйте ВЫШЕ.
// Перезапуск службы рвал соединения посреди забега, и клиент видел обычный обрыв: он честно уходил
// в переподключение к серверу, которого ещё нет. Отличить «сеть моргнула» от «сервер выключается»
// было нечем, и каждое обновление игры выглядело как поломка сети.
test('выключение сервера предупреждает игроков до разрыва', async t => {
  await listen();
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const { host, guest } = await startedRoom(url, 'coop');

  t.after(async () => {
    await Promise.all([host.close(), guest.close()]);
    await shutdown();
  });

  const warned = Promise.all([
    host.wait('shutdown', () => true, WAIT_MS),
    guest.wait('shutdown', () => true, WAIT_MS)
  ]);
  const closed = new Promise(resolve => guest.ws.once('close', (code, reason) => resolve({ code, reason })));

  shutdownServer('TEST', { exitProcess: false });

  const [notice] = await warned;
  assert.equal(notice.reason, 'restart', 'клиенту нужна причина, а не голый факт');

  // Предупреждение обязано прийти РАНЬШЕ закрытия, иначе оно останется в буфере отправки и игрок
  // увидит только обрыв — ровно то, что чинится.
  const closeEvent = await closed;
  assert.equal(closeEvent.code, 1001, 'штатный код «going away», а не аварийный обрыв');
});
