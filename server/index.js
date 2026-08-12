const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { WebSocketServer, WebSocket } = require('ws');

const {
  PLAYER_COLORS,
  safeName,
  safeDifficulty,
  randomSeed,
  createCourseSpec,
  spawnFor,
  segmentTypeAt,
  validateState,
  verifyCheckpointTime,
  verifyFinishTime,
  verifyMovement,
  resetHistory,
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
  courseKeyFor,
  ALLOWED_IN_STATE,
  canTransition,
  MAX_MESSAGE_BYTES,
  VIOLATION_DISCONNECT_THRESHOLD,
  VIOLATION_DECAY_PER_MINUTE
} = require('../shared/protocol.js');

const { validateMessage, RateLimiter, ViolationTracker } = require('../shared/validation.js');
const { coopSpec, coopSpawnFor, COOP_CHAPTER_IDS } = require('../shared/coopChapters.js');
const { validateCoopEvent, markDowned, autoRevive, coopComplete } = require('./coopRules');
const { VerifiedLeaderboard, VERIFICATION_VERSION } = require('./verifiedLeaderboard');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { Accounts } = require('./accounts');
const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');
const { IncidentDiagnostics } = require('./incidentDiagnostics');
const { BoundedIpRateLimiter } = require('./ipRateLimiter');
const { networkIdentity } = require('./networkIdentity');
const { accountAccessPolicy } = require('./accountAccessPolicy');
const { socialCosmetics } = require('./socialCosmetics');
const { backupHealthStatus } = require('./backupStatus');
const { buildIdentity } = require('./buildInfo');
const { trackSignatureMetrics } = require('./signatureMetrics');
const { SocialSafety } = require('./socialSafety');
const operationalState = require('./operationalState');
const {
  auditCoopMovement,
  verifyCoopCheckpoint,
  verifyCoopFinish,
  noteAuthoritativeLaunch,
  resetCoopMotionHistory
} = require('./coopMovementAudit');

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
      "worker-src 'self'",
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
      if (/\.(js|css|html|webmanifest)$/.test(file)) res.setHeader('Cache-Control', NO_CACHE);
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

// Путь к файлу базы. Без переменной окружения таблица живёт в памяти — так поднимаются тесты и
// локальный запуск, где файл на диске только мешает. Боевой сервер путь задаёт: см. wobble.env.
//
// Пустое значение и ':memory:' здесь не одно и то же по смыслу, но одно и то же по поведению, и
// это осознанно: сервер, у которого забыли настроить путь, должен работать, а не падать на старте.
// Одно соединение на весь процесс: таблица рекордов и аккаунты лежат в одном файле.
const databaseFile = process.env.LEADERBOARD_DB || ':memory:';
const gameDb = openDatabase(databaseFile);
migrateDatabase(gameDb);
const verifiedLeaderboard = new VerifiedLeaderboard({ db: gameDb });
const accounts = new Accounts({ db: gameDb });
const gameplay = new GameplayMetrics({ db: gameDb });
const incidentDiagnostics = new IncidentDiagnostics({ db: gameDb });
const socialSafety = new SocialSafety({ db: gameDb });

// Сессии для переподключения: токен → место игрока в комнате.
const sessions = new Map();

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Глобальные пределы защищают процесс, а не отдельный IP. Без них тысячи адресов могли каждый
// остаться внутри персонального лимита и всё равно исчерпать память одним экземпляром Node.js.
const MAX_ROOMS = positiveInt(process.env.MAX_ROOMS, 500);
const MAX_ACTIVE_SOCKETS = positiveInt(process.env.MAX_ACTIVE_SOCKETS, 2000);
const MAX_ACTIVE_MATCHES = positiveInt(process.env.MAX_ACTIVE_MATCHES, 300);
const MAX_EVENT_LOOP_LAG_MS = positiveInt(process.env.MAX_EVENT_LOOP_LAG_MS, 120);

// Задержка event loop измеряется КОРОТКИМИ ОКНАМИ, а не за всё время работы процесса.
//
// Гистограмма monitorEventLoopDelay копит выборки с момента enable() и никогда не забывает. Значит,
// её перцентиль — это перцентиль по всему аптайму, и чем дольше сервер работает, тем меньше он
// реагирует: чтобы сдвинуть 95-й перцентиль, перегрузка должна занять двадцатую часть всего времени
// жизни процесса.
//
// Замерено: если гистограмму не сбрасывать, пять секунд устойчивой блокировки поднимают p95 до
// 160 мс на свежем процессе — и не двигают его вообще уже после тридцати секунд аптайма. То есть
// защита от перегрузки (отказ от новых комнат, снапшоты на 10 Гц) переставала срабатывать примерно
// через полминуты после запуска и дальше не срабатывала никогда.
//
// Поэтому: раз в окно снимаем перцентиль, сохраняем его и сбрасываем гистограмму. Решение
// принимается по последнему завершённому окну — оно и «устойчивая задержка», и восстановление
// замечает за одно окно.
const EVENT_LOOP_WINDOW_MS = 5000;

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

let eventLoopWindowP95Ms = 0;

// Возвращает задержку последнего завершённого окна и начинает новое.
function rotateEventLoopWindow() {
  const p95 = eventLoopDelay.percentile(95) / 1e6;
  eventLoopWindowP95Ms = Number.isFinite(p95) ? p95 : 0;
  eventLoopDelay.reset();
  return eventLoopWindowP95Ms;
}

const eventLoopTimer = setInterval(rotateEventLoopWindow, EVENT_LOOP_WINDOW_MS);
eventLoopTimer.unref();

const PRODUCT_EVENT_NAMES = Object.freeze([
  'roomCreated',
  'roomJoined',
  'matchmakingStarted',
  'matchmakingMatched',
  'matchStarted',
  'checkpointReached',
  'playerDowned',
  'matchCompleted',
  'matchAbandoned',
  'connectionRecovered'
]);

function createEventCounters() {
  return Object.fromEntries(PRODUCT_EVENT_NAMES.map(name => [name, 0]));
}

function trackEvent(counters, name, amount = 1) {
  if (!Object.hasOwn(counters, name) || !Number.isSafeInteger(amount) || amount < 1) return false;
  counters[name] += amount;
  return true;
}

const productEvents = createEventCounters();
const build = buildIdentity();

function loadStatus({ lagMs = eventLoopWindowP95Ms, memory = process.memoryUsage() } = {}) {
  const normalizedLag = Number.isFinite(lagMs) ? Math.round(lagMs * 10) / 10 : 0;
  return {
    eventLoopP95Ms: normalizedLag,
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    rssMb: Math.round(memory.rss / 1024 / 1024),
    overloaded: normalizedLag >= MAX_EVENT_LOOP_LAG_MS
  };
}

function capacityStatus({
  socketCount = wss.clients.size,
  activeMatches = null,
  maxSockets = MAX_ACTIVE_SOCKETS,
  maxMatches = MAX_ACTIVE_MATCHES
} = {}) {
  const playing =
    activeMatches ??
    [...rooms.values()].filter(room => [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING].includes(room.state))
      .length;
  return {
    socketCount,
    activeMatches: playing,
    maxSockets,
    maxMatches,
    socketsFull: socketCount >= maxSockets,
    matchesFull: playing >= maxMatches
  };
}

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
  handlerErrors: 0,
  capacityRejected: 0,
  snapshotsSkippedForLoad: 0,
  verificationFailed: 0
};

const health = () => ({
  ok: true,
  service: 'wobble-rush-3d',
  version: build.version,
  commit: build.commit,
  release: build.release || null,
  protocolVersion: PROTOCOL_VERSION,
  startedAt: build.startedAt,
  rooms: rooms.size,
  players: [...rooms.values()].reduce((sum, room) => sum + room.players.size, 0),
  sessions: sessions.size,
  capacity: capacityStatus(),
  load: loadStatus(),
  events: productEvents,
  matchmaking: matchmakingStatus(),
  uptime: Math.round(process.uptime()),
  backup: backupHealthStatus({ databaseFile }),
  metrics
});

// Идёт ли выключение. Пока флаг снят, всё работает как обычно; после — сервер перестаёт брать
// новую работу, но доигрывает начатое.
let shuttingDown = false;

app.get('/health', (_req, res) => res.json(health()));

