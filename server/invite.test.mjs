import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInviteLink, readInvite } from '../client/core/invite.js';

test('приглашение сохраняет режим комнаты', () => {
  const coop = buildInviteLink('https://game.example/play?old=1#menu', 'abcde', 'coop');
  assert.equal(coop, 'https://game.example/play?room=ABCDE&mode=coop');
  assert.deepEqual(readInvite(coop), { code: 'ABCDE', mode: 'coop' });

  const race = buildInviteLink('https://game.example/play', 'Q7K9Z', 'race');
  assert.deepEqual(readInvite(race), { code: 'Q7K9Z', mode: 'race' });
});

test('старая ссылка сохраняет кооп, а неизвестный режим безопасно открывает гонку', () => {
  assert.deepEqual(readInvite('https://game.example/?room=abcde'), { code: 'ABCDE', mode: 'coop' });
  assert.deepEqual(readInvite('https://game.example/?room=abcde&mode=admin'), {
    code: 'ABCDE',
    mode: 'race'
  });
  assert.equal(readInvite('не адрес'), null);
  assert.equal(readInvite('https://game.example/?mode=coop'), null);
});
