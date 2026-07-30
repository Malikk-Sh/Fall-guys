import { ClockSync } from './ClockSync.js';
import { SnapshotBuffer, RENDER_DELAY_MS } from './SnapshotBuffer.js';
import { C2S, S2C, PROTOCOL_VERSION } from '/shared/protocol.js';

// Интервал отправки своего состояния. Совпадает с частотой рассылки снапшотов на сервере (66 мс).
const STATE_INTERVAL_MS = 66;

// Первые секунды после подключения пингуем часто, чтобы быстро набрать замеры для синхронизации часов,
// дальше переходим на редкий режим — он нужен только для показа качества связи и поддержания оценки.
const PING_FAST_MS = 350;
const PING_SLOW_MS = 2000;
const PING_FAST_COUNT = 8;

// Задержки переподключения. Растут экспоненциально, чтобы не добивать сервер, который лежит.
// К каждой добавляется случайный разброс: если сервер перезапустился, все клиенты иначе
// ломились бы обратно одновременно и ровно в один и тот же момент.
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];
const RECONNECT_JITTER_MS = 250;

const SESSION_KEY = 'wobble-session';

// Снапшоты приходят каждые 66 мс. Пропуском считаем паузу вчетверо длиннее: тройного запаса мало —
// в него попадают обычные задержки основного потока браузера на тяжёлых кадрах.
const SNAPSHOT_GAP_MS = STATE_INTERVAL_MS * 4;

// Окно, за которое считаются пропуски для оценки качества связи.
const GAP_WINDOW_MS = 10_000;

// Состояния соединения для наглядного оверлея (ТЗ 10.1).
export const LINK_STATE = Object.freeze({
  OFFLINE: 'offline',
  CONNECTING: 'connecting',
  ONLINE: 'online',
  RECONNECTING: 'reconnecting',
  FAILED: 'failed'
});

// Понятные тексты вместо кодов ошибок. Сервер шлёт код, локализация — забота клиента (ТЗ 10.2).
const ERROR_TEXT = {
  INVALID_MESSAGE: 'Игра отправила некорректный запрос. Обновите страницу.',
  PROTOCOL_ERROR: 'Соединение закрыто из-за ошибок протокола.',
  VERSION_MISMATCH: 'Версия игры устарела. Обновите страницу.',
  ROOM_NOT_FOUND: 'Комната не найдена. Проверьте код.',
  ROOM_FULL: 'В комнате нет свободных мест.',
  MATCH_ALREADY_STARTED: 'Игра в этой комнате уже началась.',
  NOT_IN_ROOM: 'Сначала создайте комнату или войдите в неё.',
  NOT_HOST: 'Это может сделать только хост.',
  NOT_READY: 'Не все игроки готовы.',
  WRONG_STATE: 'Сейчас это действие недоступно.',
  RATE_LIMITED: 'Слишком много запросов. Немного подождите.',
  SERVER_FULL: 'Сервис перегружен. Попробуйте позже.',
  RECONNECT_EXPIRED: 'Время на возвращение истекло.',
  KICKED: 'Вас исключили из комнаты.'
};

export class NetworkManager {
  constructor(ui) {
    this.ui = ui;
    this.handlers = new Map();
    this.queue = [];
    this.id = null;
    this.roomCode = null;
    this.matchId = null;
    this.pingAt = 0;
    this.lastPing = 0;
    this.pingCount = 0;
    this.lastState = 0;
    this.intentionalClose = false;
    this.linkState = LINK_STATE.OFFLINE;
    this.away = false;

    this.clock = new ClockSync();
    this.snapshots = new SnapshotBuffer();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.sessionToken = this.loadSession();

    // Статистика качества связи. Джиттер считаем как среднее отклонение задержки: именно он,
    // а не сама задержка, ощущается как «дёргается» — стабильные 150 мс играются нормально,
    // а скачущие 40–160 мс нет.
    this.rttSamples = [];
    this.jitter = 0;
    this.snapshotsReceived = 0;
    this.lastSnapshotAt = 0;
    // Пропуски снапшотов хранятся отметками времени, а не счётчиком.
    //
    // Счётчик был бы накопительным: за долгую сессию он неизбежно дорос бы до любого порога, и
    // связь навсегда осталась бы «плохой», даже когда сеть давно восстановилась. Нас интересует
    // не «сколько пропусков было когда-либо», а «сколько их прямо сейчас».
    this.gapTimes = [];
  }

  loadSession() {
    try {
      return sessionStorage.getItem(SESSION_KEY) || null;
    } catch {
      return null;
    }
  }

