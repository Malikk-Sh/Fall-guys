import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  COLLECTIONS,
  COLLECTION_MILESTONE_IDS,
  COSMETIC_BY_ID,
  collectionProgress,
  collectionRewards,
  cosmeticsInCollection
} from '../shared/cosmetics.js';
import { unlockRequirementText } from '../shared/cosmeticUnlocks.js';
import {
  LOADOUT_PRESET_COUNT,
  applyLoadout,
  readLoadoutPresets,
  saveLoadoutPreset,
  setServerCosmeticEquipHandler
} from '../client/core/cosmetics.js';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { InventoryService } = require('./inventory');

function memory() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
}

function setup() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const inventory = new InventoryService({ db, accounts });
  const account = accounts.create('Collector');
  inventory.syncEntitlements(account.id, 1000);
  return { db, inventory, account };
}

test('четыре базовые коллекции остаются 15 предметов и получают ступени 5/10/15', () => {
  assert.equal(COLLECTION_MILESTONE_IDS.length, 12);
  assert.equal(new Set(COLLECTION_MILESTONE_IDS).size, 12);

  for (const collection of COLLECTIONS) {
    const baseItems = cosmeticsInCollection(collection.id);
    assert.equal(baseItems.length, 15, `${collection.id}: базовых предметов 15`);

    const rewards = collectionRewards(collection.id);
    assert.deepEqual(
      rewards.map(item => item.unlock.gte),
      [5, 10, 15],
      `${collection.id}: три понятные ступени`
    );
    assert.equal(rewards.at(-1).rarity, 'prestige');
    assert.ok(rewards.every(item => item.collectionReward));
  }
});

test('закрытые предметы объясняют действие человеческим текстом', () => {
  assert.equal(unlockRequirementText(COSMETIC_BY_ID['space-star-crown']), 'Одержите 3 победы');
  assert.equal(
    unlockRequirementText(COSMETIC_BY_ID['space-orbit-visor']),
    'Соберите 5 подтверждённых предметов коллекции «КОСМОС»'
  );
  assert.equal(
    unlockRequirementText(COSMETIC_BY_ID['podium-trail']),
    'Попадите в тройку в гонке, где финишировали минимум 3 игрока'
  );
  assert.equal(unlockRequirementText(COSMETIC_BY_ID['space-void']), 'Награда за просмотр · скоро');
  assert.equal(unlockRequirementText(COSMETIC_BY_ID['neon-gl1tch']), 'Событие · скоро');
});

test('milestone-награды выдаются только по server-owned базовым предметам коллекции', () => {
  const { db, inventory, account } = setup();
  const base = cosmeticsInCollection('space-trouble');
  const owns = (profile, id) => profile.ownedIds.includes(id);

  for (const item of base.slice(0, 4)) inventory.grant(account.id, item.id, 'test', 2000);
  let profile = inventory.syncEntitlements(account.id, 2100);
  assert.equal(owns(profile, 'space-orbit-visor'), false);

  inventory.grant(account.id, base[4].id, 'test', 2200);
  profile = inventory.syncEntitlements(account.id, 2300);
  assert.equal(owns(profile, 'space-orbit-visor'), true);
  assert.equal(owns(profile, 'space-comet-trail'), false);

  for (const item of base.slice(5, 10)) inventory.grant(account.id, item.id, 'test', 2400);
  profile = inventory.syncEntitlements(account.id, 2500);
  assert.equal(owns(profile, 'space-comet-trail'), true);

  for (const item of base.slice(10)) inventory.grant(account.id, item.id, 'test', 2600);
  profile = inventory.syncEntitlements(account.id, 2700);
  assert.equal(owns(profile, 'space-constellation-crown'), true);

  const space = profile.collections.find(item => item.id === 'space-trouble');
  assert.equal(space.owned, 15);
  assert.equal(space.total, 15);
  assert.equal(space.complete, true);
  assert.deepEqual(
    space.milestones.map(item => [item.threshold, item.owned]),
    [
      [5, true],
      [10, true],
      [15, true]
    ]
  );

  const source = db
    .prepare('SELECT source FROM account_cosmetics WHERE account_id = ? AND cosmetic_id = ?')
    .get(account.id, 'space-orbit-visor').source;
  assert.equal(source, 'stat:collection.space-trouble>=5');
  db.close();
});

