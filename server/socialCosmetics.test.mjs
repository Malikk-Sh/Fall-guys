import test from 'node:test';
import assert from 'node:assert/strict';
import socialModule from './socialCosmetics.js';

const { SocialCosmetics } = socialModule;

const EMPTY = {
  body: 'classic',
  visor: null,
  antenna: null,
  back: null,
  trail: null,
  finish: null
};

test('публичный loadout берётся только из server resolver и сохраняет валидные слоты', () => {
  const social = new SocialCosmetics();
  let resolved = null;
  social.configure(accountId => {
    resolved = accountId;
    return {
      body: 'sky-hero',
      visor: 'neon-visor',
      antenna: 'party-antenna',
      back: 'space-oxygen-pack',
      trail: null,
      finish: 'campaign-finish'
    };
  });

  assert.deepEqual(social.forAccount('acc-42'), {
    body: 'sky-hero',
    visor: 'neon-visor',
    antenna: 'party-antenna',
    back: 'space-oxygen-pack',
    trail: null,
    finish: 'campaign-finish'
  });
  assert.equal(resolved, 'acc-42');
});

test('неизвестные и переставленные cosmetic IDs не попадают в публичный профиль', () => {
  const social = new SocialCosmetics();
  social.configure(() => ({
    body: 'neon-visor',
    visor: 'definitely-not-a-cosmetic',
    antenna: 'sky-hero',
    back: 'space-star-crown',
    trail: 'party-antenna',
    finish: 'classic'
  }));

  assert.deepEqual(social.forAccount('acc-unsafe'), EMPTY);
});

test('анонимный игрок и ошибка inventory получают безопасный базовый loadout', () => {
  const social = new SocialCosmetics();
  let calls = 0;
  social.configure(() => {
    calls++;
    throw new Error('db unavailable');
  });

  assert.deepEqual(social.forAccount(null), EMPTY);
  assert.equal(calls, 0);
  assert.deepEqual(social.forAccount('acc-1'), EMPTY);
  assert.equal(calls, 1);
});

// Старый payload — тот, что писала версия сервера без слота «спина». Он не должен ни ломаться,
// ни терять уже надетое: `back` просто нормализуется в пустой слот.
test('payload без слота back остаётся валидным и получает пустой back', () => {
  const social = new SocialCosmetics();
  social.configure(() => ({
    body: 'sky-hero',
    visor: 'clear-visor',
    antenna: 'rescue-antenna',
    trail: 'sunrise-trail',
    finish: 'campaign-finish'
  }));

  assert.deepEqual(social.forAccount('acc-legacy'), {
    body: 'sky-hero',
    visor: 'clear-visor',
    antenna: 'rescue-antenna',
    back: null,
    trail: 'sunrise-trail',
    finish: 'campaign-finish'
  });
});

test('emote loadout нормализуется до четырёх канонических ячеек без повторов', () => {
  const social = new SocialCosmetics();
  assert.deepEqual(social.sanitizeEmotes(null), [null, null, null, null]);
  assert.deepEqual(
    social.sanitizeEmotes([
      'food-chefs-kiss',
      'classic',
      'food-chefs-kiss',
      'definitely-not-a-cosmetic',
      'space-moonwalk'
    ]),
    ['food-chefs-kiss', null, null, null]
  );
});

test('разрешение на эмоцию не выдаётся без inventory и не выдаётся при его ошибке', () => {
  const social = new SocialCosmetics();
  assert.equal(social.canPlayEmote('acc-1', 'food-chefs-kiss'), false, 'resolver не подключён');

  social.configureEmotes(() => {
    throw new Error('db unavailable');
  });
  assert.equal(social.canPlayEmote('acc-1', 'food-chefs-kiss'), false, 'сбой не открывает доступ');

  let asked = null;
  social.configureEmotes((accountId, emoteId) => {
    asked = [accountId, emoteId];
    return true;
  });
  assert.equal(social.canPlayEmote(null, 'food-chefs-kiss'), false, 'гость эмоций не имеет');
  assert.equal(social.canPlayEmote('acc-1', ''), false);
  assert.equal(social.canPlayEmote('acc-1', 'food-chefs-kiss'), true);
  assert.deepEqual(asked, ['acc-1', 'food-chefs-kiss']);
});