// Сводка по игре: где падают, где бросают, сколько бегут. Данные обезличены — это счётчики по
// типам препятствий и сложностям, ни одного игрока по ним не найти.
//
// Сам процесс отдаёт её без пароля, как и /health: приложение не знает, кто перед ним, и городить
// в нём отдельную авторизацию ради счётчиков незачем. Наружу адрес не выпускается — в
// deploy/nginx-locations.conf у /metrics/ тот же запрет, что у /health, и по той же причине:
// запрос считает агрегат по базе, а такой адрес без ограничения работает как способ нагрузить
// сервер бесплатно.
app.get('/metrics/gameplay', (req, res) =>
  res.json(
    gameplay.summary({ days: positiveInt(req.query.days, 7), limit: positiveInt(req.query.limit, 200) })
  )
);
// Разделение live и ready (ТЗ 15.3): live отвечает, пока процесс жив, ready — пока сокет-сервер
// действительно принимает подключения. Балансировщику нужны разные ответы на эти вопросы.
app.get('/health/live', (_req, res) => res.json({ ok: true }));
// Private readiness handshake for the root-owned operations helper. This route is registered
// before the SPA catch-all, requires the canonical lower-case path and accepts only direct
// loopback traffic. Nginx additionally blocks every case variant from the public proxy.
app.get('/health/ops', (req, res) => {
  if (req.path !== '/health/ops') return res.status(404).end();
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '')) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ ok: true, pid: process.pid, draining: operationalState.isDraining() });
});
app.get('/health/ready', (_req, res) => {
  // Во время выключения — 503, хотя сокет ещё слушает. Это и есть смысл разделения live и ready:
  // процесс жив и доигрывает начатое, но новых игроков сюда направлять уже не нужно.
  const capacity = capacityStatus();
  const load = loadStatus();
  const ready =
    !shuttingDown &&
    !operationalState.isDraining() &&
    !!wss &&
    server.listening &&
    !capacity.socketsFull &&
    !load.overloaded;
  res.status(ready ? 200 : 503).json({ ok: ready, ...health() });
});

app.get('/leaderboard', (req, res) => {
  const seedText = String(req.query.seed || '');
  const seed = Number(seedText);
  const difficulty = safeDifficulty(req.query.difficulty);
  if (!/^\d{1,10}$/.test(seedText) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    return res.status(400).json({ ok: false, error: 'invalid-seed' });
  // Идентификатор нужен, чтобы посчитать место игрока и отставание. Он же помечает его строку в
  // выдаче. Приходит параметром запроса, а не заголовком: страница лобби обновляет таблицу обычным
  // fetch, и лишний слой тут ничего не даёт.
  const playerId = typeof req.query.playerId === 'string' ? req.query.playerId.slice(0, 64) : null;
  const key = courseKeyFor(GAME_MODE.RACE, { seed, difficulty });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    mode: GAME_MODE.RACE,
    seed: seed >>> 0,
    difficulty,
    verificationVersion: VERIFICATION_VERSION,
    entries: verifiedLeaderboard.get(GAME_MODE.RACE, key, req.query.limit, playerId),
    // null, если игрок эту трассу ещё не проходил, — отдельно от entries, потому что его строка
    // может быть далеко за пределами показанной десятки.
    standing: verifiedLeaderboard.standing(GAME_MODE.RACE, key, playerId)
  });
});

// Таблица кооперативных глав.
//
// Отдельным адресом, а не параметром к /leaderboard: у гонки трасса задаётся сидом и сложностью,
// у главы — идентификатором, и склеивать два разных набора параметров в один маршрут значило бы
// проверять их вперемешку.
//
// Время и движение здесь проверяет сервер. Для рукотворных глав используется отдельный
// CoopMovementAudit: он читает ту же data-driven разметку, что строит клиент, и проверяет
// систематическую скорость, опоры, высоту, checkpoint regions и физические минимумы, сохраняя
// узкие исключения только для серверно подтверждённых механик.
app.get('/leaderboard/coop', (req, res) => {
  const chapterId = typeof req.query.chapter === 'string' ? req.query.chapter : '';
  if (!COOP_CHAPTER_IDS.includes(chapterId))
    return res.status(400).json({ ok: false, error: 'invalid-chapter' });
  const playerId = typeof req.query.playerId === 'string' ? req.query.playerId.slice(0, 64) : null;
  const key = courseKeyFor(GAME_MODE.COOP, { chapterId });
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    ok: true,
    mode: GAME_MODE.COOP,
    chapter: chapterId,
    movementVerified: true,
    verificationVersion: VERIFICATION_VERSION,
    entries: verifiedLeaderboard.get(GAME_MODE.COOP, key, req.query.limit, playerId),
    standing: verifiedLeaderboard.standing(GAME_MODE.COOP, key, playerId)
  });
});

// ---------------------------------------------------------------------------------------------
// Аккаунты.
//
// Разговор идёт по HTTP, а не по WebSocket, сознательно: одиночный забег сокет вообще не открывает,
// а рекорд после него сохранить надо. Заводить ради этого соединение значило бы держать его ради
// одного сообщения.
//
// Код восстановления присылается с каждым запросом вместо серверной сессии. Отдельная таблица
// сессий здесь ничего не добавила бы: код и так хранится у игрока, живёт долго и передаётся по тому
// же TLS, что и любая сессия.

// Разбор тела с жёстким потолком: тут ждут короткий JSON, и принимать мегабайты незачем.
const accountJson = express.json({ limit: '2kb' });

// Ограничители по адресу, отдельные от комнатных.
//
// У создания аккаунта и у входа разные опасности: первое спамят, второе перебирают. Общий счётчик
// означал бы, что спам создания закрывает вход честному игроку с того же адреса — а за NAT это
// целый дом.
const HTTP_WINDOW_MS = 10 * 60 * 1000;
const httpLimits = {
  create: [20, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })],
  login: [40, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })],
  record: [200, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })]
};

function httpRateLimited(kind, ip) {
  if (!ip) return false;
  const [max, limiter] = httpLimits[kind];
  return limiter.limited(ip, max);
}

// Личные рекорды отдаются вместе с аккаунтом: клиенту они нужны сразу после входа, чтобы показать
// рекорд трассы в меню, и отдельный запрос за ними был бы лишним кругом.
const accountPayload = account => ({
  ok: true,
  account: { id: account.id, name: account.name },
  records: accounts.records(account.id),
  progress: accounts.progress(account.id)
});

function legacySanction(account) {
  const item = account?.id ? accountAccessPolicy.sanction(account.id) : null;
  if (!item) return null;
  return {
    reason: String(item.reason || 'other'),
    expiresAt: item.expiresAt == null ? null : Number(item.expiresAt),
    permanent: Boolean(item.permanent)
  };
}

function rejectSanctionedLegacy(res, account) {
  const sanction = legacySanction(account);
  if (!sanction) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({ ok: false, error: 'account-sanctioned', sanction });
  return true;
}

app.post('/account', accountJson, (req, res) => {
  if (httpRateLimited('create', clientIp(req))) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const account = accounts.create(req.body?.name);
  log('info', 'account_created', { accountId: account.id });
  // Код возвращается ровно здесь и больше нигде: на сервере остаётся только его хеш.
  return res.status(201).json({ ...accountPayload(account), secret: account.secret });
});

app.post('/account/login', accountJson, (req, res) => {
  if (httpRateLimited('login', clientIp(req))) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const account = accounts.login(req.body?.secret);
  // 404, а не 403: «такого аккаунта нет» и «код неверный» — для игрока одно и то же событие, и
  // различать их вслух значило бы подсказывать перебирающему, что он угадал половину.
  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
  if (rejectSanctionedLegacy(res, account)) return undefined;
  return res.json(accountPayload(account));
});

app.post('/account/name', accountJson, (req, res) => {
  const account = accounts.login(req.body?.secret);
  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
  if (rejectSanctionedLegacy(res, account)) return undefined;
  const name = accounts.rename(account.id, req.body?.name);
  return res.json({ ok: true, account: { id: account.id, name } });
});

