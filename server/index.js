const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  PLAYER_COLORS,
  safeName,
  safeDifficulty,
  randomSeed,
  createCourseSpec,
  spawnFor,
  validateState,
  canFinish,
  leaderboard
} = require('./gameRules');

const app = express();
const clientPath = path.join(__dirname, '..', 'client');
const sharedPath = path.join(__dirname, '..', 'shared');

app.disable('x-powered-by');
app.use(
  express.static(clientPath, {
    setHeaders: (res, file) => {
      if (/\.(js|css)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }
  })
);
// Общие с клиентом правила трассы: один и тот же файл исполняется и на сервере, и в браузере.
app.use('/shared', express.static(sharedPath, { maxAge: '5m' }));
app.use(
  '/vendor',
  express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build'), {
    maxAge: '1d',
    immutable: true
  })
);
// Дополнения Three.js (постобработка и её шейдеры). Они импортируют 'three' как голое имя,
// поэтому в client/index.html объявлен import map — иначе браузер загрузил бы вторую копию движка.
app.use(
  '/vendor/addons',
  express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm'), {
    maxAge: '1d',
    immutable: true
  })
);

const rooms = new Map();

// Сессии для переподключения: токен → место игрока в комнате. Живут недолго — ровно столько,
// сколько мы готовы держать слот за отвалившимся игроком.
const sessions = new Map();

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    service: 'wobble-rush-3d',
    version: '2.1.0',
    rooms: rooms.size,
    players: [...rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
    sessions: sessions.size,
    uptime: Math.round(process.uptime())
  })
);

// Отдаём index.html только для навигационных запросов. Раньше сюда попадали и запросы к
// несуществующим ассетам — браузер получал HTML вместо 404 и молча ломался на разборе.
app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(clientPath, 'index.html'));
});

const server = http.createServer(app);

const MAX_PLAYERS = 16;
const MAX_ROOMS = 500;
const ROOM_TTL = 45 * 60 * 1000;

// Сколько держим слот игрока после обрыва связи, прежде чем выкинуть его из комнаты.
const RECONNECT_GRACE_MS = 30 * 1000;
const SESSION_TTL_MS = 60 * 1000;

// Ограничение частоты создания и входа в комнаты с одного адреса.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 40;
const rateLimits = new Map();

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = rateLimits.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW_MS) {
    rateLimits.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// Проверка источника при апгрейде сокета: без неё игру можно встроить на чужой сайт и гонять
// наш сервер оттуда. Запросы без заголовка Origin (Node-клиенты, тесты, мобильные обёртки)
// пропускаем — Origin ставят только браузеры.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function originAllowed(origin, host) {
  if (!origin) return true;
  if (allowedOrigins.length) return allowedOrigins.includes(origin);
  try {
    const parsed = new URL(origin);
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return true;
    return !!host && parsed.host === host;
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 4096,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host)
});

const send = (ws, data) => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
};

// Сериализуем полезную нагрузку один раз на всю комнату. Раньше JSON.stringify вызывался на каждого
// получателя: при 16 игроках и 15 рассылках в секунду это 240 сериализаций одного и того же объекта.
const broadcast = (room, data) => {
  const payload = JSON.stringify(data);
  for (const player of room.players.values()) {
    if (player.ws && player.ws.readyState === WebSocket.OPEN) player.ws.send(payload);
  }
};

const roomCode = () => {
  let value;
  do
    value = crypto
      .randomBytes(3)
      .toString('base64url')
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 4)
      .toUpperCase()
      .padEnd(4, 'X');
  while (rooms.has(value));
  return value;
};

const publicPlayer = ({ id, name, ready, finished, time, rematch, color, disconnectedAt }) => ({
  id,
  name,
  ready: !!ready,
  finished: !!finished,
  time: time ?? null,
  rematch: !!rematch,
  color,
  online: !disconnectedAt
});

const lobbyPayload = room => ({
  type: 'lobby',
  code: room.code,
  host: room.host,
  started: room.started,
  seed: room.spec.seed,
  difficulty: room.spec.difficulty,
  players: [...room.players.values()].map(publicPlayer)
});

const emitLobby = room => broadcast(room, lobbyPayload(room));

function resetLobby(room, { newSeed = false } = {}) {
  room.started = false;
  room.startedAt = null;
  room.updatedAt = Date.now();
  if (newSeed) room.spec = createCourseSpec(randomSeed(), room.spec.difficulty);
  for (const player of room.players.values())
    Object.assign(player, {
      ready: false,
      finished: false,
      time: null,
      rematch: false,
      checkpoint: 0,
      last: null,
      lastAt: 0,
      returned: false
    });
  emitLobby(room);
}

