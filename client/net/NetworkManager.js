import { ClockSync } from './ClockSync.js';
import { SnapshotBuffer, RENDER_DELAY_MS } from './SnapshotBuffer.js';

// Интервал отправки своего состояния. Совпадает с частотой рассылки снапшотов на сервере (66 мс).
const STATE_INTERVAL_MS = 66;

// Первые секунды после подключения пингуем часто, чтобы быстро набрать замеры для синхронизации часов,
// дальше переходим на редкий режим — он нужен только для показа пинга и поддержания оценки.
const PING_FAST_MS = 350;
const PING_SLOW_MS = 3000;
const PING_FAST_COUNT = 8;

// Задержки переподключения. Растут экспоненциально, чтобы не добивать сервер, который лежит.
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000];
const SESSION_KEY = 'wobble-session';

export class NetworkManager {
  constructor(ui) {
    this.ui = ui;
    this.handlers = new Map();
    this.queue = [];
    this.id = null;
    this.roomCode = null;
    this.pingAt = 0;
    this.lastPing = 0;
    this.pingCount = 0;
    this.lastState = 0;
    this.intentionalClose = false;

    this.clock = new ClockSync();
    this.snapshots = new SnapshotBuffer();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.sessionToken = this.loadSession();
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

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.intentionalClose = false;
    clearTimeout(this.reconnectTimer);

    const url =
      window.WOBBLE_WS_URL || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.ui.status(this.reconnectAttempt ? 'Соединение потеряно, восстанавливаем…' : 'Будим сетевой сервис…');
    this.ws = new WebSocket(url);

    this.ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.pingCount = 0;
      this.lastPing = 0;
      this.ui.status('Подключено — создайте комнату или войдите по коду.');
      // Если у нас есть токен прошлой сессии, сначала пробуем вернуться в свою комнату.
      if (this.sessionToken) this.raw({ type: 'resume', token: this.sessionToken });
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

  handleMessage(message) {
    switch (message.type) {
      case 'hello':
        this.id = message.id;
        if (message.token) this.saveSession(message.token);
        // Первая грубая оценка часов — до того, как приедет первый pong.
        if (Number.isFinite(message.serverTime)) this.clock.record(Date.now(), message.serverTime);
        break;

      case 'pong':
        if (message.at === this.pingAt) this.clock.record(message.at, message.serverTime);
        break;

      case 'snapshot':
        // Пакеты складываются в буфер, а не применяются сразу: отрисовка идёт из буфера с задержкой.
        this.snapshots.push(message.serverTime, message.players || []);
        break;

      case 'resumed':
        this.ui.toast('Соединение восстановлено.');
        break;

      case 'error':
        this.ui.error(message.message || 'Сетевой запрос не удался.');
        break;
    }
    this.emit(message.type, message);
  }

  scheduleReconnect() {
    if (this.reconnectAttempt >= RECONNECT_DELAYS.length) {
      this.ui.status('Не удалось восстановить соединение. Забег продолжается в одиночном режиме.');
      this.emit('disconnect', {});
      return;
    }
    const delay = RECONNECT_DELAYS[this.reconnectAttempt++];
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

  sendState(state) {
    const now = performance.now();
    if (now - this.lastState < STATE_INTERVAL_MS) return;
    this.lastState = now;
    this.send('state', { state });
  }

  tick() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const now = performance.now();
    const interval = this.pingCount < PING_FAST_COUNT ? PING_FAST_MS : PING_SLOW_MS;
    if (now - this.lastPing > interval) {
      this.lastPing = now;
      this.pingCount++;
      this.pingAt = Date.now();
      this.send('ping', { at: this.pingAt });
    }
  }

  close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.queue.length = 0;
    this.snapshots.clear();
    this.clock.reset();
    this.saveSession(null);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'leave' }));
    this.ws?.close();
    this.ws = null;
    this.roomCode = null;
  }
}
