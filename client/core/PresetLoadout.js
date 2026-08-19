import { COSMETIC_BY_ID, COSMETIC_SLOTS } from '/shared/cosmetics.js';
import { isLocalUnlock } from '/shared/cosmeticUnlocks.js';
import { equipAccountCosmetic } from './account.js';
import {
  applyLoadout,
  equipCosmetic,
  readCosmetics,
  serverInventorySnapshot,
  setServerInventory,
  unequipCosmetic,
  unlockedCosmetics
} from './cosmetics.js';

export function desiredPresetLoadout(
  loadout,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventorySnapshot()
) {
  const current = readCosmetics(progress, profile, storage, inventory);
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const desired = { ...current };
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout?.[slot] ?? null;
    if (id && unlocked.has(id) && COSMETIC_BY_ID[id]?.slot === slot) desired[slot] = id;
    else if (slot !== 'body') desired[slot] = null;
  }
  return desired;
}

export function inventoryConfirmsPresetSlot(inventory, slot, cosmeticId) {
  return (inventory?.equipped?.[slot] ?? null) === (cosmeticId ?? null);
}

export function presetServerActions(desired, inventory = serverInventorySnapshot()) {
  if (!inventory?.equipped) return [];
  const actions = [];
  for (const slot of COSMETIC_SLOTS) {
    const id = desired?.[slot] ?? null;
    const item = id ? COSMETIC_BY_ID[id] : null;
    const current = inventory.equipped[slot] ?? null;
    if (item && !isLocalUnlock(item)) {
      if (current !== item.id) actions.push([slot, item.id]);
      continue;
    }
    if (slot !== 'body' && current !== null) actions.push([slot, null]);
  }
  return actions;
}

export function presetMatchesLoadout(actual, desired) {
  return COSMETIC_SLOTS.every(slot => (actual?.[slot] ?? null) === (desired?.[slot] ?? null));
}

function applyLocalPresetSlots(desired, progress, profile, storage, inventory) {
  for (const slot of COSMETIC_SLOTS) {
    const id = desired?.[slot] ?? null;
    const item = id ? COSMETIC_BY_ID[id] : null;
    if (item && isLocalUnlock(item)) {
      equipCosmetic(item.id, progress, profile, storage, inventory);
      continue;
    }
    if (!id && slot !== 'body') unequipCosmetic(slot, progress, profile, storage, inventory);
  }
}

export async function applyPresetLoadoutConfirmed(
  loadout,
  {
    progress = null,
    profile = null,
    storage = globalThis.localStorage,
    inventory = serverInventorySnapshot(),
    equipServer = equipAccountCosmetic
  } = {}
) {
  const desired = desiredPresetLoadout(loadout, progress, profile, storage, inventory);
  if (!inventory) {
    const actual = applyLoadout(desired, progress, profile, storage, null);
    return { confirmed: presetMatchesLoadout(actual, desired), source: 'local', loadout: actual };
  }

  let latest = inventory;
  for (const [slot, cosmeticId] of presetServerActions(desired, inventory)) {
    try {
      const next = await equipServer(slot, cosmeticId);
      if (!next || !inventoryConfirmsPresetSlot(next, slot, cosmeticId)) {
        return {
          confirmed: false,
          source: 'server',
          inventory: latest,
          loadout: readCosmetics(progress, profile, storage, latest)
        };
      }
      latest = next;
      setServerInventory(latest);
    } catch {
      return {
        confirmed: false,
        source: 'server',
        inventory: latest,
        loadout: readCosmetics(progress, profile, storage, latest)
      };
    }
  }

  applyLocalPresetSlots(desired, progress, profile, storage, latest);
  const actual = readCosmetics(progress, profile, storage, latest);
  return {
    confirmed: presetMatchesLoadout(actual, desired),
    source: 'server',
    inventory: latest,
    loadout: actual
  };
}
