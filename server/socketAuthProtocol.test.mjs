import test from 'node:test';
import assert from 'node:assert/strict';

import { C2S, PROTOCOL_VERSION } from '../shared/protocol.js';
import { validateMessage } from '../shared/validation.js';

test('protocol v14 has an explicit one-shot socket AUTH message', () => {
  assert.equal(PROTOCOL_VERSION, 14);
  assert.equal(validateMessage({ type: C2S.AUTH, ticket: `WST.${'a'.repeat(32)}` }).ok, true);
  assert.equal(validateMessage({ type: C2S.AUTH, ticket: '' }).ok, false);
});

test('room and matchmaking messages reject account credentials', () => {
  const messages = [
    { type: C2S.CREATE_ROOM, name: 'A', accountToken: `WST.${'a'.repeat(32)}` },
    { type: C2S.JOIN_ROOM, name: 'A', code: 'AB12X', accountToken: `WST.${'a'.repeat(32)}` },
    { type: C2S.FIND_COOP, name: 'A', chapterId: 'ch1', accountToken: `WST.${'a'.repeat(32)}` }
  ];

  for (const message of messages) {
    const result = validateMessage(message);
    assert.equal(result.ok, false, `${message.type} не должен принимать credential`);
    assert.match(result.detail, /accountToken: неизвестное поле/);
  }
});

// Время трассы в состоянии игрока: v14.
//
// Поле необязательное намеренно — его отсутствие возвращает прежнее поведение, а не ломает разбор.
// Авторитетом оно не становится: по нему только выбирается момент, на который смотрит диагностика
// паритета при сверке подвижных опор.
test('состояние игрока принимает время трассы и проверяет его диапазон', () => {
  const base = { type: C2S.PLAYER_STATE, matchId: 'm'.repeat(8), sequence: 1 };
  const state = { x: 0, y: 1, z: 0, ry: 0, vx: 0, vz: 0 };

  assert.equal(validateMessage({ ...base, state }).ok, true, 'без поля — как раньше');
  assert.equal(validateMessage({ ...base, state, courseTime: 12.5 }).ok, true);
  assert.equal(validateMessage({ ...base, state, courseTime: 0 }).ok, true);

  assert.equal(
    validateMessage({ ...base, state, courseTime: -1 }).ok,
    false,
    'время не бывает отрицательным'
  );
  assert.equal(validateMessage({ ...base, state, courseTime: 1e9 }).ok, false, 'и не бывает астрономическим');
  assert.equal(validateMessage({ ...base, state, courseTime: 'скоро' }).ok, false);
});
