// Канонический каталог косметики. Он используется и браузером, и серверным inventory, поэтому
// cosmetic id/slot/unlock не могут разъехаться между двумя независимыми списками.
//
// Каталог собирается из унаследованных предметов, шестидесяти предметов Content & Customization
// 2.0 и бонусных milestone-наград. Единственный источник правды по-прежнему один: разделение на
// файлы чисто механическое, второго каталога не появилось.

import { NEW_COSMETIC_CONTENT } from './cosmeticContent.js';
import { COLLECTION_MILESTONE_COSMETICS } from './cosmeticMilestones.js';
import {
  ALL_COSMETIC_SLOTS,
  COLLECTIONS,
  COLLECTION_META,
  COSMETIC_SLOTS,
  DEFAULT_PERFORMANCE,
  EMOTE_LOADOUT_SIZE,
  EMOTE_SLOT,
  RARITY_META,
  SLOT_META,
  SLOT_ORDER,
  rarityMeta,
  collectionMeta,
  slotMeta
} from './cosmeticMeta.js';

export {
  ALL_COSMETIC_SLOTS,
  COLLECTIONS,
  COLLECTION_META,
  COSMETIC_SLOTS,
  EMOTE_LOADOUT_SIZE,
  EMOTE_SLOT,
  RARITY_META,
  SLOT_META,
  SLOT_ORDER,
  rarityMeta,
  collectionMeta,
  slotMeta
};

// Унаследованные предметы. Порядок и поля сохранены дословно: `colors`, `color`, `glyph`,
// `achievement`, `localGoal`, `rewardable` продолжают читаться кодом, написанным до этой системы.
// Новое поле `render` добавлено рядом, а не вместо — старые чтения остаются валидными.
const LEGACY_COSMETICS = [
  {
    id: 'classic',
    slot: 'body',
    name: 'КЛАССИКА',
    detail: 'Базовый корпус',
    default: true,
    colors: { body: 0xff4f91, accent: 0xffde59 },
    render: { kind: 'body-suit', primary: 0xff4f91, accent: 0xffde59, belly: 0xffde59 }
  },
  {
    id: 'sky-hero',
    slot: 'body',
    name: 'ГЕРОЙ НЕБА',
    detail: 'Пройдите главу 10',
    achievement: 'coop-ch10-clear',
    colors: { body: 0x7857ff, accent: 0x68f4d2 },
    render: { kind: 'body-suit', primary: 0x7857ff, accent: 0x68f4d2, belly: 0x68f4d2 }
  },
  {
    id: 'clear-visor',
    slot: 'visor',
    name: 'ПРИЗМАТИЧЕСКИЙ ВИЗОР',
    detail: '5 безупречных глав',
    achievement: 'coop-flawless-5',
    color: 0xffd7fb,
    render: { kind: 'face-plate', primary: 0xffd7fb }
  },
  {
    id: 'rescue-antenna',
    slot: 'antenna',
    name: 'МАЯК СПАСАТЕЛЯ',
    detail: '25 спасений напарника',
    achievement: 'coop-helper-25',
    color: 0x68f4d2,
    render: { kind: 'head-antenna', primary: 0x68f4d2, motion: { sway: 0.14 } }
  },
  {
    id: 'neon-visor',
    slot: 'visor',
    name: 'НЕОНОВЫЙ ВИЗОР',
    detail: 'Rewarded-награда',
    rewardable: true,
    color: 0x6cf7ff,
    render: { kind: 'face-plate', primary: 0x6cf7ff }
  },
  {
    id: 'party-antenna',
    slot: 'antenna',
    name: 'КОНФЕТТИ-АНТЕННА',
    detail: 'Rewarded-награда',
    rewardable: true,
    color: 0xff79d1,
    render: { kind: 'head-antenna', primary: 0xff79d1, motion: { sway: 0.14 } }
  },
  {
    id: 'sunrise-trail',
    slot: 'trail',
    name: 'СЛЕД РАССВЕТА',
    detail: 'Серия daily 7 дней',
    localGoal: 'daily-7',
    color: 0xff9f43,
    render: { kind: 'particle-trail', primary: 0xff9f43, secondary: 0xffd76a, shape: 'spark' }
  },
  {
    id: 'campaign-finish',
    slot: 'finish',
    name: 'ФИНАЛ КАМПАНИИ',
    detail: 'Пройдите все 10 глав',
    achievement: 'coop-campaign-complete',
    glyph: '♛',
    render: { kind: 'finish-glyph', glyph: '♛', primary: 0xffd76a }
  },

  // Награды за гонку. До них в двух слотах из пяти лежало по одному предмету — то есть выбора там
  // не было вовсе, был выключатель. Теперь у каждого слота есть хотя бы пара вариантов, и все
  // новые висят на гоночных достижениях: играющий в главный режим наконец что-то за него получает.
  {
    id: 'racer-body',
    slot: 'body',
    name: 'ГОНОЧНЫЙ КОРПУС',
    detail: 'Финишируйте в онлайн-гонке',
    achievement: 'race-first-finish',
    colors: { body: 0x43c5ff, accent: 0xffd94b },
    render: { kind: 'body-suit', primary: 0x43c5ff, accent: 0xffd94b, belly: 0xffd94b }
  },
  {
    id: 'champion-visor',
    slot: 'visor',
    name: 'ВИЗОР ЧЕМПИОНА',
    detail: 'Выиграйте онлайн-гонку',
    achievement: 'race-win',
    color: 0xffd94b,
    render: { kind: 'face-plate', primary: 0xffd94b }
  },
  {
    id: 'veteran-antenna',
    slot: 'antenna',
    name: 'АНТЕННА ЗАВСЕГДАТАЯ',
    detail: '25 финишей в гонке',
    achievement: 'race-veteran-25',
    color: 0x9b6cff,
    render: { kind: 'head-antenna', primary: 0x9b6cff, motion: { sway: 0.14 } }
  },
  {
    id: 'podium-trail',
    slot: 'trail',
    name: 'СЛЕД ПЬЕДЕСТАЛА',
    detail: 'Тройка в гонке от трёх соперников',
    achievement: 'race-podium',
    color: 0x58ebb8,
    render: { kind: 'particle-trail', primary: 0x58ebb8, secondary: 0xd9fff1, shape: 'spark' }
  },
  {
    id: 'streak-trail',
    slot: 'trail',
    name: 'СЛЕД ПОСТОЯНСТВА',
    detail: 'Серия daily 30 дней',
    localGoal: 'daily-30',
    color: 0x7d82ff,
    render: { kind: 'particle-trail', primary: 0x7d82ff, secondary: 0xd6d8ff, shape: 'spark' }
  },
  {
    id: 'champion-finish',
    slot: 'finish',
    name: 'ФИНИШ ЧЕМПИОНА',
    detail: 'Выиграйте онлайн-гонку',
    achievement: 'race-win',
    glyph: '✦',
    render: { kind: 'finish-glyph', glyph: '✦', primary: 0xffd94b }
  }
];

