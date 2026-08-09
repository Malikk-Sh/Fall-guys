export const COSMETIC_CATALOG = Object.freeze([
  { id: 'body-mint', slot: 'body', label: 'Мятный', value: '#7df4cf', source: 'default' },
  { id: 'body-sunset', slot: 'body', label: 'Закат', value: '#ff8c62', source: 'achievement' },
  { id: 'head-crown', slot: 'head', label: 'Корона', color: '#ffd166', source: 'achievement' },
  { id: 'trail-spark', slot: 'trail', label: 'Искры', color: '#78e6ff', source: 'achievement' },
  { id: 'finish-stars', slot: 'finish', label: 'Звёзды', color: '#fff3a6', source: 'achievement' },
  {
    id: 'finish-champion',
    slot: 'finish',
    label: 'Чемпион кампании',
    color: '#ffd166',
    source: 'campaign',
    exclusive: true
  }
]);

export const COSMETIC_BY_ID = Object.freeze(
  Object.fromEntries(COSMETIC_CATALOG.map(item => [item.id, item]))
);

export const DEFAULT_COSMETIC_LOADOUT = Object.freeze({
  body: 'body-mint',
  head: 'none',
  trail: 'none',
  finish: 'none'
});

export const COSMETIC_SLOTS = Object.freeze(['body', 'head', 'trail', 'finish']);

export function publicCosmeticLoadout(loadout = DEFAULT_COSMETIC_LOADOUT) {
  const safe = { ...DEFAULT_COSMETIC_LOADOUT };
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout?.[slot];
    if (id === 'none') safe[slot] = 'none';
    else if (COSMETIC_BY_ID[id]?.slot === slot) safe[slot] = id;
  }
  return safe;
}
