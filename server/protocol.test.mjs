// Тесты протокола и валидации.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  C2S,
  S2C,
  MESSAGE_SCHEMAS,
  RATE_LIMITS,
  ROOM_STATE,
  ROOM_TRANSITIONS,
  ALLOWED_IN_STATE,
  canTransition,
  VIOLATION_WEIGHTS,
  VIOLATION_DISCONNECT_THRESHOLD,
  VIOLATION_DECAY_PER_MINUTE
} from '../shared/protocol.js';

import { validateMessage, RateLimiter, ViolationTracker } from '../shared/validation.js';

test('у каждого клиентского сообщения есть схема и ограничение частоты', () => {
  // Ровно эта проверка поймала реальный баг: тип START_MATCH был объявлен, но схемы не имел,
  // из-за чего валидатор считал его неизвестным и молча отклонял запуск забега.
  for (const [name, type] of Object.entries(C2S)) {
    assert.ok(MESSAGE_SCHEMAS[type], `${name} («${type}») объявлен без схемы`);
    assert.ok(RATE_LIMITS[type], `${name} («${type}») объявлен без ограничения частоты`);
  }
});

test('типы сообщений клиента и сервера не конфликтуют по смыслу', () => {
  // 'hello' сервер шлёт клиенту; обратного направления у него нет.
  assert.equal(S2C.WELCOME, 'hello');
  assert.ok(!Object.values(C2S).includes(S2C.SNAPSHOT));
  assert.ok(!Object.values(C2S).includes(S2C.MATCH_RESULTS));
});

test('валидатор принимает корректные сообщения', () => {
  assert.ok(validateMessage({ type: C2S.PING, at: 1700000000000 }).ok);
  assert.ok(validateMessage({ type: C2S.PLAYER_READY, ready: true }).ok);
  assert.ok(validateMessage({ type: C2S.JOIN_ROOM, code: 'AB12X' }).ok);
  assert.ok(validateMessage({ type: C2S.START_MATCH }).ok);
  assert.ok(
    validateMessage({
      type: C2S.PLAYER_STATE,
      matchId: 'a1b2c3d4e5f60718',
      sequence: 0,
      state: { x: 1, y: 2, z: -3, ry: 0.5, vx: 1, vz: -1, state: 'ground' }
    }).ok
  );
});

// `matchId` стал обязательным во всех сообщениях забега. Пока он был необязательным, пакет
// прошлого матча без него проходил проверку и применялся к новому: игрока дёргало в позицию
// из предыдущей гонки, а кооп-действие срабатывало на объекте, которого в новой главе нет.
test('сообщения забега без matchId отклоняются', () => {
  const withoutMatch = [
    { type: C2S.PLAYER_STATE, state: { x: 0, y: 1, z: -3, ry: 0, vx: 0, vz: 0, state: 'ground' } },
    { type: C2S.COOP_EVENT, action: 'plate' },
    { type: C2S.RESPAWN, checkpoint: 2 },
    {
      type: C2S.FINISH,
      clientTime: 1000,
      state: { x: 0, y: 1, z: -3, ry: 0, vx: 0, vz: 0, state: 'ground' }
    },
    { type: C2S.REMATCH_VOTE },
    { type: C2S.RETURN_TO_LOBBY }
  ];
  for (const message of withoutMatch) {
    const result = validateMessage(message);
    assert.equal(result.ok, false, `${message.type} без matchId должен отклоняться`);
  }

  // С идентификатором те же сообщения проходят.
  const matchId = 'a1b2c3d4e5f60718';
  assert.ok(validateMessage({ type: C2S.REMATCH_VOTE, matchId }).ok);
  assert.ok(validateMessage({ type: C2S.RETURN_TO_LOBBY, matchId }).ok);
  assert.ok(validateMessage({ type: C2S.RESPAWN, matchId, checkpoint: 2 }).ok);
  const shape = { x: 0, y: 1, z: -3, ry: 0, vx: 0, vz: 0, state: 'ground' };
  assert.ok(validateMessage({ type: C2S.FINISH, matchId, sequence: 1, state: shape, clientTime: 1000 }).ok);
  // И без позиции финиш теперь неполон: сервер обязан проверять его по свежей точке.
  assert.equal(validateMessage({ type: C2S.FINISH, matchId, clientTime: 1000 }).ok, false);
});

