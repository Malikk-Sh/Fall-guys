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
export const PROTOCOL_VERSION = 2;

// Сообщения клиент → сервер.
export const C2S = Object.freeze({
  RESUME: 'resume',
  CREATE_ROOM: 'create',
  JOIN_ROOM: 'join',
  LEAVE_ROOM: 'leave',
  PLAYER_READY: 'ready',
  HOST_CONFIGURE: 'configure',
  START_MATCH: 'start',
  PLAYER_STATE: 'state',
  PRESENCE: 'presence',
  COOP_EVENT: 'coopEvent',
  RESPAWN: 'respawn',
  FINISH: 'finish',
  REMATCH_VOTE: 'rematch',
  RETURN_TO_LOBBY: 'returnLobby',
  PING: 'ping'
});

// Сообщения сервер → клиент.
export const S2C = Object.freeze({
  WELCOME: 'hello',
  RESUMED: 'resumed',
  RESUME_FAILED: 'resumeFailed',
  ROOM_STATE: 'lobby',
  MATCH_START: 'start',
  SNAPSHOT: 'snapshot',
  CORRECTION: 'correction',
  PLAYER_PRESENCE: 'presence',
  COOP_EVENT: 'coopEvent',
  PLAYER_FINISHED: 'finish',
  MATCH_RESULTS: 'results',
  HOST_CHANGED: 'hostChanged',
  PONG: 'pong',
  ERROR: 'error'
});

// Коды ошибок. Клиент переводит код в текст на своём языке — сервер не занимается локализацией.
export const ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  PROTOCOL_ERROR: 'PROTOCOL_ERROR',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
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
  RESULTS: ['LOBBY', 'CLOSING'],
  CLOSING: []
});

export function canTransition(from, to) {
  return (ROOM_TRANSITIONS[from] || []).includes(to);
}

// В каких состояниях комнаты допустимо каждое действие игрока. Проверка по этой таблице закрывает
// целый класс ошибок: смена сложности во время забега, повторный старт, финиш в лобби.
export const ALLOWED_IN_STATE = Object.freeze({
  [C2S.PLAYER_READY]: [ROOM_STATE.LOBBY],
  [C2S.HOST_CONFIGURE]: [ROOM_STATE.LOBBY],
  [C2S.START_MATCH]: [ROOM_STATE.LOBBY],
  [C2S.PLAYER_STATE]: [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING],
  // Присутствие сознательно разрешено в любом состоянии комнаты: свернуть игру можно и в лобби,
  // и на экране результатов, и напарнику полезно знать об этом именно там — там его ждут.
  [C2S.COOP_EVENT]: [ROOM_STATE.PLAYING],
  [C2S.RESPAWN]: [ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING],
  [C2S.FINISH]: [ROOM_STATE.PLAYING],
  [C2S.REMATCH_VOTE]: [ROOM_STATE.PLAYING, ROOM_STATE.RESULTS],
  [C2S.RETURN_TO_LOBBY]: [ROOM_STATE.PLAYING, ROOM_STATE.RESULTS]
});

// Режимы игры. Соревновательные форматы (турниры, выбывание) сюда сознательно не входят —
// проект сфокусирован на кооперативе.
export const GAME_MODE = Object.freeze({
  RACE: 'race',
  COOP: 'coop'
});

// Роли в кооперативе. Асимметричные: ни один участок главы не проходится одной ролью.
export const COOP_ROLE = Object.freeze({
  SPARK: 'spark',
  ANCHOR: 'anchor'
});

// Максимальный размер входящего сообщения. Совпадает с maxPayload на WebSocket-сервере —
// пакеты крупнее обрываются на уровне транспорта и до валидатора не доходят.
export const MAX_MESSAGE_BYTES = 4096;

// Схемы полей. Валидатор ходит по ним механически: тип, границы, длина.
//
// `num` — конечное число в диапазоне [min, max]; NaN и Infinity отклоняются.
// `str` — строка не длиннее max; `enum` — значение из списка; `bool` — булево.
// Поля, помеченные optional, могут отсутствовать, но если есть — проверяются.
const num = (min, max) => ({ kind: 'num', min, max });
const str = max => ({ kind: 'str', max });
const bool = () => ({ kind: 'bool' });
const oneOf = values => ({ kind: 'enum', values });
const optional = schema => ({ ...schema, optional: true });

