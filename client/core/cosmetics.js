import { COSMETIC_CATALOG, DEFAULT_COSMETIC_LOADOUT } from '/shared/cosmetics.js';

const STORAGE_KEY = 'wobble-cosmetics-v1';

export const COSMETICS = COSMETIC_CATALOG;
const defaults = DEFAULT_COSMETIC_LOADOUT;

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
    (item.localGoal === 'daily-7' && Number(profile?.daily?.bestStreak || 0) >= 7)
  );
}

export function unlockedCosmetics(progress = null, profile = null, inventory = null) {
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
  inventory = null
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

  // Для server-owned слотов authoritative loadout имеет приоритет над localStorage. Trail пока
  // исключение: sunrise-trail — локальная daily-награда, пока daily streak не перенесён на сервер.
  if (inventory?.equipped) {
    for (const slot of ['body', 'visor', 'antenna', 'finish']) {
      const id = inventory.equipped[slot];
      if (typeof id === 'string' && unlocked.has(id)) equipped[slot] = id;
      else if (slot !== 'body') equipped[slot] = null;
    }
  }
  return equipped;
}

export function equipCosmetic(
  id,
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = null
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
  return equipped;
}

export function cosmeticLoadout(
  progress = null,
  profile = null,
  storage = globalThis.localStorage,
  inventory = null
) {
  const equipped = readCosmetics(progress, profile, storage, inventory);
  return Object.fromEntries(
    Object.entries(equipped).map(([slot, id]) => [slot, COSMETICS.find(item => item.id === id) || null])
  );
}

export function nextCosmeticGoal(progress = null, profile = null, inventory = null) {
  const unlocked = new Set(unlockedCosmetics(progress, profile, inventory).map(item => item.id));
  const chapters = progress?.chapters || [];
  const localChapters = profile?.coop?.chapterStats || {};
  const stats = progress?.stats || {};
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
    { id: 'sunrise-trail', label: 'Серия daily', current: Number(profile?.daily?.bestStreak || 0), target: 7 }
  ];
  return goals.find(goal => !unlocked.has(goal.id)) || null;
}
