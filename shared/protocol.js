// Описание сетевого протокола — единственный источник правды для клиента и сервера.
//
// Раньше типы сообщений были строковыми литералами, разбросанными по двум файлам: опечатка в имени
// не ловилась ничем и проявлялась как «сообщение молча не работает». Ровно так и появилось мёртвое
// сообщение checkpoint, которое клиент слал, а сервер не обрабатывал.
//
// Здесь же задаются схемы: какие поля обязательны, каких они типов и в каких границах. Валидатор
// (shared/validation.js) применяет эти схемы механически, поэтому проверка не может разойтись с
// документацией — она и есть документация.

// Версия протокола. Поднимать при любом несовместимом изменении схем: сервер отклонит клиента с
// другой версией, и игрок увидит понятное «обновите страницу» вместо необъяснимых сбоев.
export const PROTOCOL_VERSION = 11;

// Сообщения клиент → сервер.
export const C2S = Object.freeze({
  RESUME: 'resume',
  AUTH: 'auth',
  CREATE_ROOM: 'create',
  JOIN_ROOM: 'join',
  FIND_COOP: 'findCoop',
  FIND_RACE: 'findRace',
  CANCEL_MATCHMAKING: 'cancelMatchmaking',
  LEAVE_ROOM: 'leave',
  PLAYER_READY: 'ready',
  HOST_CONFIGURE: 'configure',
  START_MATCH: 'start',
  PLAYER_STATE: 'state',
  PRESENCE: 'presence',
  COOP_EVENT: 'coopEvent',
  COOP_PING: 'coopPing',
  RESPAWN: 'respawn',
  FINISH: 'finish',
  // Хост приватной комнаты управляет ботами. Положительный count добавляет столько соперников,
  // ноль убирает одного; старое {count:3} остаётся полностью совместимым.
  ADD_BOTS: 'addBots',
  REMATCH_VOTE: 'rematch',
  NEXT_CHAPTER_VOTE: 'nextChapter',
  RETURN_TO_LOBBY: 'returnLobby',
  PING: 'ping'
});

// Сообщения сервер → клиент.
export const S2C = Object.freeze({
  WELCOME: 'hello',
  AUTHENTICATED: 'authenticated',
  RESUMED: 'resumed',
  RESUME_FAILED: 'resumeFailed',
  ROOM_STATE: 'lobby',
  MATCHMAKING_WAITING: 'matchmakingWaiting',
  MATCH_START: 'start',
  SNAPSHOT: 'snapshot',
  CORRECTION: 'correction',
  PLAYER_PRESENCE: 'presence',
  COOP_EVENT: 'coopEvent',
  COOP_PING: 'coopPing',
  PLAYER_FINISHED: 'finish',
  MATCH_RESULTS: 'results',
  // Забег перестал идти в зачёт: кто-то оборвался или вышел посреди главы.
  UNRANKED: 'unranked',
  // Финиш НЕ засчитан: по данным сервера игрок ещё не пересёк черту. Отдельный тип, а не обычная
  // коррекция, — клиент обязан отличить «тебя подвинуло» от «твой финиш не принят» и повторить
  // попытку, иначе он навсегда зависнет в «Подтверждаем результат…».
  FINISH_REJECTED: 'finishRejected',
  HOST_CHANGED: 'hostChanged',
  // Сервер выключается: обновление или перезапуск. Отдельный тип, а не обычный обрыв, — клиент
  // обязан отличить «связь пропала, сейчас восстановим» от «сервера больше нет, состояние комнаты
  // потеряно». В первом случае он ждёт и переподключается молча, во втором незачем изображать
  // борьбу за соединение: комнаты уже не существует, надо честно сказать и вернуть в меню.
  SERVER_SHUTDOWN: 'shutdown',
  PONG: 'pong',
  ERROR: 'error'
});