  saveSession(token) {
    this.sessionToken = token || null;
    try {
      if (token) sessionStorage.setItem(SESSION_KEY, token);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Приватный режим — работаем без восстановления сессии.
    }
  }

  setLinkState(state) {
    if (this.linkState === state) return;
    this.linkState = state;
    this.emit('linkState', { state });
  }

  // Текущее серверное время по оценке клиента. Вся игровая логика, зависящая от времени, должна
  // спрашивать его здесь, а не у Date.now().
  serverNow() {
    return this.clock.serverNow();
  }

  // Момент, который сейчас нужно отрисовать для удалённых игроков: намеренно в прошлом,
  // чтобы для него всегда нашлась пара соседних снапшотов. Подробности — в SnapshotBuffer.js.
  renderTime() {
    return this.serverNow() - RENDER_DELAY_MS;
  }

  get latency() {
    return this.clock.latency;
  }

  // Простая словесная оценка связи. Игроку она полезнее числа: «Плохая» объясняет рывки,
  // «120 мс» — нет.
  // Сколько снапшотов пропало за последние GAP_WINDOW_MS.
  recentGaps(now = performance.now()) {
    const cutoff = now - GAP_WINDOW_MS;
    while (this.gapTimes.length && this.gapTimes[0] < cutoff) this.gapTimes.shift();
    return this.gapTimes.length;
  }

