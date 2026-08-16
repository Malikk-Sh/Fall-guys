import {
  COSMETIC_CATALOG,
  COSMETIC_BY_ID,
  COSMETIC_SLOTS,
  DEFAULT_COSMETIC_LOADOUT,
  DEFAULT_EMOTE_LOADOUT,
  EMOTE_LOADOUT_SIZE,
  EMOTE_SLOT,
  collectionProgress,
  publicCosmeticLoadout,
  publicEmoteLoadout,
  rarityMeta
} from '/shared/cosmetics.js';
import {
  cosmeticStats,
  isFutureUnlock,
  isLocalUnlock,
  unlockProgress,
  unlockRequirementText,
  unlockSatisfied
} from '/shared/cosmeticUnlocks.js';

const STORAGE_KEY = 'wobble-cosmetics-v1';
const EMOTE_STORAGE_KEY = 'wobble-emotes-v1';
const LOADOUT_PRESET_STORAGE_KEY = 'wobble-loadout-presets-v1';
export const LOADOUT_PRESET_COUNT = 3;

export const COSMETICS = COSMETIC_CATALOG;
const defaults = DEFAULT_COSMETIC_LOADOUT;
let serverInventory = null;
let serverEquip = null;
let serverEmoteEquip = null;
let presetFallback = new Array(LOADOUT_PRESET_COUNT).fill(null);

export function cosmeticLoadoutFromIds(loadout) {
  const safe = publicCosmeticLoadout(loadout);
  return Object.fromEntries(
    Object.entries(safe).map(([slot, id]) => [slot, id ? COSMETIC_BY_ID[id] || null : null])
  );
}

export function setServerInventory(inventory) {
  serverInventory = inventory || null;
}

export function setServerCosmeticEquipHandler(handler) {
  serverEquip = typeof handler === 'function' ? handler : null;
}

export function setServerEmoteEquipHandler(handler) {
  serverEmoteEquip = typeof handler === 'function' ? handler : null;
}

export function serverInventorySnapshot() {
  return serverInventory;
}

/**
 * Что игрок открыл. Server-owned условия решает сервер, daily и старые локальные фолбэки — клиент.
 */
export function unlockedCosmetics(progress = null, profile = null, inventory = serverInventory) {
  const owned = Array.isArray(inventory?.ownedIds) ? new Set(inventory.ownedIds) : null;
  const stats = cosmeticStats(progress, profile);
  const achievements = new Set((progress?.achievements || []).map(entry => entry.id));
  return COSMETICS.filter(item => {
    if (item.unlock.type === 'daily') {
      return unlockSatisfied(item, { stats, achievements, local: true }) || Boolean(owned?.has(item.id));
    }
    if (owned) return item.unlock.type === 'default' || owned.has(item.id);
    // Расширенный контент требует server inventory. Унаследованные локальные награды продолжают
    // работать гостем ровно как до появления аккаунтов.
    if (item.expansion) return false;
    return unlockSatisfied(item, { stats, achievements, local: true });
  });
}

export function isCosmeticUnlocked(id, progress = null, profile = null, inventory = serverInventory) {
  return unlockedCosmetics(progress, profile, inventory).some(item => item.id === id);
}

export function readCosmetics(
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  let stored = {};
  try {
    stored = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const equipped = { ...defaults };
  for (const slot of COSMETIC_SLOTS) {
    if (typeof stored[slot] === 'string' && unlocked.has(stored[slot])) {
      if (COSMETIC_BY_ID[stored[slot]]?.slot === slot) equipped[slot] = stored[slot];
    }
  }

  if (inventory?.equipped) {
    for (const slot of COSMETIC_SLOTS) {
      const id = inventory.equipped[slot];
      if (typeof id === 'string' && unlocked.has(id)) equipped[slot] = id;
      else if (slot === 'body') continue;
      else if (!isLocalUnlock(COSMETIC_BY_ID[equipped[slot]])) equipped[slot] = null;
    }
  }
  return equipped;
}

export function equipCosmetic(
  id,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const item = unlockedCosmetics(progress, profile, inventory).find(candidate => candidate.id === id);
  if (!item || item.slot === EMOTE_SLOT) return readCosmetics(progress, profile, storage, inventory);
  const equipped = readCosmetics(progress, profile, storage, inventory);
  equipped[item.slot] = item.id;
  persist(storage, equipped);
  if (inventory && !isLocalUnlock(item)) serverEquip?.(item.slot, item.id);
  return equipped;
}

export function unequipCosmetic(
  slot,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const equipped = readCosmetics(progress, profile, storage, inventory);
  if (slot === 'body' || !COSMETIC_SLOTS.includes(slot)) return equipped;
  const previous = COSMETIC_BY_ID[equipped[slot]];
  equipped[slot] = null;
  persist(storage, equipped);
  if (inventory && previous && !isLocalUnlock(previous)) serverEquip?.(slot, null);
  return equipped;
}

function persist(storage, equipped) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(equipped));
  } catch {
    // Закрытый storage не должен мешать примерить уже полученную награду в текущей сессии.
  }
}