// Коды ошибок. Клиент переводит код в текст на своём языке — сервер не занимается локализацией.
export const ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_ALREADY_BOUND: 'AUTH_ALREADY_BOUND',
  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',
  ACCOUNT_SANCTIONED: 'ACCOUNT_SANCTIONED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  MATCH_ALREADY_STARTED: 'MATCH_ALREADY_STARTED',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_READY: 'NOT_READY',
  WRONG_STATE: 'WRONG_STATE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_FULL: 'SERVER_FULL',
  RECONNECT_EXPIRED: 'RECONNECT_EXPIRED',
  KICKED: 'KICKED'
});

// Состояния комнаты. Раньше жизненный цикл описывался единственным булевым room.started, из-за чего
// «идёт отсчёт» и «идёт гонка» были неразличимы, а «показываем результаты» не существовало вовсе.
export const ROOM_STATE = Object.freeze({
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  RESULTS: 'RESULTS',
  CLOSING: 'CLOSING'
});

// Разрешённые переходы между состояниями. Всё, чего здесь нет, запрещено.
export const ROOM_TRANSITIONS = Object.freeze({
  LOBBY: ['COUNTDOWN', 'CLOSING'],
  COUNTDOWN: ['PLAYING', 'LOBBY', 'CLOSING'],
  PLAYING: ['RESULTS', 'CLOSING'],
  // RESULTS → COUNTDOWN — это реванш: единогласное решение запускает тот же уровень заново, минуя
  // лобби и повторную готовность. Пока перехода не было, обе кнопки экрана результатов вели в
  // LOBBY, то есть делали одно и то же, и голосовать было не за что.
  RESULTS: ['LOBBY', 'COUNTDOWN', 'CLOSING'],
  CLOSING: []
});

export function canTransition(from, to) {
  return (ROOM_TRANSITIONS[from] || []).includes(to);
}

// В каких состояниях комнаты допустимо каждое действие игрока. Проверка по этой таблице закрывает
// целый класс ошибок: смена сложности во время забега, повторный старт, финиш в лобби.
export const ALLOWED_IN_STATE = Object.freeze({
  [C2S.PLAYER_READY]: [ROOM_STATE.LOBBY],
  [C2S.ADD_BOTS]: [ROOM_STATE.LOBBY],
  [C2S.HOST_CONFIGURE]: [ROOM_STATE.LOBBY],
  [C2S.START_MATCH]: [ROOM_STATE.LOBBY],
  [C2S.PLAYER_STATE]: [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING],
  // Присутствие сознательно разрешено в любом состоянии комнаты: свернуть игру можно и в лобби,
  // и на экране результатов, и напарнику полезно знать об этом именно там — там его ждут.
  [C2S.COOP_EVENT]: [ROOM_STATE.PLAYING],
  [C2S.COOP_PING]: [ROOM_STATE.PLAYING],
  [C2S.RESPAWN]: [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING],
  [C2S.FINISH]: [ROOM_STATE.PLAYING],
  // Только на экране результатов. Раньше эти типы принимались и в PLAYING, и кнопка «реванш»
  // работала как скрытое «завершить матч досрочно» — побочный эффект, которого никто не просил.
  [C2S.REMATCH_VOTE]: [ROOM_STATE.RESULTS],
  [C2S.NEXT_CHAPTER_VOTE]: [ROOM_STATE.RESULTS],
  [C2S.RETURN_TO_LOBBY]: [ROOM_STATE.RESULTS]
});

// Режимы игры. Соревновательные форматы (турниры, выбывание) сюда сознательно не входят —
// проект сфокусирован на кооперативе.
export const GAME_MODE = Object.freeze({
  RACE: 'race',
  COOP: 'coop'
});