app.post('/account/record', accountJson, (req, res) => {
  if (httpRateLimited('record', clientIp(req))) {
    return res.status(429).json({ ok: false, error: 'rate-limited' });
  }
  const account = accounts.login(req.body?.secret);
  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
  if (rejectSanctionedLegacy(res, account)) return undefined;
  const saved = accounts.saveRecord({
    accountId: account.id,
    mode: req.body?.mode,
    courseKey: req.body?.courseKey,
    timeMs: Number(req.body?.timeMs)
  });
  if (saved.reason) return res.status(400).json({ ok: false, error: saved.reason });
  return res.json({ ok: true, ...saved });
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
// Простая FIFO-очередь для одного процесса. Запись живёт только пока открыт сокет и игрок не
// находится в комнате; регионы и MMR здесь намеренно отсутствуют.
const coopMatchmaking = [];

function matchmakingStatus({ queue = coopMatchmaking, counters = productEvents, now = Date.now() } = {}) {
  let oldestQueuedAt = Infinity;
  for (const item of queue) {
    if (Number.isFinite(item?.queuedAt)) oldestQueuedAt = Math.min(oldestQueuedAt, item.queuedAt);
  }
  return {
    waiting: queue.length,
    oldestWaitMs: Number.isFinite(oldestQueuedAt) ? Math.max(0, now - oldestQueuedAt) : 0,
    matchedSinceStart: Number(counters.matchmakingMatched || 0)
  };
}

const ROOM_TTL = 45 * 60 * 1000;
const COUNTDOWN_MS = 2800;

// Сколько комната ждёт решения на экране результатов, прежде чем уйти в лобби сама.
// Двадцати секунд хватает прочитать итоги и нажать кнопку, но не хватает, чтобы отошедший
// напарник запер остальных на карточке навсегда.
//
// Не const: значение подменяется в тестах. Ждать двадцать секунд в каждом прогоне бессмысленно,
// а проверять поведение по таймауту нужно — без теста истечение срока легко сломать незаметно,
// оно ведь не срабатывает при обычной игре.
let RESULTS_TIMEOUT_MS = 20_000;
const setResultsTimeout = ms => {
  RESULTS_TIMEOUT_MS = ms;
};

// Сколько держим слот игрока после обрыва связи, прежде чем выкинуть его из комнаты.
const RECONNECT_GRACE_MS = 30 * 1000;
const SESSION_TTL_MS = 60 * 1000;

function revokeAccountReconnectSessions(accountId) {
  const id = String(accountId || '');
  if (!id) return 0;
  let revoked = 0;
  for (const [token, session] of sessions) {
    const player = rooms.get(session?.roomCode)?.players.get(session?.playerId);
    if (session?.accountId !== id && player?.accountId !== id && player?.ws?.accountId !== id) continue;
    sessions.delete(token);
    revoked += 1;
  }
  return revoked;
}

// Уборка просроченных сессий — и продление живых.
//
// Продление здесь принципиально. Срок ставился при входе и обновлялся только на обрыве и на
// возвращении, но НЕ во время игры. То есть у любого, кто играет дольше минуты, сессия тихо
// протухала прямо посреди матча, и перезагрузка страницы уводила его в главное меню вместо своей
// комнаты — место в матче терялось на ровном месте.
//
// Смысл срока — «сколько ждём того, о ком ничего не слышно». Пока сокет игрока жив, ждать не нужно,
// поэтому таким сессиям срок сдвигается вперёд.
function expireSessions(now = Date.now()) {
  for (const [token, session] of sessions) {
    const player = rooms.get(session.roomCode)?.players.get(session.playerId);
    if (player && !player.disconnectedAt && player.ws?.readyState === WebSocket.OPEN) {
      session.expiresAt = now + SESSION_TTL_MS;
      continue;
    }
    if (now > session.expiresAt) sessions.delete(token);
  }
}

// Ограничение операций с комнатами по адресу — поверх ограничения по типам сообщений,
// которое действует на каждое соединение отдельно.
const IP_WINDOW_MS = 60 * 1000;
const IP_MAX_ROOM_OPS = 40;
const MAX_CONNECTIONS_PER_IP = 24;
const ipRoomOps = new BoundedIpRateLimiter({ windowMs: IP_WINDOW_MS });
const ipConnections = new Map();

function ipRateLimited(ip) {
  return ipRoomOps.limited(ip, IP_MAX_ROOM_OPS);
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
  // Во время выключения новые подключения не принимаем: пускать игрока в комнату, которая через
  // секунду перестанет существовать, — худший вариант из возможных. Отказ он увидит сразу и
  // попробует ещё раз, когда служба поднимется.
  verifyClient: ({ origin, req }) =>
    !shuttingDown && !operationalState.isDraining() && originAllowed(origin, req.headers.host)
});

// Типы, чей хвост после окончания матча надо гасить молча, а не считать нарушением протокола.
// Все они относятся к идущему забегу и после RESULTS не значат ничего.
const MATCH_TRAILING_TYPES = new Set([
  C2S.PLAYER_STATE,
  C2S.COOP_EVENT,
  C2S.COOP_PING,
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

function incidentForSocket(ws, { accountId = null, kind, code, roomId, matchId, mode, phase, valueMs } = {}) {
  const room = ws?.room ? rooms.get(ws.room) : null;
  const player = room?.players.get(ws?.id);
  const id = String(accountId || ws?.accountId || player?.accountId || '');
  if (!id) return false;
  try {
    return incidentDiagnostics.record({
      accountId: id,
      kind,
      code,
      roomId: roomId === undefined ? room?.code : roomId,
      matchId: matchId === undefined ? room?.matchId : matchId,
      mode: mode === undefined ? room?.mode : mode,
      phase: phase === undefined ? room?.state || (ws?.room ? null : 'roomless') : phase,
      device: ws?.device,
      valueMs
    });
  } catch {
    // Diagnostics are observability only. A SQLite/storage failure must never change gameplay,
    // authentication, moderation enforcement or the protocol response the player receives.
    return false;
  }
}

const sendError = (ws, code, message, recoverable = true) => {
  incidentForSocket(ws, { kind: 'network-error', code });
  return send(ws, { type: S2C.ERROR, code, message, recoverable });
};

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
  resultChoice,
  color,
  disconnectedAt,
  slot,
  away,
  loadout
}) => ({
  id,
  name,
  ready: !!ready,
  finished: !!finished,
  time: time ?? null,
  // Единый выбор на экране результатов вместо двух независимых флагов. Раньше «реванш» и
  // «в лобби» были отдельными булевыми, и разойтись они могли беспрепятственно: комната ждала
  // либо единогласного реванша, либо единогласного возврата, а смешанный случай не подходил ни
  // под одно условие и не подходил уже никогда — переголосовать было нельзя. Комната зависала
  // навсегда, и выглядело это как поломка: обе кнопки погашены, ничего не происходит.
  choice: resultChoice || null,
  color,
  // Публичный профиль всегда проходит повторную нормализацию перед отправкой. Даже если объект
  // игрока случайно испортит внутренний код, неизвестный ID не пересечёт сетевую границу.
  loadout: socialCosmetics.sanitize(loadout),
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
  hasNextChapter:
    room.mode === GAME_MODE.COOP && COOP_CHAPTER_IDS.indexOf(room.chapterId) < COOP_CHAPTER_IDS.length - 1,
  matchId: room.matchId,
  // Оставлено для совместимости с текущим клиентом: булево «идёт ли забег».
  started: room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING,
  seed: room.spec.seed,
  difficulty: room.spec.difficulty,
  maxPlayers: MAX_PLAYERS[room.mode],
  // Срок голосования: до этого времени комната ждёт решения, после — уходит в лобби сама.
  // Клиенту нужен именно момент, а не остаток: часы уже синхронизированы, а обратный отсчёт,
  // присланный числом, начал бы врать при первой же задержке пакета.
  resultsDeadline: room.state === ROOM_STATE.RESULTS ? room.resultsDeadline || null : null,
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
  room.resultsDeadline = null;
  room.updatedAt = Date.now();
  if (newSeed) room.spec = createCourseSpec(randomSeed(), room.spec.difficulty);
  for (const player of room.players.values())
    Object.assign(player, {
      ready: false,
      finished: false,
      time: null,
      resultChoice: null,
      checkpoint: 0,
      last: null,
      lastAt: 0,
      lastSequence: -1
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
  if (resolveResultsDecision(room)) return;
  emitLobby(room);
}

function leave(ws) {
  const queued = coopMatchmaking.findIndex(entry => entry.ws === ws);
  if (queued !== -1) {
    coopMatchmaking.splice(queued, 1);
    gameplay.count('matchmaking_queue_exit', { detail: 'leave', device: ws.device || 'desktop' });
    gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'leave', device: ws.device });
  }
  if (!ws.room) return;
  const room = rooms.get(ws.room);
  ws.room = null;
  if (room && (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)) {
    if (!room.abandonTracked) {
      room.abandonTracked = true;
      trackEvent(productEvents, 'matchAbandoned');
    }
    // Где именно бросили — самое ценное в этом событии: чекпоинт называет участок, дальше
    // которого не пошли.
    const leaver = room.players.get(ws.id);
    gameplay.count('match_abandoned', dims(room, leaver, `cp${leaver?.checkpoint ?? 0}`));
    incidentForSocket(ws, {
      accountId: leaver?.accountId,
      kind: 'match',
      code: 'abandoned',
      roomId: room.code,
      matchId: room.matchId,
      mode: room.mode,
      phase: room.state
    });
    markUnranked(room, 'left');
  }
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

  if (!ws.room) {
    const queued = coopMatchmaking.findIndex(entry => entry.ws === ws);
    incidentForSocket(ws, {
      kind: 'connection',
      code: 'disconnected',
      phase: queued === -1 ? 'roomless' : 'matchmaking'
    });
    if (queued !== -1) {
      coopMatchmaking.splice(queued, 1);
      gameplay.count('matchmaking_queue_exit', {
        detail: 'disconnect',
        device: ws.device || 'desktop'
      });
      gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'disconnect', device: ws.device });
    }
    return;
  }
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
  player.disconnectMatchContext =
    !player.finished && (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)
      ? { roomId: room.code, matchId: room.matchId, mode: room.mode, phase: room.state }
      : null;
  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'disconnected' });
  if (
    room.mode === GAME_MODE.COOP &&
    (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)
  ) {
    gameplay.count('partner_disconnect', dims(room, player, `cp${player.checkpoint || 0}`));
  }
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
  // Если оставшиеся уже проголосовали, обрыв второго обязан довести решение до конца — иначе
  // комната зависнет на результатах навсегда.
  if (resolveResultsDecision(room)) return;
  emitLobby(room);
}

