import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInviteLink, readInvite, shareInvite } from '../client/core/invite.js';

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

test('share invite использует системный share и безопасно откатывается к clipboard', async () => {
  const shared = [];
  const shareResult = await shareInvite({
    title: 'Кооп',
    url: 'https://game.example/?room=ABCDE',
    navigatorRef: { share: async payload => shared.push(payload) }
  });
  assert.equal(shareResult.shared, true);
  assert.equal(shared[0].url, 'https://game.example/?room=ABCDE');
  const copied = [];
  const fallback = await shareInvite({
    title: 'Кооп',
    url: 'https://game.example/?room=FGHIJ',
    navigatorRef: {
      share: async () => {
        throw Object.assign(new Error('gesture'), { name: 'NotAllowedError' });
      },
      clipboard: { writeText: async value => copied.push(value) }
    }
  });
  assert.equal(fallback.copied, true);
  assert.deepEqual(copied, ['https://game.example/?room=FGHIJ']);
});