// Унаследованные предметы описывали условие выдачи тремя разными полями. Резолвер должен видеть
// одну форму, поэтому старые поля переводятся в `unlock` здесь — сами поля при этом остаются на
// предмете, и код, который их читает, ничего не замечает.
//
// `localStat` сохраняет ровно то поведение, что было до этой системы: у трёх кооперативных наград
// помимо серверного достижения есть локальный фолбэк, и без него игрок, прошедший главу гостем,
// потерял бы уже полученную награду.
const LEGACY_LOCAL_FALLBACK = Object.freeze({
  'sky-hero': { path: 'coop.ch10Runs', gte: 1 },
  'clear-visor': { path: 'coop.flawless', gte: 5 },
  'rescue-antenna': { path: 'coop.revives', gte: 25 }
});

function legacyUnlock(item) {
  if (item.default) return { type: 'default' };
  if (item.achievement) {
    const localStat = LEGACY_LOCAL_FALLBACK[item.id];
    return localStat
      ? { type: 'achievement', id: item.achievement, localStat }
      : { type: 'achievement', id: item.achievement };
  }
  if (item.localGoal === 'daily-7') return { type: 'daily', streak: 7 };
  if (item.localGoal === 'daily-30') return { type: 'daily', streak: 30 };
  if (item.rewardable) return { type: 'rewarded' };
  return { type: 'admin' };
}

function normalize(item) {
  const rarity = item.rarity || 'common';
  return Object.freeze({
    ...item,
    rarity,
    collection: item.collection || null,
    tags: Object.freeze(item.tags ? [...item.tags] : []),
    unlock: Object.freeze(item.unlock ? { ...item.unlock } : legacyUnlock(item)),
    render: Object.freeze({ ...(item.render || { kind: 'body-suit' }) }),
    performance: Object.freeze({ ...DEFAULT_PERFORMANCE, ...(item.performance || {}) }),
    // Prestige не продаётся и не выдаётся за рекламу — это и есть смысл класса.
    purchasable: rarity === 'prestige' ? false : item.purchasable !== false,
    rewardable: rarity === 'prestige' ? false : Boolean(item.rewardable)
  });
}

export const COSMETIC_CATALOG = Object.freeze([
  ...LEGACY_COSMETICS.map(normalize),
  ...NEW_COSMETIC_CONTENT.map(normalize),
  ...COLLECTION_MILESTONE_COSMETICS.map(normalize)
]);

export const COSMETIC_BY_ID = Object.freeze(
  Object.fromEntries(COSMETIC_CATALOG.map(item => [item.id, item]))
);