function expireDisconnectedPlayers(now = Date.now()) {
  for (const room of [...rooms.values()]) {
    for (const player of [...room.players.values()]) {
      if (!player.disconnectedAt || now - player.disconnectedAt <= RECONNECT_GRACE_MS) continue;
      const abandoned = player.disconnectMatchContext;
      if (abandoned) {
        if (!room.abandonTracked) {
          room.abandonTracked = true;
          trackEvent(productEvents, 'matchAbandoned');
        }
        gameplay.count('match_abandoned', dims(room, player, `cp${player.checkpoint ?? 0}`));
        incidentForSocket(player.ws, {
          accountId: player.accountId,
          kind: 'match',
          code: 'abandoned',
          roomId: abandoned.roomId,
          matchId: abandoned.matchId,
          mode: abandoned.mode,
          phase: abandoned.phase
        });
        player.disconnectMatchContext = null;
      }
      dropPlayer(room, player.id);
    }
  }
}

function addPlayer(room, ws, name, playerId = null) {
  ws.room = room.code;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  const authenticated = networkIdentity.accountForSocket(ws, accounts);
  const playerName = authenticated?.name ? safeName(authenticated.name) : safeName(name);
  room.players.set(ws.id, {
    id: ws.id,
    name: playerName,
    // Хранится на игроке, но не попадает ни в один рассылаемый пакет: это ключ чужой строки в
    // таблице рекордов, и знать его соседям по комнате незачем.
    anonymousId:
      authenticated?.id ||
      (typeof playerId === 'string' && playerId.trim() ? playerId.trim().slice(0, 64) : null),
    // Серверный прогресс никогда не доверяет присланному playerId: только identity,
    // которая была подтверждена один раз и привязана к этому WebSocket.
    accountId: authenticated?.id || null,
    // Никакой loadout не принимается из CREATE/JOIN/FIND. Он разрешается по уже привязанному
    // ws.accountId через server inventory и дальше становится частью публичного room profile.
    loadout: socialCosmetics.forAccount(authenticated?.id),
    color,
    slot: 0,
    joinOrder: room.nextJoinOrder++,
    ready: false,
    finished: false,
    time: null,
    resultChoice: null,
    checkpoint: 0,
    last: null,
    lastAt: 0,
    lastSequence: -1,
    disconnectedAt: null,
    disconnectMatchContext: null,
    away: false,
    // Тип устройства нужен метрикам: телефон и компьютер играют по-разному, и мерить их вместе
    // значит не увидеть ни того, ни другого.
    device: ws.device || 'desktop',
    ws
  });
  sessions.set(ws.token, {
    playerId: ws.id,
    roomCode: room.code,
    accountId: ws.accountId || null,
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  room.updatedAt = Date.now();
  assignSlots(room);
  emitLobby(room);
}

function bindAuthenticatedSocketToRoom(ws, accountId) {
  const id = String(accountId || '');
  if (!id || !ws?.room) return false;
  const room = rooms.get(ws.room);
  const player = room?.players.get(ws.id);
  if (!player || player.ws !== ws) return false;
  const account = networkIdentity.accountForSocket(ws, accounts);
  if (!account || account.id !== id) return false;

  player.accountId = id;
  player.anonymousId = id;
  player.name = safeName(account.name);
  player.loadout = socialCosmetics.forAccount(id);

  const session = sessions.get(ws.token);
  if (session && session.playerId === ws.id && session.roomCode === room.code) {
    session.accountId = id;
  }
  room.updatedAt = Date.now();
  if (room.state === ROOM_STATE.LOBBY) emitLobby(room);
  return true;
}

function bindDeniedSocketToRoomForEnforcement(ws, accountId) {
  const id = String(accountId || '');
  if (!id || !ws?.room) return false;
  const room = rooms.get(ws.room);
  const player = room?.players.get(ws.id);
  if (!player || player.ws !== ws) return false;

  // A valid ticket proved who owns this socket even though policy denied authentication. Preserve
  // that identity only for server-side enforcement; public player payloads never expose accountId.
  player.accountId = id;
  for (const session of sessions.values()) {
    if (session.playerId === player.id && session.roomCode === room.code) session.accountId = id;
  }
  return true;
}

function createCoopRoom(chapterId, hostId) {
  const selected = COOP_CHAPTER_IDS.includes(chapterId) ? chapterId : COOP_CHAPTER_IDS[0];
  const code = roomCode();
  const room = {
    code,
    host: hostId,
    state: ROOM_STATE.LOBBY,
    mode: GAME_MODE.COOP,
    chapterId: selected,
    matchId: null,
    snapshotSequence: 0,
    startedAt: null,
    firstFinishAt: null,
    spec: coopSpec(selected),
    players: new Map(),
    nextJoinOrder: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function coopMatchCompatible(ws, entry, requested, safety = socialSafety) {
  if (!entry?.ws || entry.ws.readyState !== 1 || entry.ws === ws) return false;
  if (requested && entry.chapterId && entry.chapterId !== requested) return false;
  return !safety.shouldAvoid(ws.accountId, entry.ws.accountId);
}

function enqueueCoop(ws, message) {
  if (operationalState.isDraining()) {
    send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    return false;
  }
  leave(ws);
  const requested = COOP_CHAPTER_IDS.includes(message.chapterId) ? message.chapterId : null;
  const now = Date.now();
  gameplay.count('queue_enter', { mode: GAME_MODE.COOP, course: requested || 'any', device: ws.device });
  const partnerIndex = coopMatchmaking.findIndex(entry => coopMatchCompatible(ws, entry, requested));
  if (partnerIndex === -1) {
    coopMatchmaking.push({
      ws,
      name: message.name,
      playerId: message.playerId,
      chapterId: requested,
      queuedAt: now
    });
    trackEvent(productEvents, 'matchmakingStarted');
    incidentForSocket(ws, { kind: 'matchmaking', code: 'queued', phase: 'matchmaking' });
    return send(ws, { type: S2C.MATCHMAKING_WAITING, waitedMs: 0 });
  }

  const [partner] = coopMatchmaking.splice(partnerIndex, 1);
  const chapterId = requested || partner.chapterId || COOP_CHAPTER_IDS[0];
  const room = createCoopRoom(chapterId, partner.ws.id);
  addPlayer(room, partner.ws, partner.name, partner.playerId);
  addPlayer(room, ws, message.name, message.playerId);
  for (const player of room.players.values()) player.ready = true;
  for (const player of room.players.values()) gameplay.count('match_found', dims(room, player));
  gameplay.observe(
    'matchmaking_wait_ms',
    now - partner.queuedAt,
    dims(room, room.players.get(partner.ws.id))
  );
  trackEvent(productEvents, 'matchmakingMatched');
  incidentForSocket(partner.ws, {
    kind: 'matchmaking',
    code: 'matched',
    phase: room.state,
    valueMs: now - partner.queuedAt
  });
  incidentForSocket(ws, { kind: 'matchmaking', code: 'matched', phase: room.state });
  log('info', 'matchmaking_matched', { roomId: room.code, chapterId, waitedMs: now - partner.queuedAt });
  beginCountdown(room);
}

function beginOperationalDrain() {
  if (!operationalState.beginDrain()) return false;

  // No queued player can ever be matched after admission closes. Remove the impossible queue
  // immediately and record the exit without counting it as a capacity rejection.
  const queued = coopMatchmaking.splice(0);
  for (const entry of queued) {
    incidentForSocket(entry.ws, { kind: 'matchmaking', code: 'restart', phase: 'matchmaking' });
    gameplay.count('matchmaking_queue_exit', {
      detail: 'restart',
      device: entry.ws?.device || 'desktop'
    });
  }

  // core.shutdown broadcasts only to room players. Roomless sockets (including matchmaking) must
  // learn about maintenance now instead of waiting up to the match-drain deadline for a generic
  // network close.
  for (const client of wss.clients) {
    if (!client.room && canSend(client)) {
      send(client, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    }
  }
  return true;
}
// Возврат в комнату по токену прошлой сессии.
function resume(ws, token) {
  ws.accountAccessDenied = false;
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

  // Resume token уже принадлежит конкретному серверному player. Обычный reconnect наследует
  // accountId этого player; заранее привязанный другой account занять его место не может.
  if (player.accountId && !networkIdentity.allowed(player.accountId)) {
    ws.accountAccessDenied = true;
    ws.accountAccessDeniedAccountId = player.accountId;
    return false;
  }
  if (!networkIdentity.bindResumedPlayer(ws, player)) return false;

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
  player.disconnectMatchContext = null;
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
  trackEvent(productEvents, 'connectionRecovered');
  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'resumed' });

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
      slots: Object.fromEntries([...room.players.values()].map(item => [item.id, item.slot])),
      // Продолжение, а не начало заново.
      //
      // Сервер всё это время помнил, где игрок находится и что с ним. Без этих полей клиент
      // строил уровень с нуля и ставил персонажа на старт — то есть в середине главы игрока
      // отбрасывало к началу, а сервер продолжал видеть его там, где он был. Хуже всего это
      // работало у финишировавшего: он снова оказывался на трассе, хотя уже ждал напарника.
      resumed: {
        position: player.last || spawnFor(room.spec, player.checkpoint),
        checkpoint: player.checkpoint || 0,
        finished: !!player.finished,
        downed: !!player.downed,
        nextSequence: (player.lastSequence ?? -1) + 1
      }
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

function addVerificationFindings(room, player, findings, details = {}) {
  if (!findings?.length) return false;
  let added = false;
  for (const reason of findings) {
    if (player.verificationReasons.includes(reason)) continue;
    player.verificationReasons.push(reason);
    metrics.verificationFailed++;
    added = true;
    log('info', 'result_unverified', {
      roomId: room.code,
      matchId: room.matchId,
      playerId: player.id,
      reason,
      ...details
    });
  }
  return added;
}

// Измерения события: что за режим, какая трасса и с чего играют. Устройство берётся у игрока —
// в одной комнате могут быть и телефон, и компьютер, и усреднять их значило бы потерять главное
// различие.
function dims(room, player, detail) {
  return {
    mode: room.mode,
    course: room.mode === GAME_MODE.COOP ? room.chapterId || room.spec.chapterId : room.spec.difficulty,
    detail,
    device: player?.device || 'desktop'
  };
}

function verificationFindingsForState(room, player, state, now) {
  return room.mode === GAME_MODE.COOP
    ? auditCoopMovement(room, player, state, now)
    : verifyMovement(player, state, now, room.spec);
}

function verifyPlayerProgress(room, player, checkpoint, state, now) {
  const verification =
    room.mode === GAME_MODE.COOP
      ? verifyCoopCheckpoint(player, room.spec, checkpoint, state, now)
      : verifyCheckpointTime(player, checkpoint, now, room.spec);
  if (!verification) return null;
  addVerificationFindings(room, player, [verification.reason], verification);
  return verification;
}

function trackCheckpointDuration(room, player, checkpoint, now) {
  if (room.mode !== GAME_MODE.COOP || checkpoint <= player.checkpoint) return;
  gameplay.observe(
    'checkpoint_duration_ms',
    Math.max(0, now - (player.checkpointAt || room.startedAt || now)),
    dims(room, player, `cp${checkpoint}`)
  );
  player.checkpointAt = now;
}

// Запуск забега: отсчёт, новый matchId, сброс состояния игроков по местам появления.
//
// Вынесено из обработчика START_MATCH, потому что вызывать это надо из двух мест: по команде хоста
// и по единогласному реваншу. Реванш обязан именно ЗАПУСКАТЬ забег, а не возвращать в лобби —
// раньше обе кнопки экрана результатов вели в resetLobby, то есть делали в точности одно и то же,
// и «голосование за реванш» ничего не решало.
function beginCountdown(room) {
  // Drain is a process-wide admission boundary, not just an Nginx connection gate. Existing
  // lobby/results sockets stay alive while current matches finish, but none of them may start
  // another countdown after SIGUSR2. Every path (host start, matchmaking, rematch, next chapter)
  // funnels through this one function.
  if (operationalState.isDraining()) {
    broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    return false;
  }
  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;
  // matchId отсекает запоздавшие сообщения прошлого забега: снапшот с чужим matchId
  // игнорируется вместо того, чтобы дёрнуть игрока в позицию из предыдущей гонки.
  room.matchId = crypto.randomBytes(8).toString('hex');
  room.snapshotSequence = 0;
  room.startedAt = Date.now() + COUNTDOWN_MS;
  room.firstFinishAt = null;
  room.coopRevives = 0;
  // Забег начинается «в зачёт»; первый же обрыв связи снимает эту отметку до конца матча.
  room.unranked = null;
  room.results = null;
  room.resultsDeadline = null;
  room.abandonTracked = false;
  room.pairEndedTracked = false;
  metrics.matchesStarted++;
  trackEvent(productEvents, 'matchStarted');
  for (const item of room.players.values()) {
    gameplay.count('match_started', dims(room, item));
    incidentForSocket(item.ws, {
      accountId: item.accountId,
      kind: 'match',
      code: 'started',
      roomId: room.code,
      matchId: room.matchId,
      mode: room.mode,
      phase: room.state
    });
  }
  if (room.mode === GAME_MODE.COOP) {
    for (const item of room.players.values()) gameplay.count('chapter_started', dims(room, item));
  }
  assignSlots(room);

  for (const item of room.players.values())
    Object.assign(item, {
      finished: false,
      coopRevives: 0,
      coopFalls: 0,
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
      lastSequence: -1,
      checkpointAt: room.startedAt,
      matchStartedAt: room.startedAt,
      unverifiedReason: null,
      verificationReasons: [],
      // Отклонения и история движения принадлежат ЗАБЕГУ, а не игроку. Раньше они не сбрасывались
      // и копились через реванши: честный игрок, оставшийся в комнате на четвёртый забег, приносил
      // в него запас, израсходованный в первых трёх, и терял зачёт ни за что.
      movementAnomalies: {},
      movementHistory: [],
      freeFallSince: null,
      // Независимая история co-op audit. Она сбрасывается на каждый matchId так же, как race
      // verification, чтобы реванш не наследовал аномалии предыдущего забега.
      coopMovementAnomalies: {},
      coopMovementHistory: [],
      coopFreeFallSince: null,
      coopLastCheckpointAt: room.startedAt,
      coopMotionException: null,
      // Готовность снимается: следующий выход в лобби не должен начинаться с чужого «готов»
      // прошлого забега. На реванш это не влияет — он идёт мимо лобби.
      ready: false,
      resultChoice: null
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

// Решение на экране результатов: пора ли распускать комнату в лобби.
//
// Считать это только в момент голосования нельзя. Если один уже проголосовал, а второй оборвался,
// активным остаётся один — и условие «все проголосовали» выполнено, но пересчитать его некому:
// повторно голосовать первый не может, его голос уже учтён. Комната зависала на результатах
// навсегда. Поэтому пересчёт вызывается и на голос, и на обрыв, и на освобождение слота.
function resolveResultsDecision(room, now = Date.now()) {
  if (room.state !== ROOM_STATE.RESULTS) return false;
  const active = [...room.players.values()].filter(player => !player.disconnectedAt);
  if (!active.length) return false;

  const decided = active.every(player => player.resultChoice);
  const expired = !!room.resultsDeadline && now >= room.resultsDeadline;
  if (!decided && !expired) {
    emitLobby(room);
    return false;
  }

  // Состава должно хватать на забег. Кооперативную главу проходят вдвоём, и запускать её на
  // одного, когда напарник оборвался, бессмысленно: игрок упрётся в первую же плиту, которую
  // некому держать. Такой случай уводим в лобби — оттуда видно, что напарника ждут.
  const enoughPlayers = room.mode === GAME_MODE.COOP ? active.length === 2 : active.length > 0;

  // Продолжение кампании сохраняет сокеты, комнату, порядок пары и сразу запускает следующую
  // главу. Готовность и промежуточное лобби здесь только ломали бы непрерывность приключения.
  if (
    room.mode === GAME_MODE.COOP &&
    enoughPlayers &&
    decided &&
    active.every(player => player.resultChoice === 'next')
  ) {
    if (operationalState.isDraining()) {
      broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      return true;
    }
    const current = COOP_CHAPTER_IDS.indexOf(room.chapterId);
    const nextChapterId = COOP_CHAPTER_IDS[current + 1];
    if (nextChapterId) {
      room.chapterId = nextChapterId;
      room.spec = coopSpec(nextChapterId);
      gameplay.count('next_chapter', dims(room, active[0]));
      for (const player of active) gameplay.count('pair_continued', dims(room, player, 'next'));
      log('info', 'next_chapter', { roomId: room.code, chapterId: nextChapterId });
      beginCountdown(room);
      return true;
    }
    for (const player of active) gameplay.count('pair_continued', dims(room, player, 'final-rematch'));
    beginCountdown(room);
    return true;
  }

  // Реванш — только единогласно и только явным выбором. Во всех остальных исходах уходим в лобби:
  // и когда кто-то выбрал лобби, и когда время вышло, а кто-то так и не решил. Молчание не должно
  // толковаться как согласие на ещё один забег — человек мог просто отложить телефон.
  if (enoughPlayers && decided && active.every(player => player.resultChoice === 'rematch')) {
    if (operationalState.isDraining()) {
      broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      return true;
    }
    if (room.mode === GAME_MODE.COOP)
      for (const player of active) gameplay.count('pair_continued', dims(room, player, 'rematch'));
    log('info', 'rematch', { roomId: room.code, players: active.length });
    beginCountdown(room);
    return true;
  }
  if (room.mode === GAME_MODE.COOP && !room.pairEndedTracked) {
    room.pairEndedTracked = true;
    for (const player of active)
      gameplay.count('pair_ended', dims(room, player, expired ? 'timeout' : 'choice'));
  }
  resetLobby(room);
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
  trackEvent(productEvents, 'matchCompleted');
  // Потолок ожидания решения. Без него комната жила в RESULTS до последнего обрыва связи: один
  // отложил телефон — и второй заперт на карточке итогов, не имея ни одной кнопки, которая
  // что-то изменит.
  room.resultsDeadline = Date.now() + RESULTS_TIMEOUT_MS;
  const board = leaderboard(room);
  for (const entry of board) {
    const player = room.players.get(entry.id);
    gameplay.count('match_finished', dims(room, player));
    // Время забега — единственная величина, которую стоит усреднять: по ней видно, стала ли
    // трасса проходиться быстрее после правки, и на каком устройстве она даётся тяжелее.
    //
    // Отметка проверки идёт отдельным измерением, а не фильтром. Непроверенный забег всё равно
    // полезен для продуктовой аналитики: он показывает длительность попытки, но не участвует в
    // competitive leaderboard и не смешивается со средним подтверждённых прохождений.
    gameplay.observe(
      'finish_time',
      entry.time,
      dims(room, player, entry.verified ? 'verified' : 'unverified')
    );
    incidentForSocket(player?.ws, {
      accountId: player?.accountId,
      kind: 'match',
      code: 'completed',
      roomId: room.code,
      matchId: room.matchId,
      mode: room.mode,
      phase: room.state,
      valueMs: entry.time
    });
  }
  const verificationFailed = board.some(entry => !entry.verified);
  const coopTime = board.length ? Math.max(...board.map(entry => entry.time)) : null;
  if (room.mode === GAME_MODE.COOP) {
    for (const player of room.players.values()) gameplay.count('chapter_completed', dims(room, player));
  }
  // Итоги сохраняются, а не только рассылаются: их надо будет отдать заново тому, кто вернулся
  // по resume уже на экране результатов.
  room.results = {
    type: S2C.MATCH_RESULTS,
    matchId: room.matchId,
    mode: room.mode,
    hasNextChapter:
      room.mode === GAME_MODE.COOP && COOP_CHAPTER_IDS.indexOf(room.chapterId) < COOP_CHAPTER_IDS.length - 1,
    board,
    // В коопе засчитывается время последнего дошедшего: команда финиширует вместе.
    coopTime,
    unranked: room.unranked || (verificationFailed ? 'verification' : null),
    trusted: !room.unranked && !verificationFailed
  };
  // В публичную таблицу идут только trusted online-забеги. В race движение проверяется по
  // процедурной геометрии, в coop — отдельным data-driven CoopMovementAudit с известными
  // исключениями механик. Соло в таблицу не идёт: сервера там нет, и подтвердить движение некому.
  if (room.results.trusted) {
    verifiedLeaderboard.record({
      matchId: room.matchId,
      mode: room.mode,
      courseKey: courseKeyFor(room.mode, room.spec),
      // Анонимный идентификатор подставляется здесь, а не в leaderboard(): board уходит в рассылку
      // всем игрокам комнаты, и чужой ключ в нём означал бы, что перезаписать чужую строку в
      // таблице может любой, кто был с человеком в одном матче.
      entries: board.map(entry => ({
        ...entry,
        playerId: room.players.get(entry.id)?.anonymousId || null
      }))
    });
    if (room.mode === GAME_MODE.COOP && coopTime) {
      const accountIds = [];
      for (const player of room.players.values()) {
        if (!player.accountId) continue;
        accountIds.push(player.accountId);
        accounts.recordCoopCompletion({
          accountId: player.accountId,
          chapterId: room.chapterId,
          timeMs: coopTime,
          revives: player.coopRevives || 0,
          falls: player.coopFalls || 0
        });
      }
      accounts.recordCoopPartners({ accountIds, chapterId: room.chapterId });
    }
  }
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
  if (wss.clients.size > MAX_ACTIVE_SOCKETS) {
    metrics.capacityRejected++;
    sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервер заполнен. Попробуйте подключиться позже.', false);
    ws.close(1013, 'server capacity');
    return;
  }
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
  ws.accountId = null;
  ws.isAlive = true;
  ws.limiter = new RateLimiter();
  // По User-Agent, один раз при подключении: игрок его в середине матча не меняет.
  ws.device = deviceFromUserAgent(req.headers['user-agent']);
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

    if (message.type === C2S.AUTH) {
      const authenticated = networkIdentity.authenticate(ws, message.ticket);
      if (!authenticated.ok) {
        const code =
          authenticated.reason === 'already-bound'
            ? ERROR_CODES.AUTH_ALREADY_BOUND
            : authenticated.reason === 'unavailable'
              ? ERROR_CODES.AUTH_UNAVAILABLE
              : authenticated.reason === 'blocked-account'
                ? ERROR_CODES.ACCOUNT_SANCTIONED
                : ERROR_CODES.AUTH_FAILED;
        const detail =
          authenticated.reason === 'already-bound'
            ? 'Аккаунт уже привязан к этому соединению.'
            : authenticated.reason === 'unavailable'
              ? 'Сетевая авторизация временно недоступна.'
              : authenticated.reason === 'blocked-account'
                ? 'Онлайн-доступ аккаунта ограничен модерацией.'
                : 'WebSocket ticket недействителен, истёк или уже использован.';
        sendError(ws, code, detail, false);
        if (authenticated.reason === 'blocked-account') {
          bindDeniedSocketToRoomForEnforcement(ws, ws.accountAccessDeniedAccountId);
          incidentForSocket(ws, {
            accountId: ws.accountAccessDeniedAccountId,
            kind: 'auth',
            code: 'account-sanctioned'
          });
          try {
            ws.close(4003, 'account-sanctioned');
          } catch {
            // The account remains blocked by the server-side policy even if close races transport teardown.
          }
        }
        return;
      }
      bindAuthenticatedSocketToRoom(ws, authenticated.accountId);
      incidentForSocket(ws, { accountId: authenticated.accountId, kind: 'auth', code: 'authenticated' });
      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });
    }

    if (message.type === C2S.LEAVE_ROOM) return leave(ws);

    if (message.type === C2S.RESUME) {
      if (resume(ws, message.token)) return;
      metrics.resumeFailed++;
      if (ws.accountAccessDenied) {
        incidentForSocket(ws, {
          accountId: ws.accountAccessDeniedAccountId,
          kind: 'auth',
          code: 'account-sanctioned'
        });
        log('info', 'resume_sanctioned', { playerId: ws.id });
        sendError(ws, ERROR_CODES.ACCOUNT_SANCTIONED, 'Онлайн-доступ аккаунта ограничен модерацией.', false);
        try {
          ws.close(4003, 'account-sanctioned');
        } catch {
          // The access decision is already final; close failure cannot authorize the socket.
        }
        return;
      }
      log('info', 'resume_failed', { playerId: ws.id });
      return send(ws, { type: S2C.RESUME_FAILED, code: ERROR_CODES.RECONNECT_EXPIRED });
    }

    if (
      message.type === C2S.CREATE_ROOM ||
      message.type === C2S.JOIN_ROOM ||
      message.type === C2S.FIND_COOP
    ) {
      if (
        message.protocolVersion !== undefined &&
        message.protocolVersion !== PROTOCOL_VERSION &&
        message.protocolVersion !== PROTOCOL_VERSION - 1
      ) {
        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);
      }
      if (ipRateLimited(ws.ip)) {
        return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком много запросов. Подождите минуту.');
      }
    }

    if (message.type === C2S.CANCEL_MATCHMAKING) {
      const index = coopMatchmaking.findIndex(entry => entry.ws === ws);
      if (index !== -1) {
        coopMatchmaking.splice(index, 1);
        gameplay.count('matchmaking_queue_exit', {
          detail: 'cancel',
          device: ws.device || 'desktop'
        });
        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'button', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'cancelled', phase: 'matchmaking' });
      }
      return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });
    }

    if (message.type === C2S.FIND_COOP) {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (loadStatus().overloaded || rooms.size >= MAX_ROOMS) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      return enqueueCoop(ws, message);
    }

    // Свернувший вкладку игрок не должен оставаться кандидатом для случайного напарника. Это не
    // ready-check и не дополнительный клик: очередь просто честно отменяется, а событие измеряется.
    if (message.type === C2S.PRESENCE && !ws.room) {
      const index = coopMatchmaking.findIndex(entry => entry.ws === ws);
      if (message.away && index !== -1) {
        coopMatchmaking.splice(index, 1);
        gameplay.count('matchmaking_queue_exit', {
          detail: 'away',
          device: ws.device || 'desktop'
        });
        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'away', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'away', phase: 'matchmaking' });
        return send(ws, {
          type: S2C.MATCHMAKING_WAITING,
          cancelled: true,
          reason: 'away',
          waitedMs: 0
        });
      }
      return;
    }

    if (message.type === C2S.CREATE_ROOM) {
      leave(ws);
      if (loadStatus().overloaded) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервер перегружен. Попробуйте чуть позже.');
      }
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
        snapshotSequence: 0,
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
      trackEvent(productEvents, 'roomCreated');
      log('info', 'room_created', { roomId: code, mode });
      addPlayer(room, ws, message.name, message.playerId);
      incidentForSocket(ws, { kind: 'room', code: 'created' });
      return;
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
      trackEvent(productEvents, 'roomJoined');
      addPlayer(room, ws, message.name, message.playerId);
      incidentForSocket(ws, { kind: 'room', code: 'joined' });
      return;
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
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (capacityStatus().matchesFull) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Все игровые слоты заняты. Попробуйте чуть позже.');
      }
      const active = [...room.players.values()].filter(item => !item.disconnectedAt);
      if (room.mode === GAME_MODE.COOP && active.length !== 2) {
        return sendError(ws, ERROR_CODES.NOT_READY, 'Для кооператива нужны ровно два игрока на связи.');
      }
      if (!active.length || !active.every(item => item.ready)) {
        return sendError(ws, ERROR_CODES.NOT_READY, 'Все игроки должны быть готовы.');
      }

      return beginCountdown(room);
    }

    if (message.type === C2S.PLAYER_STATE) {
      // Сообщения прошлого забега приходят после рестарта и не должны применяться.
      if (message.matchId && message.matchId !== room.matchId) return;
      // После reconnect старый и новый сокеты могут кратко пересечься. Номер состояния не даёт
      // запоздавшему пакету откатить игрока к уже пройденной позиции.
      if (message.sequence <= (player.lastSequence ?? -1)) return;
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
      addVerificationFindings(room, player, verificationFindingsForState(room, player, result.state, now));
      verifyPlayerProgress(room, player, result.checkpoint, result.state, now);
      player.last = { ...result.state, id: player.id };
      player.lastAt = now;
      player.lastSequence = message.sequence;
      trackCheckpointDuration(room, player, result.checkpoint, now);
      if (result.checkpoint > player.checkpoint) trackEvent(productEvents, 'checkpointReached');
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
      trackSignatureMetrics({ room, player, message, result, gameplay, dimensions: dims });
      if (result.relay) {
        if (result.relay.action === 'launch') {
          // Исключение выдаёт сервер и только тому, кого действительно подбросила прошедшая все
          // проверки катапульта. Клиент сам объявить себе «режим быстрого полёта» не может.
          const target = room.players.get(result.relay.target);
          if (target) noteAuthoritativeLaunch(target);
        }
        if (result.relay.action === 'revive') {
          room.coopRevives = (room.coopRevives || 0) + 1;
          player.coopRevives = (player.coopRevives || 0) + 1;
        }
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, ...result.relay });
      }
      return;
    }

    if (message.type === C2S.COOP_PING) {
      if (room.mode !== GAME_MODE.COOP) return;
      gameplay.count('coop_ping', dims(room, player, message.command));
      return broadcast(room, {
        type: S2C.COOP_PING,
        matchId: room.matchId,
        id: player.id,
        command: message.command,
        at: Date.now()
      });
    }

    if (message.type === C2S.RESPAWN) {
      const now = Date.now();
      if (now - (player.lastRespawn || 0) < 450) return;
      player.lastRespawn = now;
      if (room.mode === GAME_MODE.COOP) {
        // В кооперативе падение — не откат, а ожидание напарника: игрок появляется у последнего
        // чекпоинта, но остаётся «упавшим», пока его не поднимут.
        if (markDowned(player, now)) {
          player.coopFalls = (player.coopFalls || 0) + 1;
          trackEvent(productEvents, 'playerDowned');
          // В кооперативе трасса рукотворная, и «тип сегмента» к ней неприменим. Место
          // обозначается пройденным чекпоинтом: этого хватает, чтобы найти участок в разметке.
          gameplay.count('fall', dims(room, player, `cp${player.checkpoint}`));
        }
        const point = coopSpawnFor(room.spec, player.checkpoint, player.slot);
        resetHistory(player);
        resetCoopMotionHistory(player);
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
      // Главный вопрос про падения — не «сколько», а «где». Место берётся по последнему
      // положению, которое сервер успел принять: именно оттуда игрок и полетел вниз.
      gameplay.count('fall', dims(room, player, segmentTypeAt(room.spec, player.last?.z ?? 0)));
      // Возрождение переносит игрока на чекпоинт. История движения до падения к новому месту
      // отношения не имеет, и окно свободного падения обязано начаться заново.
      resetHistory(player);
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
      if (message.sequence <= (player.lastSequence ?? -1)) return;

      // Финальная позиция приезжает внутри самого финиша и применяется здесь же — без
      // ограничения «не чаще раза в 32 мс», которое действует на поток обычных состояний.
      //
      // Раньше клиент слал её отдельным пакетом непосредственно перед финишем, и она попадала
      // ровно в это окно: обычные позиции идут раз в 66 мс, поэтому примерно в половине случаев
      // финальная терялась молча. Финиш проверялся по точке ПЕРЕД лентой и отклонялся, а игрок
      // видел «Финиш не засчитан» после честно пройденной трассы. Теперь позиция и завершение —
      // одна операция.
      const now = Date.now();
      const result = validateState(player, message.state, room.spec, now);
      if (result.ok) {
        addVerificationFindings(room, player, verificationFindingsForState(room, player, result.state, now));
        verifyPlayerProgress(room, player, result.checkpoint, result.state, now);
        player.last = { ...result.state, id: player.id };
        player.lastAt = now;
        player.receivedAt = now;
        trackCheckpointDuration(room, player, result.checkpoint, now);
        if (result.checkpoint > player.checkpoint) trackEvent(productEvents, 'checkpointReached');
        player.checkpoint = result.checkpoint;
        player.lastSequence = message.sequence;
      }

      // Последний отрезок тоже входит в verification boundary. У гонки и коопа разные
      // геометрия и физические исключения, но итог один: мгновенный выход к ленте не становится
      // подтверждённым результатом.
      const tail =
        room.mode === GAME_MODE.COOP
          ? verifyCoopFinish(player, room.spec, player.last, now)
          : verifyFinishTime(player, now);
      if (tail) addVerificationFindings(room, player, [tail.reason], tail);

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
        unranked: room.unranked || player.verificationReasons[0] || null,
        trusted: !room.unranked && player.verificationReasons.length === 0
      });
      return checkMatchEnd(room);
    }

    // Реванш — единогласное решение, а не команда хоста.
    //
    // Раньше голос хоста мгновенно распускал комнату в лобби. На экране результатов это выглядело
    // так: один нажал «реванш» — и карточка исчезла у обоих, второй просто не успевал ничего
    // нажать. Теперь голос — это голос: комната остаётся в RESULTS, пока не проголосуют все,
    // кто на связи, а рассылка состояния показывает счёт голосов.
    // Выбор можно менять, пока комната не решила: передумать — нормальное поведение, а запрет
    // на смену и создавал тупик. Пересчёт после каждого нажатия.
    if (message.type === C2S.REMATCH_VOTE) {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (player.resultChoice === 'rematch') return;
      player.resultChoice = 'rematch';
      return resolveResultsDecision(room);
    }

    if (message.type === C2S.NEXT_CHAPTER_VOTE) {
      // В гонке и после последней главы такой кнопки нет; поддельное сообщение не меняет выбор.
      const current = COOP_CHAPTER_IDS.indexOf(room.chapterId);
      if (room.mode !== GAME_MODE.COOP || current < 0) {
        return sendError(ws, ERROR_CODES.WRONG_STATE, 'Следующей главы сейчас нет.');
      }
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (player.resultChoice === 'next') return;
      player.resultChoice = 'next';
      gameplay.count('next_chapter_vote', dims(room, player));
      return resolveResultsDecision(room);
    }

    // Возврат в лобби — тоже общее решение. Хост здесь не привилегирован по той же причине:
    // его нажатие закрывало карточку результатов остальным.
    if (message.type === C2S.RETURN_TO_LOBBY) {
      if (player.resultChoice === 'lobby') return;
      player.resultChoice = 'lobby';
      return resolveResultsDecision(room);
    }
  }

  ws.on('close', () => handleDisconnect(ws));
  // `error` тоже ведёт к разрыву, но состояние меняем один раз — этим занимается
  // `disconnectHandled` внутри. Здесь только причина в лог.
  ws.on('error', error => {
    incidentForSocket(ws, { kind: 'connection', code: 'socket-error' });
    log('warn', 'socket_error', { playerId: ws.id, message: error?.message });
    handleDisconnect(ws);
  });
});

