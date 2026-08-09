const STORAGE_KEY = 'wobble-cosmetics-v1';

export const COSMETICS = Object.freeze([
  {
    id: 'classic',
    slot: 'body',
    name: 'КЛАССИКА',
    detail: 'Базовый корпус',
    default: true,
    colors: { body: 0xff4f91, accent: 0xffde59 }
  },
  {
    id: 'sky-hero',
    slot: 'body',
    name: 'ГЕРОЙ НЕБА',
    detail: 'Пройдите главу 10',
    achievement: 'coop-ch10-clear',
    colors: { body: 0x7857ff, accent: 0x68f4d2 }
  },
  {
    id: 'clear-visor',
    slot: 'visor',
    name: 'ПРИЗМАТИЧЕСКИЙ ВИЗОР',
    detail: '5 безупречных глав',
    achievement: 'coop-flawless-5',
    color: 0xffd7fb
  },
  {
    id: 'rescue-antenna',
    slot: 'antenna',
    name: 'МАЯК СПАСАТЕЛЯ',
    detail: '25 спасений напарника',
    achievement: 'coop-helper-25',
    color: 0x68f4d2
  },
  {
    id: 'sunrise-trail',
    slot: 'trail',
    name: 'СЛЕД РАССВЕТА',
    detail: 'Серия daily 7 дней',
    localGoal: 'daily-7',
    color: 0xff9f43
  },
  {
    id: 'campaign-finish',
    slot: 'finish',
    name: 'ФИНАЛ КАМПАНИИ',
    detail: 'Пройдите все 10 глав',
    achievement: 'coop-campaign-complete',
    glyph: '♛'
  }
]);

const defaults = Object.freeze({ body: 'classic', visor: null, antenna: null, trail: null, finish: null });

export function unlockedCosmetics(progress = null, profile = null) {
  const achievements = new Set((progress?.achievements || []).map(item => item.id));
  const localChapters = profile?.coop?.chapterStats || {};
  const localFlawless = Object.values(localChapters).reduce(
    (sum, item) => sum + Number(item?.flawless || 0),
    0
  );
  return COSMETICS.filter(
    item =>
      item.default ||
      (item.achievement && achievements.has(item.achievement)) ||
      (item.id === 'sky-hero' && Number(localChapters.ch10?.runs || 0) > 0) ||
      (item.id === 'clear-visor' && localFlawless >= 5) ||
      (item.id === 'rescue-antenna' && Number(profile?.coop?.totalRevives || 0) >= 25) ||
      (item.localGoal === 'daily-7' && Number(profile?.daily?.bestStreak || 0) >= 7)
  );
}

export function readCosmetics(progress = null, profile = null, storage = globalThis.localStorage) {
  let stored = {};
  try {
    stored = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    stored = {};
  }
  const unlocked = new Set(unlockedCosmetics(progress, profile).map(item => item.id));
  const equipped = { ...defaults };
  for (const slot of Object.keys(defaults)) {
    if (typeof stored[slot] === 'string' && unlocked.has(stored[slot])) equipped[slot] = stored[slot];
  }
  return equipped;
}

export function equipCosmetic(id, progress = null, profile = null, storage = globalThis.localStorage) {
  const item = unlockedCosmetics(progress, profile).find(candidate => candidate.id === id);
  if (!item) return readCosmetics(progress, profile, storage);
  const equipped = readCosmetics(progress, profile, storage);
  equipped[item.slot] = item.id;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(equipped));
  } catch {
    // Закрытый storage не должен мешать примерить уже полученную награду в текущей сессии.
  }
  return equipped;
}

export function cosmeticLoadout(progress = null, profile = null, storage = globalThis.localStorage) {
  const equipped = readCosmetics(progress, profile, storage);
  return Object.fromEntries(
    Object.entries(equipped).map(([slot, id]) => [slot, COSMETICS.find(item => item.id === id) || null])
  );
}

export function nextCosmeticGoal(progress = null, profile = null) {
  const unlocked = new Set(unlockedCosmetics(progress, profile).map(item => item.id));
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
