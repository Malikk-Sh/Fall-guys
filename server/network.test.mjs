// Тесты клиентского сетевого слоя.
//
// Здесь проверяется то, что нельзя увидеть со стороны сервера: в каком порядке клиент отправляет
// пакеты, что он делает с личностью при восстановлении сессии и какие сообщения он копит, пока
// соединения нет. Каждый тест соответствует конкретному сбою, который игрок видел как «ошибка
// сервера» или «результат не подтверждается».

import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkManager } from '../client/net/NetworkManager.js';
import { C2S, S2C, PROTOCOL_VERSION } from '../shared/protocol.js';

// Хранилище сессии: в Node его нет, а именно вокруг него крутится половина ошибок переподключения.
const fakeStorage = () => {
  const data = new Map();
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
};

const stubUi = () => ({
  status: () => {},
  error: () => {},
  toast: () => {}
});

// Сетевой менеджер с подставным сокетом. Настоящий не нужен: нас интересует, ЧТО он отправляет
// и в каком порядке.
function makeNet({ storage = fakeStorage() } = {}) {
  const previous = Object.prototype.hasOwnProperty.call(globalThis, 'sessionStorage')
    ? globalThis.sessionStorage
    : undefined;
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    configurable: true,
    writable: true
  });
  const net = new NetworkManager(stubUi());
  if (previous === undefined) delete globalThis.sessionStorage;
  else globalThis.sessionStorage = previous;

  const sent = [];
  net.storage = storage;
  net.sent = sent;
  // Подставной сокет и запрет на реальное подключение.
  net.ws = { readyState: 1, send: payload => sent.push(JSON.parse(payload)), close: () => {} };
  net.connect = () => {};
  // saveSession обращается к sessionStorage напрямую — направляем его в тот же объект.
  net.saveSession = token => {
    net.sessionToken = token || null;
    if (token) storage.setItem('wobble-session', token);
    else storage.removeItem('wobble-session');
  };
  return net;
}

// Обычное подключение: сервер поздоровался, матч начался.
function bringOnline(net, { matchId = 'm1', id = 'me' } = {}) {
  net.handleMessage({
    type: S2C.WELCOME,
    id,
    token: 'token-1',
    serverTime: Date.now(),
    protocolVersion: PROTOCOL_VERSION
  });
  net.handleMessage({ type: S2C.MATCH_START, matchId, at: Date.now(), spec: {} });
  net.sent.length = 0;
  return net;
}

const SNAPSHOT = { x: 0, y: 1, z: -5, ry: 0, vx: 0, vz: -8, state: 'ground' };

test('обычное подключение сразу принимает выданную личность', () => {
  const net = makeNet();
  net.handleMessage({ type: S2C.WELCOME, id: 'abc', token: 'token-1', serverTime: Date.now() });
  assert.equal(net.id, 'abc');
  assert.equal(net.sessionToken, 'token-1');
  assert.equal(net.handshakeReady, true, 'без восстановления сессии рукопожатие завершено сразу');
});

test('во время восстановления сессии временная личность не принимается', () => {
  const net = makeNet();
  // Так выглядит переподключение: токен прошлой сессии есть, resume отправлен, ответа ещё нет.
  net.resumeInFlight = true;
  net.resumeToken = 'old-token';
  net.id = 'old-id';
  net.handleMessage({ type: S2C.WELCOME, id: 'temp-id', token: 'temp-token', serverTime: Date.now() });

  assert.equal(net.id, 'old-id', 'временный id не должен подменять прежний');
  assert.notEqual(net.sessionToken, 'temp-token', 'временный токен не должен затирать сохранённый');
  assert.equal(net.handshakeReady, false, 'до подтверждения возврата отправлять ещё нельзя');
  assert.deepEqual(net.pendingWelcome, { id: 'temp-id', token: 'temp-token' }, 'но запомнить его надо');
});

test('успешный resume возвращает прежний id и сохраняет присланный токен', () => {
  const net = makeNet();
  net.resumeInFlight = true;
  net.resumeToken = 'old-token';
  net.handleMessage({ type: S2C.WELCOME, id: 'temp-id', token: 'temp-token', serverTime: Date.now() });
  net.handleMessage({ type: S2C.RESUMED, id: 'old-id', token: 'renewed-token', serverTime: Date.now() });

  assert.equal(net.id, 'old-id', 'иначе игрок перестанет узнавать себя в снапшотах');
  assert.equal(net.sessionToken, 'renewed-token');
  assert.equal(net.storage.getItem('wobble-session'), 'renewed-token', 'токен обязан пережить перезагрузку');
  assert.equal(net.handshakeReady, true);
  assert.equal(net.resumeInFlight, false);
  assert.equal(net.pendingWelcome, null, 'временная личность больше не нужна');
});