let snapshotTick = 0;
const snapshotTimer = setInterval(() => {
  const now = Date.now();
  snapshotTick++;
  // При перегрузке отправляем два тика из трёх: частота падает с 15 до 10 Гц, но таймеры комнат
  // и переход COUNTDOWN → PLAYING продолжают обрабатываться на каждом тике.
  const skipBroadcast = loadStatus().overloaded && snapshotTick % 3 === 0;
  for (const room of rooms.values()) {
    // Истёк срок голосования на результатах — решаем без опоздавших. Проверка живёт здесь, а не
    // в отдельном таймере на комнату: таймеры пришлось бы заводить, снимать и не забывать снимать
    // при роспуске, а этот цикл и так обходит все комнаты каждый тик.
    if (room.state === ROOM_STATE.RESULTS && room.resultsDeadline && now >= room.resultsDeadline) {
      resolveResultsDecision(room, now);
      continue;
    }

    // Комната без активного матча не участвует в рассылке вообще (ТЗ 12.5).
    if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) continue;

    // Отсчёт закончился — переводим комнату в игру.
    if (room.state === ROOM_STATE.COUNTDOWN && now >= room.startedAt) {
      setRoomState(room, ROOM_STATE.PLAYING);
    }

    if (skipBroadcast) {
      metrics.snapshotsSkippedForLoad++;
      continue;
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
      {
        type: S2C.SNAPSHOT,
        matchId: room.matchId,
        sequence: room.snapshotSequence++,
        serverTime: now,
        players
      },
      { dropIfCongested: true }
    );
  }
}, 66);
snapshotTimer.unref();