export function cosmeticLoadout(
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const equipped = readCosmetics(progress, profile, storage, inventory);
  return Object.fromEntries(Object.entries(equipped).map(([slot, id]) => [slot, COSMETIC_BY_ID[id] || null]));
}

// ── Эмоции ──────────────────────────────────────────────────────────────────────────────────

export function readEmoteLoadout(
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  if (Array.isArray(inventory?.emotes)) return publicEmoteLoadout(inventory.emotes);
  let stored = null;
  try {
    stored = JSON.parse(storage?.getItem(EMOTE_STORAGE_KEY) || 'null');
  } catch {
    stored = null;
  }
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const safe = publicEmoteLoadout(stored || DEFAULT_EMOTE_LOADOUT);
  return safe.map(id => (id && unlocked.has(id) ? id : null));
}

export function equipEmote(
  position,
  id,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const index = Number(position);
  const current = readEmoteLoadout(progress, profile, storage, inventory);
  if (!Number.isInteger(index) || index < 0 || index >= EMOTE_LOADOUT_SIZE) return current;
  const item = id == null ? null : COSMETIC_BY_ID[id];
  if (id != null && (!item || item.slot !== EMOTE_SLOT)) return current;
  if (item && !isCosmeticUnlocked(item.id, progress, profile, inventory)) return current;

  const next = current.map(entry => (item && entry === item.id ? null : entry));
  next[index] = item ? item.id : null;
  const safe = publicEmoteLoadout(next);
  try {
    storage?.setItem(EMOTE_STORAGE_KEY, JSON.stringify(safe));
  } catch {
    // См. persist: недоступный storage не повод отказывать в действии.
  }
  if (inventory) serverEmoteEquip?.(index, item ? item.id : null);
  return safe;
}

// ── Три быстрых образа ──────────────────────────────────────────────────────────────────────

function normalizePresetList(value) {
  const source = Array.isArray(value) ? value : [];
  return Array.from({ length: LOADOUT_PRESET_COUNT }, (_, index) => {
    const preset = source[index];
    return preset && typeof preset === 'object' ? publicCosmeticLoadout(preset) : null;
  });
}

/**
 * Presets — локальное удобство, а не entitlement. Они содержат только канонические ID и при
 * применении всё равно проходят обычный applyLoadout → server equip.
 */
export function readLoadoutPresets(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LOADOUT_PRESET_STORAGE_KEY);
    if (raw != null) return normalizePresetList(JSON.parse(raw));
    return new Array(LOADOUT_PRESET_COUNT).fill(null);
  } catch {
    return presetFallback.map(preset => (preset ? { ...preset } : null));
  }
}

