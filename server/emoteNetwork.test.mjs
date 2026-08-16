// Сетевой контракт эмоций.
//
// Эмоция — единственное действие косметики, которое пересекает сетевую границу, и потому
// единственное, где косметика могла бы стать оружием: спамом, произвольной анимацией у чужого
// клиента или способом что-то изменить в чужом состоянии. Здесь проверяется, что ни одного из
// этих способов нет.

import test from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWED_IN_STATE, C2S, MESSAGE_SCHEMAS, RATE_LIMITS, ROOM_STATE, S2C } from '../shared/protocol.js';
import { RateLimiter, validateMessage } from '../shared/validation.js';
import { COSMETIC_BY_ID, isEmote, publicEmoteLoadout } from '../shared/cosmetics.js';
import socialModule from './socialCosmetics.js';

const { SocialCosmetics } = socialModule;

test('схема emote принимает только канонический ID и ничего больше', () => {
  assert.ok(MESSAGE_SCHEMAS[C2S.EMOTE], 'сообщение описано схемой');
  assert.equal(validateMessage({ type: C2S.EMOTE, emoteId: 'food-chefs-kiss' }).ok, true);
  assert.equal(validateMessage({ type: C2S.EMOTE }).ok, false, 'ID обязателен');
  assert.equal(validateMessage({ type: C2S.EMOTE, emoteId: '' }).ok, false, 'пустой ID не проходит');

  // Клиент не диктует чужому клиенту, что и как рисовать: длительность, трансформации и настройки
  // анимации схемой не предусмотрены и потому отклоняются целиком вместе с сообщением.
  for (const extra of [
    { duration: 30 },
    { transform: { x: 100 } },
    { animation: 'custom' },
    { impulse: { x: 50, y: 50, z: 50 } },
    { scale: 12 }
  ]) {
    assert.equal(
      validateMessage({ type: C2S.EMOTE, emoteId: 'food-chefs-kiss', ...extra }).ok,
      false,
      `лишнее поле ${Object.keys(extra)[0]} отклоняется`
    );
  }
});

test('эмоция разрешена там, где игроки видят друг друга, и нигде больше', () => {
  assert.deepEqual(ALLOWED_IN_STATE[C2S.EMOTE], [
    ROOM_STATE.LOBBY,
    ROOM_STATE.COUNTDOWN,
    ROOM_STATE.PLAYING,
    ROOM_STATE.RESULTS
  ]);
  assert.equal(ALLOWED_IN_STATE[C2S.EMOTE].includes(ROOM_STATE.CLOSING), false);
});

test('частота эмоций ограничена примерно двумя в секунду с коротким запасом', () => {
  const [limit, windowMs] = RATE_LIMITS[C2S.EMOTE];
  assert.ok(limit <= 3, 'burst не больше трёх');
  assert.ok(limit / (windowMs / 1000) <= 2.5, 'устойчивый темп около двух в секунду');

  // Проверка на самом ограничителе, а не только на числах: спам гасится, обычное нажатие — нет.
  let now = 0;
  const limiter = new RateLimiter();
  let allowed = 0;
  for (let index = 0; index < 25; index++) {
    if (limiter.allow(C2S.EMOTE, now)) allowed++;
    now += 20;
  }
  assert.ok(allowed <= limit + 1, `из двадцати пяти подряд прошло ${allowed}`);

  // Через окно эмоции снова доступны: ограничитель наказывает поток, а не игрока.
  now += windowMs;
  assert.equal(limiter.allow(C2S.EMOTE, now), true);
});

test('серверное событие эмоции несёт только ID отправителя и предмета', () => {
  // Сравниваем с формой, которую строит обработчик в server/index.js: ключей ровно четыре, и
  // среди них нет ничего, что клиент мог бы задать сам.
  const broadcast = { type: S2C.PLAYER_EMOTE, id: 'player-1', emoteId: 'food-chefs-kiss', at: 1000 };
  assert.deepEqual(Object.keys(broadcast).sort(), ['at', 'emoteId', 'id', 'type']);
  assert.equal(isEmote(broadcast.emoteId), true);
});

test('сервер отклоняет эмоцию, которой игрок не владеет или не выбрал', () => {
  const social = new SocialCosmetics();
  const owned = new Set(['food-chefs-kiss', 'neon-robot-dance']);
  let selected = publicEmoteLoadout(['food-chefs-kiss', null, null, null]);
  social.configureEmotes((_accountId, emoteId) => {
    const item = COSMETIC_BY_ID[emoteId];
    if (!item || item.slot !== 'emote') return false;
    if (!owned.has(emoteId)) return false;
    return selected.includes(emoteId);
  });

  assert.equal(social.canPlayEmote('acc-1', 'food-chefs-kiss'), true);
  assert.equal(social.canPlayEmote('acc-1', 'neon-robot-dance'), false, 'владеет, но не выбрал');
  assert.equal(social.canPlayEmote('acc-1', 'space-moonwalk'), false, 'не владеет');
  assert.equal(social.canPlayEmote('acc-1', 'classic'), false, 'не эмоция');
  assert.equal(social.canPlayEmote('acc-1', '../../etc/passwd'), false, 'мусор вместо ID');

  // Выбор меняется в шкафу между двумя сообщениями — значит проверять его надо на каждое, а не
  // один раз при входе в комнату.
  selected = publicEmoteLoadout(['neon-robot-dance', null, null, null]);
  assert.equal(social.canPlayEmote('acc-1', 'food-chefs-kiss'), false);
  assert.equal(social.canPlayEmote('acc-1', 'neon-robot-dance'), true);
});

test('эмоции каталога не несут игровых эффектов', () => {
  const emotes = Object.values(COSMETIC_BY_ID).filter(item => item.slot === 'emote');
  assert.equal(emotes.length, 6);
  for (const item of emotes) {
    // Ни одно поле эмоции не описывает физику: ни импульса, ни урона, ни хитбокса, ни скорости.
    // Отсутствие таких полей — не забывчивость, а условие: их нечему было бы применить.
    for (const forbidden of ['impulse', 'damage', 'hitbox', 'speed', 'mass', 'knockback', 'cooldown']) {
      assert.equal(forbidden in item.render, false, `${item.id}: у эмоции нет поля ${forbidden}`);
      assert.equal(forbidden in item, false, `${item.id}: у эмоции нет поля ${forbidden}`);
    }
    // Длительность ограничена сверху: «эмоция» на полминуты была бы способом занять экран.
    assert.ok(item.render.duration > 0 && item.render.duration <= 3.5, `${item.id}: разумная длительность`);
  }
});