function pruneIncidentDiagnostics(now = Date.now()) {
  try {
    return incidentDiagnostics.pruneExpired(now);
  } catch {
    // Diagnostics are observability only. A retention cleanup failure must never stop gameplay.
    process.stderr.write('[wobble] incident_diagnostics_housekeeping_failed\n');
    return 0;
  }
}

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
  pruneIncidentDiagnostics(now);

  // Игроки, не вернувшиеся за отведённое время, освобождают слот и считаются
  // abandon только после истечения grace period — краткий обрыв с успешным resume им не является.
  expireDisconnectedPlayers(now);
  for (const room of [...rooms.values()]) {
    if (room.state === ROOM_STATE.PLAYING && room.mode === GAME_MODE.COOP) {
      // Упавший поднимается сам по истечении срока — иначе пара, где один отошёл от устройства,
      // застряла бы в главе навсегда.
      for (const id of autoRevive(room, now)) {
        room.coopRevives = (room.coopRevives || 0) + 1;
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, action: 'revive', target: id });
      }
    }
    // Если все ушли из матча, он не должен висеть в PLAYING до истечения TTL.
    if (room.state === ROOM_STATE.PLAYING) checkMatchEnd(room);
  }

  // Сброс раз в пятнадцать секунд, вместе с прочей уборкой: копить дольше незачем, а писать
  // чаще — значит платить обращением к диску за каждое падение в пропасть.
  gameplay.flush();
  expireSessions(now);
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) rooms.delete(code);
  ipRoomOps.cleanup(now, { force: true });
  for (const [, limiter] of Object.values(httpLimits)) limiter.cleanup(now, { force: true });
}, 15000);
heartbeatTimer.unref();

