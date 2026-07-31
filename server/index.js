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

const {
  PROTOCOL_VERSION,
  C2S,
  S2C,
  ERROR_CODES,
  ROOM_STATE,
  GAME_MODE,
  ALLOWED_IN_STATE,
  canTransition,
  MAX_MESSAGE_BYTES,
  VIOLATION_DISCONNECT_THRESHOLD,
  VIOLATION_DECAY_PER_MINUTE
} = require('../shared/protocol.js');

const { validateMessage, RateLimiter, ViolationTracker } = require('../shared/validation.js');
const { coopSpec, coopSpawnFor, COOP_CHAPTER_IDS } = require('../shared/coopChapters.js');
const { validateCoopEvent, markDowned, autoRevive, coopComplete } = require('./coopRules');

const app = express();
const clientPath = path.join(__dirname, '..', 'client');
const sharedPath = path.join(__dirname, '..', 'shared');

app.disable('x-powered-by');

// Хеш встроенного import map для политики безопасности.
//
// Import map обязан быть встроенным в HTML — внешние карты браузеры не поддерживают. При строгой
// политике script-src 'self' такой скрипт блокируется, и игра просто не загружается: спецификатор
// 'three' перестаёт разрешаться. Разрешать 'unsafe-inline' ради этого нельзя — это открыло бы
// исполнение любого встроенного скрипта. Поэтому считаем хеш содержимого при старте: политика
// остаётся строгой и автоматически подстраивается, если карта изменится.
function inlineScriptHashes() {
  try {
    const html = require('fs').readFileSync(path.join(clientPath, 'index.html'), 'utf8');
    const hashes = [];
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
      const body = match[1];
      if (!body.trim()) continue;
      hashes.push(`'sha256-${crypto.createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    return hashes;
  } catch {
    return [];
  }
}
const INLINE_SCRIPT_HASHES = inlineScriptHashes();

// Заголовки безопасности (ТЗ 13.6). Игра целиком самодостаточна: внешних скриптов, шрифтов и
// стилей нет, поэтому политика может быть строгой без риска что-то сломать.
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      ["script-src 'self'", ...INLINE_SCRIPT_HASHES].join(' '),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'none'"
    ].join('; ')
  );
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

// Код клиента и общие с сервером правила НЕ кэшируются надолго.
//
// Имена файлов без хеша, а протокол между клиентом и сервером обязан совпадать. Пятиминутный
// кэш означал, что после деплоя часть игроков несколько минут говорит со свежим сервером старым
// клиентом: сообщения не сходятся по схеме, и сбои выглядят случайными. Долгий immutable-кэш
// оставлен только для vendor-файлов, чьи версии меняются вместе с именем пакета.
const NO_CACHE = 'no-cache, must-revalidate';
app.use(
  express.static(clientPath, {
    setHeaders: (res, file) => {
      if (/\.(js|css|html)$/.test(file)) res.setHeader('Cache-Control', NO_CACHE);
    }
  })
);
// Общие с клиентом правила: один и тот же файл исполняется и на сервере, и в браузере.
app.use(
  '/shared',
  express.static(sharedPath, {
    setHeaders: res => res.setHeader('Cache-Control', NO_CACHE)
  })
);
app.use(
  '/vendor',
  express.static(path.join(__dirname, '..', 'node_modules', 'three', 'build'), {
    maxAge: '1d',
    immutable: true
  })
);
// Дополнения Three.js (постобработка). Они импортируют 'three' как голое имя, поэтому в
// client/index.html объявлен import map — иначе браузер загрузил бы вторую копию движка.
app.use(
  '/vendor/addons',
  express.static(path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm'), {
    maxAge: '1d',
    immutable: true
  })
);

const rooms = new Map();

// Сессии для переподключения: токен → место игрока в комнате.
const sessions = new Map();

const metrics = {
  connections: 0,
  matchesStarted: 0,
  matchesFinished: 0,
  invalidMessages: 0,
  disconnectsForAbuse: 0,
  reconnects: 0,
  // Наблюдаемость сетевых сбоев. Без этих счётчиков «иногда ломается» остаётся догадкой:
  // отклонённый финиш и отброшенный хвостовой пакет выглядят для игрока одинаково, а чинятся
  // по-разному.
  finishRejected: 0,
  latePacketsDropped: 0,
  resumeSucceeded: 0,
  resumeFailed: 0,
  socketSendFailures: 0,
  handlerErrors: 0
};

const health = () => ({
  ok: true,
  service: 'wobble-rush-3d',
  version: '2.2.0',
  protocolVersion: PROTOCOL_VERSION,
  rooms: rooms.size,
  players: [...rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
  sessions: sessions.size,
  uptime: Math.round(process.uptime()),
  metrics
});

app.get('/health', (_req, res) => res.json(health()));
// Разделение live и ready (ТЗ 15.3): live отвечает, пока процесс жив, ready — пока сокет-сервер
// действительно принимает подключения. Балансировщику нужны разные ответы на эти вопросы.
app.get('/health/live', (_req, res) => res.json({ ok: true }));
app.get('/health/ready', (_req, res) => {
  const ready = !!wss && server.listening;
  res.status(ready ? 200 : 503).json({ ok: ready, ...health() });
});

// Отдаём index.html только для навигационных запросов. Раньше сюда попадали и запросы к
// несуществующим ассетам — браузер получал HTML вместо 404 и молча ломался на разборе.
app.get('*', (req, res, next) => {
  if (path.extname(req.path)) return next();
  res.setHeader('Cache-Control', NO_CACHE);
  res.sendFile(path.join(clientPath, 'index.html'));
});

const server = http.createServer(app);

// Вместимость зависит от режима: кооп — строго на двоих, гонка — до шестнадцати.
const MAX_PLAYERS = { [GAME_MODE.RACE]: 16, [GAME_MODE.COOP]: 2 };
const MAX_ROOMS = 500;
const ROOM_TTL = 45 * 60 * 1000;
const COUNTDOWN_MS = 2800;

// Сколько держим слот игрока после обрыва связи, прежде чем выкинуть его из комнаты.
const RECONNECT_GRACE_MS = 30 * 1000;
const SESSION_TTL_MS = 60 * 1000;

// Ограничение операций с комнатами по адресу — поверх ограничения по типам сообщений,
// которое действует на каждое соединение отдельно.
const IP_WINDOW_MS = 60 * 1000;
const IP_MAX_ROOM_OPS = 40;
const MAX_CONNECTIONS_PER_IP = 24;
const ipRoomOps = new Map();
const ipConnections = new Map();

function ipRateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const entry = ipRoomOps.get(ip);
  if (!entry || now - entry.start > IP_WINDOW_MS) {
    ipRoomOps.set(ip, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > IP_MAX_ROOM_OPS;
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
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
  verifyClient: ({ origin, req }) => originAllowed(origin, req.headers.host)
});

// Типы, чей хвост после окончания матча надо гасить молча, а не считать нарушением протокола.
// Все они относятся к идущему забегу и после RESULTS не значат ничего.
const MATCH_TRAILING_TYPES = new Set([
  C2S.PLAYER_STATE,
  C2S.COOP_EVENT,
  C2S.RESPAWN,
  C2S.FINISH
]);

// Порог, после которого соединение считается захлебнувшимся. При медленном канале очередь
// отправки растёт неограниченно и съедает память сервера; лучше отбросить устаревший снапшот.
const MAX_BUFFERED_BYTES = 512 * 1024;

const canSend = ws => ws && ws.readyState === WebSocket.OPEN;

// Отправка в сокет, которая не роняет процесс.
//
// Между проверкой readyState и самим send() соединение может закрыться — с точки зрения Node это
// разные тики. Тогда `ws.send()` бросает исключение, и без перехвата оно уходит наверх: один
// оборвавшийся игрок гасит сервер целиком вместе со всеми чужими комнатами. Ошибка доставки —
// нормальное событие сети, а не повод падать.
function socketSend(ws, payload) {
  if (!canSend(ws)) return false;
  try {
    ws.send(payload, error => {
      if (!error) return;
      metrics.socketSendFailures++;
      log('warn', 'socket_send_failed', { playerId: ws.id, message: error.message });
      try {
        ws.terminate();
      } catch {
        // Сокет уже мёртв — этого мы и добивались.
      }
    });
    return true;
  } catch (error) {
    metrics.socketSendFailures++;
    log('warn', 'socket_send_threw', { playerId: ws.id, message: error.message });
    return false;
  }
}

const send = (ws, data) => socketSend(ws, JSON.stringify(data));

const sendError = (ws, code, message, recoverable = true) =>
  send(ws, { type: S2C.ERROR, code, message, recoverable });

// Сериализуем полезную нагрузку один раз на всю комнату. Раньше JSON.stringify вызывался на каждого
// получателя: при 16 игроках и 15 рассылках в секунду это 240 сериализаций одного и того же объекта.
const broadcast = (room, data, { dropIfCongested = false } = {}) => {
  const payload = JSON.stringify(data);
  for (const player of room.players.values()) {
    const ws = player.ws;
    if (!canSend(ws)) continue;
    // Снапшоты можно пропускать: следующий придёт через 66 мс и полностью заменит этот.
    // Сообщения о состоянии комнаты пропускать нельзя — они не повторяются.
    if (dropIfCongested && ws.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    socketSend(ws, payload);
  }
};

const roomCode = () => {
  let value;
  do
    value = crypto
      .randomBytes(4)
      .toString('base64url')
      .replace(/[^A-Z0-9]/gi, '')
      .slice(0, 5)
      .toUpperCase()
      .padEnd(5, 'X');
  while (rooms.has(value));
  return value;
};

// Переход состояния комнаты. Недопустимые переходы не выполняются молча — это баг, и он должен
// быть заметен в логах, а не превращаться в тихо разъехавшееся состояние.
function setRoomState(room, next) {
  if (room.state === next) return true;
  if (!canTransition(room.state, next)) {
    log('warn', 'invalid_room_transition', { roomId: room.code, from: room.state, to: next });
    return false;
  }
  room.state = next;
  room.updatedAt = Date.now();
  return true;
}

// Структурные логи (ТЗ 15.1). Токены и другие чувствительные поля сюда не попадают.
function log(level, event, fields = {}) {
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

const publicPlayer = ({
  id,
  name,
  ready,
  finished,
  time,
  rematch,
  returned,
  color,
  disconnectedAt,
  slot,
  away
}) => ({
  id,
  name,
  ready: !!ready,
  finished: !!finished,
  time: time ?? null,
  rematch: !!rematch,
  // Кто уже нажал «вернуться в лобби»: на экране результатов это надо показывать так же,
  // как голоса за реванш, иначе нажавший не понимает, ждут его или он ждёт.
  returned: !!returned,
  color,
  slot: slot ?? 0,
  online: !disconnectedAt,
  // `online` и `away` — разные вещи. Первое означает «связь оборвалась», второе — «игра свёрнута,
  // человек рядом». Напарнику важно различать их: в первом случае ждать бессмысленно.
  away: !!away
});

const lobbyPayload = room => ({
  type: S2C.ROOM_STATE,
  code: room.code,
  host: room.host,
  state: room.state,
  mode: room.mode,
  chapterId: room.chapterId || null,
  matchId: room.matchId,
  // Оставлено для совместимости с текущим клиентом: булево «идёт ли забег».
  started: room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING,
  seed: room.spec.seed,
  difficulty: room.spec.difficulty,
  maxPlayers: MAX_PLAYERS[room.mode],
  players: [...room.players.values()].map(publicPlayer)
});

const emitLobby = room => broadcast(room, lobbyPayload(room));

// Ролей больше нет — сервер раздаёт только «место» (0 или 1) по порядку входа. От него зависит
// лишь точка появления: два персонажа не должны стоять в одной координате, иначе на первом же
// кадре они выталкивают друг друга.
function assignSlots(room) {
  const ordered = [...room.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  ordered.forEach((player, index) => {
    player.slot = index;
  });
}

function resetLobby(room, { newSeed = false } = {}) {
  setRoomState(room, ROOM_STATE.LOBBY);
  room.startedAt = null;
  room.matchId = null;
  room.firstFinishAt = null;
  room.results = null;
  room.unranked = null;
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
  assignSlots(room);
  emitLobby(room);
}

function dropPlayer(room, playerId) {
  room.players.delete(playerId);
  room.updatedAt = Date.now();
  if (!room.players.size) {
    setRoomState(room, ROOM_STATE.CLOSING);
    rooms.delete(room.code);
    log('info', 'room_closed', { roomId: room.code });
    return;
  }

  // Миграция хоста детерминирована (ТЗ 3.6): сначала те, кто на связи, среди них — вошедший раньше.
  if (room.host === playerId) {
    const previousHostId = room.host;
    const candidates = [...room.players.values()].sort((a, b) => {
      if (!!a.disconnectedAt !== !!b.disconnectedAt) return a.disconnectedAt ? 1 : -1;
      return a.joinOrder - b.joinOrder;
    });
    room.host = candidates[0].id;
    broadcast(room, { type: S2C.HOST_CHANGED, previousHostId, hostId: room.host });
    log('info', 'host_migrated', { roomId: room.code, hostId: room.host });
  }

  assignSlots(room);
  emitLobby(room);
}

function leave(ws) {
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  ws.room = null;
  if (room && (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING))
    markUnranked(room, 'left');
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
  // `close` и `error` приходят оба, и почти всегда подряд. Без этого флага счётчик подключений
  // с адреса уменьшался дважды за один разрыв и со временем уходил в минус, раздавая лишние
  // соединения одному клиенту, — а отметка времени обрыва переписывалась второй раз.
  if (ws.disconnectHandled) return;
  ws.disconnectHandled = true;

  const ip = ws.ip;
  if (ip && ipConnections.has(ip)) {
    const left = ipConnections.get(ip) - 1;
    if (left > 0) ipConnections.set(ip, left);
    else ipConnections.delete(ip);
  }

  if (!ws.room) return;
  const room = rooms.get(ws.room);
  if (!room) return;
  const player = room.players.get(ws.id);
  if (!player) return;
  // Сокет уже заменён: игрок вернулся по resume с нового соединения, а это — запоздавшее
  // закрытие старого. Пометить игрока отключённым здесь значило бы выкинуть того, кто только
  // что успешно вернулся.
  if (player.ws !== ws) {
    log('info', 'stale_socket_closed', { roomId: room.code, playerId: ws.id });
    return;
  }
  player.ws = null;
  player.disconnectedAt = Date.now();
  room.updatedAt = Date.now();
  // Обрыв посреди забега снимает зачёт. Раньше кооп молча превращался в одиночное прохождение:
  // оставшийся доходил до финиша, получал время — и не знал, что это время уже ничего не значит,
  // потому что половину главы за напарника не проходил никто. Честнее сказать это вслух.
  if (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)
    markUnranked(room, 'disconnect');
  if (ws.token) {
    const session = sessions.get(ws.token);
    if (session) session.expiresAt = Date.now() + SESSION_TTL_MS;
  }
  log('info', 'player_disconnected', { roomId: room.code, playerId: ws.id });
  emitLobby(room);
}

function addPlayer(room, ws, name) {
  ws.room = room.code;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  room.players.set(ws.id, {
    id: ws.id,
    name: safeName(name),
    color,
    slot: 0,
    joinOrder: room.nextJoinOrder++,
    ready: false,
    finished: false,
    time: null,
    rematch: false,
    checkpoint: 0,
    last: null,
    lastAt: 0,
    disconnectedAt: null,
    away: false,
    ws
  });
  sessions.set(ws.token, {
    playerId: ws.id,
    roomCode: room.code,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  room.updatedAt = Date.now();
  assignSlots(room);
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

  // Прежний сокет мог ещё не закрыться — так бывает, когда клиент переподключился раньше, чем
  // сервер заметил обрыв. Отвязываем его от комнаты ДО закрытия: иначе его `close` придёт уже
  // после подмены и попытается пометить вернувшегося игрока отключённым.
  const previousWs = player.ws;
  player.ws = ws;
  player.disconnectedAt = null;
  // `disconnectHandled` здесь НЕ ставим: закрытие старого сокета всё ещё должно вернуть
  // счётчик подключений с адреса. Отвязки от комнаты достаточно — до игрока обработчик
  // после неё не доходит.
  if (previousWs && previousWs !== ws) {
    previousWs.room = null;
    try {
      previousWs.close(4001, 'Session resumed elsewhere');
    } catch {
      // Уже закрыт — ровно то состояние, которого мы хотели.
    }
  }
  // Раз соединение восстанавливается, вкладка снова на экране: иначе флаг «отошёл» пережил бы
  // возвращение и напарник продолжал бы ждать уже вернувшегося игрока.
  player.away = false;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  room.updatedAt = Date.now();
  metrics.reconnects++;
  metrics.resumeSucceeded++;

  // Токен возвращается вместе с ответом. Клиенту он нужен: при подключении сервер выдал ему
  // новый временный токен в `hello`, и без этой строки клиент сохранил бы у себя токен,
  // который сервер только что удалил, — следующий обрыв уже не восстановился бы.
  send(ws, { type: S2C.RESUMED, id: ws.id, token: ws.token, serverTime: Date.now() });
  if (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING) {
    send(ws, {
      type: S2C.MATCH_START,
      at: room.startedAt,
      matchId: room.matchId,
      mode: room.mode,
      spec: room.spec,
      slots: Object.fromEntries([...room.players.values()].map(item => [item.id, item.slot]))
    });
  }
  // Вернулся на экран результатов — верни и сами результаты. Иначе игрок, у которого связь
  // моргнула сразу после финиша, попадал в комнату без карточки: голосовать не за что,
  // времени не видно, и единственный выход — выйти из игры.
  if (room.state === ROOM_STATE.RESULTS && room.results) send(ws, room.results);
  emitLobby(room);
  log('info', 'player_resumed', { roomId: room.code, playerId: ws.id });
  return true;
}

// Снимает зачёт с текущего забега и говорит об этом оставшимся — один раз за матч.
//
// Кооп после обрыва не прерывается: оставшийся игрок доигрывает главу (иначе он застрял бы
// навсегда), но результат такого прохождения не рекорд — половину препятствий проходил не тот,
// кто их задумывался проходить, а автоподъём заменял напарника. Отметка `unranked` уезжает
// вместе с результатами и в личные рекорды не пишется.
function markUnranked(room, reason) {
  if (room.unranked) return false;
  room.unranked = reason;
  broadcast(room, { type: S2C.UNRANKED, matchId: room.matchId, reason });
  log('info', 'match_unranked', { roomId: room.code, matchId: room.matchId, reason });
  return true;
}

// Матч завершается, когда дошли все, кто ещё на связи. В коопе это обязательное условие:
// глава считается пройденной только вдвоём.
function checkMatchEnd(room) {
  if (room.state !== ROOM_STATE.PLAYING) return;
  if (room.mode === GAME_MODE.COOP) {
    // Глава засчитывается, только когда дошли оба: одиночный финиш матч не завершает.
    if (!coopComplete(room)) return;
    return finishMatch(room);
  }
  const active = [...room.players.values()].filter(player => !player.disconnectedAt);
  if (!active.length || !active.every(player => player.finished)) return;
  finishMatch(room);
}

function finishMatch(room) {
  if (!setRoomState(room, ROOM_STATE.RESULTS)) return;
  metrics.matchesFinished++;
  const board = leaderboard(room);
  const coopTime = board.length ? Math.max(...board.map(entry => entry.time)) : null;
  // Итоги сохраняются, а не только рассылаются: их надо будет отдать заново тому, кто вернулся
  // по resume уже на экране результатов.
  room.results = {
    type: S2C.MATCH_RESULTS,
    matchId: room.matchId,
    mode: room.mode,
    board,
    // В коопе засчитывается время последнего дошедшего: команда финиширует вместе.
    coopTime,
    unranked: room.unranked || null
  };
  broadcast(room, room.results);
  // Сразу за итогами — состояние комнаты. Без него клиент остаётся с составом, снятым ещё до
  // старта: счётчик голосов на экране результатов не с чего было бы нарисовать до первого голоса.
  emitLobby(room);
  log('info', 'match_finished', { roomId: room.code, matchId: room.matchId, players: board.length });
}

// Адрес клиента с учётом обратного прокси.
//
// За Nginx `req.socket.remoteAddress` — это адрес самого Nginx, один на всех. Тогда лимиты
// «24 соединения» и «40 операций с комнатами в минуту» делятся между ВСЕМИ игроками сразу, и при
// нескольких десятках человек отказы начинают сыпаться на случайных людей. Заголовку доверяем
// только по явному разрешению: если Node смотрит в интернет напрямую, его подделает кто угодно.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  const openFromIp = (ipConnections.get(ip) || 0) + 1;
  if (openFromIp > MAX_CONNECTIONS_PER_IP) {
    sendError(ws, ERROR_CODES.RATE_LIMITED, 'Слишком много подключений с одного адреса.', false);
    ws.close();
    return;
  }
  ipConnections.set(ip, openFromIp);

  ws.id = crypto.randomBytes(8).toString('hex');
  ws.token = crypto.randomBytes(16).toString('hex');
  ws.ip = ip;
  ws.isAlive = true;
  ws.limiter = new RateLimiter();
  ws.violations = new ViolationTracker({
    threshold: VIOLATION_DISCONNECT_THRESHOLD,
    decayPerMinute: VIOLATION_DECAY_PER_MINUTE
  });
  metrics.connections++;

  send(ws, {
    type: S2C.WELCOME,
    id: ws.id,
    token: ws.token,
    serverTime: Date.now(),
    protocolVersion: PROTOCOL_VERSION
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Единая точка отказа: начисляет штраф, отвечает структурированной ошибкой и при необходимости
  // закрывает соединение.
  const reject = (reason, code, message) => {
    metrics.invalidMessages++;
    sendError(ws, code, message);
    if (ws.violations.add(reason)) {
      metrics.disconnectsForAbuse++;
      log('warn', 'connection_closed_for_abuse', { playerId: ws.id, score: ws.violations.current() });
      sendError(ws, ERROR_CODES.PROTOCOL_ERROR, 'Соединение закрыто из-за некорректных запросов.', false);
      ws.close();
    }
  };

  // Внешняя обёртка ловит всё, что не предусмотрено внутри. Непредвиденная ошибка в обработке
  // одного сообщения одного игрока не должна ронять процесс со всеми остальными комнатами:
  // это единственный обработчик, куда приходят данные из внешнего мира.
  ws.on('message', raw => {
    try {
      handleClientMessage(raw);
    } catch (error) {
      metrics.handlerErrors++;
      log('error', 'message_handler_threw', {
        playerId: ws.id,
        roomId: ws.room || null,
        message: error?.message,
        stack: error?.stack
      });
    }
  });

  function handleClientMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return reject('INVALID_SCHEMA', ERROR_CODES.INVALID_MESSAGE, 'Некорректное сетевое сообщение.');
    }

    const validation = validateMessage(message);
    if (!validation.ok) {
      return reject(
        validation.reason,
        ERROR_CODES.INVALID_MESSAGE,
        `Некорректное сообщение: ${validation.detail}`
      );
    }

    if (!ws.limiter.allow(message.type)) {
      return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком часто. Немного подождите.');
    }

    // Отметка времени сервера в каждом pong — по ней клиент оценивает расхождение часов.
    if (message.type === C2S.PING) {
      return send(ws, { type: S2C.PONG, at: message.at, serverTime: Date.now() });
    }
    if (message.type === C2S.LEAVE_ROOM) return leave(ws);

    if (message.type === C2S.RESUME) {
      if (resume(ws, message.token)) return;
      metrics.resumeFailed++;
      log('info', 'resume_failed', { playerId: ws.id });
      return send(ws, { type: S2C.RESUME_FAILED, code: ERROR_CODES.RECONNECT_EXPIRED });
    }

    if (message.type === C2S.CREATE_ROOM || message.type === C2S.JOIN_ROOM) {
      if (message.protocolVersion !== undefined && message.protocolVersion !== PROTOCOL_VERSION) {
        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);
      }
      if (ipRateLimited(ws.ip)) {
        return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком много запросов. Подождите минуту.');
      }
    }

    if (message.type === C2S.CREATE_ROOM) {
      leave(ws);
      if (rooms.size >= MAX_ROOMS) {
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      const mode = message.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;
      const code = roomCode();
      // В кооперативе «сложность» — это выбор главы: сид там ни при чём, уровни рукотворные.
      const chapterId = COOP_CHAPTER_IDS.includes(message.difficulty)
        ? message.difficulty
        : COOP_CHAPTER_IDS[0];
      const room = {
        code,
        host: ws.id,
        state: ROOM_STATE.LOBBY,
        mode,
        chapterId,
        matchId: null,
        startedAt: null,
        firstFinishAt: null,
        spec:
          mode === GAME_MODE.COOP
            ? coopSpec(chapterId)
            : createCourseSpec(randomSeed(), safeDifficulty(message.difficulty)),
        players: new Map(),
        nextJoinOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      rooms.set(code, room);
      log('info', 'room_created', { roomId: code, mode });
      return addPlayer(room, ws, message.name);
    }

    if (message.type === C2S.JOIN_ROOM) {
      leave(ws);
      const room = rooms.get(message.code.trim().toUpperCase());
      if (!room) return sendError(ws, ERROR_CODES.ROOM_NOT_FOUND, 'Комната не найдена. Проверьте код.');
      if (room.state !== ROOM_STATE.LOBBY) {
        return sendError(ws, ERROR_CODES.MATCH_ALREADY_STARTED, 'Игра в этой комнате уже началась.');
      }
      if (room.players.size >= MAX_PLAYERS[room.mode]) {
        return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');
      }
      return addPlayer(room, ws, message.name);
    }

    const room = rooms.get(ws.room);
    const player = room?.players.get(ws.id);
    if (!room || !player) {
      return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Сначала создайте комнату или войдите в неё.');
    }

    // Пакет из чужого забега — опоздавший, а не злонамеренный. Молча отбрасываем ДО проверки
    // состояния: иначе хвост прошлого матча получал бы WRONG_STATE и начислял игроку нарушения.
    if (message.matchId && room.matchId && message.matchId !== room.matchId) {
      metrics.latePacketsDropped++;
      return;
    }

    // Хвост завершившегося матча.
    //
    // Это и есть главная причина «ошибки сервера, когда второй игрок доходит до конца». Клиент
    // шлёт `finish`, сервер тут же переводит комнату в RESULTS — а следующий кадр того же клиента
    // уже отправил `state`. Пакет приходит через миллисекунды, находит комнату в RESULTS, не
    // проходит по таблице состояний и превращается в ошибку протокола со штрафом. Ничьей вины
    // здесь нет: так работает порядок доставки, и правильная реакция — тишина.
    if (room.state === ROOM_STATE.RESULTS && MATCH_TRAILING_TYPES.has(message.type)) {
      metrics.latePacketsDropped++;
      return;
    }

    // Проверка допустимости действия в текущем состоянии комнаты. Закрывает целый класс ошибок:
    // смена сложности во время забега, повторный старт, финиш в лобби.
    const allowedStates = ALLOWED_IN_STATE[message.type];
    if (allowedStates && !allowedStates.includes(room.state)) {
      return reject('WRONG_STATE', ERROR_CODES.WRONG_STATE, 'Это действие сейчас недоступно.');
    }

    room.updatedAt = Date.now();

    if (message.type === C2S.PLAYER_READY) {
      player.ready = message.ready;
      return emitLobby(room);
    }

    if (message.type === C2S.HOST_CONFIGURE) {
      if (room.host !== ws.id) {
        return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Настройки меняет только хост.');
      }
      if (message.difficulty !== undefined) {
        if (room.mode === GAME_MODE.COOP) {
          room.chapterId = COOP_CHAPTER_IDS.includes(message.difficulty)
            ? message.difficulty
            : room.chapterId;
          room.spec = coopSpec(room.chapterId);
        } else {
          room.spec = createCourseSpec(randomSeed(), safeDifficulty(message.difficulty));
        }
      }
      if (message.mode !== undefined && message.mode !== room.mode) {
        // Смена режима меняет вместимость: лишних игроков в коопе быть не должно.
        if (message.mode === GAME_MODE.COOP && room.players.size > MAX_PLAYERS[GAME_MODE.COOP]) {
          return sendError(
            ws,
            ERROR_CODES.ROOM_FULL,
            'Для кооператива в комнате должно быть не больше двух игроков.'
          );
        }
        room.mode = message.mode;
        // Смена режима меняет и тип уровня: у кооператива главы, у гонки процедурная трасса.
        room.spec =
          room.mode === GAME_MODE.COOP
            ? coopSpec(room.chapterId)
            : createCourseSpec(randomSeed(), room.spec.difficulty || 'normal');
        assignSlots(room);
      }
      // Любое изменение настроек сбрасывает готовность: игроки согласились на другие условия.
      for (const item of room.players.values()) item.ready = false;
      return emitLobby(room);
    }

    if (message.type === C2S.START_MATCH) {
      if (room.host !== ws.id) {
        return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Забег запускает только хост.');
      }
      const active = [...room.players.values()].filter(item => !item.disconnectedAt);
      if (room.mode === GAME_MODE.COOP && active.length !== 2) {
        return sendError(ws, ERROR_CODES.NOT_READY, 'Для кооператива нужны ровно два игрока на связи.');
      }
      if (!active.length || !active.every(item => item.ready)) {
        return sendError(ws, ERROR_CODES.NOT_READY, 'Все игроки должны быть готовы.');
      }

      if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return;
      // matchId отсекает запоздавшие сообщения прошлого забега: снапшот с чужим matchId
      // игнорируется вместо того, чтобы дёрнуть игрока в позицию из предыдущей гонки.
      room.matchId = crypto.randomBytes(8).toString('hex');
      room.startedAt = Date.now() + COUNTDOWN_MS;
      room.firstFinishAt = null;
      // Забег начинается «в зачёт»; первый же обрыв связи снимает эту отметку до конца матча.
      room.unranked = null;
      metrics.matchesStarted++;
      assignSlots(room);

      for (const item of room.players.values())
        Object.assign(item, {
          finished: false,
          time: null,
          checkpoint: 0,
          last: {
            ...(room.mode === GAME_MODE.COOP ? coopSpawnFor(room.spec, 0, item.slot) : room.spec.start),
            ry: 0,
            vx: 0,
            vz: 0,
            state: 'ground',
            checkpoint: 0
          },
          downed: false,
          downedAt: 0,
          lastAt: room.startedAt,
          rematch: false,
          returned: false
        });

      log('info', 'match_started', { roomId: room.code, matchId: room.matchId, mode: room.mode });
      return broadcast(room, {
        type: S2C.MATCH_START,
        at: room.startedAt,
        matchId: room.matchId,
        mode: room.mode,
        spec: room.spec,
        slots: Object.fromEntries([...room.players.values()].map(item => [item.id, item.slot]))
      });
    }

    if (message.type === C2S.PLAYER_STATE) {
      // Сообщения прошлого забега приходят после рестарта и не должны применяться.
      if (message.matchId && message.matchId !== room.matchId) return;
      if (Date.now() < room.startedAt - 300) return;
      const now = Date.now();
      if (now - (player.receivedAt || 0) < 32) return;
      player.receivedAt = now;
      const result = validateState(player, message.state, room.spec, now);
      if (!result.ok) {
        if (result.reason === 'speed') {
          send(ws, { type: S2C.CORRECTION, position: result.position, reason: 'movement' });
        }
        return;
      }
      player.last = { ...result.state, id: player.id };
      player.lastAt = now;
      player.checkpoint = result.checkpoint;
      return;
    }

    // Игрок свернул игру или вернулся. Сервер здесь ничего не решает — только запоминает и
    // пересказывает: решение принимает человек, а знать об этом должен напарник.
    if (message.type === C2S.PRESENCE) {
      if (player.away === message.away) return;
      player.away = message.away;
      broadcast(room, { type: S2C.PLAYER_PRESENCE, id: player.id, away: player.away });
      emitLobby(room);
      return;
    }

    if (message.type === C2S.COOP_EVENT) {
      if (room.mode !== GAME_MODE.COOP) {
        return sendError(ws, ERROR_CODES.WRONG_STATE, 'Это действие доступно только в кооперативе.');
      }
      if (message.matchId && message.matchId !== room.matchId) return;
      const result = validateCoopEvent(room, player, message);
      // Отклонённое кооп-действие — чаще всего рассинхрон на долю секунды, а не обман,
      // поэтому штрафа здесь нет: игрока не за что наказывать.
      if (!result.ok) return;
      if (result.relay) {
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, ...result.relay });
      }
      return;
    }

    if (message.type === C2S.RESPAWN) {
      const now = Date.now();
      if (now - (player.lastRespawn || 0) < 450) return;
      player.lastRespawn = now;
      if (room.mode === GAME_MODE.COOP) {
        // В кооперативе падение — не откат, а ожидание напарника: игрок появляется у последнего
        // чекпоинта, но остаётся «упавшим», пока его не поднимут.
        markDowned(player, now);
        const point = coopSpawnFor(room.spec, player.checkpoint, player.slot);
        player.last = {
          ...point,
          ry: 0,
          vx: 0,
          vz: 0,
          state: 'air',
          checkpoint: player.checkpoint,
          id: player.id
        };
        player.lastAt = now;
        broadcast(room, {
          type: S2C.COOP_EVENT,
          matchId: room.matchId,
          action: 'downed',
          target: player.id
        });
        return send(ws, { type: S2C.CORRECTION, position: point, reason: 'respawn' });
      }
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
      return send(ws, { type: S2C.CORRECTION, position, reason: 'respawn' });
    }

    if (message.type === C2S.FINISH) {
      // Повторный финиш ничего не меняет и не является нарушением: он приходит при
      // переподключении и при повторной попытке после отказа.
      if (player.finished) return;
      if (!canFinish(player, room.spec)) {
        metrics.finishRejected++;
        log('info', 'finish_rejected', {
          roomId: room.code,
          matchId: room.matchId,
          playerId: player.id
        });
        // Отказ помечен явно, а не спрятан в обычную коррекцию: клиент должен понять, что финиш
        // НЕ засчитан, и повторить его после следующего валидного состояния. Раньше он видел
        // рядовую коррекцию, считал себя финишировавшим и навсегда оставался в «Подтверждаем
        // результат…».
        return send(ws, {
          type: S2C.FINISH_REJECTED,
          matchId: room.matchId,
          position: player.last || spawnFor(room.spec, player.checkpoint),
          reason: 'finish-validation'
        });
      }
      player.finished = true;
      player.time = Math.max(0, Date.now() - room.startedAt);
      if (!room.firstFinishAt) room.firstFinishAt = Date.now();
      broadcast(room, {
        type: S2C.PLAYER_FINISHED,
        matchId: room.matchId,
        id: player.id,
        time: player.time,
        board: leaderboard(room),
        unranked: room.unranked || null
      });
      return checkMatchEnd(room);
    }

    // Реванш — единогласное решение, а не команда хоста.
    //
    // Раньше голос хоста мгновенно распускал комнату в лобби. На экране результатов это выглядело
    // так: один нажал «реванш» — и карточка исчезла у обоих, второй просто не успевал ничего
    // нажать. Теперь голос — это голос: комната остаётся в RESULTS, пока не проголосуют все,
    // кто на связи, а рассылка состояния показывает счёт голосов.
    if (message.type === C2S.REMATCH_VOTE) {
      if (player.rematch) return;
      player.rematch = true;
      const voters = [...room.players.values()].filter(item => !item.disconnectedAt);
      if (voters.length > 0 && voters.every(item => item.rematch)) return resetLobby(room);
      return emitLobby(room);
    }

    // Возврат в лобби — тоже общее решение. Хост здесь не привилегирован по той же причине:
    // его нажатие закрывало карточку результатов остальным.
    if (message.type === C2S.RETURN_TO_LOBBY) {
      if (player.returned) return;
      player.returned = true;
      const active = [...room.players.values()].filter(item => !item.disconnectedAt);
      if (active.length > 0 && active.every(item => item.returned)) return resetLobby(room);
      return emitLobby(room);
    }
  }

  ws.on('close', () => handleDisconnect(ws));
  // `error` тоже ведёт к разрыву, но состояние меняем один раз — этим занимается
  // `disconnectHandled` внутри. Здесь только причина в лог.
  ws.on('error', error => {
    log('warn', 'socket_error', { playerId: ws.id, message: error?.message });
    handleDisconnect(ws);
  });
});

const snapshotTimer = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    // Комната без активного матча не участвует в рассылке вообще (ТЗ 12.5).
    if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) continue;

    // Отсчёт закончился — переводим комнату в игру.
    if (room.state === ROOM_STATE.COUNTDOWN && now >= room.startedAt) {
      setRoomState(room, ROOM_STATE.PLAYING);
    }

    const players = [...room.players.values()]
      .filter(player => player.last)
      .map(player => ({
        ...player.last,
        id: player.id,
        checkpoint: player.checkpoint,
        finished: player.finished
      }));

    broadcast(
      room,
      { type: S2C.SNAPSHOT, matchId: room.matchId, serverTime: now, players },
      { dropIfCongested: true }
    );
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
    if (room.state === ROOM_STATE.PLAYING && room.mode === GAME_MODE.COOP) {
      // Упавший поднимается сам по истечении срока — иначе пара, где один отошёл от устройства,
      // застряла бы в главе навсегда.
      for (const id of autoRevive(room, now)) {
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, action: 'revive', target: id });
      }
    }
    // Если все ушли из матча, он не должен висеть в PLAYING до истечения TTL.
    if (room.state === ROOM_STATE.PLAYING) checkMatchEnd(room);
  }

  for (const [token, session] of sessions) if (now > session.expiresAt) sessions.delete(token);
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) rooms.delete(code);
  for (const [ip, entry] of ipRoomOps) if (now - entry.start > IP_WINDOW_MS) ipRoomOps.delete(ip);
}, 15000);
heartbeatTimer.unref();

const port = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(port, () => log('info', 'server_started', { port }));
}

module.exports = { app, server, rooms, sessions, metrics, leave, resetLobby, originAllowed };
