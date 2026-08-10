import test from 'node:test';
import assert from 'node:assert/strict';

import { C2S, PROTOCOL_VERSION } from '../shared/protocol.js';
import { validateMessage } from '../shared/validation.js';

test('protocol v10 has an explicit one-shot socket AUTH message', () => {
  assert.equal(PROTOCOL_VERSION, 10);
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
