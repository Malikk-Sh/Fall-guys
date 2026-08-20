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
const { preloadBots, spawnBots, resetBots, stepBots, clearBots, placeBotsOnGrid } = require('./roomBots');
const { raceSpawnFor } = require('../shared/raceGrid.js');
const { assignRaceSlots } = require('./raceSlots');
const { ShadowInputRuntime, SERVER_SIMULATION_INTERVAL_MS } = require('./shadowInputRuntime');

// Модель бота загружается здесь, а не только в bootstrap: иначе любая точка входа, берущая
// index.js напрямую, молча оставалась бы без ботов — и добор в подборе не срабатывал бы, ничего
// об этом не сообщая. Вызов идемпотентен, ошибку разбирает bootstrap, где есть структурный лог.
preloadBots().catch(() => {});

// Засчитывать ли ботов соперниками при выдаче наград за гонку.
//
// Решение продуктовое, а не техническое, поэтому вынесено отдельной константой: при true игрок,
// обогнавший ботов, получает «победу» и «пьедестал» так же, как за обгон людей — включая
// приватную комнату, где ботов позвал он сам. При false награды требуют живых соперников, а боты
// остаются украшением гонки.
const BOTS_COUNT_AS_OPPONENTS = true;
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
const shadowInputRuntime = new ShadowInputRuntime();

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
  shadowSimulation: shadowInputRuntime.metrics(),
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
  C2S.CLIENT_INPUT,
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
  loadout,
  bot
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
  away: !!away,
  // Игрок вправе знать, с кем соревнуется. Признак идёт в каждом пакете о составе комнаты, а не
  // только в итогах: соперника видно с первой секунды, и с первой же секунды понятно, кто он.
  bot: !!bot
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
  // Момент, когда публичная гонка стартует сама. null у приватных комнат и пока не собран минимум.
  // Как и resultsDeadline — момент, а не остаток: часы синхронизированы, а присланный числом
  // остаток начал бы врать при первой задержке пакета.
  fillDeadline: room.matchmade ? room.fillDeadline || null : null,
  minPlayers: room.matchmade ? MIN_RACE_PLAYERS : null,
  players: [...room.players.values()].map(publicPlayer)
});

const emitLobby = room => broadcast(room, lobbyPayload(room));

function assignSlots(room) {
  const ordered = [...room.players.values()].sort((a, b) => a.joinOrder - b.joinOrder);
  ordered.forEach((player, index) => {
    player.slot = index;
  });
}