// Предметы, добавленные Content & Customization 2.0. Milestone-награды намеренно не входят в этот
// список: исходный контент остаётся ровно шестьюдесятью предметами и четыре коллекции — по 15.
export const NEW_COSMETIC_IDS = Object.freeze(
  COSMETIC_CATALOG.filter(item => item.expansion === 'customization-2').map(item => item.id)
);

export const COLLECTION_MILESTONE_IDS = Object.freeze(
  COSMETIC_CATALOG.filter(item => item.collectionReward).map(item => item.id)
);

export const DEFAULT_COSMETIC_LOADOUT = Object.freeze({
  body: 'classic',
  visor: null,
  antenna: null,
  back: null,
  trail: null,
  finish: null
});

export const DEFAULT_EMOTE_LOADOUT = Object.freeze(new Array(EMOTE_LOADOUT_SIZE).fill(null));

export function cosmeticsForSlot(slot) {
  return COSMETIC_CATALOG.filter(item => item.slot === slot);
}

// Базовые предметы коллекции. Milestone-награды относятся к теме, но не могут считать сами себя в
// прогресс: иначе награда за 5 предметов превращала 5/15 в 6/15 без нового коллекционного предмета.
export function cosmeticsInCollection(collection) {
  return COSMETIC_CATALOG.filter(item => item.collection === collection && !item.collectionReward);
}

export function collectionRewards(collection) {
  return COSMETIC_CATALOG.filter(item => item.collection === collection && item.collectionReward).sort(
    (a, b) => Number(a.unlock?.gte || 0) - Number(b.unlock?.gte || 0)
  );
}

/**
 * Нормализация публичного loadout.
 *
 * Единственная граница между сетью и рендером: сюда приходит что угодно, отсюда выходят только
 * канонические ID в правильных слотах. Старый payload без `back` нормализуется в `null`, а не
 * исчезает — иначе удалённый игрок остался бы без слота вовсе.
 */
export function publicCosmeticLoadout(loadout = DEFAULT_COSMETIC_LOADOUT) {
  const safe = { ...DEFAULT_COSMETIC_LOADOUT };
  for (const slot of COSMETIC_SLOTS) {
    const id = loadout?.[slot];
    if (id == null && slot !== 'body') safe[slot] = null;
    else if (COSMETIC_BY_ID[id]?.slot === slot) safe[slot] = id;
  }
  return safe;
}

/**
 * Нормализация emote loadout: ровно EMOTE_LOADOUT_SIZE ячеек, только канонические emote ID,
 * без повторов. Клиентский JSON произвольной формы сюда попасть не может.
 */
export function publicEmoteLoadout(loadout = DEFAULT_EMOTE_LOADOUT) {
  const source = Array.isArray(loadout) ? loadout : [];
  const seen = new Set();
  const safe = [];
  for (let index = 0; index < EMOTE_LOADOUT_SIZE; index++) {
    const id = source[index];
    if (typeof id === 'string' && COSMETIC_BY_ID[id]?.slot === EMOTE_SLOT && !seen.has(id)) {
      seen.add(id);
      safe.push(id);
    } else safe.push(null);
  }
  return safe;
}

export function isEmote(cosmeticId) {
  return COSMETIC_BY_ID[cosmeticId]?.slot === EMOTE_SLOT;
}

/**
 * Что делать с предметом на заданном уровне детализации: 'full' | 'reduced' | 'hidden'.
 */
export function cosmeticDetailMode(item, level = 'full') {
  if (!item) return 'hidden';
  if (level === 'full') return 'full';
  return item.performance?.[level] || DEFAULT_PERFORMANCE[level] || 'hidden';
}

/**
 * Прогресс по четырём базовым коллекциям. Milestone-награды возвращаются отдельно и не меняют
 * знаменатель 15 — это бонусы за прогресс, а не новые требования для самих себя.
 */
export function collectionProgress(ownedIds = []) {
  const owned = ownedIds instanceof Set ? ownedIds : new Set(ownedIds);
  return COLLECTIONS.map(collection => {
    const items = cosmeticsInCollection(collection.id);
    const ownedCount = items.reduce((sum, item) => sum + (owned.has(item.id) ? 1 : 0), 0);
    return {
      ...collection,
      total: items.length,
      owned: ownedCount,
      percent: items.length ? Math.round((ownedCount / items.length) * 100) : 0,
      complete: items.length > 0 && ownedCount === items.length,
      mythic: items.filter(item => item.rarity === 'mythic').map(item => item.id),
      milestones: collectionRewards(collection.id).map(item => ({
        id: item.id,
        name: item.name,
        rarity: item.rarity,
        threshold: Number(item.unlock?.gte || 0),
        reached: ownedCount >= Number(item.unlock?.gte || 0),
        owned: owned.has(item.id)
      }))
    };
  });
}
