const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const {
  server,
  setResultsTimeout,
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
const listen = () => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const shutdown = () => new Promise(resolve => server.close(resolve));

// Довести клиента до финишной черты по-настоящему: сервер проверяет позицию, и телепорт он
// отвергнет. Шаги подобраны под серверное правило скорости (3.2 + dt*18 за пакет) и под
// ограничение «не чаще раза в 32 мс».
const STATE_STEP = 3.2;
const STATE_GAP_MS = 55;

async function runToFinish(client, spec, matchId, { stopBefore = 0 } = {}) {
  let z = spec.start.z;
  const target = spec.finishZ - 1;
  const at = value => ({ x: 0, y: spec.start.y, z: value, ry: 0, vx: 0, vz: -8, state: 'ground' });
  while (z > target) {
    z = Math.max(target, z - STATE_STEP);
    client.send('state', { matchId, state: at(z) });
    await new Promise(resolve => setTimeout(resolve, STATE_GAP_MS));
  }
  if (stopBefore) return z;
  // Финальная позиция едет ВНУТРИ finish — именно так её теперь отправляет клиент.
  client.send('finish', { matchId, state: at(z), clientTime: 1000 });
  return z;
}

// Забег, который проходит проверку на честность, а не только доезжает до финиша.
//
// runToFinish выше шлёт 3.2 единицы за 55 мс — это 58 единиц в секунду при потолке в 22. Коопу это
// сходит с рук: его итоги в таблицу рекордов не идут, и ни один тест там отметку «проверено» не
// смотрит. Гонке — нет, поэтому здесь шаг подобран под предел наблюдаемой скорости.
//
// Быстрее не сделать: честный забег упирается ровно в тот же потолок, что и живой игрок, и время
// теста задаётся длиной трассы, а не тем, как часто мы шлём пакеты.
const HONEST_STEP = 1;
const HONEST_GAP_MS = 55;

async function runHonestly(client, spec, matchId, { step = HONEST_STEP } = {}) {
  let z = spec.start.z;
  const target = spec.finishZ - 1;
  const at = value => ({ x: 0, y: spec.start.y, z: value, ry: 0, vx: 0, vz: -8, state: 'ground' });
  while (z > target) {
    z = Math.max(target, z - step);
    client.send('state', { matchId, state: at(z) });
    await new Promise(resolve => setTimeout(resolve, HONEST_GAP_MS));
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
  const notice = await host.wait('unranked', () => true, 3000);
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
  const notice = await host.wait('unranked', () => true, 3000);
  assert.equal(notice.reason, 'left', 'добровольный выход отличается от обрыва');

  // Оставшийся доходит до финиша по-настоящему: телепорт сервер бы не принял.
  await runToFinish(host, started.spec, started.matchId);
  const results = await host.wait('results', () => true, 5000);
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
  await host.wait('finish', m => m.id === host.messages.find(x => x.type === 'hello').id, 5000);
  await runToFinish(guest, started.spec, started.matchId);

  // И сразу вдогонку — то самое опоздавшее состояние.
  guest.send('state', {
    matchId: started.matchId,
    state: { x: 0, y: started.spec.start.y, z: lastZ, ry: 0, vx: 0, vz: -8, state: 'ground' }
  });

  const results = await Promise.all([
    host.wait('results', () => true, 5000),
    guest.wait('results', () => true, 5000)
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
  await host.wait('finish', () => true, 5000);
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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, 5000), guest.wait('results', () => true, 5000)]);

  // Голосует хост — тот, кто раньше мог решать за всех.
  host.send('rematch', { matchId: started.matchId });
  const afterFirst = await guest.wait('lobby', m => m.players.some(p => p.choice === 'rematch'), 3000);
  assert.equal(afterFirst.state, 'RESULTS', 'комната обязана остаться на результатах');
  assert.equal(afterFirst.players.filter(p => p.choice === 'rematch').length, 1, 'засчитан ровно один голос');
  assert.ok(afterFirst.resultsDeadline, 'клиенту нужен срок, чтобы показать отсчёт');

  // И только второй голос запускает забег. Именно ЗАБЕГ, а не возврат в лобби: иначе кнопка
  // «реванш» делала бы ровно то же, что «в лобби», и голосовать было бы не за что.
  guest.send('rematch', { matchId: started.matchId });
  // Предикат обязан отсекать матч, который уже был: в истории клиента лежит `start` первого
  // забега, и ожидание «любого start» нашло бы его, ничего на самом деле не проверив.
  const restart = await guest.wait('start', m => m.matchId !== started.matchId, 3000);
  assert.notEqual(restart.matchId, started.matchId, 'у реванша свой matchId');
  assert.equal(restart.spec.seed, started.spec.seed, 'реванш идёт по той же трассе');
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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, 5000), guest.wait('results', () => true, 5000)]);

  // Историю чистим намеренно: в ней уже лежат состояния LOBBY, полученные до старта забега,
  // и ожидание нашло бы их, ничего на самом деле не проверив.
  guest.messages.length = 0;
  host.send('rematch', { matchId: started.matchId });
  guest.send('returnLobby', { matchId: started.matchId });

  // Несогласие разрешается в пользу лобби: заставлять играть ещё раз того, кто уже уходит, нельзя.
  const lobby = await guest.wait('lobby', m => m.state === 'LOBBY', 3000);
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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, 5000), guest.wait('results', () => true, 5000)]);

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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  await Promise.all([host.wait('results', () => true, 5000), guest.wait('results', () => true, 5000)]);

  // Хост сначала за лобби, потом передумал.
  host.send('returnLobby', { matchId: started.matchId });
  await guest.wait('lobby', m => m.players.some(p => p.choice === 'lobby'), 3000);
  host.send('rematch', { matchId: started.matchId });
  guest.send('rematch', { matchId: started.matchId });

  // Предикат обязан отсекать матч, который уже был: в истории клиента лежит `start` первого
  // забега, и ожидание «любого start» нашло бы его, ничего на самом деле не проверив.
  const restart = await guest.wait('start', m => m.matchId !== started.matchId, 3000);
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
  const resumed = await host.wait('resumed', () => true, 3000);
  assert.equal(resumed.id, hostHello.id, 'идентификатор должен сохраниться');
  assert.ok(resumed.token, 'токен обязан вернуться клиенту, иначе следующий обрыв не восстановится');

  // Теперь добиваем старое соединение.
  oldWs.terminate();
  await new Promise(resolve => setTimeout(resolve, 400));

  const lobby = await guest.wait('lobby', m => m.players.every(p => p.online), 3000);
  assert.equal(lobby.players.length, 2, 'оба игрока на месте');
  assert.equal(host.ws.readyState, WebSocket.OPEN, 'новое соединение должно остаться живым');

  // И новое соединение продолжает работать.
  host.send('ready', { ready: true });
  await guest.wait('lobby', m => m.players.some(p => p.id === hostHello.id && p.ready), 3000);
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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  const original = await guest.wait('results', () => true, 5000);

  guest.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token: guestHello.token });
  await back.wait('resumed', () => true, 3000);

  const restored = await back.wait('results', () => true, 3000);
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
  await host.wait('finish', () => true, 5000);
  await runToFinish(guest, started.spec, started.matchId);
  await host.wait('results', () => true, 5000);

  // Голосует только хост.
  host.send('rematch', { matchId: started.matchId });
  await host.wait('lobby', m => m.state === 'RESULTS' && m.players.some(p => p.choice === 'rematch'), 3000);

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
  await back.wait('resumed', () => true, 3000);

  const restart = await back.wait('start', () => true, 3000);
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
  await host.wait('finish', () => true, 5000);

  host.ws.terminate();
  back = new TestClient(url);
  await back.wait('hello');
  back.send('resume', { token: hostHello.token });
  await back.wait('resumed', () => true, 3000);

  const restart = await back.wait('start', () => true, 3000);
  assert.equal(restart.resumed.finished, true, 'сервер обязан сказать, что игрок уже дошёл');
  void guest;
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
    runHonestly(guest, started.spec, started.matchId, { step: 0.9 })
  ]);
  const results = await host.wait('results', () => true, 5000);
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
  assert.equal(anonymous.verificationVersion, 1, 'версия проверки отдаётся клиенту');
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
  const resumed = await back.wait('resumed', () => true, 3000);
  assert.ok(resumed, 'игрок обязан вернуться в свою комнату');
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
    host.wait('shutdown', () => true, 3000),
    guest.wait('shutdown', () => true, 3000)
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