function resetLobby(room, { newSeed = false } = {}) {
  clearBots(room);
  setRoomState(room, ROOM_STATE.LOBBY);
  room.startedAt = null;
  room.matchId = null;
  room.firstFinishAt = null;
  room.results = null;
  room.unranked = null;
  room.resultsDeadline = null;
  room.updatedAt = Date.now();
  room.matchmade = false;
  room.fillDeadline = null;
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
  const humans = [...room.players.values()].filter(player => !player.bot);
  if (!humans.length) {
    clearBots(room);
    setRoomState(room, ROOM_STATE.CLOSING);
    rooms.delete(room.code);
    log('info', 'room_closed', { roomId: room.code });
    return;
  }
  if (room.host === playerId) {
    const previousHostId = room.host;
    const candidates = humans.sort((a, b) => {
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

function handleDisconnect(ws) {
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
  if (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)
    markUnranked(room, 'disconnect');
  if (ws.token) {
    const session = sessions.get(ws.token);
    if (session) session.expiresAt = Date.now() + SESSION_TTL_MS;
  }
  log('info', 'player_disconnected', { roomId: room.code, playerId: ws.id });
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

function addPlayer(room, ws, name) {
  ws.room = room.code;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  const authenticated = networkIdentity.accountForSocket(ws, accounts);
  const playerName = authenticated?.name ? safeName(authenticated.name) : safeName(name);
  room.players.set(ws.id, {
    id: ws.id,
    name: playerName,
    anonymousId: authenticated?.id || null,
    accountId: authenticated?.id || null,
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
  if (session && session.playerId === ws.id && session.roomCode === room.code) session.accountId = id;
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
  addPlayer(room, partner.ws, partner.name);
  addPlayer(room, ws, message.name);
  for (const player of room.players.values()) player.ready = true;
  for (const player of room.players.values()) gameplay.count('match_found', dims(room, player));
  gameplay.observe('matchmaking_wait_ms', now - partner.queuedAt, dims(room, room.players.get(partner.ws.id)));
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

const MIN_RACE_PLAYERS = 2;
const RACE_FILL_MS = 25_000;
const RACE_BOT_FIELD = 4;
const RACE_BOT_SKILLS = Object.freeze(['rookie', 'steady', 'sharp']);

function connectedPlayers(room) {
  let count = 0;
  for (const player of room.players.values()) if (!player.disconnectedAt) count += 1;
  return count;
}

function connectedHumans(room) {
  let count = 0;
  for (const player of room.players.values()) if (!player.disconnectedAt && !player.bot) count += 1;
  return count;
}

function stillRacing(room) {
  let count = 0;
  for (const player of room.players.values()) {
    if (player.finished || player.disconnectedAt) continue;
    count += 1;
  }
  return count;
}

function openRaceRoomFor(ws, difficulty, safety = socialSafety) {
  for (const room of rooms.values()) {
    if (room.mode !== GAME_MODE.RACE || !room.matchmade) continue;
    if (room.state !== ROOM_STATE.LOBBY) continue;
    if (difficulty && room.spec.difficulty !== difficulty) continue;
    if (room.players.size >= MAX_PLAYERS[GAME_MODE.RACE]) continue;
    let blocked = false;
    for (const player of room.players.values()) {
      if (safety.shouldAvoid(ws.accountId, player.accountId)) {
        blocked = true;
        break;
      }
    }
    if (!blocked) return room;
  }
  return null;
}

function createMatchmadeRaceRoom(difficulty, hostId) {
  const code = roomCode();
  const room = {
    code,
    host: hostId,
    state: ROOM_STATE.LOBBY,
    mode: GAME_MODE.RACE,
    chapterId: null,
    matchId: null,
    snapshotSequence: 0,
    startedAt: null,
    firstFinishAt: null,
    spec: createCourseSpec(randomSeed(), difficulty),
    players: new Map(),
    nextJoinOrder: 0,
    matchmade: true,
    fillDeadline: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function startMatchmadeRace(room, reason) {
  room.fillDeadline = null;
  if (capacityStatus().matchesFull) {
    metrics.capacityRejected++;
    room.fillDeadline = Date.now() + RACE_FILL_MS;
    emitLobby(room);
    return false;
  }
  const now = Date.now();
  for (const player of room.players.values()) {
    if (player.disconnectedAt || player.bot) continue;
    gameplay.count('match_found', dims(room, player));
    if (player.queuedAt) gameplay.observe('matchmaking_wait_ms', now - player.queuedAt, dims(room, player));
  }
  trackEvent(productEvents, 'matchmakingMatched');
  log('info', 'race_matchmaking_started', {
    roomId: room.code,
    players: connectedPlayers(room),
    difficulty: room.spec.difficulty,
    reason
  });
  beginCountdown(room);
  return true;
}

function enqueueRace(ws, message) {
  if (operationalState.isDraining()) {
    send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    return false;
  }
  leave(ws);
  const requested = message.difficulty ? safeDifficulty(message.difficulty) : '';
  const now = Date.now();
  gameplay.count('queue_enter', { mode: GAME_MODE.RACE, course: requested || 'any', device: ws.device });
  const existing = openRaceRoomFor(ws, requested);
  const room = existing || createMatchmadeRaceRoom(safeDifficulty(requested), ws.id);
  addPlayer(room, ws, message.name);
  const player = room.players.get(ws.id);
  if (player) {
    player.ready = true;
    player.queuedAt = now;
  }
  if (!existing) {
    trackEvent(productEvents, 'matchmakingStarted');
    incidentForSocket(ws, { kind: 'matchmaking', code: 'queued', phase: 'matchmaking' });
  }
  const connected = connectedPlayers(room);
  if (connected >= MAX_PLAYERS[GAME_MODE.RACE]) {
    room.fillDeadline = null;
    log('info', 'race_matchmaking_full', { roomId: room.code, difficulty: room.spec.difficulty });
    return startMatchmadeRace(room, 'full');
  }
  if (!room.fillDeadline) room.fillDeadline = now + RACE_FILL_MS;
  emitLobby(room);
  return send(ws, {
    type: S2C.MATCHMAKING_WAITING,
    waitedMs: 0,
    roomCode: room.code,
    players: connected,
    minPlayers: MIN_RACE_PLAYERS,
    startsAt: room.fillDeadline
  });
}

function beginOperationalDrain() {
  if (!operationalState.beginDrain()) return false;
  const queued = coopMatchmaking.splice(0);
  for (const entry of queued) {
    incidentForSocket(entry.ws, { kind: 'matchmaking', code: 'restart', phase: 'matchmaking' });
    gameplay.count('matchmaking_queue_exit', { detail: 'restart', device: entry.ws?.device || 'desktop' });
  }
  for (const client of wss.clients) {
    if (!client.room && canSend(client)) send(client, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
  }
  return true;
}

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
  if (player.accountId && !networkIdentity.allowed(player.accountId)) {
    ws.accountAccessDenied = true;
    ws.accountAccessDeniedAccountId = player.accountId;
    return false;
  }
  if (!networkIdentity.bindResumedPlayer(ws, player)) return false;
  sessions.delete(ws.token);
  ws.id = session.playerId;
  ws.token = token;
  ws.room = room.code;
  const previousWs = player.ws;
  player.ws = ws;
  player.disconnectedAt = null;
  player.disconnectMatchContext = null;
  if (previousWs && previousWs !== ws) {
    previousWs.room = null;
    try {
      previousWs.close(4001, 'Session resumed elsewhere');
    } catch {}
  }
  player.away = false;
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  room.updatedAt = Date.now();
  metrics.reconnects++;
  metrics.resumeSucceeded++;
  trackEvent(productEvents, 'connectionRecovered');
  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'resumed' });
  send(ws, { type: S2C.RESUMED, id: ws.id, token: ws.token, serverTime: Date.now() });
  if (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING) {
    send(ws, {
      type: S2C.MATCH_START,
      at: room.startedAt,
      matchId: room.matchId,
      mode: room.mode,
      spec: room.spec,
      slots: Object.fromEntries([...room.players.values()].map(item => [item.id, item.slot])),
      resumed: {
        position: player.last || spawnFor(room.spec, player.checkpoint),
        raceSpawn: room.mode === GAME_MODE.RACE && player.raceSpawn ? { ...player.raceSpawn } : null,
        checkpoint: player.checkpoint || 0,
        finished: !!player.finished,
        downed: !!player.downed,
        nextSequence: (player.lastSequence ?? -1) + 1
      }
    });
  }
  if (room.state === ROOM_STATE.RESULTS && room.results) send(ws, room.results);
  emitLobby(room);
  log('info', 'player_resumed', { roomId: room.code, playerId: ws.id });
  return true;
}

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

function beginCountdown(room) {
  if (operationalState.isDraining()) {
    broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
    return false;
  }
  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;
  room.matchId = crypto.randomBytes(8).toString('hex');
  resetBots(room);
  if (room.mode === GAME_MODE.RACE) assignRaceSlots(room, room.matchId);
  else assignSlots(room);
  placeBotsOnGrid(room);
  room.snapshotSequence = 0;
  room.startedAt = Date.now() + COUNTDOWN_MS;
  room.firstFinishAt = null;
  room.coopRevives = 0;
  room.unranked = null;
  room.results = null;
  room.resultsDeadline = null;
  room.abandonTracked = false;
  room.pairEndedTracked = false;
  metrics.matchesStarted++;
  trackEvent(productEvents, 'matchStarted');
  for (const item of room.players.values()) {
    if (item.bot) continue;
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
  for (const item of room.players.values()) {
    const start =
      room.mode === GAME_MODE.COOP
        ? coopSpawnFor(room.spec, 0, item.slot)
        : raceSpawnFor(room.spec, item.slot, room.players.size);
    Object.assign(item, {
      finished: false,
      coopRevives: 0,
      coopFalls: 0,
      time: null,
      checkpoint: 0,
      raceSpawn: room.mode === GAME_MODE.RACE ? { ...start } : null,
      last: { ...start, ry: 0, vx: 0, vz: 0, state: 'ground', checkpoint: 0 },
      downed: false,
      downedAt: 0,
      lastAt: room.startedAt,
      lastSequence: -1,
      checkpointAt: room.startedAt,
      matchStartedAt: room.startedAt,
      unverifiedReason: null,
      verificationReasons: [],
      movementAnomalies: {},
      movementHistory: [],
      freeFallSince: null,
      coopMovementAnomalies: {},
      coopMovementHistory: [],
      coopFreeFallSince: null,
      coopLastCheckpointAt: room.startedAt,
      coopMotionException: null,
      ready: false,
      resultChoice: null
    });
  }
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

function resolveResultsDecision(room, now = Date.now()) {
  if (room.state !== ROOM_STATE.RESULTS) return false;
  const active = [...room.players.values()].filter(player => !player.disconnectedAt);
  const voters = active.filter(player => !player.bot);
  if (!voters.length) return false;
  const decided = voters.every(player => player.resultChoice);
  const expired = !!room.resultsDeadline && now >= room.resultsDeadline;
  if (!decided && !expired) {
    emitLobby(room);
    return false;
  }
  const enoughPlayers = room.mode === GAME_MODE.COOP ? voters.length === 2 : voters.length > 0;
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
  if (enoughPlayers && decided && voters.every(player => player.resultChoice === 'rematch')) {
    if (operationalState.isDraining()) {
      broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      return true;
    }
    if (room.mode === GAME_MODE.COOP)
      for (const player of active) gameplay.count('pair_continued', dims(room, player, 'rematch'));
    log('info', 'rematch', { roomId: room.code, players: voters.length });
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

function checkMatchEnd(room) {
  if (room.state !== ROOM_STATE.PLAYING) return;
  if (room.mode === GAME_MODE.COOP) {
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
  room.resultsDeadline = Date.now() + RESULTS_TIMEOUT_MS;
  const board = leaderboard(room);
  for (const entry of board) {
    const player = room.players.get(entry.id);
    if (player?.bot) continue;
    gameplay.count('match_finished', dims(room, player));
    gameplay.observe('finish_time', entry.time, dims(room, player, entry.verified ? 'verified' : 'unverified'));
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
  room.results = {
    type: S2C.MATCH_RESULTS,
    matchId: room.matchId,
    mode: room.mode,
    hasNextChapter:
      room.mode === GAME_MODE.COOP && COOP_CHAPTER_IDS.indexOf(room.chapterId) < COOP_CHAPTER_IDS.length - 1,
    board,
    coopTime,
    unranked: room.unranked || (verificationFailed ? 'verification' : null),
    trusted: !room.unranked && !verificationFailed
  };
  if (room.results.trusted) {
    verifiedLeaderboard.record({
      matchId: room.matchId,
      mode: room.mode,
      courseKey: courseKeyFor(room.mode, room.spec),
      entries: board.map(entry => ({ ...entry, playerId: room.players.get(entry.id)?.anonymousId || null }))
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
    if (room.mode === GAME_MODE.RACE) {
      const standings = room.results?.board || [];
      const bestByAccount = new Map();
      let botFinishers = 0;
      let position = 0;
      for (const entry of standings) {
        const participant = room.players.get(entry.id);
        if (participant?.bot) {
          if (!BOTS_COUNT_AS_OPPONENTS) continue;
          botFinishers += 1;
          position += 1;
          continue;
        }
        const accountId = participant?.accountId;
        if (!accountId) continue;
        position += 1;
        if (bestByAccount.has(accountId)) continue;
        bestByAccount.set(accountId, position);
      }
      const finishers = bestByAccount.size + botFinishers;
      for (const [accountId, place] of bestByAccount) accounts.recordRaceFinish({ accountId, place, finishers });
    }
  }
  broadcast(room, room.results);
  emitLobby(room);
  log('info', 'match_finished', { roomId: room.code, matchId: room.matchId, players: board.length });
}

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

  const CONNECTION_HANDLERS = Object.freeze({
    [C2S.PING]: message => send(ws, { type: S2C.PONG, at: message.at, serverTime: Date.now() }),
    [C2S.AUTH]: message => {
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
          incidentForSocket(ws, { accountId: ws.accountAccessDeniedAccountId, kind: 'auth', code: 'account-sanctioned' });
          try {
            ws.close(4003, 'account-sanctioned');
          } catch {}
        }
        return;
      }
      bindAuthenticatedSocketToRoom(ws, authenticated.accountId);
      incidentForSocket(ws, { accountId: authenticated.accountId, kind: 'auth', code: 'authenticated' });
      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });
    },
    [C2S.LEAVE_ROOM]: () => leave(ws),
    [C2S.RESUME]: message => {
      if (resume(ws, message.token)) return;
      metrics.resumeFailed++;
      if (ws.accountAccessDenied) {
        incidentForSocket(ws, { accountId: ws.accountAccessDeniedAccountId, kind: 'auth', code: 'account-sanctioned' });
        log('info', 'resume_sanctioned', { playerId: ws.id });
        sendError(ws, ERROR_CODES.ACCOUNT_SANCTIONED, 'Онлайн-доступ аккаунта ограничен модерацией.', false);
        try {
          ws.close(4003, 'account-sanctioned');
        } catch {}
        return;
      }
      log('info', 'resume_failed', { playerId: ws.id });
      return send(ws, { type: S2C.RESUME_FAILED, code: ERROR_CODES.RECONNECT_EXPIRED });
    }
  });

  const LOBBY_HANDLERS = Object.freeze({
    [C2S.CANCEL_MATCHMAKING]: () => {
      const raceRoom = rooms.get(ws.room);
      if (raceRoom?.matchmade && raceRoom.state === ROOM_STATE.LOBBY) {
        gameplay.count('queue_cancel', { mode: GAME_MODE.RACE, detail: 'button', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'cancelled', phase: 'matchmaking' });
        leave(ws);
        return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });
      }
      const index = coopMatchmaking.findIndex(entry => entry.ws === ws);
      if (index !== -1) {
        coopMatchmaking.splice(index, 1);
        gameplay.count('matchmaking_queue_exit', { detail: 'cancel', device: ws.device || 'desktop' });
        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'button', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'cancelled', phase: 'matchmaking' });
      }
      return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });
    },
    [C2S.FIND_COOP]: message => {
      if (operationalState.isDraining()) return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      if (loadStatus().overloaded || rooms.size >= MAX_ROOMS) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      return enqueueCoop(ws, message);
    },
    [C2S.FIND_RACE]: message => {
      if (operationalState.isDraining()) return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      if (loadStatus().overloaded) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      if (rooms.size >= MAX_ROOMS && !openRaceRoomFor(ws, safeDifficulty(message.difficulty))) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      return enqueueRace(ws, message);
    },
    [C2S.CREATE_ROOM]: message => {
      leave(ws);
      if (loadStatus().overloaded) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервер перегружен. Попробуйте чуть позже.');
      }
      if (rooms.size >= MAX_ROOMS) return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      const mode = message.mode === GAME_MODE.COOP ? GAME_MODE.COOP : GAME_MODE.RACE;
      const code = roomCode();
      const chapterId = COOP_CHAPTER_IDS.includes(message.difficulty) ? message.difficulty : COOP_CHAPTER_IDS[0];
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
      addPlayer(room, ws, message.name);
      incidentForSocket(ws, { kind: 'room', code: 'created' });
    },
    [C2S.JOIN_ROOM]: message => {
      leave(ws);
      const room = rooms.get(message.code.trim().toUpperCase());
      if (!room) return sendError(ws, ERROR_CODES.ROOM_NOT_FOUND, 'Комната не найдена. Проверьте код.');
      if (room.state !== ROOM_STATE.LOBBY)
        return sendError(ws, ERROR_CODES.MATCH_ALREADY_STARTED, 'Игра в этой комнате уже началась.');
      if (room.matchmade)
        return sendError(ws, ERROR_CODES.ROOM_NOT_FOUND, 'Это комната случайного подбора. Нажмите «Найти гонку».');
      if (room.players.size >= MAX_PLAYERS[room.mode])
        return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');
      trackEvent(productEvents, 'roomJoined');
      addPlayer(room, ws, message.name);
      incidentForSocket(ws, { kind: 'room', code: 'joined' });
    }
  });

  const ROOM_HANDLERS = Object.freeze({
    [C2S.ADD_BOTS]: (message, room) => {
      if (room.host !== ws.id) return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Соперников добавляет только хост.');
      if (room.matchmade) return sendError(ws, ERROR_CODES.WRONG_STATE, 'В случайной гонке соперников подбирает сервер.');
      if (room.mode !== GAME_MODE.RACE) return sendError(ws, ERROR_CODES.WRONG_STATE, 'Боты пока есть только в гонке.');
      const free = MAX_PLAYERS[GAME_MODE.RACE] - room.players.size;
      if (message.count > 0 && free <= 0) return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');
      const changed = addRoomBots(room, {
        count: message.count === 0 ? 0 : Math.min(message.count, free),
        skill: message.skill || RACE_BOT_SKILLS
      });
      if (!changed)
        return sendError(ws, ERROR_CODES.WRONG_STATE, message.count === 0 ? 'В комнате нет ботов.' : 'Соперники сейчас недоступны.');
      log('info', 'room_bots_changed', { roomId: room.code, delta: changed });
    },
    [C2S.PLAYER_READY]: (message, room, player) => {
      player.ready = message.ready;
      return emitLobby(room);
    },
    [C2S.HOST_CONFIGURE]: (message, room) => {
      if (room.host !== ws.id) return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Настройки меняет только хост.');
      if (room.matchmade) return sendError(ws, ERROR_CODES.WRONG_STATE, 'Настройки случайной гонки задаёт подбор.');
      if (message.difficulty !== undefined) {
        if (room.mode === GAME_MODE.COOP) {
          room.chapterId = COOP_CHAPTER_IDS.includes(message.difficulty) ? message.difficulty : room.chapterId;
          room.spec = coopSpec(room.chapterId);
        } else room.spec = createCourseSpec(randomSeed(), safeDifficulty(message.difficulty));
      }
      if (message.mode !== undefined && message.mode !== room.mode) {
        const humans = [...room.players.values()].filter(item => !item.bot);
        if (message.mode === GAME_MODE.COOP && humans.length > MAX_PLAYERS[GAME_MODE.COOP])
          return sendError(ws, ERROR_CODES.ROOM_FULL, 'Для кооператива в комнате должно быть не больше двух игроков.');
        if (message.mode === GAME_MODE.COOP) clearBots(room);
        room.mode = message.mode;
        room.spec =
          room.mode === GAME_MODE.COOP
            ? coopSpec(room.chapterId)
            : createCourseSpec(randomSeed(), room.spec.difficulty || 'normal');
        assignSlots(room);
      }
      for (const item of room.players.values()) if (!item.bot) item.ready = false;
      resetBots(room);
      return emitLobby(room);
    },
    [C2S.START_MATCH]: (message, room) => {
      if (room.host !== ws.id) return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Забег запускает только хост.');
      if (operationalState.isDraining()) return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      if (room.matchmade) return sendError(ws, ERROR_CODES.NOT_READY, 'Гонка начнётся сама, когда соберутся соперники.');
      if (capacityStatus().matchesFull) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Все игровые слоты заняты. Попробуйте чуть позже.');
      }
      const active = [...room.players.values()].filter(item => !item.disconnectedAt);
      if (room.mode === GAME_MODE.COOP && active.length !== 2)
        return sendError(ws, ERROR_CODES.NOT_READY, 'Для кооператива нужны ровно два игрока на связи.');
      if (!active.length || !active.every(item => item.ready))
        return sendError(ws, ERROR_CODES.NOT_READY, 'Все игроки должны быть готовы.');
      return beginCountdown(room);
    },
    [C2S.PLAYER_STATE]: (message, room, player) => {
      if (message.matchId && message.matchId !== room.matchId) return;
      if (message.sequence <= (player.lastSequence ?? -1)) return;
      if (Date.now() < room.startedAt - 300) return;
      const now = Date.now();
      if (now - (player.receivedAt || 0) < 32) return;
      player.receivedAt = now;
      const result = validateState(player, message.state, room.spec, now);
      if (!result.ok) {
        if (result.reason === 'speed') send(ws, { type: S2C.CORRECTION, position: result.position, reason: 'movement' });
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
    },
    [C2S.CLIENT_INPUT]: (message, room, player) => {
      shadowInputRuntime.accept({ player, room, message });
    },
    [C2S.PRESENCE]: (message, room, player) => {
      if (player.away === message.away) return;
      player.away = message.away;
      broadcast(room, { type: S2C.PLAYER_PRESENCE, id: player.id, away: player.away });
      emitLobby(room);
    },
    [C2S.COOP_EVENT]: (message, room, player) => {
      if (room.mode !== GAME_MODE.COOP) return sendError(ws, ERROR_CODES.WRONG_STATE, 'Это действие доступно только в кооперативе.');
      if (message.matchId && message.matchId !== room.matchId) return;
      const result = validateCoopEvent(room, player, message);
      if (!result.ok) return;
      trackSignatureMetrics({ room, player, message, result, gameplay, dimensions: dims });
      if (result.relay) {
        if (result.relay.action === 'launch') {
          const target = room.players.get(result.relay.target);
          if (target) noteAuthoritativeLaunch(target);
        }
        if (result.relay.action === 'revive') {
          room.coopRevives = (room.coopRevives || 0) + 1;
          player.coopRevives = (player.coopRevives || 0) + 1;
        }
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, ...result.relay });
      }
    },
    [C2S.COOP_PING]: (message, room, player) => {
      if (room.mode !== GAME_MODE.COOP) return;
      gameplay.count('coop_ping', dims(room, player, message.command));
      return broadcast(room, { type: S2C.COOP_PING, matchId: room.matchId, id: player.id, command: message.command, at: Date.now() });
    },
    [C2S.EMOTE]: (message, room, player) => {
      if (!player.accountId) return;
      if (!socialCosmetics.canPlayEmote(player.accountId, message.emoteId)) return;
      gameplay.count('emote', dims(room, player, message.emoteId));
      return broadcast(room, { type: S2C.PLAYER_EMOTE, id: player.id, emoteId: message.emoteId, at: Date.now() });
    },
    [C2S.RESPAWN]: (message, room, player) => {
      const now = Date.now();
      if (now - (player.lastRespawn || 0) < 450) return;
      player.lastRespawn = now;
      if (room.mode === GAME_MODE.COOP) {
        if (markDowned(player, now)) {
          player.coopFalls = (player.coopFalls || 0) + 1;
          trackEvent(productEvents, 'playerDowned');
          gameplay.count('fall', dims(room, player, `cp${player.checkpoint}`));
        }
        const point = coopSpawnFor(room.spec, player.checkpoint, player.slot);
        resetHistory(player);
        resetCoopMotionHistory(player);
        player.last = { ...point, ry: 0, vx: 0, vz: 0, state: 'air', checkpoint: player.checkpoint, id: player.id };
        player.lastAt = now;
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, action: 'downed', target: player.id });
        return send(ws, { type: S2C.CORRECTION, position: point, reason: 'respawn' });
      }
      const position = player.checkpoint === 0 && player.raceSpawn ? player.raceSpawn : spawnFor(room.spec, player.checkpoint);
      gameplay.count('fall', dims(room, player, segmentTypeAt(room.spec, player.last?.z ?? 0)));
      resetHistory(player);
      player.last = { ...position, ry: 0, vx: 0, vz: 0, state: 'air', checkpoint: player.checkpoint, id: player.id };
      player.lastAt = now;
      return send(ws, { type: S2C.CORRECTION, position, reason: 'respawn' });
    },
    [C2S.FINISH]: (message, room, player) => {
      if (player.finished) return;
      if (message.sequence <= (player.lastSequence ?? -1)) return;
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
      const tail =
        room.mode === GAME_MODE.COOP
          ? verifyCoopFinish(player, room.spec, player.last, now)
          : verifyFinishTime(player, now);
      if (tail) addVerificationFindings(room, player, [tail.reason], tail);
      if (!canFinish(player, room.spec)) {
        metrics.finishRejected++;
        log('info', 'finish_rejected', { roomId: room.code, matchId: room.matchId, playerId: player.id });
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
        racing: stillRacing(room),
        unranked: room.unranked || player.verificationReasons[0] || null,
        trusted: !room.unranked && player.verificationReasons.length === 0
      });
      return checkMatchEnd(room);
    },
    [C2S.REMATCH_VOTE]: (message, room, player) => {
      if (operationalState.isDraining()) return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      if (player.resultChoice === 'rematch') return;
      player.resultChoice = 'rematch';
      return resolveResultsDecision(room);
    },
    [C2S.NEXT_CHAPTER_VOTE]: (message, room, player) => {
      const current = COOP_CHAPTER_IDS.indexOf(room.chapterId);
      if (room.mode !== GAME_MODE.COOP || current < 0) return sendError(ws, ERROR_CODES.WRONG_STATE, 'Следующей главы сейчас нет.');
      if (operationalState.isDraining()) return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      if (player.resultChoice === 'next') return;
      player.resultChoice = 'next';
      gameplay.count('next_chapter_vote', dims(room, player));
      return resolveResultsDecision(room);
    },
    [C2S.RETURN_TO_LOBBY]: (message, room, player) => {
      if (player.resultChoice === 'lobby') return;
      player.resultChoice = 'lobby';
      return resolveResultsDecision(room);
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
    if (!validation.ok)
      return reject(validation.reason, ERROR_CODES.INVALID_MESSAGE, `Некорректное сообщение: ${validation.detail}`);
    if (!ws.limiter.allow(message.type))
      return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком часто. Немного подождите.');
    const connection = CONNECTION_HANDLERS[message.type];
    if (connection) return connection(message);
    if (
      message.type === C2S.CREATE_ROOM ||
      message.type === C2S.JOIN_ROOM ||
      message.type === C2S.FIND_COOP ||
      message.type === C2S.FIND_RACE
    ) {
      if (
        message.protocolVersion !== undefined &&
        message.protocolVersion !== PROTOCOL_VERSION &&
        message.protocolVersion !== PROTOCOL_VERSION - 1
      )
        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);
      if (ipRateLimited(ws.ip)) return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком много запросов. Подождите минуту.');
    }
    const lobbyAction = LOBBY_HANDLERS[message.type];
    if (lobbyAction) return lobbyAction(message);
    if (message.type === C2S.PRESENCE && !ws.room) {
      const index = coopMatchmaking.findIndex(entry => entry.ws === ws);
      if (message.away && index !== -1) {
        coopMatchmaking.splice(index, 1);
        gameplay.count('matchmaking_queue_exit', { detail: 'away', device: ws.device || 'desktop' });
        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'away', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'away', phase: 'matchmaking' });
        return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, reason: 'away', waitedMs: 0 });
      }
      return;
    }
    const room = rooms.get(ws.room);
    const player = room?.players.get(ws.id);
    if (!room || !player) return sendError(ws, ERROR_CODES.NOT_IN_ROOM, 'Сначала создайте комнату или войдите в неё.');
    if (message.matchId && room.matchId && message.matchId !== room.matchId) {
      metrics.latePacketsDropped++;
      return;
    }
    if (room.state === ROOM_STATE.RESULTS && MATCH_TRAILING_TYPES.has(message.type)) {
      metrics.latePacketsDropped++;
      return;
    }
    const allowedStates = ALLOWED_IN_STATE[message.type];
    if (allowedStates && !allowedStates.includes(room.state))
      return reject('WRONG_STATE', ERROR_CODES.WRONG_STATE, 'Это действие сейчас недоступно.');
    room.updatedAt = Date.now();
    const roomAction = ROOM_HANDLERS[message.type];
    if (roomAction) return roomAction(message, room, player);
  }

  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', error => {
    incidentForSocket(ws, { kind: 'connection', code: 'socket-error' });
    log('warn', 'socket_error', { playerId: ws.id, message: error?.message });
    handleDisconnect(ws);
  });
});