test('второй обрыв подряд восстанавливается тем же путём', () => {
  const net = makeNet();
  net.resumeInFlight = true;
  net.resumeToken = 'old-token';
  net.handleMessage({ type: S2C.RESUMED, id: 'me', token: 'token-2', serverTime: Date.now() });
  assert.equal(net.sessionToken, 'token-2');

  // Второй раунд: клиент снова подключается и снова возвращается по СВЕЖЕМУ токену.
  net.resumeInFlight = true;
  net.resumeToken = net.sessionToken;
  net.handleMessage({ type: S2C.WELCOME, id: 'temp', token: 'temp', serverTime: Date.now() });
  net.handleMessage({ type: S2C.RESUMED, id: 'me', token: 'token-3', serverTime: Date.now() });
  assert.equal(net.id, 'me');
  assert.equal(net.sessionToken, 'token-3', 'иначе следующая попытка уйдёт с мёртвым токеном');
});

test('неудачный resume чистит токен и заново подтверждает account перед новой жизнью', async () => {
  const net = makeNet();
  net.roomCode = 'ABCDE';
  net.matchId = 'm1';
  net.resumeInFlight = true;
  net.resumeToken = 'dead-token';
  net.handleMessage({ type: S2C.WELCOME, id: 'temp-id', token: 'fresh-token', serverTime: Date.now() });
  net.queue.push(JSON.stringify({ type: C2S.PLAYER_STATE }));

  let freshRequests = 0;
  net.ui.accountToken = async ({ fresh } = {}) => {
    assert.equal(fresh, true, 'после провала resume нужен новый WST из HttpOnly session');
    freshRequests++;
    return 'WST.fresh-after-resume-failure-1234567890';
  };

  let expired = 0;
  net.on('sessionExpired', () => expired++);
  net.handleMessage({ type: S2C.RESUME_FAILED, code: 'RECONNECT_EXPIRED' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(expired, 1, 'игра должна узнать, что возвращаться некуда');
  assert.equal(net.id, null, 'временный hello нельзя принимать до нового socket-auth');
  assert.equal(net.sessionToken, null, 'мёртвый room-session должен быть удалён');
  assert.equal(net.matchId, null, 'матча больше нет');
  assert.deepEqual(net.queue, [], 'очередь прошлой жизни отправлять некуда');
  assert.equal(freshRequests, 1, 'новый WST запрашивается ровно один раз');
  assert.deepEqual(net.sent.at(-1), {
    type: C2S.AUTH,
    ticket: 'WST.fresh-after-resume-failure-1234567890'
  });

  net.handleMessage({ type: S2C.AUTHENTICATED, accountId: 'acc-1' });
  assert.equal(net.id, 'temp-id', 'личность нового сокета принимается только после AUTH');
  assert.equal(net.sessionToken, 'fresh-token', 'новая room-session сохраняется после AUTH');
  assert.equal(net.handshakeReady, true);
});

// Финальная позиция едет ВНУТРИ финиша, а не отдельным пакетом перед ним. Отдельным она попадала
// под серверное ограничение «не чаще раза в 32 мс» и примерно в половине случаев терялась молча,
// после чего финиш проверялся по точке перед лентой и отклонялся.
test('финиш несёт финальную позицию внутри себя', () => {
  const net = bringOnline(makeNet());
  net.finish(SNAPSHOT, 42_000);

  assert.equal(net.sent.length, 1, 'один пакет, а не два — иначе позицию можно потерять по дороге');
  const [packet] = net.sent;
  assert.equal(packet.type, C2S.FINISH);
  assert.equal(packet.matchId, 'm1');
  assert.equal(packet.sequence, 0);
  assert.equal(packet.clientTime, 42_000);
  assert.deepEqual(packet.state, SNAPSHOT, 'позиция обязана ехать вместе с финишем');
});

test('состояния нумеруются, а resume продолжает серверную последовательность', () => {
  const net = bringOnline(makeNet());
  net.sendState(SNAPSHOT, { force: true });
  net.sendState(SNAPSHOT, { force: true });
  assert.deepEqual(
    net.sent.map(packet => packet.sequence),
    [0, 1]
  );

  net.handleMessage({
    type: S2C.MATCH_START,
    matchId: 'm1',
    at: Date.now(),
    spec: {},
    resumed: { nextSequence: 42 }
  });
  net.sent.length = 0;
  net.sendState(SNAPSHOT, { force: true });
  assert.equal(net.sent[0].sequence, 42);
});

test('клиент отбрасывает повторные и запоздавшие серверные snapshots', () => {
  const net = bringOnline(makeNet());
  net.handleMessage({ type: S2C.SNAPSHOT, matchId: 'm1', sequence: 5, serverTime: 1000, players: [] });
  net.handleMessage({ type: S2C.SNAPSHOT, matchId: 'm1', sequence: 5, serverTime: 1001, players: [] });
  net.handleMessage({ type: S2C.SNAPSHOT, matchId: 'm1', sequence: 4, serverTime: 999, players: [] });

  assert.equal(net.snapshotsReceived, 1);
  assert.equal(net.staleSnapshots, 2);
  assert.equal(net.snapshots.latest.time, 1000);

  net.handleMessage({ type: S2C.MATCH_START, matchId: 'm2', at: Date.now(), spec: {} });
  net.handleMessage({ type: S2C.SNAPSHOT, matchId: 'm2', sequence: 0, serverTime: 2000, players: [] });
  assert.equal(net.snapshotsReceived, 2, 'новый матч начинает свою последовательность заново');
});

test('после финиша состояние больше не отправляется', () => {
  const net = bringOnline(makeNet());
  net.finish(SNAPSHOT, 1000);
  net.sent.length = 0;

  // Именно этот пакет и вызывал серверную ошибку у второго дошедшего.
  assert.equal(net.sendState(SNAPSHOT, { force: true }), false);
  assert.equal(net.sendState(SNAPSHOT), false);
  assert.deepEqual(net.sent, [], 'после финиша клиент обязан замолчать о своей позиции');
});

test('финиш отправляется один раз за матч и снова разрешается в новом', () => {
  const net = bringOnline(makeNet());
  assert.equal(net.finish(SNAPSHOT, 1000), true);
  net.sent.length = 0;
  assert.equal(net.finish(SNAPSHOT, 1000), false, 'повторный финиш того же матча не нужен');
  assert.deepEqual(net.sent, []);

  net.handleMessage({ type: S2C.MATCH_START, matchId: 'm2', at: Date.now(), spec: {} });
  net.sent.length = 0;
  assert.equal(net.finish(SNAPSHOT, 2000), true, 'новый забег — новое право на финиш');
  assert.equal(net.sent[0].matchId, 'm2');
});

test('отказ сервера разрешает повторить финиш', () => {
  const net = bringOnline(makeNet());
  net.finish(SNAPSHOT, 1000);
  net.allowFinishRetry();
  net.sent.length = 0;
  assert.equal(net.finish(SNAPSHOT, 1200), true, 'иначе добежавший останется без результата навсегда');
  assert.equal(net.sent[0].type, C2S.FINISH);
  assert.deepEqual(net.sent[0].state, SNAPSHOT, 'и снова с актуальной позицией');
});

test('вне матча состояние и кооп-события не отправляются вовсе', () => {
  const net = makeNet();
  net.handleMessage({ type: S2C.WELCOME, id: 'me', token: 't', serverTime: Date.now() });
  net.sent.length = 0;
  assert.equal(net.sendState(SNAPSHOT), false);
  assert.equal(net.sendCoopEvent('plate'), false);
  assert.equal(net.finish(SNAPSHOT, 1), false);
  assert.deepEqual(net.sent, [], 'без matchId эти пакеты бессмысленны');
});

test('пока сокет закрыт, транзиентные пакеты не копятся', () => {
  const net = bringOnline(makeNet());
  net.ws = { readyState: 3, send: () => {}, close: () => {} };

  for (const type of [C2S.PLAYER_STATE, C2S.FINISH, C2S.RESPAWN, C2S.COOP_EVENT, C2S.REMATCH_VOTE, C2S.PING])
    net.send(type, { matchId: 'm1' });
  assert.deepEqual(net.queue, [], 'позиция и голос из прошлого никому не нужны после переподключения');

  // А вот вход в комнату подождать можно и нужно.
  net.send(C2S.JOIN_ROOM, { code: 'ABCDE', name: 'Игрок' });
  assert.equal(net.queue.length, 1, 'намерение войти в комнату переживает обрыв');
});

test('до подтверждения возврата не отправляется ничего', () => {
  const net = bringOnline(makeNet());
  net.handshakeReady = false;
  net.sent.length = 0;
  net.send(C2S.PLAYER_READY, { ready: true });
  assert.deepEqual(net.sent, [], 'сервер ещё не знает, кто мы, — отвечать он будет ошибками');
});

test('несовпадение версий заставляет клиента замолчать', () => {
  const net = makeNet();
  let closed = false;
  net.ws.close = () => (closed = true);
  let notified = 0;
  net.on('versionMismatch', () => notified++);

  net.handleMessage({
    type: S2C.WELCOME,
    id: 'me',
    token: 't',
    serverTime: Date.now(),
    protocolVersion: PROTOCOL_VERSION + 1
  });

  assert.equal(notified, 1, 'игра должна показать «обновите страницу»');
  assert.equal(closed, true, 'и закрыть соединение, а не продолжать слать несовместимые пакеты');
  assert.equal(net.id, null, 'личность от несовместимого сервера не принимаем');
  net.sent.length = 0;
  net.send(C2S.PLAYER_READY, { ready: true });
  assert.deepEqual(net.sent, [], 'после несовпадения версий клиент молчит');
});
