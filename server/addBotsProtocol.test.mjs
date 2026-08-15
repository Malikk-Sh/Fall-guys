import test from 'node:test';
import assert from 'node:assert/strict';
import { C2S } from '../shared/protocol.js';
import { validateMessage } from '../shared/validation.js';

test('addBots принимает только целое число соперников', () => {
  for (const count of [0, 1, 4, 8]) {
    assert.equal(validateMessage({ type: C2S.ADD_BOTS, count }).ok, true, `count=${count}`);
  }

  for (const count of [0.1, 0.9, 1.5, 7.99]) {
    const result = validateMessage({ type: C2S.ADD_BOTS, count });
    assert.equal(result.ok, false, `дробный count=${count} обязан отклоняться до обработчика`);
  }
});
