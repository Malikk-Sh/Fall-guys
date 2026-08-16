// Редкости, коллекции и слоты косметики — в одном месте.
//
// Раньше «редкости» не существовало вовсе, а подписи слотов жили строками внутри UI. С шестьюдесятью
// новыми предметами такой расклад означал бы шесть разных списков, которые надо править вручную при
// каждом добавлении, и любой из них мог отстать. Здесь единственный источник: каталог ссылается на
// эти ключи, UI берёт из них цвет, метку и порядок, а валидатор ловит опечатку до запуска игры.

// Порядок важен: он же задаёт сортировку в шкафу и в фильтрах.
export const RARITY_ORDER = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic', 'prestige']);

// `icon` и `shape` существуют не для красоты. Требование доступности: редкость обязана читаться без
// цветового зрения, поэтому у каждой ступени есть собственный символ и словесная метка, а цвет —
// только третий признак.
export const RARITY_META = Object.freeze({
  common: Object.freeze({
    id: 'common',
    label: 'ОБЫЧНЫЙ',
    short: 'C',
    icon: '•',
    color: 0xb9c2e6,
    order: 0
  }),
  rare: Object.freeze({
    id: 'rare',
    label: 'РЕДКИЙ',
    short: 'R',
    icon: '◆',
    color: 0x49b6ff,
    order: 1
  }),
  epic: Object.freeze({
    id: 'epic',
    label: 'ЭПИЧЕСКИЙ',
    short: 'E',
    icon: '✦',
    color: 0xb573ff,
    order: 2
  }),
  legendary: Object.freeze({
    id: 'legendary',
    label: 'ЛЕГЕНДАРНЫЙ',
    short: 'L',
    icon: '★',
    color: 0xffb038,
    order: 3
  }),
  mythic: Object.freeze({
    id: 'mythic',
    label: 'МИФИЧЕСКИЙ',
    short: 'M',
    icon: '☄',
    color: 0xff5f8f,
    order: 4
  }),
  // Prestige нужен архитектурно уже сейчас, хотя ни один из шестидесяти новых предметов его не
  // использует: будущая награда за тяжёлое достижение не должна требовать правки половины кода.
  // Она продаваться не может — это и есть смысл класса.
  prestige: Object.freeze({
    id: 'prestige',
    label: 'ПРЕСТИЖ',
    short: 'P',
    icon: '♛',
    color: 0x63ffd5,
    order: 5,
    purchasable: false,
    rewardable: false
  })
});

export const COLLECTION_ORDER = Object.freeze(['space-trouble', 'food-fight', 'neon-arcade', 'pirate-panic']);

export const COLLECTION_META = Object.freeze({
  'space-trouble': Object.freeze({
    id: 'space-trouble',
    name: 'КОСМИЧЕСКИЕ НЕПРИЯТНОСТИ',
    shortName: 'КОСМОС',
    description: 'Скафандры, спутники и всё, что светится в пустоте.',
    icon: '🛰',
    color: 0x6cc6ff,
    sortOrder: 0
  }),
  'food-fight': Object.freeze({
    id: 'food-fight',
    name: 'ЕДА В БОЮ',
    shortName: 'ЕДА',
    description: 'Кухня вышла из-под контроля и убежала на трассу.',
    icon: '🍔',
    color: 0xffa94d,
    sortOrder: 1
  }),
  'neon-arcade': Object.freeze({
    id: 'neon-arcade',
    name: 'НЕОНОВЫЙ АРКАД',
    shortName: 'АРКАДА',
    description: 'Пиксели, катодные лучи и слишком много подсветки.',
    icon: '🕹',
    color: 0xb573ff,
    sortOrder: 2
  }),
  'pirate-panic': Object.freeze({
    id: 'pirate-panic',
    name: 'ПИРАТСКАЯ ПАНИКА',
    shortName: 'ПИРАТЫ',
    description: 'Треуголки, сундуки и подозрительно живой попугай.',
    icon: '🏴',
    color: 0x58e0b0,
    sortOrder: 3
  })
});

export const COLLECTIONS = Object.freeze(COLLECTION_ORDER.map(id => COLLECTION_META[id]));

// Носимые слоты. `emote` сюда не входит намеренно: у эмоций свой loadout на четыре ячейки, и
// смешивать их с одиночными слотами значило бы или ломать equip, или заводить четыре псевдослота.
export const COSMETIC_SLOTS = Object.freeze(['body', 'visor', 'antenna', 'back', 'trail', 'finish']);

export const EMOTE_SLOT = 'emote';
export const EMOTE_LOADOUT_SIZE = 4;

// Все слоты, которые может иметь предмет каталога.
export const ALL_COSMETIC_SLOTS = Object.freeze([...COSMETIC_SLOTS, EMOTE_SLOT]);

// Подписи слотов для UI. Внутренний ключ `antenna` остался ради совместимости с сохранёнными
// loadout и колонкой в базе, но смысл слота расширился: туда теперь надевают короны, шляпы, уши и
// рога. Показывать игроку слово «антенна» было бы прямой ложью, поэтому метка отвязана от ключа.
export const SLOT_META = Object.freeze({
  body: Object.freeze({ id: 'body', label: 'ТЕЛО', icon: '🧍', order: 0, required: true }),
  visor: Object.freeze({ id: 'visor', label: 'ЛИЦО', icon: '😎', order: 1, required: false }),
  antenna: Object.freeze({ id: 'antenna', label: 'ГОЛОВА', icon: '👑', order: 2, required: false }),
  back: Object.freeze({ id: 'back', label: 'СПИНА', icon: '🎒', order: 3, required: false }),
  trail: Object.freeze({ id: 'trail', label: 'СЛЕД', icon: '✨', order: 4, required: false }),
  emote: Object.freeze({ id: 'emote', label: 'ЭМОЦИИ', icon: '💃', order: 5, required: false }),
  finish: Object.freeze({ id: 'finish', label: 'ПОБЕДА', icon: '🏁', order: 6, required: false })
});

export const SLOT_ORDER = Object.freeze(
  Object.values(SLOT_META)
    .slice()
    .sort((a, b) => a.order - b.order)
    .map(meta => meta.id)
);

// Известные типы выдачи. Server-owned выдаёт только сервер; local — единственное исключение,
// унаследованная daily-серия, которая никогда не была серверной и не должна ею притвориться.
export const UNLOCK_TYPES = Object.freeze([
  'default',
  'achievement',
  'stat',
  'daily',
  'rewarded',
  'event',
  'shop',
  'pass',
  'admin'
]);

// Типы, которые сервер вправе выдать сам по данным аккаунта.
export const SERVER_GRANTABLE_UNLOCKS = Object.freeze(['default', 'achievement', 'stat']);

// Типы, которых пока не существует как источника выдачи: каталог к ним готов, реализации нет.
// Предметы с ними показываются как «скоро» и не выдаются ни клиентом, ни сервером.
export const FUTURE_UNLOCKS = Object.freeze(['rewarded', 'event', 'shop', 'pass']);

// Уровни детализации, которые понимает косметический рендерер.
export const DETAIL_LEVELS = Object.freeze(['full', 'simple', 'minimal']);

// Что делать с предметом на пониженной детализации, если предмет не сказал иного.
export const DEFAULT_PERFORMANCE = Object.freeze({ simple: 'full', minimal: 'hidden' });

export function rarityMeta(rarity) {
  return RARITY_META[rarity] || RARITY_META.common;
}

export function collectionMeta(collection) {
  return COLLECTION_META[collection] || null;
}

export function slotMeta(slot) {
  return SLOT_META[slot] || null;
}