test('состояние и финиш требуют порядковый номер', () => {
  const matchId = 'a1b2c3d4e5f60718';
  const state = { x: 0, y: 1, z: -3, ry: 0, vx: 0, vz: 0, state: 'ground' };
  assert.equal(validateMessage({ type: C2S.PLAYER_STATE, matchId, state }).ok, false);
  assert.equal(validateMessage({ type: C2S.FINISH, matchId, state }).ok, false);
  assert.ok(validateMessage({ type: C2S.PLAYER_STATE, matchId, sequence: 0, state }).ok);
});

test('валидатор отклоняет некорректные сообщения', () => {
  const bad = [
    [null, 'сообщение не объект'],
    ['строка', 'сообщение не объект'],
    [{}, 'нет type'],
    [{ type: 'нет-такого' }, 'неизвестный тип'],
    [{ type: C2S.PLAYER_READY }, 'нет обязательного ready'],
    [{ type: C2S.PLAYER_READY, ready: 'да' }, 'ready не булево'],
    [{ type: C2S.JOIN_ROOM, code: 'X'.repeat(50) }, 'слишком длинный код'],
    [{ type: C2S.JOIN_ROOM, code: '' }, 'пустой код'],
    [{ type: C2S.JOIN_ROOM, code: '   ' }, 'код только из пробелов'],
    [{ type: C2S.JOIN_ROOM, code: 12345 }, 'код не строка'],
    [{ type: C2S.PING, at: -5 }, 'отрицательная отметка времени']
  ];
  for (const [message, why] of bad) {
    assert.equal(validateMessage(message).ok, false, `должно отклоняться: ${why}`);
  }
});

test('схемы закрыты для лишних полей на любом уровне', () => {
  const matchId = 'a1b2c3d4e5f60718';
  const state = { x: 0, y: 1, z: -3, ry: 0, vx: 0, vz: 0 };

  const extraTopLevel = validateMessage({
    type: C2S.PLAYER_READY,
    ready: true,
    admin: true
  });
  assert.equal(extraTopLevel.ok, false);
  assert.match(extraTopLevel.detail, /admin: неизвестное поле/);

  const extraNested = validateMessage({
    type: C2S.PLAYER_STATE,
    matchId,
    sequence: 0,
    state: { ...state, teleport: true }
  });
  assert.equal(extraNested.ok, false);
  assert.match(extraNested.detail, /state\.teleport: неизвестное поле/);
});

test('валидатор отсекает NaN и Infinity в координатах', () => {
  // Самый вредный случай: NaN не ломает проверку диапазона наивным сравнением, но, попав в
  // состояние игрока, распространяется на все последующие вычисления.
  const base = { x: 0, y: 0, z: 0, ry: 0, vx: 0, vz: 0 };
  for (const value of [NaN, Infinity, -Infinity]) {
    const message = { type: C2S.PLAYER_STATE, state: { ...base, x: value } };
    assert.equal(validateMessage(message).ok, false, `должно отклоняться: x = ${value}`);
  }
  // И выход за границы карты тоже.
  assert.equal(validateMessage({ type: C2S.PLAYER_STATE, state: { ...base, z: -99999 } }).ok, false);
});

test('вложенные объекты проверяются рекурсивно', () => {
  const matchId = 'a1b2c3d4e5f60718';
  const ok = validateMessage({
    type: C2S.COOP_EVENT,
    matchId,
    action: 'launch',
    vector: { x: 1, y: 8, z: 0 }
  });
  assert.ok(ok.ok);

  const bad = validateMessage({
    type: C2S.COOP_EVENT,
    matchId,
    action: 'launch',
    vector: { x: 1, y: 'вверх', z: 0 }
  });
  assert.equal(bad.ok, false);

  const unknownAction = validateMessage({ type: C2S.COOP_EVENT, matchId, action: 'взорвать-всё' });
  assert.equal(unknownAction.ok, false);
});