  get quality() {
    if (this.linkState === LINK_STATE.RECONNECTING) return 'reconnecting';
    if (this.linkState !== LINK_STATE.ONLINE) return 'offline';
    const rtt = this.clock.rtt;
    if (!Number.isFinite(rtt)) return 'unknown';
    const gaps = this.recentGaps();
    if (rtt < 90 && this.jitter < 60 && gaps <= 1) return 'good';
    if (rtt < 240 && this.jitter < 140 && gaps <= 5) return 'unstable';
    return 'poor';
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.intentionalClose = false;
    clearTimeout(this.reconnectTimer);
    this.setLinkState(this.reconnectAttempt ? LINK_STATE.RECONNECTING : LINK_STATE.CONNECTING);

    const url =
      window.WOBBLE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ui.status(this.reconnectAttempt ? 'Соединение потеряно, восстанавливаем…' : 'Будим сетевой сервис…');
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.pingCount = 0;
      this.lastPing = 0;
      this.gapTimes.length = 0;
      this.setLinkState(LINK_STATE.ONLINE);
      this.ui.status('Подключено — создайте комнату или войдите по коду.');
      // Если у нас есть токен прошлой сессии, сначала пробуем вернуться в свою комнату.
      if (this.sessionToken) this.raw({ type: C2S.RESUME, token: this.sessionToken });
      for (const item of this.queue.splice(0)) this.ws.send(item);
    });

    this.ws.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      this.handleMessage(message);
    });

    this.ws.addEventListener('error', () => {
      this.ui.error('Сетевой сервис недоступен. Одиночный режим по-прежнему работает.');
    });

    this.ws.addEventListener('close', () => {
      if (this.intentionalClose) return;
      this.emit('connectionLost', {});
      this.scheduleReconnect();
    });
  }

  recordRtt(rtt) {
    if (!Number.isFinite(rtt)) return;
    this.rttSamples.push(rtt);
    if (this.rttSamples.length > 12) this.rttSamples.shift();
    const mean = this.rttSamples.reduce((sum, value) => sum + value, 0) / this.rttSamples.length;
    this.jitter =
      this.rttSamples.reduce((sum, value) => sum + Math.abs(value - mean), 0) / this.rttSamples.length;
  }

  handleMessage(message) {
    switch (message.type) {
      case S2C.WELCOME:
        this.id = message.id;
        if (message.token) this.saveSession(message.token);
        // Несовпадение версий ловим сразу, а не когда сервер отклонит вход: так игрок узнаёт
        // причину до того, как что-то сломается.
        if (message.protocolVersion && message.protocolVersion !== PROTOCOL_VERSION) {
          this.ui.error(ERROR_TEXT.VERSION_MISMATCH);
        }
        // Грубая начальная оценка: настоящие замеры приедут с первыми pong.
        this.clock.seed(message.serverTime);
        break;

      case S2C.PONG:
        if (message.at === this.pingAt) {
          this.clock.record(message.at, message.serverTime);
          this.recordRtt(Date.now() - message.at);
        }
        break;

      case S2C.MATCH_START:
        this.matchId = message.matchId || null;
        // Новый забег — старая история позиций больше не имеет смысла.
        this.snapshots.clear();
        this.gapTimes.length = 0;
        break;

      case S2C.SNAPSHOT: {
        // Снапшот прошлого забега применять нельзя: он дёрнул бы игроков в позиции из прошлой гонки.
        if (this.matchId && message.matchId && message.matchId !== this.matchId) return;
        const now = performance.now();
        if (this.lastSnapshotAt && now - this.lastSnapshotAt > SNAPSHOT_GAP_MS) {
          this.gapTimes.push(now);
        }
        this.lastSnapshotAt = now;
        this.snapshotsReceived++;
        this.snapshots.push(message.serverTime, message.players || []);
        break;
      }

      case S2C.RESUMED:
        this.setLinkState(LINK_STATE.ONLINE);
        this.ui.toast('Соединение восстановлено.');
        // Сервер снимает признак «отошёл» при возврате в комнату. Если игра всё ещё свёрнута
        // (на компьютере фоновая вкладка успевает переподключиться), сообщаем об этом заново —
        // иначе напарник увидит вернувшегося, которого на самом деле нет.
        if (this.away) this.send(C2S.PRESENCE, { away: true });
        break;

      case S2C.ERROR:
        this.ui.error(ERROR_TEXT[message.code] || message.message || 'Сетевой запрос не удался.');
        break;
    }
    this.emit(message.type, message);
  }

  scheduleReconnect() {
    this.setLinkState(LINK_STATE.RECONNECTING);
    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      this.setLinkState(LINK_STATE.FAILED);
      this.ui.status('Не удалось восстановить соединение.');
      this.emit('disconnect', {});
      return;
    }
    const base = RECONNECT_DELAYS[this.reconnectAttempt++];
    const delay = base + Math.random() * RECONNECT_JITTER_MS;
    this.ui.status(`Соединение потеряно, повтор через ${Math.round(delay / 1000)} с…`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  emit(type, message) {
    for (const handler of this.handlers.get(type) || []) handler(message);
  }

  raw(object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(object));
  }

  send(type, data = {}) {
    const payload = JSON.stringify({ type, ...data });
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    else {
      this.connect();
      if (this.queue.length < 8) this.queue.push(payload);
      this.ui.status('Подключаемся… запрос поставлен в очередь.');
    }
  }

  createRoom({ name, difficulty, mode }) {
    this.send(C2S.CREATE_ROOM, { name, difficulty, mode, protocolVersion: PROTOCOL_VERSION });
  }

  joinRoom({ name, code }) {
    this.send(C2S.JOIN_ROOM, { name, code, protocolVersion: PROTOCOL_VERSION });
  }

  sendState(state) {
    const now = performance.now();
    if (now - this.lastState < STATE_INTERVAL_MS) return;
    this.lastState = now;
    this.send(C2S.PLAYER_STATE, { state, matchId: this.matchId ?? undefined });
  }

  // Кооперативное действие: нажатие плиты, запуск напарника катапультой, луч, оживление.
  // Сервер проверяет допустимость и ретранслирует напарнику.
  sendCoopEvent(action, data = {}) {
    this.send(C2S.COOP_EVENT, { action, matchId: this.matchId ?? undefined, ...data });
  }

  // Игра свёрнута или снова на экране. Флаг хранится здесь, а не в игре, потому что его надо
  // повторить после переподключения: сервер о нём не знает, пока ему не скажут.
  sendPresence(away) {
    if (this.away === away) return;
    this.away = away;
    this.send(C2S.PRESENCE, { away });
  }

  // Ускоренная переоценка часов. Пока вкладка была свёрнута, таймеры браузера тормозились,
  // и накопленные замеры описывают уже не ту задержку — надёжнее собрать их заново.
  resyncClock() {
    this.pingCount = 0;
    this.lastPing = 0;
  }

  tick() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const interval = this.pingCount < PING_FAST_COUNT ? PING_FAST_MS : PING_SLOW_MS;
    if (now - this.lastPing > interval) {
      this.lastPing = now;
      this.pingCount++;
      this.pingAt = Date.now();
      this.send(C2S.PING, { at: this.pingAt });
    }
  }

  close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.queue.length = 0;
    this.snapshots.clear();
    this.clock.reset();
    this.saveSession(null);
    this.matchId = null;
    this.rttSamples.length = 0;
    this.setLinkState(LINK_STATE.OFFLINE);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: C2S.LEAVE_ROOM }));
    this.ws?.close();
    this.ws = null;
    this.roomCode = null;
  }
}