// Как называется трасса в таблицах рекордов — и в общей, и в личной.
//
// Гонка описывается сидом и сложностью: трасса восстанавливается из них целиком. Кооперативная
// глава сидом не описывается вовсе — у неё рукотворная разметка и имя. Правило живёт в общем
// модуле, потому что ключ считают трое: сервер при записи, сервер при выдаче и клиент при
// запросе. Разойдись они на один символ — игрок не нашёл бы в таблице собственный результат.
export function courseKeyFor(mode, spec) {
  if (!spec) return '';
  if (mode === GAME_MODE.COOP) return String(spec.chapterId || spec.id || '');
  return `${(spec.seed ?? 0) >>> 0}:${spec.difficulty || 'normal'}`;
}

// Ролей в кооперативе больше нет.
//
// Раньше их было две, с разными прыжком, весом и способностями, и каждый участок требовал
// определённой. Красиво на бумаге и плохо в игре: половину времени игрок упирался в задачу,
// которую его роль решить не может, и ждал напарника — а если напарник не понял, чего от него
// хотят, пара стояла. Плюс любая ошибка в разметке превращалась в тупик: плита не той роли,
// пропасть шире прыжка тяжёлого, способность не у того.
//
// Теперь персонажи одинаковые, а кооператив держится на присутствии, а не на способностях:
// плиту надо КОМУ-ТО держать, пока другой идёт. В одиночку по-прежнему никак — но кто именно
// держит, а кто идёт, решают сами игроки и могут поменяться в любой момент.

// Максимальный размер входящего сообщения. Совпадает с maxPayload на WebSocket-сервере —
// пакеты крупнее обрываются на уровне транспорта и до валидатора не доходят.
export const MAX_MESSAGE_BYTES = 4096;

// Схемы полей. Валидатор ходит по ним механически: тип, границы, длина.
//
// `num` — конечное число в диапазоне [min, max]; NaN и Infinity отклоняются.
// `str` — непустая строка в диапазоне длины; `enum` — значение из списка; `bool` — булево.
// Поля, помеченные optional, могут отсутствовать, но если есть — проверяются.
const num = (min, max) => ({ kind: 'num', min, max });
// `min` по умолчанию 1: пустая строка проходила проверку и добиралась до логики, где означала уже
// что-то другое — пустой код комнаты искал комнату с именем '', пустой токен шёл в поиск сессии.
const str = (max, min = 1) => ({ kind: 'str', min, max });
const bool = () => ({ kind: 'bool' });
const oneOf = values => ({ kind: 'enum', values });
const optional = schema => ({ ...schema, optional: true });

// Границы координат совпадают с проверкой в gameRules.validateState: за ними игрок физически
// оказаться не может, и такое сообщение — либо баг, либо попытка обмана.
const COORD = num(-500, 500);
const VELOCITY = num(-200, 200);

// Форма состояния игрока. Одна на два сообщения: обычное `state` и финальное внутри `finish`.
const PLAYER_STATE_SHAPE = {
  kind: 'object',
  fields: {
    x: COORD,
    y: COORD,
    z: COORD,
    ry: num(-100, 100),
    vx: VELOCITY,
    vy: optional(VELOCITY),
    vz: VELOCITY,
    checkpoint: optional(num(0, 64)),
    state: optional(oneOf(['ground', 'air', 'dive', 'slam', 'downed']))
  }
};