function dropPlayer(room, playerId) {
  room.players.delete(playerId);
  room.updatedAt = Date.now();
  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }
  // Хост ушёл — передаём права первому оставшемуся, предпочитая тех, кто на связи.
  if (room.host === playerId) {
    const online = [...room.players.values()].find(item => !item.disconnectedAt);
    room.host = (online || room.players.values().next().value).id;
  }
  emitLobby(room);
}

function leave(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  ws.room = null;
  if (ws.token) {
    sessions.delete(ws.token);
    ws.token = null;
  }
  if (!room) return;
  dropPlayer(room, ws.id);
}

// Обрыв связи — не то же самое, что выход. Слот держится RECONNECT_GRACE_MS, чтобы игрок,
// у которого моргнул wi-fi, вернулся в тот же забег, а не обнаружил пустое меню.
function handleDisconnect(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  const player = room.players.get(ws.id);
  if (!player) return;
  player.ws = null;
  player.disconnectedAt = Date.now();
  room.updatedAt = Date.now();
  if (ws.token) {
    const session = sessions.get(ws.token);
    if (session) session.expiresAt = Date.now() + SESSION_TTL_MS;
  }
  emitLobby(room);
}

function addPlayer(room, ws, name) {
  ws.room = room.code;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  room.players.set(ws.id, {
    id: ws.id,
    name: safeName(name),
    color,
    ready: false,
    finished: false,
    time: null,
    rematch: false,
    checkpoint: 0,
    last: null,
    lastAt: 0,
    disconnectedAt: null,
    ws
  });
  sessions.set(ws.token, {
    playerId: ws.id,
    roomCode: room.code,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  room.updatedAt = Date.now();
  emitLobby(room);
}

// Возврат в комнату по токену прошлой сессии.
function resume(ws, token) {
  const session = sessions.get(token);
  if (!session) return false;
  const room = rooms.get(session.roomCode);
  if (!room) {
    sessions.delete(token);
    return false;
  }
  const player = room.players.get(session.playerId);
  if (!player) {
    sessions.delete(token);
    return false;
  }

  // Занимаем прежнее место: идентификатор игрока сохраняется, поэтому напарник не увидит,
  // что кто-то «вышел и зашёл».
  sessions.delete(ws.token);
  ws.id = session.playerId;
  ws.token = token;
  ws.room = room.code;
  player.ws = ws;
  player.disconnectedAt = null;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  room.updatedAt = Date.now();

  send(ws, { type: 'resumed', id: ws.id, serverTime: Date.now() });
  if (room.started) send(ws, { type: 'start', at: room.startedAt, spec: room.spec });
  emitLobby(room);
  return true;
}

wss.on('connection', (ws, req) => {
  ws.id = crypto.randomBytes(8).toString('hex');
  ws.token = crypto.randomBytes(16).toString('hex');
  ws.ip = req.socket.remoteAddress;
  ws.isAlive = true;

  send(ws, { type: 'hello', id: ws.id, token: ws.token, serverTime: Date.now() });
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return send(ws, { type: 'error', message: 'Некорректное сетевое сообщение.' });
    }
    if (!message || typeof message.type !== 'string') return;

    // Отметка времени сервера в каждом pong — по ней клиент оценивает расхождение часов.
    if (message.type === 'ping') return send(ws, { type: 'pong', at: message.at, serverTime: Date.now() });
    if (message.type === 'leave') return leave(ws);

    if (message.type === 'resume') {
      if (typeof message.token === 'string' && resume(ws, message.token)) return;
      return send(ws, { type: 'resumeFailed' });
    }

    if (message.type === 'create') {
      if (rateLimited(ws.ip))
        return send(ws, { type: 'error', message: 'Слишком много запросов. Подождите минуту.' });
      leave(ws);
      if (rooms.size >= MAX_ROOMS)
        return send(ws, { type: 'error', message: 'Сервис перегружен. Попробуйте позже.' });
      const code = roomCode();
      const spec = createCourseSpec(randomSeed(), safeDifficulty(message.difficulty));
      const room = {
        code,
        host: ws.id,
        started: false,
        startedAt: null,
        spec,
        players: new Map(),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      rooms.set(code, room);
      return addPlayer(room, ws, message.name);
    }

    if (message.type === 'join') {
      if (rateLimited(ws.ip))
        return send(ws, { type: 'error', message: 'Слишком много запросов. Подождите минуту.' });
      leave(ws);
      const room = rooms.get(
        String(message.code || '')
          .trim()
          .toUpperCase()
      );
      if (!room) return send(ws, { type: 'error', message: 'Комната не найдена. Проверьте код.' });
      if (room.started) return send(ws, { type: 'error', message: 'Этот забег уже начался.' });
      if (room.players.size >= MAX_PLAYERS)
        return send(ws, { type: 'error', message: 'В комнате уже 16 игроков.' });
      return addPlayer(room, ws, message.name);
    }

    const room = rooms.get(ws.room);
    const player = room?.players.get(ws.id);
    if (!room || !player)
      return send(ws, { type: 'error', message: 'Сначала создайте комнату или войдите в неё.' });
    room.updatedAt = Date.now();

    if (message.type === 'ready' && !room.started) {
      player.ready = !!message.ready;
      return emitLobby(room);
    }

    if (message.type === 'configure' && !room.started && room.host === ws.id) {
      room.spec = createCourseSpec(randomSeed(), safeDifficulty(message.difficulty));
      for (const item of room.players.values()) item.ready = false;
      return emitLobby(room);
    }

    if (message.type === 'start') {
      if (room.host !== ws.id) return send(ws, { type: 'error', message: 'Забег может начать только хост.' });
      if (room.started) return;
      if (!room.players.size || ![...room.players.values()].every(item => item.ready))
        return send(ws, { type: 'error', message: 'Все игроки должны быть готовы.' });
      room.started = true;
      room.startedAt = Date.now() + 2800;
      for (const item of room.players.values())
        Object.assign(item, {
          finished: false,
          time: null,
          checkpoint: 0,
          last: { ...room.spec.start, ry: 0, vx: 0, vz: 0, state: 'ground', checkpoint: 0 },
          lastAt: room.startedAt,
          rematch: false,
          returned: false
        });
      return broadcast(room, { type: 'start', at: room.startedAt, spec: room.spec });
    }

    if (message.type === 'state' && room.started && Date.now() >= room.startedAt - 300) {
      const now = Date.now();
      if (now - (player.receivedAt || 0) < 32) return;
      player.receivedAt = now;
      const result = validateState(player, message.state, room.spec, now);
      if (!result.ok) {
        if (result.reason === 'speed')
          send(ws, { type: 'correction', position: result.position, reason: 'movement' });
        return;
      }
      player.last = { ...result.state, id: player.id };
      player.lastAt = now;
      player.checkpoint = result.checkpoint;
      return;
    }

    if (message.type === 'respawn' && room.started) {
      const now = Date.now();
      if (now - (player.lastRespawn || 0) < 450) return;
      player.lastRespawn = now;
      const position = spawnFor(room.spec, player.checkpoint);
      player.last = {
        ...position,
        ry: 0,
        vx: 0,
        vz: 0,
        state: 'air',
        checkpoint: player.checkpoint,
        id: player.id
      };
      player.lastAt = now;
      return send(ws, { type: 'correction', position, reason: 'respawn' });
    }

    if (message.type === 'finish' && room.started) {
      if (!canFinish(player, room.spec))
        return send(ws, {
          type: 'correction',
          position: player.last || spawnFor(room.spec, player.checkpoint),
          reason: 'finish-validation'
        });
      player.finished = true;
      player.time = Math.max(0, Date.now() - room.startedAt);
      const board = leaderboard(room);
      return broadcast(room, { type: 'finish', id: player.id, time: player.time, board });
    }

    if (message.type === 'rematch' && room.started) {
      player.rematch = true;
      if (room.host === player.id || [...room.players.values()].every(item => item.rematch))
        return resetLobby(room);
      return emitLobby(room);
    }

    if (message.type === 'returnLobby' && room.started) {
      player.returned = true;
      if (room.host === player.id || [...room.players.values()].every(item => item.finished || item.returned))
        return resetLobby(room);
      return send(ws, lobbyPayload(room));
    }
  });

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => handleDisconnect(ws));
});

