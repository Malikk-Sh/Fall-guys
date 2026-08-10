import test from 'node:test';
import assert from 'node:assert/strict';
import socialModule from './socialCosmetics.js';

const { SocialCosmetics } = socialModule;

test('публичный loadout берётся только из server resolver и сохраняет валидные слоты', () => {
  const social = new SocialCosmetics();
  let resolved = null;
  social.configure(accountId => {
    resolved = accountId;
    return {
      body: 'sky-hero',
      visor: 'neon-visor',
      antenna: 'party-antenna',
      trail: null,
      finish: 'campaign-finish'
    };
  });

  assert.deepEqual(social.forAccount('acc-42'), {
    body: 'sky-hero',
    visor: 'neon-visor',
    antenna: 'party-antenna',
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
    trail: 'party-antenna',
    finish: 'classic'
  }));

  assert.deepEqual(social.forAccount('acc-unsafe'), {
    body: 'classic',
    visor: null,
    antenna: null,
    trail: null,
    finish: null
  });
});

test('анонимный игрок и ошибка inventory получают безопасный базовый loadout', () => {
  const social = new SocialCosmetics();
  let calls = 0;
  social.configure(() => {
    calls++;
    throw new Error('db unavailable');
  });

  assert.deepEqual(social.forAccount(null), {
    body: 'classic',
    visor: null,
    antenna: null,
    trail: null,
    finish: null
  });
  assert.equal(calls, 0);
  assert.deepEqual(social.forAccount('acc-1'), {
    body: 'classic',
    visor: null,
    antenna: null,
    trail: null,
    finish: null
  });
  assert.equal(calls, 1);
});
