import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPresetLoadoutConfirmed,
  desiredPresetLoadout,
  inventoryConfirmsPresetSlot,
  presetMatchesLoadout,
  presetServerActions
} from '../client/core/PresetLoadout.js';
import { setServerInventory } from '../client/core/cosmetics.js';

const memory = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
};

test('preset sanitization keeps only owned items in their canonical slots', () => {
  const inventory = {
    ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'],
    equipped: { body: 'classic', back: 'space-oxygen-pack' }
  };
  const desired = desiredPresetLoadout(
    { body: 'space-astronaut', visor: 'space-oxygen-pack', back: null },
    null,
    null,
    memory(),
    inventory
  );
  assert.equal(desired.body, 'space-astronaut');
  assert.equal(desired.visor, null);
  assert.equal(desired.back, null);
});

test('server confirmation checks the canonical equipped snapshot', () => {
  assert.equal(inventoryConfirmsPresetSlot({ equipped: { body: 'classic' } }, 'body', 'classic'), true);
  assert.equal(
    inventoryConfirmsPresetSlot({ equipped: { body: 'classic' } }, 'body', 'space-astronaut'),
    false
  );
  assert.equal(inventoryConfirmsPresetSlot({ equipped: { back: null } }, 'back', null), true);
});

test('preset confirmation compares every canonical slot before claiming success', () => {
  const desired = {
    body: 'classic',
    visor: null,
    antenna: null,
    back: null,
    trail: null,
    finish: null
  };
  assert.equal(presetMatchesLoadout({ ...desired }, desired), true);
  assert.equal(presetMatchesLoadout({ ...desired, back: 'space-oxygen-pack' }, desired), false);
});

test('server preset actions are ordered and include explicit clears', () => {
  const inventory = {
    ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'],
    equipped: { body: 'classic', back: 'space-oxygen-pack' }
  };
  assert.deepEqual(presetServerActions({ body: 'space-astronaut', back: null }, inventory), [
    ['body', 'space-astronaut'],
    ['back', null]
  ]);
});

test('preset reports success only after every server-owned slot is confirmed', async () => {
  const storage = memory();
  const initial = {
    ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'],
    equipped: { body: 'classic', back: 'space-oxygen-pack' }
  };
  const calls = [];
  const result = await applyPresetLoadoutConfirmed(
    { body: 'space-astronaut', back: null },
    {
      storage,
      inventory: initial,
      equipServer: async (slot, id) => {
        calls.push([slot, id]);
        if (slot === 'body') {
          return { ...initial, equipped: { ...initial.equipped, body: id } };
        }
        return { ...initial, equipped: { body: 'space-astronaut', back: id } };
      }
    }
  );
  assert.equal(result.confirmed, true);
  assert.deepEqual(calls, [
    ['body', 'space-astronaut'],
    ['back', null]
  ]);
  setServerInventory(null);
});

test('preset never claims success after a rejected server slot', async () => {
  const initial = {
    ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'],
    equipped: { body: 'classic', back: 'space-oxygen-pack' }
  };
  let calls = 0;
  const result = await applyPresetLoadoutConfirmed(
    { body: 'space-astronaut', back: null },
    {
      storage: memory(),
      inventory: initial,
      equipServer: async (slot, id) =>
        ++calls === 1 ? { ...initial, equipped: { ...initial.equipped, [slot]: id } } : null
    }
  );
  assert.equal(result.confirmed, false);
  assert.equal(calls, 2);
  setServerInventory(null);
});