const snapshotTimer = setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.started) continue;
    const players = [...room.players.values()]
      .filter(player => player.last)
      .map(player => ({
        ...player.last,
        id: player.id,
        checkpoint: player.checkpoint,
        finished: player.finished
      }));
    broadcast(room, { type: 'snapshot', serverTime: Date.now(), players, finished: leaderboard(room) });
  }
}, 66);
snapshotTimer.unref();

const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }

  const now = Date.now();

  // Игроки, не вернувшиеся за отведённое время, освобождают слот.
  for (const room of [...rooms.values()]) {
    for (const player of [...room.players.values()]) {
      if (player.disconnectedAt && now - player.disconnectedAt > RECONNECT_GRACE_MS) {
        dropPlayer(room, player.id);
      }
    }
  }

  for (const [token, session] of sessions) if (now > session.expiresAt) sessions.delete(token);
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) rooms.delete(code);
  for (const [ip, entry] of rateLimits) if (now - entry.start > RATE_LIMIT_WINDOW_MS) rateLimits.delete(ip);
}, 15000);
heartbeatTimer.unref();

const port = process.env.PORT || 3000;
if (require.main === module)
  server.listen(port, () => console.log(`Wobble Rush 3D на http://localhost:${port}`));

module.exports = { app, server, rooms, sessions, leave, resetLobby, originAllowed };
