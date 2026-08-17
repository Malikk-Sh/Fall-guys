// Бонусные награды за прогресс коллекций.
//
// Базовые четыре коллекции по-прежнему содержат ровно по 15 предметов Content & Customization 2.0.
// Эти предметы — награды поверх коллекции: они показываются рядом с темой, но сами не увеличивают
// счётчик 5/15 → 10/15 → 15/15. Иначе получение награды само двигало бы следующую цель.
//
// Условие остаётся обычным server-grantable `stat`: InventoryService подмешивает в статистику
// только число реально принадлежащих аккаунту БАЗОВЫХ предметов коллекции. Клиент это число может
// показывать, но выдачу не решает.

const milestone = (collection, items) =>
  items.map(item =>
    Object.freeze({
      ...item,
      collection,
      collectionReward: true,
      expansion: 'customization-milestones'
    })
  );

const SPACE_TROUBLE = [
  {
    id: 'space-orbit-visor',
    slot: 'visor',
    name: 'ОРБИТАЛЬНЫЙ ВИЗОР',
    description: 'Небольшое созвездие кружит прямо перед стеклом.',
    rarity: 'epic',
    tags: ['space', 'milestone', 'face'],
    unlock: { type: 'stat', path: 'collection.space-trouble', gte: 5 },
    render: { kind: 'face-nebula', primary: 0x243a73, secondary: 0x8fd8ff },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'space-comet-trail',
    slot: 'trail',
    name: 'КОМЕТНЫЙ ШЛЕЙФ',
    description: 'Яркие искры остаются позади как короткая орбита.',
    rarity: 'legendary',
    tags: ['space', 'milestone', 'particles'],
    unlock: { type: 'stat', path: 'collection.space-trouble', gte: 10 },
    render: {
      kind: 'particle-trail',
      primary: 0xfff1bd,
      secondary: 0x72c7ff,
      shape: 'star',
      density: 1.1
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'space-constellation-crown',
    slot: 'antenna',
    name: 'КОРОНА СОЗВЕЗДИЯ',
    description: 'Награда за полный звёздный маршрут коллекционера.',
    rarity: 'prestige',
    tags: ['space', 'milestone', 'crown'],
    unlock: { type: 'stat', path: 'collection.space-trouble', gte: 15 },
    render: {
      kind: 'head-crown',
      primary: 0xe9f7ff,
      secondary: 0x6cc6ff,
      points: 5,
      style: 'star',
      motion: { sway: 0.12, bob: 0.45, lag: 0.3 }
    }
  }
];

const FOOD_FIGHT = [
  {
    id: 'food-soda-pack',
    slot: 'back',
    name: 'ГАЗИРОВАННЫЙ РАНЕЦ',
    description: 'Два баллона лимонада. Не спрашивайте про давление.',
    rarity: 'epic',
    tags: ['food', 'milestone', 'pack'],
    unlock: { type: 'stat', path: 'collection.food-fight', gte: 5 },
    render: {
      kind: 'back-tanks',
      primary: 0xff6b6b,
      secondary: 0xffd257,
      count: 2,
      nozzle: true,
      motion: { bob: 0.8, landing: 1.1, lag: 0.45 }
    }
  },
  {
    id: 'food-party-trail',
    slot: 'trail',
    name: 'ПРАЗДНИЧНАЯ ПОСЫПКА',
    description: 'Крошки закончились — начался настоящий праздник.',
    rarity: 'legendary',
    tags: ['food', 'milestone', 'particles'],
    unlock: { type: 'stat', path: 'collection.food-fight', gte: 10 },
    render: {
      kind: 'particle-trail',
      primary: 0xff7fc4,
      secondary: 0x6cf7ff,
      shape: 'sprinkle',
      density: 1.15
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'food-master-chef-crown',
    slot: 'antenna',
    name: 'КОРОНА ШЕФА',
    description: 'Высшая награда кухни, пережившей все пятнадцать блюд.',
    rarity: 'prestige',
    tags: ['food', 'milestone', 'crown'],
    unlock: { type: 'stat', path: 'collection.food-fight', gte: 15 },
    render: {
      kind: 'head-crown',
      primary: 0xfff7e6,
      secondary: 0xffb547,
      points: 5,
      style: 'fries',
      motion: { sway: 0.18, bob: 0.55, lag: 0.35 }
    }
  }
];

const NEON_ARCADE = [
  {
    id: 'neon-token-visor',
    slot: 'visor',
    name: 'ЖЕТОННЫЙ ВИЗОР',
    description: 'Светящаяся полоса с пиксельным блеском старого автомата.',
    rarity: 'epic',
    tags: ['neon', 'milestone', 'face'],
    unlock: { type: 'stat', path: 'collection.neon-arcade', gte: 5 },
    render: { kind: 'face-scan', primary: 0x10152d, secondary: 0x22e0ff },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-combo-trail',
    slot: 'trail',
    name: 'КОМБО-СЛЕД',
    description: 'Пиксели догоняют друг друга, будто счётчик комбо не хочет сбрасываться.',
    rarity: 'legendary',
    tags: ['neon', 'milestone', 'pixel'],
    unlock: { type: 'stat', path: 'collection.neon-arcade', gte: 10 },
    render: {
      kind: 'particle-trail',
      primary: 0x22e0ff,
      secondary: 0xff4fd8,
      shape: 'square',
      density: 1.2
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-high-score-crown',
    slot: 'antenna',
    name: 'КОРОНА HIGH SCORE',
    description: 'Пятнадцать из пятнадцати. Автомат наконец признал рекорд.',
    rarity: 'prestige',
    tags: ['neon', 'milestone', 'crown'],
    unlock: { type: 'stat', path: 'collection.neon-arcade', gte: 15 },
    render: {
      kind: 'head-crown',
      primary: 0x22e0ff,
      secondary: 0xff4fd8,
      points: 4,
      style: 'pixel',
      motion: { sway: 0.1, bob: 0.4, lag: 0.25 }
    }
  }
];

const PIRATE_PANIC = [
  {
    id: 'pirate-compass-pack',
    slot: 'back',
    name: 'КОМПАСНЫЙ ЯЩИК',
    description: 'Показывает на сокровища. Иногда даже в правильную сторону.',
    rarity: 'epic',
    tags: ['pirate', 'milestone', 'pack'],
    unlock: { type: 'stat', path: 'collection.pirate-panic', gte: 5 },
    render: {
      kind: 'back-crate',
      primary: 0x6e4426,
      secondary: 0xf0d98a,
      style: 'treasure',
      motion: { bob: 0.6, landing: 1, lag: 0.4 }
    }
  },
  {
    id: 'pirate-gold-trail',
    slot: 'trail',
    name: 'ЗОЛОТОЙ СЛЕД',
    description: 'Монеты не настоящие, но пираты всё равно пытаются подобрать.',
    rarity: 'legendary',
    tags: ['pirate', 'milestone', 'particles'],
    unlock: { type: 'stat', path: 'collection.pirate-panic', gte: 10 },
    render: {
      kind: 'particle-trail',
      primary: 0xffd257,
      secondary: 0xff9f43,
      shape: 'spark',
      density: 1.05
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'pirate-admiral-crown',
    slot: 'antenna',
    name: 'КОРОНА АДМИРАЛА',
    description: 'Полная коллекция делает капитана адмиралом. По крайней мере в шкафу.',
    rarity: 'prestige',
    tags: ['pirate', 'milestone', 'crown'],
    unlock: { type: 'stat', path: 'collection.pirate-panic', gte: 15 },
    render: {
      kind: 'head-crown',
      primary: 0xf0d98a,
      secondary: 0x8c2f39,
      points: 5,
      style: 'star',
      motion: { sway: 0.13, bob: 0.45, lag: 0.32 }
    }
  }
];

export const COLLECTION_MILESTONE_COSMETICS = Object.freeze([
  ...milestone('space-trouble', SPACE_TROUBLE),
  ...milestone('food-fight', FOOD_FIGHT),
  ...milestone('neon-arcade', NEON_ARCADE),
  ...milestone('pirate-panic', PIRATE_PANIC)
]);