const port = process.env.PORT || 3000;

// К какому интерфейсу привязываться.
//
// По умолчанию — ко всем: так работает на платформах вроде Render, где снаружи слушает их
// собственный балансировщик. На своём VPS за Nginx правильнее `HOST=127.0.0.1`: тогда порт 3000
// не виден из интернета вовсе и попасть в игру можно только через прокси, где стоит TLS,
// заголовки безопасности и ограничения.
const host = process.env.HOST || '0.0.0.0';
// Корректное завершение по сигналу от systemd или Docker.
//
// Без него `systemctl restart` рвал соединения посреди забега: игроки видели обычный обрыв связи
// и уходили в переподключение — к серверу, которого ещё нет. Клиент честно ждал и повторял,
// потому что отличить «сеть моргнула» от «сервер выключается» ему было нечем. Обновление игры
// выглядело как поломка сети, и происходило это при каждом развёртывании.
//
// Порядок важен: сначала снимаем готовность и перестаём брать новых, потом предупреждаем тех,
// кто уже играет, и только затем закрываем.
const GOODBYE_MS = 300;

function shutdown(signal, { exitProcess = true } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal, rooms: rooms.size, sessions: sessions.size });

  clearInterval(snapshotTimer);
  clearInterval(eventLoopTimer);
  eventLoopDelay.disable();
  clearInterval(heartbeatTimer);

  // Предупреждение уходит ДО закрытия сокетов, иначе клиент увидит только обрыв. Состояние комнат
  // живёт в памяти процесса и переживёт перезапуск: честно говорим, что комната потеряна, вместо
  // того чтобы обещать восстановление, которого не будет.
  for (const room of rooms.values()) {
    broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
  }

  // Небольшая пауза, чтобы предупреждение успело уйти в сеть. Закрывать сокет в том же тике —
  // значит отправить сообщение в никуда: оно останется в буфере отправки.
  setTimeout(() => {
    for (const client of wss.clients) {
      // 1001 — «going away», штатный код именно для выключения сервера.
      try {
        client.close(1001, 'Server restarting');
      } catch {
        // Сокет мог отвалиться сам, пока мы шли по списку. Это не мешает завершению.
      }
    }
    wss.close();
    server.close(() => {
      // База закрывается до выхода: в режиме WAL это дописывает журнал в основной файл, и рекорды
      // не зависят от того, успеет ли это сделать следующий запуск.
      try {
        // Накопленное с последнего сброса — тоже данные. Пятнадцать секунд статистики теряются
        // при каждом развёртывании, а развёртываний бывает много.
        gameplay.flush();
        gameDb.close();
      } catch (error) {
        log('warn', 'database_close_failed', { error: error.message });
      }
      log('info', 'shutdown_complete', {});
      // exitProcess снимается в тестах: выход из процесса убил бы сам прогон. Проверять поведение
      // выключения нужно, а единственная его часть, которую нельзя выполнить внутри теста, —
      // как раз завершение процесса.
      if (exitProcess) process.exit(0);
    });
    // Страховка: одно зависшее соединение не должно задерживать перезапуск навсегда. systemd
    // всё равно добьёт процесс по своему таймауту, но лучше уйти самим и с нулевым кодом.
    setTimeout(() => {
      log('warn', 'shutdown_forced', {});
      if (exitProcess) process.exit(0);
    }, 3000).unref();
  }, GOODBYE_MS).unref();
}