// Отдельно от проверки выше: там лишнее поле — обычное имя, здесь — имя из Object.prototype.
//
// Разница существенная. Если отбор лишних полей написан через оператор `in`, а не через
// Object.hasOwn, то `__proto__`, `toString` и `constructor` считаются описанными в схеме, и
// проверка пропускает ровно те имена, ради которых её и заводили. Обычным полем эту ошибку не
// поймать — тест обязан идти именно по цепочке прототипов.
test('поля из Object.prototype не считаются описанными в схеме', () => {
  // При разборе JSON `__proto__` становится обычным собственным полем и загрязнения прототипа не
  // вызывает, но в схеме его нет — значит, отказ.
  const polluted = JSON.parse(`{"type":"${C2S.PLAYER_READY}","ready":true,"__proto__":{"admin":1}}`);
  assert.equal(validateMessage(polluted).ok, false, '__proto__ — тоже неизвестное поле');

  for (const name of ['toString', 'constructor', 'hasOwnProperty', 'valueOf']) {
    const message = { type: C2S.PLAYER_READY, ready: true, [name]: 1 };
    assert.equal(validateMessage(message).ok, false, `${name} — не поле схемы`);
  }
});

test('пустые строки не проходят там, где значение обязано быть', () => {
  // Код комнаты проверен в тесте выше; здесь — остальные строковые поля, где пустое значение
  // добиралось до логики и означало уже другое: пустой токен шёл в поиск сессии, пустой matchId
  // сравнивался с идентификатором текущего матча.
  assert.equal(validateMessage({ type: C2S.RESUME, token: '' }).ok, false, 'пустой токен сессии');
  assert.equal(validateMessage({ type: C2S.REMATCH_VOTE, matchId: '' }).ok, false, 'пустой matchId');

  // Имя — сознательное исключение: safeName на сервере заменяет пустое значение на «Wobbler»,
  // поэтому отказ всему сообщению из-за пустого имени противоречил бы обработке.
  assert.ok(validateMessage({ type: C2S.CREATE_ROOM }).ok, 'имя можно не присылать вовсе');
  assert.ok(validateMessage({ type: C2S.CREATE_ROOM, name: '' }).ok, 'и можно прислать пустым');
});

// Валидатор стоит на границе доверия: всё, что приходит из сети, проходит через него. Исключение
// здесь — это не отказ игроку, а падение обработчика сообщения.
//
// Генератор с фиксированным зерном: случайный тест, который падает раз в сто прогонов и не
// воспроизводится, хуже отсутствующего.
test('валидатор не падает ни на каком мусоре', () => {
  let seed = 20260802;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = list => list[Math.floor(rnd() * list.length)];

  const atom = () =>
    pick([
      0,
      -1,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER,
      1e308,
      '',
      'ok',
      ' \uD800',
      '👾'.repeat(40),
      true,
      false,
      null,
      undefined
    ]);

  const value = depth =>
    depth <= 0 || rnd() < 0.4
      ? atom()
      : rnd() < 0.5
        ? Array.from({ length: Math.floor(rnd() * 4) }, () => value(depth - 1))
        : Object.fromEntries(
            Array.from({ length: Math.floor(rnd() * 5) }, () => [
              pick(['type', 'matchId', 'state', 'vector', 'x', 'code', '__proto__', 'токен']),
              value(depth - 1)
            ])
          );

  const types = [...Object.keys(MESSAGE_SCHEMAS), 'нет-такого', ''];
  for (let i = 0; i < 3000; i++) {
    const message = rnd() < 0.15 ? value(4) : { type: pick(types), ...value(3) };
    const result = validateMessage(message);
    assert.equal(typeof result.ok, 'boolean', `итог должен быть решением, а не ${result?.ok}`);
    if (!result.ok) assert.equal(typeof result.reason, 'string', 'у отказа обязана быть причина');
  }
});

test('ограничитель частоты работает скользящим окном', () => {
  const limiter = new RateLimiter({ test: [3, 1000] });
  const now = 10_000;

  assert.ok(limiter.allow('test', now));
  assert.ok(limiter.allow('test', now));
  assert.ok(limiter.allow('test', now));
  assert.equal(limiter.allow('test', now), false, 'четвёртое сообщение в окне отклоняется');

  // Окно скользящее, а не сбрасываемое: через полсекунды всё ещё нельзя.
  assert.equal(limiter.allow('test', now + 500), false);
  // А когда первые три вышли за окно — снова можно.
  assert.ok(limiter.allow('test', now + 1001));

  // Тип без объявленного лимита не ограничивается.
  assert.ok(limiter.allow('без-лимита', now));
});