export const MESSAGE_SCHEMAS = Object.freeze({
  [C2S.PING]: { at: num(0, Number.MAX_SAFE_INTEGER) },

  [C2S.RESUME]: { token: str(64) },
  [C2S.AUTH]: { ticket: str(64) },

  [C2S.CREATE_ROOM]: {
    // Ноль, а не общая единица: пустое имя сервер осмысленно заменяет на «Wobbler» (safeName), и
    // отклонять из-за него всё сообщение значило бы спорить с собственной обработкой.
    name: optional(str(32, 0)),
    // Постоянный анонимный идентификатор игрока: живёт в localStorage, ничего о человеке не
    // сообщает и нужен ровно для одного — чтобы в таблице рекордов у него была одна строка на
    // трассу, а не по строке на каждый забег. Необязателен: старый клиент его не присылает.
    //
    // Это не средство от читерства. Придумать себе новый идентификатор ничего не стоит, но это
    // ровно то же, что прийти новым игроком, — то есть защищаться тут не от чего.
    playerId: optional(str(64)),
    difficulty: optional(str(16)),
    mode: optional(oneOf(Object.values(GAME_MODE))),
    protocolVersion: optional(num(0, 1000))
  },

  [C2S.JOIN_ROOM]: {
    name: optional(str(32, 0)), // ноль по той же причине, что и в CREATE_ROOM
    playerId: optional(str(64)),
    code: str(8),
    protocolVersion: optional(num(0, 1000))
  },

  [C2S.FIND_COOP]: {
    name: optional(str(32, 0)),
    playerId: optional(str(64)),
    // Пустая строка означает «любая глава»; конкретная глава проверяется сервером по каталогу.
    chapterId: optional(str(16, 0)),
    protocolVersion: optional(num(0, 1000))
  },
  // Подбор в гонку. Отличие от кооперативного — не в форме сообщения, а в том, что собирается
  // не пара, а группа: сложность играет ту же роль, что глава, а вместо «нашлась пара» комната
  // ждёт наполнения по таймеру. Пустая строка означает «любая сложность».
  [C2S.FIND_RACE]: {
    name: optional(str(32, 0)),
    playerId: optional(str(64)),
    difficulty: optional(str(16, 0)),
    protocolVersion: optional(num(0, 1000))
  },
  [C2S.CANCEL_MATCHMAKING]: {},

  [C2S.PLAYER_READY]: { ready: bool() },
  // 0 — убрать одного бота; 1..8 — добавить указанное количество. Только целые значения входят
  // в протокол: иначе 0.9 проходил бы числовой диапазон, округлялся в 0 и неожиданно удалял бота.
  [C2S.ADD_BOTS]: {
    count: oneOf([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    skill: optional(oneOf(['rookie', 'steady', 'sharp']))
  },

  [C2S.START_MATCH]: {},

  [C2S.HOST_CONFIGURE]: {
    difficulty: optional(str(16)),
    mode: optional(oneOf(Object.values(GAME_MODE)))
  },

  // `matchId` обязателен во всех сообщениях, относящихся к забегу. Пока он был необязательным,
  // пакет прошлого матча без него проходил проверку и применялся к новому.
  [C2S.PLAYER_STATE]: {
    matchId: str(32),
    sequence: num(0, Number.MAX_SAFE_INTEGER),
    state: PLAYER_STATE_SHAPE
  },

  // Игра свёрнута или снова на экране. На телефоне переключение в мессенджер — обычное дело,
  // а для напарника неподвижный персонаж неотличим от вылета: он стоит и ждёт неизвестно чего.
  [C2S.PRESENCE]: { away: bool() },

  // Кооперативное событие: инициатор сообщает о воздействии на объект или на напарника.
  // Сервер ограничивает модуль импульса и ретранслирует — подробности в server/coopRules.js.
  [C2S.COOP_EVENT]: {
    matchId: str(32),
    action: oneOf(['plate', 'launch', 'revive']),
    target: optional(str(32)),
    objectId: optional(str(48)),
    value: optional(num(-100, 100)),
    vector: optional({
      kind: 'object',
      fields: { x: VELOCITY, y: VELOCITY, z: VELOCITY }
    })
  },
  [C2S.COOP_PING]: {
    matchId: str(32),
    command: oneOf(['here', 'wait', 'go', 'help', 'ready', 'thanks'])
  },

  [C2S.RESPAWN]: { matchId: str(32), checkpoint: optional(num(0, 64)) },
  // Финальное состояние едет ВНУТРИ finish, а не отдельным пакетом перед ним.
  //
  // Отдельным оно проходило через общий обработчик состояния, а тот отбрасывает всё, что пришло
  // раньше 32 мс после предыдущего. Обычные позиции идут раз в 66 мс, поэтому примерно в половине
  // случаев принудительная финальная позиция молча терялась, и финиш проверялся по точке ПЕРЕД
  // лентой. Игрок видел «Финиш не засчитан» на ровном месте. Внутри finish состояние проверяется
  // в том же обработчике, без ограничения по частоте, — позиция и завершение стали одной операцией.
  [C2S.FINISH]: {
    matchId: str(32),
    sequence: num(0, Number.MAX_SAFE_INTEGER),
    state: PLAYER_STATE_SHAPE,
    clientTime: optional(num(0, Number.MAX_SAFE_INTEGER))
  },
  [C2S.LEAVE_ROOM]: {},
  [C2S.REMATCH_VOTE]: { matchId: str(32) },
  [C2S.NEXT_CHAPTER_VOTE]: { matchId: str(32) },
  [C2S.RETURN_TO_LOBBY]: { matchId: str(32) }
});

// Ограничения частоты по действиям. Формат: [сколько сообщений, за сколько миллисекунд].
//
// Значения подобраны с запасом к штатному поведению: состояние шлётся раз в 66 мс, то есть
// примерно 15 раз в секунду, — лимит 25 не мешает игре, но отсекает поток на порядок больший.
export const RATE_LIMITS = Object.freeze({
  [C2S.AUTH]: [4, 60_000],
  [C2S.CREATE_ROOM]: [5, 60_000],
  [C2S.JOIN_ROOM]: [20, 60_000],
  [C2S.FIND_COOP]: [10, 60_000],
  [C2S.FIND_RACE]: [10, 60_000],
  [C2S.CANCEL_MATCHMAKING]: [10, 10_000],
  [C2S.PLAYER_READY]: [30, 10_000],
  // Плюс/минус — обычный UI-контрол: восьми быстрых тапов должно хватать до потолка комнаты.
  [C2S.ADD_BOTS]: [16, 10_000],
  [C2S.HOST_CONFIGURE]: [20, 10_000],
  [C2S.START_MATCH]: [10, 10_000],
  [C2S.PLAYER_STATE]: [25, 1_000],
  // Переключение приложений — действие человеческого темпа. Лимит отсекает мигание вкладкой,
  // но оставляет запас на нормальную работу с телефоном.
  [C2S.PRESENCE]: [20, 10_000],
  [C2S.COOP_EVENT]: [30, 1_000],
  // Пинги — человеческое действие: короткий burst допустим, постоянный спам нет.
  [C2S.COOP_PING]: [4, 5_000],
  [C2S.RESPAWN]: [5, 5_000],
  [C2S.FINISH]: [5, 10_000],
  [C2S.REMATCH_VOTE]: [10, 10_000],
  [C2S.NEXT_CHAPTER_VOTE]: [10, 10_000],
  [C2S.RETURN_TO_LOBBY]: [10, 10_000],
  [C2S.PING]: [10, 1_000],
  [C2S.RESUME]: [10, 60_000],
  [C2S.LEAVE_ROOM]: [10, 10_000]
});

// Штрафные баллы за нарушения. Копятся на соединении; при достижении порога клиент отключается.
//
// Разделение по весу принципиально: превышение частоты бывает у честного игрока с лагами и стоит
// мало, а попытка изменить защищённое состояние — почти наверняка намеренная и стоит дорого.
export const VIOLATION_WEIGHTS = Object.freeze({
  INVALID_SCHEMA: 1,
  RATE_EXCEEDED: 1,
  WRONG_STATE: 2,
  UNKNOWN_TYPE: 2,
  PROTECTED_STATE: 3,
  PROTOCOL_ABUSE: 5
});

export const VIOLATION_DISCONNECT_THRESHOLD = 12;

// Штрафы затухают со временем: у игрока с нестабильной сетью они не должны накапливаться
// за всю сессию и в итоге выкидывать его без вины.
export const VIOLATION_DECAY_PER_MINUTE = 4;
