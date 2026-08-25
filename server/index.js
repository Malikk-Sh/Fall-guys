const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const { EVENT_LOOP_WINDOW_MS, createEventLoopLoad } = require('./eventLoopLoad');
const { createEventCounters, trackEvent } = require('./productEvents');
const { installSpaFallback, installStaticShell } = require('./httpAssets');
const { installLegacyAccountRoutes } = require('./legacyAccountRoutes');
const { installLeaderboardRoutes } = require('./leaderboardRoutes');

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
  finishRejection,
  leaderboard,
  budgetFor: raceAnomalyBudget
} = require('./gameRules');
const { anomalyMeasurements } = require('./movementAnomalyTelemetry');

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
const { VerifiedLeaderboard } = require('./verifiedLeaderboard');
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
  resetCoopMotionHistory,
  budgetFor: coopAnomalyBudget
} = require('./coopMovementAudit');

const app = express();
const clientPath = path.join(__dirname, '..', 'client');
const sharedPath = path.join(__dirname, '..', 'shared');

app.disable('x-powered-by');

// Политика безопасности и раздача статики живут отдельным модулем: они не знают ни про комнаты,
// ни про сокеты, и проверяются собственными тестами.
installStaticShell(app, {
  clientPath,
  sharedPath,
  vendorPath: path.join(__dirname, '..', 'node_modules', 'three', 'build'),
  addonsPath: path.join(__dirname, '..', 'node_modules', 'three', 'examples', 'jsm')
});

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

// Наблюдение за перегрузкой живёт отдельным сервисом: окно, порог и сам замер задержки не зависят
// ни от комнат, ни от сокетов, и на это состояние опираются сразу несколько мест — health, отказ в
// новых комнатах и сброс части снапшотов.
const eventLoopLoad = createEventLoopLoad({ thresholdMs: MAX_EVENT_LOOP_LAG_MS });
const rotateEventLoopWindow = () => eventLoopLoad.rotate();
const loadStatus = options => eventLoopLoad.status(options);

const productEvents = createEventCounters();
const build = buildIdentity();

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

// Загрузился ли preload серверной симуляции.
//
// Отдельным полем — потому что его отсутствие НИЧЕМ ДРУГИМ наружу не проявляется. Preload
// обрабатывает `CLIENT_INPUT` и пишет `shadow_simulation_metrics`; здесь, в `index.js`, этого
// сообщения нет вовсе. Сервер без него отвечает на `/health`, водит матчи и выглядит полностью
// здоровым, молча выбрасывая поток ввода от клиентов. Единственный симптом — отсутствие строки
// метрик в журнале, а она неотличима от «сегодня никто не играл».
//
// Так и было: systemd-юнит разошёлся с `npm start` на один флаг `--require`, и симуляция не
// работала на проде ни дня. Расхождение в репозитории теперь сторожит тест, но уже развёрнутый
// сервер тест не осматривает — а это поле осматривает, и `deploy/smoke.sh` его требует.
//
// Состояний три, а не два: «не загружен» и «загружен, но не работает» — разные поломки, и сливать
// их в булево значит повторять ту же ошибку, из-за которой этот баг прожил столько времени.
//
// Спрашивается `running`, а не `started`. Второе — флаг «запуск когда-то удался», выставляемый один
// раз и переживающий `stop()`: остановленный мост продолжал бы числиться живым, и smoke принял бы
// его за рабочий. Поле, заведённое против слепоты, нельзя делать слепым самому.
const SHADOW_BRIDGE_KEY = Symbol.for('wobble.shadow-input-bridge');
const shadowBridgeStatus = () => {
  const bridge = globalThis[SHADOW_BRIDGE_KEY];
  if (!bridge) return 'absent';
  return bridge.running ? 'started' : 'loaded';
};