test('счётчик нарушений отключает нарушителя и прощает случайные сбои', () => {
  const start = 1_000_000;
  const tracker = new ViolationTracker({
    threshold: VIOLATION_DISCONNECT_THRESHOLD,
    decayPerMinute: VIOLATION_DECAY_PER_MINUTE,
    now: start
  });

  // Грубое нарушение весит больше мелкого.
  assert.ok(VIOLATION_WEIGHTS.PROTOCOL_ABUSE > VIOLATION_WEIGHTS.RATE_EXCEEDED);

  // Поток грубых нарушений быстро упирается в порог.
  let disconnected = false;
  for (let i = 0; i < 5 && !disconnected; i++) {
    disconnected = tracker.add('PROTOCOL_ABUSE', start);
  }
  assert.ok(disconnected, 'явное злоупотребление должно приводить к отключению');

  // Редкие мелкие нарушения затухают и не копятся всю сессию.
  const patient = new ViolationTracker({
    threshold: VIOLATION_DISCONNECT_THRESHOLD,
    decayPerMinute: VIOLATION_DECAY_PER_MINUTE,
    now: start
  });
  let time = start;
  for (let i = 0; i < 30; i++) {
    time += 60_000;
    assert.equal(
      patient.add('RATE_EXCEEDED', time),
      false,
      'одно мелкое нарушение в минуту не должно приводить к отключению'
    );
  }
});

test('переходы состояний комнаты ограничены таблицей', () => {
  assert.ok(canTransition(ROOM_STATE.LOBBY, ROOM_STATE.COUNTDOWN));
  assert.ok(canTransition(ROOM_STATE.COUNTDOWN, ROOM_STATE.PLAYING));
  assert.ok(canTransition(ROOM_STATE.PLAYING, ROOM_STATE.RESULTS));
  assert.ok(canTransition(ROOM_STATE.RESULTS, ROOM_STATE.LOBBY));

  // Нельзя перепрыгнуть отсчёт, вернуться из результатов в игру или уйти куда-то из CLOSING.
  assert.equal(canTransition(ROOM_STATE.LOBBY, ROOM_STATE.PLAYING), false);
  assert.equal(canTransition(ROOM_STATE.RESULTS, ROOM_STATE.PLAYING), false);
  assert.equal(canTransition(ROOM_STATE.CLOSING, ROOM_STATE.LOBBY), false);

  // Каждое состояние объявлено в таблице переходов, иначе переход из него всегда запрещён.
  for (const state of Object.values(ROOM_STATE)) {
    assert.ok(ROOM_TRANSITIONS[state], `для состояния ${state} не объявлены переходы`);
  }
});

test('действия разрешены только в подходящих состояниях комнаты', () => {
  // Именно эти сочетания раньше не проверялись вообще.
  assert.ok(!ALLOWED_IN_STATE[C2S.HOST_CONFIGURE].includes(ROOM_STATE.PLAYING));
  assert.ok(!ALLOWED_IN_STATE[C2S.START_MATCH].includes(ROOM_STATE.PLAYING));
  assert.ok(!ALLOWED_IN_STATE[C2S.FINISH].includes(ROOM_STATE.LOBBY));
  assert.ok(!ALLOWED_IN_STATE[C2S.PLAYER_READY].includes(ROOM_STATE.RESULTS));

  // И наоборот — штатные действия разрешены.
  assert.ok(ALLOWED_IN_STATE[C2S.PLAYER_STATE].includes(ROOM_STATE.PLAYING));
  assert.ok(ALLOWED_IN_STATE[C2S.FINISH].includes(ROOM_STATE.PLAYING));

  // Все состояния из таблицы существуют.
  for (const states of Object.values(ALLOWED_IN_STATE)) {
    for (const state of states) {
      assert.ok(Object.values(ROOM_STATE).includes(state), `несуществующее состояние ${state}`);
    }
  }
});