const shadowSimulationTimer = setInterval(
  () => shadowInputRuntime.tick(rooms),
  SERVER_SIMULATION_INTERVAL_MS
);
shadowSimulationTimer.unref();

let snapshotTick = 0;
const snapshotTimer = setInterval(() => {
  const now = Date.now();
  snapshotTick++;
  const skipBroadcast = loadStatus().overloaded && snapshotTick % 3 === 0;
  for (const room of rooms.values()) {
    if (room.state === ROOM_STATE.RESULTS && room.resultsDeadline && now >= room.resultsDeadline) {
      resolveResultsDecision(room, now);
      continue;
    }
    if (room.state === ROOM_STATE.LOBBY && room.fillDeadline && now >= room.fillDeadline) {
      room.fillDeadline = null;
      const humans = connectedHumans(room);
      if (!humans) continue;
      if (humans >= MIN_RACE_PLAYERS) {
        startMatchmadeRace(room, 'deadline');
        continue;
      }
      const added = room.bots
        ? room.bots.list.length
        : addRoomBots(room, { count: RACE_BOT_FIELD - humans, skill: RACE_BOT_SKILLS });
      if (!added) {
        room.fillDeadline = now + RACE_FILL_MS;
        continue;
      }
      log('info', 'race_bots_filled', { roomId: room.code, humans, bots: added });
      startMatchmadeRace(room, 'bots');
      continue;
    }
    if (room.state !== ROOM_STATE.COUNTDOWN && room.state !== ROOM_STATE.PLAYING) continue;
    if (room.state === ROOM_STATE.COUNTDOWN && now >= room.startedAt) setRoomState(room, ROOM_STATE.PLAYING);
    if (skipBroadcast) {
      metrics.snapshotsSkippedForLoad++;
      continue;
    }
    if (room.bots) {
      stepBots(room, {
        now,
        onFinish: player => {
          if (!room.firstFinishAt) room.firstFinishAt = now;
          broadcast(room, {
            type: S2C.PLAYER_FINISHED,
            matchId: room.matchId,
            id: player.id,
            time: player.time,
            board: leaderboard(room),
            racing: stillRacing(room)
          });
          checkMatchEnd(room);
        }
      });
    }
    const players = [...room.players.values()]
      .filter(player => player.last)
      .map(player => ({ ...player.last, id: player.id, checkpoint: player.checkpoint, finished: player.finished }));
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
  expireDisconnectedPlayers(now);
  for (const room of [...rooms.values()]) {
    if (room.state === ROOM_STATE.PLAYING && room.mode === GAME_MODE.COOP) {
      for (const id of autoRevive(room, now)) {
        room.coopRevives = (room.coopRevives || 0) + 1;
        broadcast(room, { type: S2C.COOP_EVENT, matchId: room.matchId, action: 'revive', target: id });
      }
    }
    if (room.state === ROOM_STATE.PLAYING) checkMatchEnd(room);
  }
  try {
    gameplay.flush();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        level: 'warn',
        event: 'metrics_flush_failed',
        ts: new Date().toISOString(),
        message: String(error?.message || '').slice(0, 200)
      })}\n`
    );
  }
  expireSessions(now);
  for (const [code, room] of rooms) {
    if (now - room.updatedAt <= ROOM_TTL) continue;
    clearBots(room);
    rooms.delete(code);
  }
  ipRoomOps.cleanup(now, { force: true });
  for (const [, limiter] of Object.values(httpLimits)) limiter.cleanup(now, { force: true });
}, 15000);
heartbeatTimer.unref();

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';
const GOODBYE_MS = 300;

function shutdown(signal, { exitProcess = true } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'shutdown_started', { signal, rooms: rooms.size, sessions: sessions.size });
  clearInterval(shadowSimulationTimer);
  clearInterval(snapshotTimer);
  clearInterval(eventLoopTimer);
  eventLoopDelay.disable();
  clearInterval(heartbeatTimer);
  for (const room of rooms.values()) broadcast(room, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
  setTimeout(() => {
    for (const client of wss.clients) {
      try {
        client.close(1001, 'Server restarting');
      } catch {}
    }
    wss.close();
    server.close(() => {
      try {
        gameDb.exec('PRAGMA busy_timeout = 1000');
        gameplay.flush();
        gameDb.close();
      } catch (error) {
        log('warn', 'database_close_failed', { error: error.message });
      }
      log('info', 'shutdown_complete', {});
      if (exitProcess) process.exit(0);
    });
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

function addRoomBots(room, options) {
  const added = spawnBots(room, options);
  if (added) {
    assignSlots(room);
    emitLobby(room);
  }
  return added;
}

function resetRateLimits() {
  ipRoomOps.clear();
  ipConnections.clear();
  for (const [, limiter] of Object.values(httpLimits)) limiter.clear();
}

module.exports = {
  addRoomBots,
  app,
  server,
  resetRateLimits,
  rooms,
  sessions,
  metrics,
  shadowInputRuntime,
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