test('три loadout presets хранят только канонические слоты и не обходят server ownership', () => {
  assert.equal(LOADOUT_PRESET_COUNT, 3);
  const storage = memory();
  const saved = saveLoadoutPreset(
    0,
    {
      body: 'space-astronaut',
      visor: 'space-star-crown',
      antenna: 'space-star-crown',
      back: 'space-oxygen-pack',
      trail: null,
      finish: null
    },
    storage
  );
  assert.equal(saved.length, 3);
  assert.equal(saved[0].body, 'space-astronaut');
  assert.equal(saved[0].visor, null);
  assert.equal(saved[0].antenna, 'space-star-crown');
  assert.equal(readLoadoutPresets(storage)[1], null);
  assert.equal(readLoadoutPresets(storage)[2], null);

  const calls = [];
  setServerCosmeticEquipHandler((slot, id) => calls.push([slot, id]));
  const inventory = {
    ownedIds: ['classic', 'space-oxygen-pack'],
    equipped: {
      body: 'classic',
      visor: null,
      antenna: null,
      back: null,
      trail: null,
      finish: null
    }
  };
  const applied = applyLoadout(saved[0], null, null, storage, inventory);
  assert.equal(applied.body, 'classic');
  assert.ok(calls.some(([slot, id]) => slot === 'back' && id === 'space-oxygen-pack'));
  assert.equal(
    calls.some(([, id]) => id === 'space-astronaut'),
    false
  );
  setServerCosmeticEquipHandler(null);
});

test('preset остаётся доступен в сессии, если storage не сохранил запись', () => {
  const failedStorage = {
    getItem: () => null,
    setItem() {
      throw new Error('quota exceeded');
    }
  };
  saveLoadoutPreset(1, { body: 'classic', back: 'space-oxygen-pack' }, failedStorage);
  assert.equal(readLoadoutPresets(failedStorage)[1].back, 'space-oxygen-pack');

  // Успешная запись возвращает обычный persisted-режим и не оставляет fallback включённым навсегда.
  const healthyStorage = memory();
  saveLoadoutPreset(1, { body: 'classic', back: null }, healthyStorage);
  assert.equal(readLoadoutPresets(healthyStorage)[1].back, null);
});

test('multi-slot loadout отправляет server equip последовательно', async () => {
  const storage = memory();
  const calls = [];
  const releases = [];
  setServerCosmeticEquipHandler((slot, id) => {
    calls.push([slot, id]);
    return new Promise(resolve => releases.push(resolve));
  });
  const inventory = {
    ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'],
    equipped: {
      body: 'classic',
      visor: null,
      antenna: null,
      back: null,
      trail: null,
      finish: null
    }
  };

  applyLoadout(
    {
      body: 'space-astronaut',
      visor: null,
      antenna: null,
      back: 'space-oxygen-pack',
      trail: null,
      finish: null
    },
    null,
    null,
    storage,
    inventory
  );
  assert.deepEqual(calls, [['body', 'space-astronaut']], 'второй запрос ждёт первого ответа');

  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['body', 'space-astronaut'],
    ['back', 'space-oxygen-pack']
  ]);
  releases.shift()();
  await new Promise(resolve => setImmediate(resolve));
  setServerCosmeticEquipHandler(null);
});

test('collectionProgress показывает milestone отдельно от базового процента', () => {
  const owned = cosmeticsInCollection('food-fight')
    .slice(0, 5)
    .map(item => item.id);
  owned.push('food-soda-pack');

  const food = collectionProgress(owned).find(item => item.id === 'food-fight');
  assert.equal(food.owned, 5);
  assert.equal(food.total, 15);
  assert.equal(food.milestones[0].reached, true);
  assert.equal(food.milestones[0].owned, true);
  assert.equal(food.milestones[1].reached, false);
});
