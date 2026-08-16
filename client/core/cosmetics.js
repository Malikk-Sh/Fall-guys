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

export const COSMETICS = COSMETIC_CATALOG;
const defaults = DEFAULT_COSMETIC_LOADOUT;
let serverInventory = null;
let serverEquip = null;
let serverEmoteEquip = null;

// Remote player metadata contains IDs only. Never let room payloads provide materials/colors
// directly: normalize every slot against the shared canonical catalog, then resolve the known item.
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
 * Что игрок открыл.
 *
 * Правило то же, что и было, но записано теперь один раз, а не шестьюдесятью ветками: серверные
 * условия решает сервер (owned), локальные — клиент. Между ними ровно одна граница, и она здесь.
 */
export function unlockedCosmetics(progress = null, profile = null, inventory = serverInventory) {
  const owned = Array.isArray(inventory?.ownedIds) ? new Set(inventory.ownedIds) : null;
  const stats = cosmeticStats(progress, profile);
  const achievements = new Set((progress?.achievements || []).map(entry => entry.id));
  return COSMETICS.filter(item => {
    // Daily streak — единственная механика, которая никогда не была серверной. Сервер её не
    // считает и подтвердить не может, поэтому она решается здесь и при подключённом inventory тоже.
    //
    // «Или владение» здесь не дыра, а сложение: сервер daily-предметы не выдаёт, но если он всё же
    // числит предмет за игроком (выдача поддержкой, будущий источник), отнимать его локальным
    // счётчиком было бы неправильно.
    if (item.unlock.type === 'daily') {
      return unlockSatisfied(item, { stats, achievements, local: true }) || Boolean(owned?.has(item.id));
    }
    // Дальше — server-authoritative путь: список владения приходит с сервера, и клиент только
    // читает его. Никакой предмет не появляется у игрока потому, что так решил браузер.
    if (owned) return item.unlock.type === 'default' || owned.has(item.id);
    // Инвентаря нет: гость или ещё не загруженный профиль.
    //
    // Новый контент в этом состоянии остаётся закрытым намеренно. Его stat-условия считаются по
    // серверной статистике, и «посчитать их самому» означало бы client-authoritative ownership для
    // шестидесяти предметов сразу. Унаследованные награды продолжают открываться локально — они и
    // раньше так работали, и отнимать у гостя уже полученное нельзя.
    if (item.expansion === 'customization-2') return false;
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
      // Слот проверяется отдельно от владения: сохранённый образ мог пережить смену каталога, и
      // предмет, переехавший в другой слот, иначе оказался бы надет не туда.
      if (COSMETIC_BY_ID[stored[slot]]?.slot === slot) equipped[slot] = stored[slot];
    }
  }

  // Для server-owned слотов authoritative loadout имеет приоритет над localStorage.
  //
  // Trail раньше был исключён целиком: в нём лежала одна локальная daily-награда, и спрашивать о
  // ней сервер было не у кого. Теперь в слоте есть и серверные следы — за гонку, — и полное
  // исключение означало бы, что владелец такого следа видит его снятым после перезахода, хотя
  // сервер и остальные игроки продолжают его показывать. Поэтому исключение сузилось с целого
  // слота до конкретных локальных наград: серверное берётся с сервера, локальное остаётся местным.
  if (inventory?.equipped) {
    for (const slot of COSMETIC_SLOTS) {
      const id = inventory.equipped[slot];
      if (typeof id === 'string' && unlocked.has(id)) equipped[slot] = id;
      else if (slot === 'body') continue;
      // Локальную награду сервер не знает и не может ни подтвердить, ни снять.
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

/**
 * Снятие предмета. Тело снять нельзя — у персонажа не бывает «без корпуса», и попытка это сделать
 * оставила бы игрока невидимкой для остальных.
 */
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

// ── Шкаф ────────────────────────────────────────────────────────────────────────────────────

/**
 * Полное описание каталога для интерфейса: что открыто, что надето, чего не хватает.
 *
 * Одна функция вместо шести списков внутри UI — именно это и требуется, чтобы новый предмет
 * появлялся в шкафу сам, без правки виджетов.
 */
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

  return COSMETICS.map(item => ({
    item,
    id: item.id,
    slot: item.slot,
    rarity: rarityMeta(item.rarity),
    collection: item.collection,
    owned: unlocked.has(item.id),
    equipped: item.slot === EMOTE_SLOT ? emotes.includes(item.id) : equipped[item.slot] === item.id,
    favorite: favorites.has(item.id),
    // «Скоро» — честная формулировка для rewarded/shop/pass/event: механики выдачи ещё нет, и
    // рисовать игроку цель, к которой нельзя двигаться, было бы обманом.
    upcoming: isFutureUnlock(item),
    requirement: unlockRequirementText(item),
    progress: unlockProgress(item, stats)
  }));
}

export function wardrobeCollections(progress = null, profile = null, inventory = serverInventory) {
  const unlocked = unlockedCosmetics(progress, profile, inventory).map(item => item.id);
  return collectionProgress(unlocked);
}

/**
 * Случайный образ.
 *
 * Только из полученного: предложить надеть закрытое — значит предложить действие, которое сервер
 * отвергнет. Тело обязательно, остальные слоты могут остаться пустыми, чтобы «случайный» иногда
 * означал и «ничего лишнего».
 */
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
    // Для необязательных слотов пустой вариант участвует в жеребьёвке наравне с предметами.
    if (slot !== 'body' && random() < 0.25) {
      loadout[slot] = null;
      continue;
    }
    loadout[slot] = pick(options)?.id ?? (slot === 'body' ? defaults.body : null);
  }
  if (!loadout.body || COSMETIC_BY_ID[loadout.body]?.slot !== 'body') loadout.body = defaults.body;
  return loadout;
}

/** Применяет готовый образ через обычный server-authoritative путь, слот за слотом. */
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

/**
 * Ближайшая цель.
 *
 * Раньше это был список из девяти вручную выписанных целей, который приходилось дополнять при
 * каждой новой награде — и который уже однажды отстал, объявляя «все награды получены» при
 * половине закрытого каталога. Теперь цель берётся из самого каталога: первый закрытый предмет,
 * у которого прогресс выражается числом.
 */
export function nextCosmeticGoal(progress = null, profile = null, inventory = serverInventory) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const stats = cosmeticStats(progress, profile);
  for (const item of COSMETICS) {
    if (unlocked.has(item.id) || isFutureUnlock(item)) continue;
    const goal = unlockProgress(item, stats);
    if (!goal || goal.target <= 0 || goal.current >= goal.target) continue;
    return { id: item.id, label: goal.label, current: goal.current, target: goal.target };
  }
  return null;
}