// Границы координат совпадают с проверкой в gameRules.validateState: за ними игрок физически
// оказаться не может, и такое сообщение — либо баг, либо попытка обмана.
const COORD = num(-500, 500);
const VELOCITY = num(-200, 200);

export const MESSAGE_SCHEMAS = Object.freeze({
  [C2S.PING]: { at: num(0, Number.MAX_SAFE_INTEGER) },

  [C2S.RESUME]: { token: str(64) },

  [C2S.CREATE_ROOM]: {
    name: optional(str(32)),
    difficulty: optional(str(16)),
    mode: optional(oneOf(Object.values(GAME_MODE))),
    protocolVersion: optional(num(0, 1000))
  },

  [C2S.JOIN_ROOM]: {
    name: optional(str(32)),
    code: str(8),
    protocolVersion: optional(num(0, 1000))
  },

  [C2S.PLAYER_READY]: { ready: bool() },

  [C2S.START_MATCH]: {},

  [C2S.HOST_CONFIGURE]: {
    difficulty: optional(str(16)),
    mode: optional(oneOf(Object.values(GAME_MODE)))
  },

  [C2S.PLAYER_STATE]: {
    matchId: optional(str(32)),
    state: {
      kind: 'object',
      fields: {
        x: COORD,
        y: COORD,
        z: COORD,
        ry: num(-100, 100),
        vx: VELOCITY,
        vz: VELOCITY,
        checkpoint: optional(num(0, 64)),
        state: optional(oneOf(['ground', 'air', 'dive']))
      }
    }
  },

  // Игра свёрнута или снова на экране. На телефоне переключение в мессенджер — обычное дело,
  // а для напарника неподвижный персонаж неотличим от вылета: он стоит и ждёт неизвестно чего.
  [C2S.PRESENCE]: { away: bool() },

  // Кооперативное событие: инициатор сообщает о воздействии на объект или на напарника.
  // Сервер ограничивает модуль импульса и ретранслирует — подробности в server/coopRules.js.
  [C2S.COOP_EVENT]: {
    matchId: optional(str(32)),
    action: oneOf(['plate', 'launch', 'beam', 'revive', 'grabTether', 'releaseTether']),
    target: optional(str(32)),
    objectId: optional(str(48)),
    value: optional(num(-100, 100)),
    vector: optional({
      kind: 'object',
      fields: { x: VELOCITY, y: VELOCITY, z: VELOCITY }
    })
  },

  [C2S.RESPAWN]: { checkpoint: optional(num(0, 64)) },
  [C2S.FINISH]: {
    matchId: optional(str(32)),
    clientTime: optional(num(0, Number.MAX_SAFE_INTEGER))
  },
  [C2S.LEAVE_ROOM]: {},
  [C2S.REMATCH_VOTE]: {},
  [C2S.RETURN_TO_LOBBY]: {}
});

// Ограничения частоты по действиям. Формат: [сколько сообщений, за сколько миллисекунд].
//
// Значения подобраны с запасом к штатному поведению: состояние шлётся раз в 66 мс, то есть
// примерно 15 раз в секунду, — лимит 25 не мешает игре, но отсекает поток на порядок больший.
export const RATE_LIMITS = Object.freeze({
  [C2S.CREATE_ROOM]: [5, 60_000],
  [C2S.JOIN_ROOM]: [20, 60_000],
  [C2S.PLAYER_READY]: [30, 10_000],
  [C2S.HOST_CONFIGURE]: [20, 10_000],
  [C2S.START_MATCH]: [10, 10_000],
  [C2S.PLAYER_STATE]: [25, 1_000],
  // Переключение приложений — действие человеческого темпа. Лимит отсекает мигание вкладкой,
  // но оставляет запас на нормальную работу с телефоном.
  [C2S.PRESENCE]: [20, 10_000],
  [C2S.COOP_EVENT]: [30, 1_000],
  [C2S.RESPAWN]: [5, 5_000],
  [C2S.FINISH]: [5, 10_000],
  [C2S.REMATCH_VOTE]: [10, 10_000],
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
