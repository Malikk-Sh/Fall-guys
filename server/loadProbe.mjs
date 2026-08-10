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

import { WebSocket } from 'ws';
import { loadTargets } from './loadProbeConfig.mjs';

const { wsUrl, httpUrl } = loadTargets();
const ROOMS = Math.max(1, Number(process.argv[2] || 12));
const SECONDS = Math.max(1, Number(process.argv[3] || 20));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor() {
    this.ws = new WebSocket(wsUrl);
    this.waiters = [];
    this.matchId = null;
    this.spec = null;
    this.ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'hello') this.id = message.id;
      if (message.type === 'start') {
        this.matchId = message.matchId;
        this.spec = message.spec;
        this.startedAt = message.at;
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
      const timer = setTimeout(() => reject(new Error(`timeout ${type}`)), ms);
      this.waiters.push({
        type,
        ok,
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        }
      });
    });
  }

  send(type, data = {}) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, ...data }));
  }

  close() {
    this.ws.close();
  }
}

async function health() {
  const response = await fetch(`${httpUrl}/health`);
  if (!response.ok) throw new Error(`health HTTP ${response.status}`);
  return response.json();
}

const rooms = [];
console.log(`target ws:   ${wsUrl}`);
console.log(`target http: ${httpUrl}`);
console.log(`поднимаю ${ROOMS} кооп-комнат (${ROOMS * 2} игроков)…`);

for (let index = 0; index < ROOMS; index++) {
  const host = new Client();
  const guest = new Client();
  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: `H${index}`, mode: 'coop' });
  const lobby = await host.wait('lobby', message => message.players.length === 1);
  guest.send('join', { name: `G${index}`, code: lobby.code });
  await host.wait('lobby', message => message.players.length === 2);
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', message => message.players.every(player => player.ready));
  host.send('start');
  await Promise.all([host.wait('start'), guest.wait('start')]);
  rooms.push([host, guest]);
}

// Ждём конца отсчёта, иначе позиции сервер игнорирует.
await sleep(3200);

const before = await health();
console.log(`шлю позиции ${SECONDS} с…`);
let z = 10;
const timer = setInterval(() => {
  z -= 0.4;
  if (z < -180) z = 10;
  for (const pair of rooms) {
    for (const client of pair) {
      client.send('state', {
        matchId: client.matchId,
        state: { x: 0, y: 1.2, z, ry: 0, vx: 0, vz: -7, state: 'ground' }
      });
    }
  }
}, 66);

await sleep(SECONDS * 1000);
clearInterval(timer);

const after = await health();

console.log('\n--- РЕЗУЛЬТАТ ГЕНЕРАТОРА ---');
console.log(`build:                 ${after.version} · ${after.commit || 'unknown'} · protocol ${after.protocolVersion}`);
console.log(`игроков онлайн:        ${after.players}`);
console.log(`комнат:                ${after.rooms}`);
console.log(`matchmaking waiting:   ${after.matchmaking?.waiting ?? '—'}`);
console.log(`event-loop p95:        ${after.load?.eventLoopP95Ms ?? '—'} мс`);
console.log(`RSS по health:         ${after.load?.rssMb ?? '—'} МБ`);
console.log(`некорректных сообщений: ${after.metrics.invalidMessages - before.metrics.invalidMessages}`);
console.log(`сбоев отправки:         ${after.metrics.socketSendFailures - before.metrics.socketSendFailures}`);
console.log(`ошибок обработчика:     ${after.metrics.handlerErrors - before.metrics.handlerErrors}`);

for (const [host, guest] of rooms) {
  host.close();
  guest.close();
}
