import {
  COSMETIC_CATALOG,
  COSMETIC_BY_ID,
  DEFAULT_COSMETIC_LOADOUT,
  publicCosmeticLoadout
} from '/shared/cosmetics.js';

const STORAGE_KEY = 'wobble-cosmetics-v1';

export const COSMETICS = COSMETIC_CATALOG;
const defaults = DEFAULT_COSMETIC_LOADOUT;
let serverInventory = null;
let serverEquip = null;

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

function locallyUnlocked(item, progress, profile) {
  const achievements = new Set((progress?.achievements || []).map(entry => entry.id));
  const localChapters = profile?.coop?.chapterStats || {};
  const localFlawless = Object.values(localChapters).reduce(
    (sum, entry) => sum + Number(entry?.flawless || 0),
    0
  );
  return (
    item.default ||
    (item.achievement && achievements.has(item.achievement)) ||
    (item.id === 'sky-hero' && Number(localChapters.ch10?.runs || 0) > 0) ||
    (item.id === 'clear-visor' && localFlawless >= 5) ||
    (item.id === 'rescue-antenna' && Number(profile?.coop?.totalRevives || 0) >= 25) ||
    (item.localGoal === 'daily-7' && Number(profile?.daily?.bestStreak || 0) >= 7) ||
    (item.localGoal === 'daily-30' && Number(profile?.daily?.bestStreak || 0) >= 30)
  );
}

export function unlockedCosmetics(progress = null, profile = null, inventory = serverInventory) {
  const owned = Array.isArray(inventory?.ownedIds) ? new Set(inventory.ownedIds) : null;
  return COSMETICS.filter(item => {
    // Daily streak пока остаётся локальной механикой и не притворяется server-authoritative.
    if (item.localGoal) return locallyUnlocked(item, progress, profile);
    if (owned) return item.default || owned.has(item.id);
    return locallyUnlocked(item, progress, profile);
  });
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
  for (const slot of Object.keys(defaults)) {
    if (typeof stored[slot] === 'string' && unlocked.has(stored[slot])) equipped[slot] = stored[slot];
  }

  // Для server-owned слотов authoritative loadout имеет приоритет над localStorage.
  //
  // Trail раньше был исключён целиком: в нём лежала одна локальная daily-награда, и спрашивать о
  // ней сервер было не у кого. Теперь в слоте есть и серверные следы — за гонку, — и полное
  // исключение означало бы, что владелец такого следа видит его снятым после перезахода, хотя
  // сервер и остальные игроки продолжают его показывать. Поэтому исключение сузилось с целого
  // слота до конкретных локальных наград: серверное берётся с сервера, локальное остаётся местным.
  if (inventory?.equipped) {
    for (const slot of ['body', 'visor', 'antenna', 'trail', 'finish']) {
      const id = inventory.equipped[slot];
      if (typeof id === 'string' && unlocked.has(id)) equipped[slot] = id;
      else if (slot === 'body') continue;
      // Локальную награду сервер не знает и не может ни подтвердить, ни снять.
      else if (!COSMETIC_BY_ID[equipped[slot]]?.localGoal) equipped[slot] = null;
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
  if (!item) return readCosmetics(progress, profile, storage, inventory);
  const equipped = readCosmetics(progress, profile, storage, inventory);
  equipped[item.slot] = item.id;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(equipped));
  } catch {
    // Закрытый storage не должен мешать примерить уже полученную награду в текущей сессии.
  }
  if (inventory && !item.localGoal) serverEquip?.(item.slot, item.id);
  return equipped;
}

export function cosmeticLoadout(
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = serverInventory
) {
  const equipped = readCosmetics(progress, profile, storage, inventory);
  return Object.fromEntries(
    Object.entries(equipped).map(([slot, id]) => [slot, COSMETICS.find(item => item.id === id) || null])
  );
}

export function nextCosmeticGoal(progress = null, profile = null, inventory = serverInventory) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const chapters = progress?.chapters || [];
  const localChapters = profile?.coop?.chapterStats || {};
  const stats = progress?.stats || {};
  // Гоночные счётчики приходят в прогрессе аккаунта; у неавторизованного их просто нет.
  const race = progress?.race || {};
  const goals = [
    {
      id: 'sky-hero',
      label: 'Глава 10',
      current:
        chapters.some(item => item.chapterId === 'ch10') || Number(localChapters.ch10?.runs || 0) > 0 ? 1 : 0,
      target: 1
    },
    {
      id: 'clear-visor',
      label: 'Безупречные главы',
      current: Math.max(
        chapters.reduce((sum, item) => sum + Number(item.flawless || 0), 0),
        Object.values(localChapters).reduce((sum, item) => sum + Number(item?.flawless || 0), 0)
      ),
      target: 5
    },
    {
      id: 'rescue-antenna',
      label: 'Спасения',
      current: Math.max(Number(stats.coopRevives || 0), Number(profile?.coop?.totalRevives || 0)),
      target: 25
    },
    {
      id: 'sunrise-trail',
      label: 'Серия daily',
      current: Number(profile?.daily?.bestStreak || 0),
      target: 7
    },
    // Гоночные цели. Без них список заканчивался на кооперативных, и игрок, забравший их все,
    // видел «ВСЕ ИГРОВЫЕ НАГРАДЫ ПОЛУЧЕНЫ» при том, что половина каталога оставалась закрытой.
    { id: 'racer-body', label: 'Финиши в гонке', current: Number(race.finishes || 0), target: 1 },
    { id: 'podium-trail', label: 'Пьедесталы', current: Number(race.podiums || 0), target: 1 },
    { id: 'champion-visor', label: 'Победы в гонке', current: Number(race.wins || 0), target: 1 },
    { id: 'veteran-antenna', label: 'Финиши в гонке', current: Number(race.finishes || 0), target: 25 },
    {
      id: 'streak-trail',
      label: 'Серия daily',
      current: Number(profile?.daily?.bestStreak || 0),
      target: 30
    }
  ];
  return goals.find(goal => !unlocked.has(goal.id)) || null;
}
