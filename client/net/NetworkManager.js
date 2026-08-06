import { ClockSync } from './ClockSync.js';
import { SnapshotBuffer } from './SnapshotBuffer.js';
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

// Пакеты, которые НЕЛЬЗЯ копить в очереди на время обрыва.
//
// Все они описывают «сейчас»: позиция, финиш, респавн, голос. Пока сокет был закрыт, это «сейчас»
// прошло. Отправленные пачкой после переподключения, они в лучшем случае бессмысленны, а в худшем
// приходят раньше, чем сервер подтвердил восстановление сессии, — и он отвечает на них ошибками
// игроку, которого в комнате ещё нет, начисляя нарушения протокола.
const TRANSIENT_TYPES = new Set([
  C2S.PLAYER_STATE,
  C2S.COOP_EVENT,
  C2S.RESPAWN,
  C2S.FINISH,
  C2S.REMATCH_VOTE,
  C2S.RETURN_TO_LOBBY,
  C2S.PRESENCE,
  C2S.PING
]);

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
  static hasSavedSession() {
    try {
      return !!sessionStorage.getItem(SESSION_KEY);
    } catch {
      return false;
    }
  }

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
    // Монотонный номер состояния позволяет серверу отбрасывать запоздавшие и повторно
    // доставленные пакеты. При resume сервер сообщает, с какого номера продолжить.
    this.stateSequence = 0;
    this.intentionalClose = false;
    this.linkState = LINK_STATE.OFFLINE;
    this.away = false;

    // Финиш отправляется ровно один раз за матч, и после него состояние больше не шлётся.
    // Именно хвостовой `state` после `finish` и вызывал серверную ошибку у второго дошедшего.
    this.finishSentFor = null;

    // Рукопожатие. Пока идёт восстановление сессии, `hello` считается предварительным: сервер
    // выдаёт его КАЖДОМУ новому сокету, включая тот, которым мы собираемся вернуться в старую
    // комнату. Принять этот временный id и токен сразу — значит разойтись с сервером в том, кто
    // мы такие: он считает нас прежним игроком, мы себя — новым.
    this.pendingWelcome = null;
    this.resumeInFlight = false;
    this.resumeToken = null;
    this.handshakeReady = false;
    // Клиент старее сервера: говорить с ним бессмысленно, страницу надо обновить.
    this.versionMismatch = false;

    this.clock = new ClockSync();
    this.snapshots = new SnapshotBuffer();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    // Сервер предупредил о перезапуске. Отличает штатное обновление от обрыва связи: восстановление
    // идёт по-разному, и говорить игроку надо разное.
    this.serverRestarting = false;
    this.sessionToken = this.loadSession();

    // Статистика качества связи. Джиттер считаем как среднее отклонение задержки: именно он,
    // а не сама задержка, ощущается как «дёргается» — стабильные 150 мс играются нормально,
    // а скачущие 40–160 мс нет.
    this.rttSamples = [];
    this.jitter = 0;
    this.snapshotsReceived = 0;
    this.lastSnapshotSequence = -1;
    this.staleSnapshots = 0;
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
    return this.serverNow() - this.snapshots.renderDelay;
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
      // Счётчик попыток здесь НЕ сбрасывается.
      //
      // Открытый TCP-сокет ещё не значит рабочее соединение: сервер может принимать подключение
      // и тут же рвать его на рукопожатии — например, при несовпадении версий или отказе по
      // лимиту адреса. Сбрасывая счётчик на `open`, клиент бесконечно повторял бы ПЕРВУЮ попытку
      // каждые полсекунды вместо пяти затухающих. Сброс перенесён в успешное завершение
      // рукопожатия — туда, где соединение действительно работает.
      this.pingCount = 0;
      this.lastPing = 0;
      this.gapTimes.length = 0;
      this.setLinkState(LINK_STATE.ONLINE);
      this.ui.status('Подключено — создайте комнату или войдите по коду.');
      // Если у нас есть токен прошлой сессии, сначала пробуем вернуться в свою комнату — и до
      // ответа сервера не отправляем ничего, кроме самого запроса на возврат. Иначе очередь
      // уйдёт от имени игрока, которого в комнате ещё нет.
      this.resumeToken = this.sessionToken;
      this.resumeInFlight = !!this.resumeToken;
      this.handshakeReady = !this.resumeInFlight;
      if (this.resumeInFlight) this.raw({ type: C2S.RESUME, token: this.resumeToken });
      else this.flushQueue();
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
      // После предупреждения о перезапуске счётчик попыток начинаем заново: сервер поднимется
      // через несколько секунд, а исчерпанные попытки прошлого обрыва отправили бы игрока прямо
      // в «Не удалось восстановить соединение», ни разу не попробовав.
      if (this.serverRestarting) this.reconnectAttempt = 0;
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

  // Принять личность, выданную сервером новому сокету. Вызывается либо сразу (обычное
  // подключение), либо после неудачного восстановления сессии.
  adoptWelcome() {
    const welcome = this.pendingWelcome;
    this.pendingWelcome = null;
    if (!welcome) return;
    this.id = welcome.id;
    if (welcome.token) this.saveSession(welcome.token);
    this.handshakeReady = true;
    // Рукопожатие завершилось — соединение рабочее, счётчик попыток можно обнулить.
    this.reconnectAttempt = 0;
    this.flushQueue();
  }

  flushQueue() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const item of this.queue.splice(0)) this.ws.send(item);
  }

  handleMessage(message) {
    switch (message.type) {
      case S2C.WELCOME:
        // Несовпадение версий ловим сразу, а не когда сервер отклонит вход: так игрок узнаёт
        // причину до того, как что-то сломается. И перестаём слать: несовместимый клиент,
        // который продолжает говорить, только собирает ошибки протокола.
        if (message.protocolVersion && message.protocolVersion !== PROTOCOL_VERSION) {
          this.versionMismatch = true;
          this.intentionalClose = true;
          this.ui.error(ERROR_TEXT.VERSION_MISMATCH);
          this.emit('versionMismatch', message);
          this.ws?.close();
          return;
        }
        this.pendingWelcome = { id: message.id, token: message.token };
        // Пока восстановление в полёте, эта личность — запасная: настоящую пришлёт `resumed`.
        if (!this.resumeInFlight) this.adoptWelcome();
        // Грубая начальная оценка: настоящие замеры приедут с первыми pong.
        this.clock.seed(message.serverTime);
        break;

      case S2C.PONG:
        if (message.at === this.pingAt) {
          this.clock.record(message.at, message.serverTime);
          this.recordRtt(Date.now() - message.at);
        }
        break;

      // Код комнаты нужен, чтобы отличить «мы были в комнате» от «мы только подключились».
      // Без него неудачное восстановление из ЛОББИ проходило незамеченным: matchId там ещё null,
      // и клиент оставлял на экране комнату, которой на сервере уже нет. Кнопки в ней начинали
      // отвечать «сначала войдите в комнату».
      case S2C.ROOM_STATE:
        this.roomCode = message.code || null;
        break;

      case S2C.MATCH_START:
        this.matchId = message.matchId || null;
        this.stateSequence = message.resumed?.nextSequence ?? 0;
        // Новый забег — новое право на финиш.
        this.finishSentFor = null;
        // Новый забег — старая история позиций больше не имеет смысла.
        this.snapshots.clear();
        this.lastSnapshotSequence = -1;
        this.gapTimes.length = 0;
        break;

      case S2C.SNAPSHOT: {
        // Снапшот прошлого забега применять нельзя: он дёрнул бы игроков в позиции из прошлой гонки.
        if (this.matchId && message.matchId && message.matchId !== this.matchId) return;
        if (Number.isSafeInteger(message.sequence) && message.sequence <= this.lastSnapshotSequence) {
          this.staleSnapshots++;
          return;
        }
        if (Number.isSafeInteger(message.sequence)) this.lastSnapshotSequence = message.sequence;
        const now = performance.now();
        if (this.lastSnapshotAt && now - this.lastSnapshotAt > SNAPSHOT_GAP_MS) {
          this.gapTimes.push(now);
        }
        this.lastSnapshotAt = now;
        this.snapshotsReceived++;
        this.snapshots.push(message.serverTime, message.players || [], now);
        break;
      }

      case S2C.RESUMED:
        // Возвращаем себе ПРЕЖНИЙ идентификатор, а не тот временный, что выдали этому сокету.
        // Иначе игрок перестаёт узнавать самого себя: свой снапшот выглядит чужим, и игра
        // создаёт вторую модель себя же рядом с настоящей.
        this.id = message.id;
        this.saveSession(message.token || this.resumeToken);
        this.pendingWelcome = null;
        this.resumeInFlight = false;
        this.resumeToken = null;
        this.handshakeReady = true;
        this.reconnectAttempt = 0;
        this.setLinkState(LINK_STATE.ONLINE);
        this.ui.toast('Соединение восстановлено.');
        this.flushQueue();
        // Сервер снимает признак «отошёл» при возврате в комнату. Если игра всё ещё свёрнута
        // (на компьютере фоновая вкладка успевает переподключиться), сообщаем об этом заново —
        // иначе напарник увидит вернувшегося, которого на самом деле нет.
        if (this.away) this.send(C2S.PRESENCE, { away: true });
        break;

      case S2C.RESUME_FAILED: {
        // Вернуться не удалось: комнаты уже нет либо срок истёк. Старый токен мёртв — держать
        // его значит гарантированно провалить и следующую попытку.
        const hadSession = !!this.roomCode || !!this.matchId;
        this.saveSession(null);
        this.resumeInFlight = false;
        this.resumeToken = null;
        this.matchId = null;
        this.roomCode = null;
        this.finishSentFor = null;
        // Транзиентные пакеты прошлой жизни отправлять некуда и незачем.
        this.queue.length = 0;
        this.adoptWelcome();
        if (hadSession) this.emit('sessionExpired', message);
        break;
      }

      // Сервер выключается — обновление или перезапуск.
      //
      // Отличать это от обрыва связи обязательно. Комнаты живут в памяти процесса и перезапуск не
      // переживают, поэтому цепляться за старую сессию бессмысленно: resume гарантированно
      // провалится. Сбрасываем токен заранее и подключаемся заново уже начисто — и говорим прямо,
      // что происходит, вместо «соединение потеряно», которое выглядит как проблема у игрока.
      case S2C.SERVER_SHUTDOWN:
        this.serverRestarting = true;
        this.saveSession(null);
        this.resumeToken = null;
        this.resumeInFlight = false;
        this.matchId = null;
        this.roomCode = null;
        this.finishSentFor = null;
        this.queue.length = 0;
        this.ui.status('Сервер обновляется. Подключимся заново через несколько секунд…');
        break;

      case S2C.ERROR:
        this.ui.error(ERROR_TEXT[message.code] || message.message || 'Сетевой запрос не удался.');
        break;
    }
    this.emit(message.type, message);
  }

  scheduleReconnect() {
    this.setLinkState(LINK_STATE.RECONNECTING);
    if (this.serverRestarting) {
      this.serverRestarting = false;
      this.reconnectAttempt = 1;
      this.ui.status('Сервер обновляется, подключаемся заново…');
      this.reconnectTimer = setTimeout(() => this.connect(), 2500);
      return;
    }
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
    // Несовместимый клиент молчит: любое его сообщение сервер всё равно отвергнет, а нам важнее,
    // чтобы игрок увидел «обновите страницу», а не поток сетевых ошибок поверх него.
    if (this.versionMismatch) return false;
    const payload = JSON.stringify({ type, ...data });
    if (this.ws?.readyState === WebSocket.OPEN && this.handshakeReady) {
      this.ws.send(payload);
      return true;
    }
    this.connect();
    // Транзиентные пакеты не копим — см. TRANSIENT_TYPES.
    if (TRANSIENT_TYPES.has(type)) return false;
    if (this.queue.length < 8) this.queue.push(payload);
    this.ui.status('Подключаемся… запрос поставлен в очередь.');
    return false;
  }

  createRoom({ name, playerId, difficulty, mode }) {
    this.send(C2S.CREATE_ROOM, {
      name,
      playerId,
      difficulty,
      mode,
      protocolVersion: PROTOCOL_VERSION
    });
  }

  joinRoom({ name, playerId, code }) {
    this.send(C2S.JOIN_ROOM, { name, playerId, code, protocolVersion: PROTOCOL_VERSION });
  }

  sendState(state, { force = false } = {}) {
    if (!this.matchId) return false;
    // После отправки финиша состояние не шлём вовсе. Сервер к этому моменту уже мог перевести
    // комнату в «результаты», и опоздавший пакет стал бы ошибкой протокола на ровном месте.
    if (this.finishSentFor === this.matchId) return false;
    const now = performance.now();
    if (!force && now - this.lastState < STATE_INTERVAL_MS) return false;
    this.lastState = now;
    return this.send(C2S.PLAYER_STATE, {
      state,
      matchId: this.matchId,
      sequence: this.stateSequence++
    });
  }

  // Финиш вместе с финальной позицией — одним пакетом.
  //
  // Отдельным пакетом позиция не годилась: сервер отбрасывает состояния, пришедшие раньше 32 мс
  // после предыдущего, а обычные позиции идут раз в 66 мс. Примерно в половине случаев финальная
  // попадала в это окно и терялась молча, финиш проверялся по точке перед лентой и отклонялся.
  // Внутри `finish` состояние применяется без ограничения по частоте.
  finish(state, clientTime) {
    if (!this.matchId || this.finishSentFor === this.matchId) return false;
    this.finishSentFor = this.matchId;
    return this.send(C2S.FINISH, {
      matchId: this.matchId,
      sequence: this.stateSequence++,
      state,
      clientTime
    });
  }

  // Сервер финиш не принял: позиция ещё не за чертой. Разрешаем повторить — иначе игрок,
  // который реально добежал, останется без результата.
  allowFinishRetry() {
    this.finishSentFor = null;
  }

  // Кооперативное действие: нажатие плиты, запуск напарника катапультой, оживление.
  // Сервер проверяет допустимость и ретранслирует напарнику.
  sendCoopEvent(action, data = {}) {
    if (!this.matchId) return false;
    return this.send(C2S.COOP_EVENT, { action, matchId: this.matchId, ...data });
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
    this.finishSentFor = null;
    this.pendingWelcome = null;
    this.resumeInFlight = false;
    this.resumeToken = null;
    this.handshakeReady = false;
    this.rttSamples.length = 0;
    this.setLinkState(LINK_STATE.OFFLINE);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: C2S.LEAVE_ROOM }));
    this.ws?.close();
    this.ws = null;
    this.roomCode = null;
  }
}