const health = () => ({
  ok: true,
  service: 'wobble-rush-3d',
  shadowBridge: shadowBridgeStatus(),
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

// Таблицы рекордов зависят только от проверенного лидерборда и разбора параметров запроса.
installLeaderboardRoutes(app, { verifiedLeaderboard });

// Аккаунты по коду восстановления живут отдельным модулем: они не знают ни про комнаты, ни про
// сокеты, а свои ограничители по адресу держат при себе.
const legacyAccountRoutes = installLegacyAccountRoutes(app, {
  accounts,
  accountAccessPolicy,
  clientIp,
  log
});

installSpaFallback(app, { clientPath });

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
  // Бот живёт ровно один матч. Оставить его в лобби значит показать игрокам участника, который
  // никогда не нажмёт «готов» и о котором нельзя сказать, дождётся он реванша или нет.
  clearBots(room);
  setRoomState(room, ROOM_STATE.LOBBY);
  room.startedAt = null;
  room.matchId = null;
  room.firstFinishAt = null;
  room.results = null;
  room.unranked = null;
  room.resultsDeadline = null;
  room.updatedAt = Date.now();
  // Отыгравшая публичная комната перестаёт быть публичной.
  //
  // Иначе к вернувшимся в лобби подсаживался бы случайный новичок, его появление заводило бы срок
  // набора, и людей, которые ещё решают, играть ли снова, утаскивало бы в новый забег без их
  // согласия. Собравшаяся группа остаётся группой: повторный забег у неё уже есть — голосование
  // за реванш.
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
  // Комната закрывается, когда ушли ЛЮДИ, а не когда опустел список участников.
  //
  // Боты живут в том же списке, поэтому его размер после ухода последнего игрока до нуля уже не
  // доходит: комната провисела бы с одними ботами до истечения TTL, занимая слот и продолжая
  // гонять физику для пустой трибуны.
  const humans = [...room.players.values()].filter(player => !player.bot);
  if (!humans.length) {
    clearBots(room);
    setRoomState(room, ROOM_STATE.CLOSING);
    rooms.delete(room.code);
    log('info', 'room_closed', { roomId: room.code });
    return;
  }

  // Миграция хоста детерминирована (ТЗ 3.6): сначала те, кто на связи, среди них — вошедший раньше.
  // Бот хостом стать не может: он не нажмёт «начать» и не сменит настройки.
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

// playerId из сообщения сюда больше не приходит. Клиент его по-прежнему присылает — старые версии
// в ходу, и ломать им вход незачем, — но сервер поле игнорирует: личность игрока определяется
// только подтверждённой identity сокета.
function addPlayer(room, ws, name) {
  ws.room = room.code;
  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];
  const authenticated = networkIdentity.accountForSocket(ws, accounts);
  const playerName = authenticated?.name ? safeName(authenticated.name) : safeName(name);
  room.players.set(ws.id, {
    id: ws.id,
    name: playerName,
    // Ключ строки в таблице рекордов. У гостя его нет вовсе — и это не пропуск, а решение: без
    // подтверждённой личности запись некуда класть, кроме как под ключ, выбранный самим клиентом.
    // Именно так и было раньше, и это позволяло занять чужую строку.
    //
    // Хранится на игроке, но не попадает ни в один рассылаемый пакет: знать чужой ключ соседям по
    // комнате незачем.
    anonymousId: authenticated?.id || null,
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
  addPlayer(room, partner.ws, partner.name);
  addPlayer(room, ws, message.name);
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

// Подбор в гонку.
//
// Устроен иначе, чем кооперативный, и не по прихоти. В кооперативе собирается ПАРА: как только
// нашёлся второй, ждать больше нечего и матч начинается. В гонке собирается ГРУППА, и «достаточно»
// определяется не количеством, а временем: ждать шестнадцатого — значит не начать никогда, а
// стартовать вдвоём в ту же секунду — значит лишить гонку гонки.
//
// Поэтому здесь нет второго параллельного списка ожидающих. Публичная комната — она же очередь:
// игрок попадает в настоящее лобби, видит, как подходят остальные, и матч начинается либо когда
// комната заполнилась, либо по истечении срока набора. Заодно это переиспользует всё, что у комнат
// уже есть: вход, выход, рассылку лобби, миграцию хоста, отсчёт и роспуск по TTL.
const MIN_RACE_PLAYERS = 2;
const RACE_FILL_MS = 25_000;

// Сколько участников должно оказаться на старте, если живых не набралось.
//
// Не шестнадцать: комната, где один человек и пятнадцать ботов, — это одиночная игра с
// декорациями, а не гонка. Четверо дают ощущение соревнования и оставляют место тем, кто ещё
// ищет: боты добираются до этого числа, а подошедший позже человек садится на свободный слот.
const RACE_BOT_FIELD = 4;

// Уровни ботов в доборе идут вперемешку. Одинаковые прибежали бы плотной группой и выглядели бы
// одним соперником, размноженным трижды.
const RACE_BOT_SKILLS = Object.freeze(['rookie', 'steady', 'sharp']);

// Сколько игроков в комнате НА СВЯЗИ.
//
// Размер room.players для этого не годится: отключившийся остаётся в списке ещё тридцать секунд —
// столько ему даётся на переподключение. Для набора это означало бы, что гонка может стартовать с
// одним живым участником, а поскольку обрыв случился в лобби, забег не пометился бы незачётным и
// одиночный результат попал бы в таблицу проверенных рекордов.
function connectedPlayers(room) {
  let count = 0;
  for (const player of room.players.values()) if (!player.disconnectedAt) count += 1;
  return count;
}

// Сколько ЖИВЫХ игроков на связи. Набор считается по ним: бот в комнате не повод перестать ждать
// людей, иначе первый же добор закрывал бы дверь перед теми, кто уже искал гонку.
function connectedHumans(room) {
  let count = 0;
  for (const player of room.players.values()) if (!player.disconnectedAt && !player.bot) count += 1;
  return count;
}

// Сколько участников ещё на трассе — и людей, и ботов.
//
// Число уходит вместе с сообщением о финише и нужно ровно для одного: дошедший должен понимать,
// кончилась гонка или продолжается без него. Считать это на клиенте нельзя — состав комнаты он
// знает по лобби, а кто из соперников уже дошёл и кто оборвался, достоверно известно только здесь.
function stillRacing(room) {
  let count = 0;
  for (const player of room.players.values()) {
    if (player.finished || player.disconnectedAt) continue;
    count += 1;
  }
  return count;
}

// Свободная публичная комната. Избегание уважается и здесь: игрок, которого попросили больше не
// сводить с этим человеком, не должен встретить его через случайный подбор.
//
// Пустая difficulty означает «любая» и подбирает комнату любой сложности. Это не то же самое, что
// «обычная»: игрок, которому всё равно, должен попадать к тем, кто уже ждёт, а не заводить рядом
// третью комнату — иначе выбор «любая» замедлял бы подбор вместо того, чтобы ускорять его.
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
    // Отличает публичную комнату от приватной: по коду в неё не войти, зато она сама себя
    // запускает. Приватные комнаты этого поля не имеют и продолжают ждать хоста.
    matchmade: true,
    // Срок набора появляется не сразу, а когда собирается минимум: считать время в одиночестве
    // незачем, а игрок, зашедший первым, иначе смотрел бы на истекающий отсчёт без соперников.
    fillDeadline: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

// Единственная точка, где публичная гонка стартует.
//
// Оба пути — «комната заполнилась» и «истёк срок набора» — идут сюда, чтобы проверка мощности и
// учёт состоявшегося подбора не разъезжались между ними. Раньше их было два, и телеметрия успеха
// не велась ни в одном: воронка показывала бы входящих в очередь и ноль матчей.
function startMatchmadeRace(room, reason) {
  room.fillDeadline = null;

  // Тот же предел, что и у ручного запуска. Без него набор нескольких комнат, истёкший
  // одновременно, перешагивал бы лимит активных матчей ровно тогда, когда он и нужен.
  if (capacityStatus().matchesFull) {
    metrics.capacityRejected++;
    // Не отменяем набор, а откладываем: игроки уже собрались, и разгонять их из-за чужой нагрузки
    // хуже, чем попросить подождать ещё немного.
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
  // Пустая строка — осознанный выбор «любая», а не отсутствие выбора. Приводить её к 'normal' сразу
  // значило бы молча подменять запрос игрока: он просил любую комнату, а получил бы только обычные.
  const requested = message.difficulty ? safeDifficulty(message.difficulty) : '';
  const now = Date.now();
  gameplay.count('queue_enter', {
    mode: GAME_MODE.RACE,
    course: requested || 'any',
    device: ws.device
  });

  const existing = openRaceRoomFor(ws, requested);
  // Сложность выбирается только когда комнату действительно надо создать.
  const room = existing || createMatchmadeRaceRoom(safeDifficulty(requested), ws.id);
  addPlayer(room, ws, message.name);
  // Готовность в публичной комнате не спрашивают: игрок уже сказал «найти гонку», и второй раз
  // подтверждать то же самое — лишний клик перед стартом, которого он и так ждёт.
  const player = room.players.get(ws.id);
  if (player) {
    player.ready = true;
    // Момент входа в очередь — по нему считается время ожидания, когда матч состоится.
    player.queuedAt = now;
  }

  if (!existing) {
    trackEvent(productEvents, 'matchmakingStarted');
    incidentForSocket(ws, { kind: 'matchmaking', code: 'queued', phase: 'matchmaking' });
  }

  const connected = connectedPlayers(room);

  // Комната заполнилась — ждать больше некого.
  if (connected >= MAX_PLAYERS[GAME_MODE.RACE]) {
    room.fillDeadline = null;
    log('info', 'race_matchmaking_full', { roomId: room.code, difficulty: room.spec.difficulty });
    return startMatchmadeRace(room, 'full');
  }

  // Срок набора заводится с ПЕРВОГО вошедшего, а не со второго.
  //
  // Раньше он появлялся только когда соберутся двое, и одинокий игрок на пустом сервере ждал не
  // двадцать пять секунд, а бесконечность: срок, который никогда не заведётся, не истечёт. Теперь
  // ожидание всегда конечно — за это время либо подойдут люди, либо к нему выйдут боты.
  //
  // Повторный вход срок НЕ продлевает: иначе поток входящих отодвигал бы старт бесконечно, и
  // первый пришедший ждал бы дольше всех.
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
        raceSpawn: room.mode === GAME_MODE.RACE && player.raceSpawn ? { ...player.raceSpawn } : null,
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
      ? // `player.last` здесь ещё ПРЕЖНЕЕ состояние: обновляют его оба вызывающих уже после
        // проверки. Значит это ровно тот отрезок, по которому чекпоинт и был выдан.
        verifyCoopCheckpoint(player, room.spec, checkpoint, state, now, player.last)
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
  // matchId одновременно отсекает хвост прошлого забега и служит солью для перестановки race-slot'ов:
  // ряды отличаются по Z, поэтому привязывать переднюю клетку к joinOrder было бы постоянной форой.
  room.matchId = crypto.randomBytes(8).toString('hex');
  // Сначала сбрасываем/при необходимости пересоздаём ботов. Смена сложности может пересобрать их
  // записи целиком, поэтому окончательные slot'ы назначаются уже после resetBots.
  resetBots(room);
  if (room.mode === GAME_MODE.RACE) assignRaceSlots(room, room.matchId);
  else assignSlots(room);
  // Внутренняя физика ботов должна получить те же уже перемешанные клетки, что player.last и клиенты.
  placeBotsOnGrid(room);
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
  // Бот в продуктовую статистику не идёт ни здесь, ни в других счётчиках участников. Причина не в
  // чистоте ради чистоты: у бота нет устройства, и его события легли бы на desktop, сдвинув и
  // воронку подбора, и разрезы по устройствам — тем сильнее, чем чаще комнаты добираются ботами.
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
      // Для гонки сохраняем клетку отдельно: checkpoint 0 обязан возвращать игрока именно сюда,
      // а не в старую общую центральную точку. В коопе старт и так вычисляется по slot каждый раз.
      raceSpawn: room.mode === GAME_MODE.RACE ? { ...start } : null,
      last: {
        ...start,
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

// Решение на экране результатов: пора ли распускать комнату в лобби.
//
// Считать это только в момент голосования нельзя. Если один уже проголосовал, а второй оборвался,
// активным остаётся один — и условие «все проголосовали» выполнено, но пересчитать его некому:
// повторно голосовать первый не может, его голос уже учтён. Комната зависала на результатах
// навсегда. Поэтому пересчёт вызывается и на голос, и на обрыв, и на освобождение слота.
function resolveResultsDecision(room, now = Date.now()) {
  if (room.state !== ROOM_STATE.RESULTS) return false;
  const active = [...room.players.values()].filter(player => !player.disconnectedAt);
  // Голосуют только люди. Бот сидит в комнате обычным участником и кнопку нажать не может, так что
  // условие «решили все» при нём не выполнялось бы никогда: выбор человека ждал бы двадцатисекундного
  // срока, а реванш стал бы недостижим вовсе — по истечении срока комната уходит в лобби.
  const voters = active.filter(player => !player.bot);
  if (!voters.length) return false;

  const decided = voters.every(player => player.resultChoice);
  const expired = !!room.resultsDeadline && now >= room.resultsDeadline;
  if (!decided && !expired) {
    emitLobby(room);
    return false;
  }

  // Состава должно хватать на забег. Кооперативную главу проходят вдвоём, и запускать её на
  // одного, когда напарник оборвался, бессмысленно: игрок упрётся в первую же плиту, которую
  // некому держать. Такой случай уводим в лобби — оттуда видно, что напарника ждут.
  const enoughPlayers = room.mode === GAME_MODE.COOP ? voters.length === 2 : voters.length > 0;

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

// Полагается ли по итогам этого матча вообще обращаться к публичной таблице.
//
// Вынесено отдельно, потому что разница между режимами тут смысловая, а не техническая, и её легко
// стереть одной правкой условия. Гонка — личное соревнование: отбор идёт по игроку уже внутри
// `verifiedLeaderboard.record()`, и решение комнаты сводится к «не дисквалифицирована ли она сама».
// Кооператив — командный результат с общим временем: писать половину команды бессмысленно, поэтому
// непроверенный напарник снимает зачёт со всей главы.
function leaderboardRecordEligible({ mode, unranked, verificationFailed }) {
  if (unranked) return false;
  if (mode === GAME_MODE.RACE) return true;
  return !verificationFailed;
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
    // Время бота — не наблюдение о трассе, а настройка его же модели. В среднем времени прохождения
    // оно рассказывало бы о том, как быстро мы сделали ботов, и заглушало бы единственное, ради чего
    // эта величина считается: стала ли трасса проходиться быстрее у людей.
    if (player?.bot) continue;
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
    // Сколько отклонений насчитала проверка движения за этот забег — и насколько это близко к
    // запасу. Только отчёт: счётчики уже посчитаны проверкой, ни одно правило отсюда не меняется.
    //
    // Пороги в `movementAudit.js` выведены прогонами ботов, живых людей за ними нет. Сегодняшний
    // замер показал, чего это стоит: на ботах отрыв траектории давал 6.947 %, на живых игроках
    // 9.44 %. Прежде чем трогать запасы отклонений, надо увидеть то же самое про них.
    //
    // Считается по ФИНИШИРОВАВШИМ, а не по всем в комнате: у оборвавшегося забег неполный, и его
    // расход не сравним с полным прохождением. Население то же, что у `finish_time` рядом.
    const anomalies =
      room.mode === GAME_MODE.COOP ? player?.coopMovementAnomalies : player?.movementAnomalies;
    const budget = room.mode === GAME_MODE.COOP ? coopAnomalyBudget : raceAnomalyBudget;
    for (const measurement of anomalyMeasurements(anomalies, budget)) {
      // Сколько раз признак сработал за забег: даёт и число забегов с ним, и среднее по ним.
      gameplay.observe('movement_anomaly', measurement.count, dims(room, player, measurement.reason));
      // И насколько это доля запаса. Корзина `over` — ровно те забеги, где признак стал находкой;
      // остальные показывают, кто насколько не дошёл, а этого сейчас не видно вовсе.
      gameplay.count(
        'movement_anomaly_headroom',
        dims(room, player, `${measurement.reason}:${measurement.bucket}`)
      );
    }
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
    // Причина «без зачёта» — КОМНАТНАЯ, и в гонке проверка движения в неё больше не входит.
    //
    // Гонка — личное соревнование, и провал проверки у одного не делает чужой забег непроверенным.
    // Свою причину каждый видит в собственной строке доски (`verified`, `verificationReason`), и
    // клиент берёт её оттуда. Оставь мы здесь общий признак — игрок, чью строку сервер записал,
    // читал бы плашку «время никуда не записалось». Кооператив другой: там результат командный и
    // время общее, поэтому непроверенный напарник по-прежнему снимает зачёт со всей главы.
    unranked: room.unranked || (room.mode !== GAME_MODE.RACE && verificationFailed ? 'verification' : null),
    trusted: !room.unranked && !verificationFailed
  };
  // Строка в публичной таблице — решение ПО ИГРОКУ, а не по комнате.
  //
  // `verifiedLeaderboard.record()` и так отбирает записи по `entry.verified`, но этот отбор не
  // получал шанса сработать: вызов стоял под комнатными воротами, и один непроверенный финиш
  // отменял запись сразу всем. Честный игрок терял рекорд из-за джиттера у соседа по комнате.
  //
  // Планка для отдельной строки при этом не меняется ни на йоту: непроверенный не попадает в
  // таблицу и теперь. Снимается только сопутствующий урон.
  //
  // В кооперативе ворота остаются комнатными: время там общее, глава засчитывается команде, и
  // записывать половину команды бессмысленно.
  //
  // Соло в таблицу не идёт вовсе: сервера там нет, и подтвердить движение некому.
  const recordEligible = leaderboardRecordEligible({
    mode: room.mode,
    unranked: room.unranked,
    verificationFailed
  });
  if (recordEligible) {
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
  }
  // Награды и достижения остаются под КОМНАТНЫМИ воротами, и это осознанно.
  //
  // Место в гонке считается по всей итоговой таблице, включая непроверенных: убрать их из подсчёта
  // значило бы сдвинуть места остальным, а оставить — выдать достижение за обгон того, чей забег не
  // подтверждён. Это отдельное решение с отдельной ценой, и в одном изменении с таблицей рекордов
  // ему не место. Пока строже: непроверенный финиш в комнате снимает награды со всех.
  if (room.results.trusted) {
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

    // Итоги гонки по аккаунтам. Место берётся из уже посчитанной таблицы результатов, а не
    // пересчитывается заново: разойдись они — игрок увидел бы на экране одно место, а награду
    // получил бы за другое.
    if (room.mode === GAME_MODE.RACE) {
      // Считаем по АККАУНТАМ, а не по аватарам.
      //
      // Один аккаунт может занимать несколько слотов: авторизация запрещает второй раз назвать
      // себя одним сокетом, но не запрещает войти в комнату со второй вкладки. По аватарам «живой
      // соперник» и «пьедестал» тогда набирались бы из самого себя — две вкладки давали бы победу,
      // три — пьедестал, и каждая добавляла бы финиш к счётчику завсегдатая. Порог, который можно
      // выполнить в одиночку, не порог.
      //
      // Из нескольких аватаров одного аккаунта берётся лучший: доска уже отсортирована по времени,
      // поэтому первое вхождение и есть лучшее.
      // Место считается по ПОРЯДКУ В ПРОТОКОЛЕ, а не по номеру среди людей.
      //
      // Первая редакция складывала место из числа уже учтённых аккаунтов, а ботов лишь добавляла к
      // общему количеству участников. Получалось прямо противоположное задуманному: единственный
      // человек, пришедший ЧЕТВЁРТЫМ после трёх ботов, записывался как первый из четырёх — то есть
      // получал и победу, и пьедестал за проигранный забег. Место обязано считаться там же, где
      // игрок его видит, — в итоговой таблице.
      const standings = room.results?.board || [];
      const bestByAccount = new Map();
      let botFinishers = 0;
      // Строка протокола, на которой мы сейчас стоим: и люди, и боты.
      let position = 0;
      for (const entry of standings) {
        const participant = room.players.get(entry.id);
        if (participant?.bot) {
          // Боты считаются соперниками наравне с людьми: обогнать их — результат. Переключается
          // константой BOTS_COUNT_AS_OPPONENTS. Когда она выключена, бот не занимает и места.
          if (!BOTS_COUNT_AS_OPPONENTS) continue;
          botFinishers += 1;
          position += 1;
          continue;
        }
        const accountId = participant?.accountId;
        if (!accountId) continue;
        position += 1;
        // Защита от самонаграждения: несколько вкладок одного аккаунта — один участник, и место
        // засчитывается по лучшему из них. Доска отсортирована по времени, поэтому первое
        // вхождение и есть лучшее.
        if (bestByAccount.has(accountId)) continue;
        bestByAccount.set(accountId, position);
      }
      const finishers = bestByAccount.size + botFinishers;
      for (const [accountId, place] of bestByAccount) {
        accounts.recordRaceFinish({ accountId, place, finishers });
      }
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

  // Сообщения, которым комната не нужна: они про соединение и личность, а не про игру.
  //
  // Обработчики собраны в таблицы, а раньше были цепочкой из двадцати шести `if`, растянутой на
  // шестьсот строк. Порядок в такой цепочке значил всё, но не был виден: чтобы понять, почему
  // проверка версии стоит именно здесь, приходилось читать её целиком. Теперь порядок задан
  // конвейером ниже — по нему видно, что фаз три и что между ними стоят общие проверки.
  //
  // Тела обработчиков перенесены дословно: имена параметров совпадают с прежними переменными,
  // поэтому внутри не поменялось ни строки.
  const CONNECTION_HANDLERS = Object.freeze({
    // Отметка времени сервера в каждом pong — по ней клиент оценивает расхождение часов.
    [C2S.PING]: message => {
      return send(ws, { type: S2C.PONG, at: message.at, serverTime: Date.now() });
    },
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
    },
    [C2S.LEAVE_ROOM]: () => {
      return leave(ws);
    },
    [C2S.RESUME]: message => {
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
  });

  // Вход в игру: подбор и комнаты. Сюда попадают только после общей проверки версии и лимита.
  const LOBBY_HANDLERS = Object.freeze({
    [C2S.CANCEL_MATCHMAKING]: () => {
      // Гонка ждёт не в списке, а в настоящей комнате, поэтому отмена для неё — это выход.
      // Отдельного состояния «в очереди» у неё нет, и заводить его только ради отмены незачем.
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
        gameplay.count('matchmaking_queue_exit', {
          detail: 'cancel',
          device: ws.device || 'desktop'
        });
        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'button', device: ws.device });
        incidentForSocket(ws, { kind: 'matchmaking', code: 'cancelled', phase: 'matchmaking' });
      }
      return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });
    },
    [C2S.FIND_COOP]: message => {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (loadStatus().overloaded || rooms.size >= MAX_ROOMS) {
        metrics.capacityRejected++;
        return sendError(ws, ERROR_CODES.SERVER_FULL, 'Сервис перегружен. Попробуйте позже.');
      }
      return enqueueCoop(ws, message);
    },
    [C2S.FIND_RACE]: message => {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      // Проверка на MAX_ROOMS мягче, чем у кооператива: подбор в гонку чаще ВХОДИТ в уже открытую
      // комнату, чем создаёт новую, и отказывать входящему из-за общего числа комнат значило бы
      // закрывать дверь в помещение, где есть места.
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
      addPlayer(room, ws, message.name);
      incidentForSocket(ws, { kind: 'room', code: 'created' });
      return;
    },
    [C2S.JOIN_ROOM]: message => {
      leave(ws);
      const room = rooms.get(message.code.trim().toUpperCase());
      if (!room) return sendError(ws, ERROR_CODES.ROOM_NOT_FOUND, 'Комната не найдена. Проверьте код.');
      if (room.state !== ROOM_STATE.LOBBY) {
        return sendError(ws, ERROR_CODES.MATCH_ALREADY_STARTED, 'Игра в этой комнате уже началась.');
      }
      // Публичная комната набирается подбором, а не по коду. Код у неё есть и виден в лобби, так
      // что запрет — не про угадывание: пришедший по ссылке обошёл бы и подбор по сложности, и
      // список избеганий, а главное — остался бы неготовым, но всё равно поехал бы по таймеру.
      if (room.matchmade) {
        return sendError(
          ws,
          ERROR_CODES.ROOM_NOT_FOUND,
          'Это комната случайного подбора. Нажмите «Найти гонку».'
        );
      }
      if (room.players.size >= MAX_PLAYERS[room.mode]) {
        return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');
      }
      trackEvent(productEvents, 'roomJoined');
      addPlayer(room, ws, message.name);
      incidentForSocket(ws, { kind: 'room', code: 'joined' });
      return;
    }
  });

  // Действия внутри комнаты. Вызываются, когда комната и игрок уже найдены, опоздавшие пакеты
  // отброшены, а таблица состояний разрешила действие — поэтому room и player приходят готовыми.
  const ROOM_HANDLERS = Object.freeze({
    // Хост приватной комнаты зовёт ботов.
    [C2S.ADD_BOTS]: (message, room) => {
      if (room.host !== ws.id) {
        return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Соперников добавляет только хост.');
      }
      // В публичной комнате состав определяет подбор: он и людей приведёт, и ботов позовёт сам.
      // Разрешить здесь ручной вызов значило бы дать одному участнику решать за остальных.
      if (room.matchmade) {
        return sendError(ws, ERROR_CODES.WRONG_STATE, 'В случайной гонке соперников подбирает сервер.');
      }
      if (room.mode !== GAME_MODE.RACE) {
        return sendError(ws, ERROR_CODES.WRONG_STATE, 'Боты пока есть только в гонке.');
      }
      const free = MAX_PLAYERS[GAME_MODE.RACE] - room.players.size;
      // Удаление не требует свободного места — наоборот, именно в полной комнате кнопка «−»
      // особенно нужна, чтобы освободить слот живому игроку.
      if (message.count > 0 && free <= 0)
        return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');
      const changed = addRoomBots(room, {
        count: message.count === 0 ? 0 : Math.min(message.count, free),
        skill: message.skill || RACE_BOT_SKILLS
      });
      if (!changed)
        return sendError(
          ws,
          ERROR_CODES.WRONG_STATE,
          message.count === 0 ? 'В комнате нет ботов.' : 'Соперники сейчас недоступны.'
        );
      log('info', 'room_bots_changed', { roomId: room.code, delta: changed });
      return undefined;
    },

    [C2S.PLAYER_READY]: (message, room, player) => {
      player.ready = message.ready;
      return emitLobby(room);
    },
    [C2S.HOST_CONFIGURE]: (message, room) => {
      if (room.host !== ws.id) {
        return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Настройки меняет только хост.');
      }
      // В публичной комнате сложность выбрана подбором, и менять её на ходу нельзя: остальные
      // пришли именно на неё. Заодно это снимает противоречие — смена настроек сбрасывает
      // готовность всем, а набор стартует по таймеру и о готовности не спрашивает.
      if (room.matchmade) {
        return sendError(ws, ERROR_CODES.WRONG_STATE, 'Настройки случайной гонки задаёт подбор.');
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
        //
        // Боты в этот счёт не идут. Модель бота написана для гонки — кооперативную главу проходят
        // вдвоём и с механиками на двоих, и напарник из бота не выйдет. Поэтому при переходе в кооп
        // ботов не пересчитывают, а распускают: иначе хост, добавивший троих, получал бы отказ
        // «в комнате должно быть не больше двух игроков», не понимая, о каких игроках речь.
        const humans = [...room.players.values()].filter(item => !item.bot);
        if (message.mode === GAME_MODE.COOP && humans.length > MAX_PLAYERS[GAME_MODE.COOP]) {
          return sendError(
            ws,
            ERROR_CODES.ROOM_FULL,
            'Для кооператива в комнате должно быть не больше двух игроков.'
          );
        }
        if (message.mode === GAME_MODE.COOP) clearBots(room);
        room.mode = message.mode;
        // Смена режима меняет и тип уровня: у кооператива главы, у гонки процедурная трасса.
        room.spec =
          room.mode === GAME_MODE.COOP
            ? coopSpec(room.chapterId)
            : createCourseSpec(randomSeed(), room.spec.difficulty || 'normal');
        assignSlots(room);
      }
      // Любое изменение настроек сбрасывает готовность: игроки согласились на другие условия.
      //
      // Бота это не касается, и не по недосмотру: PLAYER_READY он не пришлёт никогда, а неготовый
      // участник не даёт комнате стартовать. Сброс готовности боту означал бы, что смена сложности
      // после «добавить ботов» насовсем запирает старт: кнопка гаснет, а сервер отвечает NOT_READY.
      for (const item of room.players.values()) if (!item.bot) item.ready = false;
      // Настройки сменились — сменилась и трасса, а бот бежит по геометрии, собранной под прежнюю.
      // resetBots пересоберёт состав под новый spec тем же числом и теми же уровнями.
      resetBots(room);
      return emitLobby(room);
    },
    [C2S.START_MATCH]: (message, room) => {
      if (room.host !== ws.id) {
        return reject('PROTECTED_STATE', ERROR_CODES.NOT_HOST, 'Забег запускает только хост.');
      }
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      // Публичная комната стартует сама и только по своим правилам. Первый вошедший становится в
      // ней хостом — и без этого запрета мог бы нажать «начать» сразу после поиска и уехать в
      // гонку в одиночку, обойдя весь набор.
      if (room.matchmade) {
        return sendError(ws, ERROR_CODES.NOT_READY, 'Гонка начнётся сама, когда соберутся соперники.');
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
    },
    [C2S.PLAYER_STATE]: (message, room, player) => {
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
      // Время трассы, на котором клиент снял это состояние. Нужно только диагностике паритета:
      // по нему сверяется опора под игроком с подвижной платформой. Авторитетом не является —
      // ни прогресс, ни проверка состояния его не читают.
      player.lastCourseTime = Number.isFinite(message.courseTime) ? message.courseTime : null;
      player.lastSequence = message.sequence;
      trackCheckpointDuration(room, player, result.checkpoint, now);
      if (result.checkpoint > player.checkpoint) trackEvent(productEvents, 'checkpointReached');
      player.checkpoint = result.checkpoint;
      return;
    },
    [C2S.PRESENCE]: (message, room, player) => {
      if (player.away === message.away) return;
      player.away = message.away;
      broadcast(room, { type: S2C.PLAYER_PRESENCE, id: player.id, away: player.away });
      emitLobby(room);
      return;
    },
    [C2S.COOP_EVENT]: (message, room, player) => {
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
    },
    [C2S.COOP_PING]: (message, room, player) => {
      if (room.mode !== GAME_MODE.COOP) return;
      gameplay.count('coop_ping', dims(room, player, message.command));
      return broadcast(room, {
        type: S2C.COOP_PING,
        matchId: room.matchId,
        id: player.id,
        command: message.command,
        at: Date.now()
      });
    },
    // Эмоция.
    //
    // Клиент присылает только ID. Сервер проверяет всё остальное: участника комнаты (это уже
    // сделано выше — до сюда доходят лишь `room`+`player`), канонический ID, слот, владение и то,
    // что предмет действительно выбран в emote loadout. Ничего из присланного не пересказывается
    // дальше, кроме самого ID: длительность, поза и эффект — дело каталога, а не отправителя.
    //
    // Эмоция не трогает authoritative state: ни позиции, ни скорости, ни чекпоинта. Это событие
    // презентации, и в обработчике намеренно нет ни одной строки, которая меняла бы игрока.
    [C2S.EMOTE]: (message, room, player) => {
      // Гость эмоций не имеет: у него нет ни владения, ни выбранного набора. Это не отказ в
      // обслуживании, а следствие того, что владение — свойство аккаунта.
      if (!player.accountId) return;
      if (!socialCosmetics.canPlayEmote(player.accountId, message.emoteId)) return;
      gameplay.count('emote', dims(room, player, message.emoteId));
      return broadcast(room, {
        type: S2C.PLAYER_EMOTE,
        id: player.id,
        emoteId: message.emoteId,
        at: Date.now()
      });
    },
    [C2S.RESPAWN]: (message, room, player) => {
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
      const position =
        player.checkpoint === 0 && player.raceSpawn
          ? player.raceSpawn
          : spawnFor(room.spec, player.checkpoint);
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
    },
    [C2S.FINISH]: (message, room, player) => {
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
        player.lastCourseTime = Number.isFinite(message.courseTime) ? message.courseTime : null;
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
        const rejection = finishRejection(player, room.spec);
        metrics.finishRejected++;
        log('info', 'finish_rejected', {
          roomId: room.code,
          matchId: room.matchId,
          playerId: player.id,
          reason: rejection.reason
        });
        gameplay.count('finish_rejected', dims(room, player, rejection.reason));
        // Отказ помечен явно, а не спрятан в обычную коррекцию: клиент должен понять, что финиш
        // НЕ засчитан, и повторить его после следующего валидного состояния. Раньше он видел
        // рядовую коррекцию, считал себя финишировавшим и навсегда оставался в «Подтверждаем
        // результат…».
        //
        // Место возврата зависит от причины — см. `finishRejection`. Возврат в одну и ту же точку
        // для обеих причин и был вторым способом остаться в «Подтверждаем результат…» навсегда.
        return send(ws, {
          type: S2C.FINISH_REJECTED,
          matchId: room.matchId,
          position: rejection.position,
          checkpoint: player.checkpoint,
          reason: rejection.reason
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
        // Причина здесь только КОМНАТНАЯ, и это не косметика.
        //
        // Сообщение о финише уходит всем в комнате. Пока в нём ехала личная причина финишировавшего,
        // она попадала в сессию КАЖДОГО клиента: `receiveFinish` применял её до проверки `message.id`.
        // Честный сосед получал плашку «без зачёта» за чужую проверку и переставал сохранять даже
        // свой локальный рекорд — при том, что сервер его строку в таблицу записывает.
        //
        // Заодно закрывается утечка: имя сработавшего сигнала (`sustained-speed` и прочие) говорило
        // всей комнате, на какой именно проверке споткнулся конкретный игрок.
        //
        // Свой статус каждый берёт из собственной строки `board`: там есть и `verified`, и причина.
        unranked: room.unranked || null,
        trusted: !room.unranked
      });
      return checkMatchEnd(room);
    },
    [C2S.REMATCH_VOTE]: (message, room, player) => {
      if (operationalState.isDraining()) {
        return send(ws, { type: S2C.SERVER_SHUTDOWN, reason: 'restart' });
      }
      if (player.resultChoice === 'rematch') return;
      player.resultChoice = 'rematch';
      return resolveResultsDecision(room);
    },
    [C2S.NEXT_CHAPTER_VOTE]: (message, room, player) => {
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
      ) {
        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);
      }
      if (ipRateLimited(ws.ip)) {
        return reject('RATE_EXCEEDED', ERROR_CODES.RATE_LIMITED, 'Слишком много запросов. Подождите минуту.');
      }
    }

    // Вход в игру: подбор и создание комнат.
    const lobbyAction = LOBBY_HANDLERS[message.type];
    if (lobbyAction) return lobbyAction(message);

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

    // Всё остальное — действия внутри комнаты.
    const roomAction = ROOM_HANDLERS[message.type];
    if (roomAction) return roomAction(message, room, player);

    // Игрок свернул игру или вернулся. Сервер здесь ничего не решает — только запоминает и
    // пересказывает: решение принимает человек, а знать об этом должен напарник.

    // Реванш — единогласное решение, а не команда хоста.
    //
    // Раньше голос хоста мгновенно распускал комнату в лобби. На экране результатов это выглядело
    // так: один нажал «реванш» — и карточка исчезла у обоих, второй просто не успевал ничего
    // нажать. Теперь голос — это голос: комната остаётся в RESULTS, пока не проголосуют все,
    // кто на связи, а рассылка состояния показывает счёт голосов.
    // Выбор можно менять, пока комната не решила: передумать — нормальное поведение, а запрет
    // на смену и создавал тупик. Пересчёт после каждого нажатия.

    // Возврат в лобби — тоже общее решение. Хост здесь не привилегирован по той же причине:
    // его нажатие закрывало карточку результатов остальным.
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

    // Истёк срок набора публичной гонки — стартуем тем составом, который собрался.
    //
    // Проверка живёт здесь по той же причине, что и голосование на результатах строкой выше:
    // отдельный таймер на комнату пришлось бы заводить, снимать при старте, снимать при выходе
    // последнего игрока и не забыть снять при роспуске, а этот цикл и так обходит все комнаты.
    if (room.state === ROOM_STATE.LOBBY && room.fillDeadline && now >= room.fillDeadline) {
      room.fillDeadline = null;
      // Пока ждали, кто-то мог отвалиться. Считаем только тех, кто на связи: оборвавшийся ещё
      // тридцать секунд числится в комнате, и по размеру списка гонка стартовала бы в одиночку.
      const humans = connectedHumans(room);
      if (!humans) continue;
      if (humans >= MIN_RACE_PLAYERS) {
        startMatchmadeRace(room, 'deadline');
        continue;
      }
      // Людей не хватило. Раньше на этом месте набор просто начинался заново, и на пустом сервере
      // игрок мог ждать сколько угодно, ни разу не увидев гонки. Теперь к нему выходят боты:
      // соперники ненастоящие, зато забег настоящий и начинается сейчас.
      //
      // Комната, где боты уже стоят, идёт сразу на старт. Такое бывает: если в прошлый срок
      // упёрлись в потолок активных матчей, старт отложился, боты остались, и повторный вызов
      // spawnBots вернул бы ноль — не «ботов нет», а «они уже здесь». Ветка ниже приняла бы этот
      // ноль за отказ и переназначала срок бесконечно, даже когда нагрузка давно спала.
      const added = room.bots
        ? room.bots.list.length
        : addRoomBots(room, { count: RACE_BOT_FIELD - humans, skill: RACE_BOT_SKILLS });
      if (!added) {
        // Боты почему-то недоступны — ждём людей дальше, как раньше.
        room.fillDeadline = now + RACE_FILL_MS;
        continue;
      }
      log('info', 'race_bots_filled', { roomId: room.code, humans, bots: added });
      startMatchmadeRace(room, 'bots');
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

    // Бота двигает сервер: живому игроку состояние присылает его клиент, а за бота шаг физики
    // делается здесь — в том же цикле, который рассылает состояние, поэтому бот двигается ровно с
    // той частотой, с какой его видят.
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
  //
  // Обёрнут по той же причине, что и pruneIncidentDiagnostics выше: статистика — наблюдаемость, и
  // остановить ею игру нельзя. Раньше исключение отсюда поднималось из колбэка таймера, не встречало
  // ни одного обработчика и завершало процесс — то есть неудачная запись счётчика выбрасывала из
  // забега всех игроков во всех комнатах разом.
  try {
    gameplay.flush();
  } catch (error) {
    // Сообщать об этом через log() нельзя.
    //
    // console.* перехвачен reliability capture, а его приёмник пишет событие синхронно тем же
    // соединением с той же базой. Значит рассказ о том, что ожидание базы исчерпано, стоил бы
    // второго такого же ожидания: цикл событий встал бы вдвое дольше — и снапшоты, и heartbeat, и
    // разбор сообщений. Пишем прямо в поток, минуя перехват; ровно так же поступает
    // pruneIncidentDiagnostics выше и по той же причине.
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
    // Освобождаем графику ботов до того, как комната исчезнет: иначе их сцены остались бы жить
    // ссылками из ничего.
    clearBots(room);
    rooms.delete(code);
  }
  ipRoomOps.cleanup(now, { force: true });
  legacyAccountRoutes.cleanup(now);
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
  eventLoopLoad.stop();
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
        // На выходе ждём занятый файл меньше, чем в игре.
        //
        // Ожидание блокировки синхронно: оно останавливает цикл событий целиком, а значит и
        // страховочный выход двумя строками ниже, который стоит на трёх секундах. С обычными пятью
        // секундами перезапуск, пришедшийся на чужую запись, растянулся бы дольше собственного
        // предела — то есть ограничение перестало бы что-либо ограничивать. Секунды здесь хватает:
        // терять на выходе нечего, кроме последней пачки счётчиков.
        gameDb.exec('PRAGMA busy_timeout = 1000');
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

// Завести ботов в комнате. Экспортируется ради тестов и добора: правила потолка живут в roomBots.
//
// Состав комнаты после этого обязательно рассылается. Само по себе добавление меняет только карту
// на сервере, и без рассылки соперники существуют, бегут и финишируют, но в лобби их не видно —
// именно так это и выглядело при первой проверке в браузере.
function addRoomBots(room, options) {
  const added = spawnBots(room, options);
  if (added) {
    assignSlots(room);
    emitLobby(room);
  }
  return added;
}

// Сброс счётчиков по адресу. Нужен тестам: они ходят с одного 127.0.0.1 и за минуту создают
// комнат больше, чем позволено живому человеку. Без сброса набор разваливался непредсказуемо —
// падал тот тест, который случайно пересёк границу окна.
function resetRateLimits() {
  ipRoomOps.clear();
  ipConnections.clear();
  legacyAccountRoutes.clear();
}

module.exports = {
  addRoomBots,
  app,
  server,
  // Экспортируется ради теста: разница между режимами тут смысловая, и стереть её одной правкой
  // условия легко, а сквозной прогон кооперативного матча ради одной ветки — дорого.
  leaderboardRecordEligible,
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
