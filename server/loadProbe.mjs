// Нагрузочная проба: сколько процессорного времени и памяти ест сервер под игроками.
//
// Не тест — инструмент. Отвечает на вопрос, который иначе решается на глаз: хватит ли ядра и
// гигабайта на арендованном VPS, и с какого числа игроков начинать беспокоиться.
//
// Клиенты настоящие: подключаются по WebSocket, создают кооп-комнаты, стартуют матчи и шлют
// позиции с той же частотой, что и браузер — раз в 66 мс. Никаких заглушек: сервер проходит
// полный путь от валидации схемы до рассылки снапшотов.
//
//   npm run load                 # 12 комнат (24 игрока), 20 секунд
//   node server/loadProbe.mjs 8 30
//
// Ограничение: сервер не пускает больше 24 соединений с одного адреса, поэтому с localhost
// больше 12 комнат не поднять. Для большего запускайте пробу с нескольких машин.

import { WebSocket } from 'ws';

const URL = process.env.WOBBLE_URL || 'ws://127.0.0.1:3000/ws';
const ROOMS = Number(process.argv[2] || 12);
const SECONDS = Number(process.argv[3] || 20);

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Client {
  constructor() {
    this.ws = new WebSocket(URL);
    this.waiters = [];
    this.matchId = null;
    this.spec = null;
    this.ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'hello') this.id = m.id;
      if (m.type === 'start') {
        this.matchId = m.matchId;
        this.spec = m.spec;
        this.startedAt = m.at;
      }
      for (const w of [...this.waiters])
        if (w.type === m.type && w.ok(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(m);
        }
    });
  }
  wait(type, ok = () => true, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ' + type)), ms);
      this.waiters.push({ type, ok, resolve: v => (clearTimeout(t), resolve(v)) });
    });
  }
  send(type, data = {}) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type, ...data }));
  }
  close() {
    this.ws.close();
  }
}

const rooms = [];
console.log(`поднимаю ${ROOMS} кооп-комнат (${ROOMS * 2} игроков)…`);
for (let i = 0; i < ROOMS; i++) {
  const host = new Client();
  const guest = new Client();
  await Promise.all([host.wait('hello'), guest.wait('hello')]);
  host.send('create', { name: `H${i}`, mode: 'coop' });
  const lobby = await host.wait('lobby', m => m.players.length === 1);
  guest.send('join', { name: `G${i}`, code: lobby.code });
  await host.wait('lobby', m => m.players.length === 2);
  host.send('ready', { ready: true });
  guest.send('ready', { ready: true });
  await host.wait('lobby', m => m.players.every(p => p.ready));
  host.send('start');
  await Promise.all([host.wait('start'), guest.wait('start')]);
  rooms.push([host, guest]);
}

// Ждём конца отсчёта, иначе позиции сервер игнорирует.
await sleep(3200);

const before = await fetch('http://127.0.0.1:3000/health').then(r => r.json());
const cpu0 = process.hrtime.bigint();
const stat0 = await pidStat();

console.log(`шлю позиции ${SECONDS} с…`);
let z = 10;
const timer = setInterval(() => {
  z -= 0.4;
  if (z < -180) z = 10;
  for (const [a, b] of rooms)
    for (const c of [a, b])
      c.send('state', {
        matchId: c.matchId,
        state: { x: 0, y: 1.2, z, ry: 0, vx: 0, vz: -7, state: 'ground' }
      });
}, 66);

await sleep(SECONDS * 1000);
clearInterval(timer);

const stat1 = await pidStat();
const after = await fetch('http://127.0.0.1:3000/health').then(r => r.json());
const wall = Number(process.hrtime.bigint() - cpu0) / 1e9;

console.log('\n--- РЕЗУЛЬТАТ ---');
console.log(`игроков онлайн:        ${after.players}`);
console.log(`комнат:                ${after.rooms}`);
console.log(`память сервера (RSS):  ${stat1.rssMb.toFixed(1)} МБ`);
console.log(`процессор:             ${(((stat1.cpu - stat0.cpu) / wall) * 100).toFixed(1)} % одного ядра`);
console.log(`некорректных сообщений: ${after.metrics.invalidMessages - before.metrics.invalidMessages}`);
console.log(`сбоев отправки:         ${after.metrics.socketSendFailures}`);
console.log(`ошибок обработчика:     ${after.metrics.handlerErrors}`);

for (const [a, b] of rooms) {
  a.close();
  b.close();
}
process.exit(0);

async function pidStat() {
  const { execSync } = await import('node:child_process');
  const pid = execSync('pgrep -f "^node server/index.js" | head -1').toString().trim();
  const stat = execSync(`cat /proc/${pid}/stat`).toString().split(' ');
  const utime = Number(stat[13]);
  const stime = Number(stat[14]);
  const hz = 100;
  const rss = Number(execSync(`awk '/VmRSS/{print $2}' /proc/${pid}/status`).toString().trim());
  return { cpu: (utime + stime) / hz, rssMb: rss / 1024 };
}
