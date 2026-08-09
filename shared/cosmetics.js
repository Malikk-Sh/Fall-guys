// Канонический каталог косметики. Он используется и браузером, и серверным inventory, поэтому
// cosmetic id/slot/unlock не могут разъехаться между двумя независимыми списками.
export const COSMETIC_CATALOG = Object.freeze([
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

export const COSMETIC_BY_ID = Object.freeze(
  Object.fromEntries(COSMETIC_CATALOG.map(item => [item.id, item]))
);

export const DEFAULT_COSMETIC_LOADOUT = Object.freeze({
  body: 'classic',
  visor: null,
  antenna: null,
  trail: null,
  finish: null
});

export const COSMETIC_SLOTS = Object.freeze(['body', 'visor', 'antenna', 'trail', 'finish']);

export function publicCosmeticLoadout(loadout = DEFAULT_COSMETIC_LOADOUT) {
  const safe = { ...DEFAULT_COSMETIC_LOADOUT };
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout?.[slot];
    if (id == null && slot !== 'body') safe[slot] = null;
    else if (COSMETIC_BY_ID[id]?.slot === slot) safe[slot] = id;
  }
  return safe;
}