export function saveLoadoutPreset(index, loadout, storage = globalThis.localStorage) {
  const position = Number(index);
  const presets = readLoadoutPresets(storage);
  if (!Number.isInteger(position) || position < 0 || position >= LOADOUT_PRESET_COUNT) return presets;
  presets[position] = loadout && typeof loadout === 'object' ? publicCosmeticLoadout(loadout) : null;
  presetFallback = presets.map(preset => (preset ? { ...preset } : null));
  try {
    storage?.setItem(LOADOUT_PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // На устройстве без localStorage три образа продолжают работать до закрытия вкладки.
  }
  return presets;
}

// ── Шкаф ────────────────────────────────────────────────────────────────────────────────────

function serverCollectionProgress(inventory, fallbackOwned) {
  const owned = Array.isArray(inventory?.ownedIds) ? inventory.ownedIds : fallbackOwned;
  return collectionProgress(owned);
}

export function wardrobeItems({
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory,
  favorites = new Set()
} = {}) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const equipped = readCosmetics(progress, profile, storage, inventory);
  const emotes = readEmoteLoadout(progress, profile, storage, inventory);
  const stats = cosmeticStats(progress, profile);
  // Milestone rewards зависят от server-owned базовых предметов. Локальная daily-награда может
  // подсвечиваться как полученная, но не должна незаметно выдавать server prestige.
  stats.collection = Object.fromEntries(
    serverCollectionProgress(inventory, unlocked).map(collection => [collection.id, collection.owned])
  );

  return COSMETICS.map(item => ({
    item,
    id: item.id,
    slot: item.slot,
    rarity: rarityMeta(item.rarity),
    collection: item.collection,
    owned: unlocked.has(item.id),
    equipped: item.slot === EMOTE_SLOT ? emotes.includes(item.id) : equipped[item.slot] === item.id,
    favorite: favorites.has(item.id),
    upcoming: isFutureUnlock(item),
    requirement: unlockRequirementText(item),
    progress: unlockProgress(item, stats)
  }));
}

export function wardrobeCollections(progress = null, profile = null, inventory = serverInventory) {
  const unlocked = unlockedCosmetics(progress, profile, inventory).map(item => item.id);
  const visible = collectionProgress(unlocked);
  if (!Array.isArray(inventory?.ownedIds)) return visible;

  // Полоса коллекции показывает всё, что игрок реально видит полученным, включая старые local daily.
  // А ступени наград берут server-owned прогресс: так UI не обещает entitlement раньше сервера.
  const verified = new Map(
    collectionProgress(inventory.ownedIds).map(collection => [collection.id, collection.milestones])
  );
  return visible.map(collection => ({
    ...collection,
    milestones: verified.get(collection.id) || collection.milestones
  }));
}

export function randomLoadout({
  progress = null,
  profile = null,
  inventory = serverInventory,
  random = Math.random
} = {}) {
  const unlocked = unlockedCosmetics(progress, profile, inventory).filter(item => !item.hidden);
  const pick = list => (list.length ? list[Math.floor(random() * list.length) % list.length] : null);
  const loadout = { ...defaults };
  for (const slot of COSMETIC_SLOTS) {
    const options = unlocked.filter(item => item.slot === slot);
    if (!options.length) {
      loadout[slot] = slot === 'body' ? defaults.body : null;
      continue;
    }
    if (slot !== 'body' && random() < 0.25) {
      loadout[slot] = null;
      continue;
    }
    loadout[slot] = pick(options)?.id ?? (slot === 'body' ? defaults.body : null);
  }
  if (!loadout.body || COSMETIC_BY_ID[loadout.body]?.slot !== 'body') loadout.body = defaults.body;
  return loadout;
}

export function applyLoadout(
  loadout,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout?.[slot] ?? null;
    if (id && unlocked.has(id) && COSMETIC_BY_ID[id]?.slot === slot) {
      equipCosmetic(id, progress, profile, storage, inventory);
    } else if (slot !== 'body') {
      unequipCosmetic(slot, progress, profile, storage, inventory);
    }
  }
  return readCosmetics(progress, profile, storage, inventory);
}

export function nextCosmeticGoal(progress = null, profile = null, inventory = serverInventory) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const stats = cosmeticStats(progress, profile);
  stats.collection = Object.fromEntries(
    serverCollectionProgress(inventory, unlocked).map(collection => [collection.id, collection.owned])
  );
  for (const item of COSMETICS) {
    if (unlocked.has(item.id) || isFutureUnlock(item)) continue;
    // Server-only расширенный контент не должен обещаться гостю как достижимая локальная цель.
    if (item.expansion && !inventory) continue;
    const goal = unlockProgress(item, stats);
    if (!goal || goal.target <= 0 || goal.current >= goal.target) continue;
    return { id: item.id, label: goal.label, current: goal.current, target: goal.target };
  }
  return null;
}