if (require.main === module) {
  server.listen(port, host, () =>
    log('info', 'server_started', { port, host, version: build.version, commit: build.commit })
  );
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Сброс счётчиков по адресу. Нужен тестам: они ходят с одного 127.0.0.1 и за минуту создают
// комнат больше, чем позволено живому человеку. Без сброса набор разваливался непредсказуемо —
// падал тот тест, который случайно пересёк границу окна.
function resetRateLimits() {
  ipRoomOps.clear();
  ipConnections.clear();
  for (const [, limiter] of Object.values(httpLimits)) limiter.clear();
}

module.exports = {
  app,
  server,
  resetRateLimits,
  rooms,
  sessions,
  metrics,
  verifiedLeaderboard,
  accounts,
  gameplay,
  incidentDiagnostics,
  pruneIncidentDiagnostics,
  socialSafety,
  coopMatchCompatible,
  beginOperationalDrain,
  leave,
  resetLobby,
  originAllowed,
  positiveInt,
  capacityStatus,
  loadStatus,
  health,
  matchmakingStatus,
  addVerificationFindings,
  verificationFindingsForState,
  verifyPlayerProgress,
  rotateEventLoopWindow,
  EVENT_LOOP_WINDOW_MS,
  createEventCounters,
  trackEvent,
  setResultsTimeout,
  expireDisconnectedPlayers,
  expireSessions,
  revokeAccountReconnectSessions,
  SESSION_TTL_MS,
  shutdown
};
