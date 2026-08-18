// Нагрузочная проба: создаёт настоящих WebSocket-клиентов и нагружает игровой сервер.
//
// Это именно LOAD GENERATOR. CPU/RSS сервера измеряет отдельный `npm run load:observe`, который
// запускается на самом VPS. Поэтому генераторы можно запускать с нескольких внешних машин.
//
//   npm run load                              # localhost: 12 комнат, 20 секунд
//   WOBBLE_WS_URL=wss://game.example/ws \
//   WOBBLE_HTTP_URL=https://game.example npm run load -- 8 300
//
// `WOBBLE_URL` оставлен как совместимый alias для старых команд, но новые сценарии должны явно
// использовать WOBBLE_WS_URL и WOBBLE_HTTP_URL.

import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { loadStateMessage, loadTargets } from './loadProbeConfig.mjs';

const { wsUrl, httpUrl } = loadTargets();
const ROOMS = Math.max(1, Number(process.argv[2] || 12));
const SECONDS = Math.max(1, Number(process.argv[3] || 20));
const RESULT_PATH = String(process.env.WOBBLE_LOAD_RESULT_PATH || '').trim() || null;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor() {
    this.waiters = [];
    this.matchId = null;
    this.spec = null;
    this.sequence = 0;

    // HELLO может прилететь почти сразу после локального WebSocket handshake. Waiter ставится ДО
    // открытия сокета, иначе быстрый loopback успевает доставить событие между `new Client()` и
    // внешним `client.wait('hello')`, после чего probe восемь секунд ждёт уже прошедшее сообщение.
    this.hello = this.wait('hello');
    this.ws = new WebSocket(wsUrl);
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'hello') this.id = message.id;
      if (message.type === 'start') {
        this.matchId = message.matchId;
        this.spec = message.spec;
        this.startedAt = message.at;
        this.sequence = 0;
      }
      for (const waiter of [...this.waiters]) {
        if (waiter.type !== message.type || !waiter.ok(message)) continue;
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
  }

  wait(type, ok = () => true, ms = 8000) {
    return new Promise((resolve, reject) => {
      const waiter = { type, ok, resolve: null };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout ${type}`));
      }, ms);
      waiter.resolve = value => {
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.push(waiter);
    });
  }

  send(type, data = {}) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, ...data }));
  }

  sendState(z, vz) {
    this.sequence += 1;
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify(loadStateMessage({ matchId: this.matchId, sequence: this.sequence, z, vz }))
      );
    }
  }

  close() {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close();
    }
  }
}

async function health() {
  const response = await fetch(`${httpUrl}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json();
}

async function readiness() {
  const response = await fetch(`${httpUrl}/health/ready`);
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status is still useful if an intermediary returned a non-JSON error body.
  }
  return { ok: response.ok && body?.ok === true, status: response.status };
}

function compactHealth(value) {
  return {
    rooms: value.rooms,
    players: value.players,
    sessions: value.sessions,
    capacity: value.capacity,
    load: value.load,
    matchmaking: value.matchmaking,
    metrics: value.metrics
  };
}

function metricDelta(before, after, name) {
  return Number(after.metrics?.[name] || 0) - Number(before.metrics?.[name] || 0);
}

const initial = await health();
const rooms = [];
const clients = [];
console.log(`target ws:   ${wsUrl}`);
console.log(`target http: ${httpUrl}`);
console.log(`поднимаю ${ROOMS} кооп-комнат (${ROOMS * 2} игроков)…`);

try {
  for (let index = 0; index < ROOMS; index++) {
    const host = new Client();
    const guest = new Client();
    clients.push(host, guest);
    await Promise.all([host.hello, guest.hello]);

    // Все ожидания регистрируются ДО команды, которая может немедленно вызвать ответ. Это важно
    // не только для HELLO: на localhost CREATE/JOIN/READY/START тоже иногда проходят полный
    // server round-trip раньше, чем следующая строка JavaScript успевает поставить waiter.
    const createdLobby = host.wait('lobby', message => message.players.length === 1);
    host.send('create', { name: `H${index}`, mode: 'coop' });
    const lobby = await createdLobby;

    const joinedLobby = host.wait('lobby', message => message.players.length === 2);
    guest.send('join', { name: `G${index}`, code: lobby.code });
    await joinedLobby;

    const readyLobby = host.wait('lobby', message => message.players.every(player => player.ready));
    host.send('ready', { ready: true });
    guest.send('ready', { ready: true });
    await readyLobby;

    const hostStart = host.wait('start');
    const guestStart = guest.wait('start');
    host.send('start');
    await Promise.all([hostStart, guestStart]);
    rooms.push([host, guest]);
  }

  // Ждём конца отсчёта, иначе позиции сервер игнорирует.
  await sleep(3200);

  const before = await health();
  console.log(`шлю позиции ${SECONDS} с…`);
  let z = 10;
  let direction = -1;
  const timer = setInterval(() => {
    const stepDirection = direction;
    z += stepDirection * 0.4;
    const vz = stepDirection * 7;
    for (const pair of rooms) {
      for (const client of pair) client.sendState(z, vz);
    }
    if (z <= -120) direction = 1;
    else if (z >= 10) direction = -1;
  }, 66);

  await sleep(SECONDS * 1000);
  clearInterval(timer);

  const after = await health();
  const ready = await readiness();
  const deltas = Object.fromEntries(
    [
      'invalidMessages',
      'socketSendFailures',
      'handlerErrors',
      'capacityRejected',
      'snapshotsSkippedForLoad',
      'verificationFailed',
      'latePacketsDropped'
    ].map(name => [name, metricDelta(initial, after, name)])
  );
  const result = {
    roomsRequested: ROOMS,
    playersRequested: ROOMS * 2,
    seconds: SECONDS,
    targets: { wsUrl, httpUrl },
    build: {
      version: after.version,
      commit: after.commit || null,
      protocolVersion: after.protocolVersion
    },
    initial: compactHealth(initial),
    beforeTraffic: compactHealth(before),
    after: compactHealth(after),
    readiness: ready,
    deltas
  };

  if (RESULT_PATH) await writeFile(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log('\n--- РЕЗУЛЬТАТ ГЕНЕРАТОРА ---');
  console.log(
    `build:                 ${after.version} · ${after.commit || 'unknown'} · protocol ${after.protocolVersion}`
  );
  console.log(`игроков онлайн:        ${after.players}`);
  console.log(`комнат:                ${after.rooms}`);
  console.log(`matchmaking waiting:   ${after.matchmaking?.waiting ?? '—'}`);
  console.log(`event-loop p95:        ${after.load?.eventLoopP95Ms ?? '—'} мс`);
  console.log(`RSS по health:         ${after.load?.rssMb ?? '—'} МБ`);
  console.log(`ready после нагрузки:  ${ready.ok ? 'да' : `нет (HTTP ${ready.status})`}`);
  console.log(`некорректных сообщений: ${deltas.invalidMessages}`);
  console.log(`сбоев отправки:         ${deltas.socketSendFailures}`);
  console.log(`ошибок обработчика:     ${deltas.handlerErrors}`);
  console.log(`отказов по capacity:    ${deltas.capacityRejected}`);
  console.log(`snapshot skip по load:  ${deltas.snapshotsSkippedForLoad}`);
} finally {
  for (const client of clients) client.close();
}
