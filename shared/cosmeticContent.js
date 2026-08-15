// Контент Content & Customization 2.0: шестьдесят новых предметов в четырёх коллекциях.
//
// Здесь только данные. Ни одной ветки `if (id === ...)`: каждый предмет говорит, из какого
// render kind он собирается и с какими параметрами, а рендерер и шкаф читают это механически.
// Добавить шестьдесят первый предмет — значит дописать сюда запись, а не править шесть списков.
//
// Про `render`: `kind` выбирает фабрику в client/game/cosmetics, остальные поля — её параметры.
// `motion` — вторичная анимация (качание, отставание, реакция на приземление). Это исключительно
// presentation: игровая физика от косметики не зависит и зависеть не должна.
//
// Про `performance`: чем предмет становится на пониженной детализации. `full` — как есть,
// `reduced` — упрощённая версия, `hidden` — не рисуется. Умолчания живут в cosmeticMeta.js,
// поэтому повторять их у каждого дешёвого предмета не нужно.

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPACE TROUBLE
// ─────────────────────────────────────────────────────────────────────────────────────────────
const SPACE_TROUBLE = [
  {
    id: 'space-astronaut',
    slot: 'body',
    name: 'АСТРОНАВТ',
    description: 'Лёгкий костюм для прогулок там, где не за что держаться.',
    rarity: 'rare',
    tags: ['space', 'suit'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 1 },
    render: {
      kind: 'body-suit',
      primary: 0xf2f6ff,
      accent: 0x4f8cff,
      belly: 0xd9e4ff,
      features: ['collar', 'stripes']
    }
  },
  {
    id: 'space-alien',
    slot: 'body',
    name: 'ПРИШЕЛЕЦ',
    description: 'Бирюзовый гость, который так и не понял правил гонки.',
    rarity: 'rare',
    tags: ['space', 'creature'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 5 },
    render: {
      kind: 'body-creature',
      primary: 0x53e0a8,
      accent: 0x1f7d63,
      belly: 0x9df5cf,
      ears: 'stalk',
      muzzle: false
    }
  },
  {
    id: 'space-retro-robot',
    slot: 'body',
    name: 'РЕТРО-РОБОТ',
    description: 'Панели, заклёпки и одна очень важная мигающая лампа.',
    rarity: 'epic',
    tags: ['space', 'robot'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 20 },
    render: {
      kind: 'body-plated',
      primary: 0xb9c4d8,
      accent: 0xff8a3d,
      panel: 0x8492ad,
      glow: 0xffd166
    }
  },
  {
    id: 'space-moon-cat',
    slot: 'body',
    name: 'ЛУННЫЙ КОТ',
    description: 'Костюм кота, который первым добрался до Луны и никому не сказал.',
    rarity: 'epic',
    tags: ['space', 'creature', 'cat'],
    unlock: { type: 'stat', path: 'coop.chapters', gte: 3 },
    render: {
      kind: 'body-creature',
      primary: 0x8a92c8,
      accent: 0xf7f2ff,
      belly: 0xe6e2ff,
      ears: 'point',
      muzzle: true,
      tail: true
    }
  },
  {
    id: 'space-satellite-dish',
    slot: 'antenna',
    name: 'СПУТНИКОВАЯ ТАРЕЛКА',
    description: 'Ловит сигнал отовсюду, кроме нужного направления.',
    rarity: 'rare',
    tags: ['space', 'tech'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 8 },
    render: {
      kind: 'head-dish',
      primary: 0xdfe7f5,
      secondary: 0x5b7bb8,
      motion: { sway: 0.22, lag: 0.5 }
    }
  },
  {
    id: 'space-star-crown',
    slot: 'antenna',
    name: 'ЗВЁЗДНАЯ КОРОНА',
    description: 'Три звезды на орбите головы. Держатся честным словом.',
    rarity: 'epic',
    tags: ['space', 'crown'],
    unlock: { type: 'stat', path: 'race.wins', gte: 3 },
    render: {
      kind: 'head-crown',
      primary: 0xffd76a,
      secondary: 0xfff3c4,
      points: 3,
      style: 'star',
      motion: { sway: 0.16, bob: 0.5, lag: 0.35 }
    }
  },
  {
    id: 'space-rocket-fin',
    slot: 'antenna',
    name: 'РАКЕТНЫЙ ГРЕБЕНЬ',
    description: 'Аэродинамики не добавляет, зато выглядит быстро.',
    rarity: 'rare',
    tags: ['space', 'rocket'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 12 },
    render: {
      kind: 'head-fin',
      primary: 0xff5f6d,
      secondary: 0xfff0f2,
      motion: { sway: 0.08, lag: 0.2 }
    }
  },
  {
    id: 'space-nebula-visor',
    slot: 'visor',
    name: 'ТУМАННОСТЬ',
    description: 'Внутри стекла медленно ползёт чужая галактика.',
    rarity: 'epic',
    tags: ['space', 'glow'],
    unlock: { type: 'stat', path: 'coop.flawless', gte: 3 },
    render: { kind: 'face-nebula', primary: 0x8f6bff, secondary: 0x6cf7ff },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'space-alien-eyes',
    slot: 'visor',
    name: 'ЧУЖИЕ ГЛАЗА',
    description: 'Два огромных глаза, которые всегда смотрят чуть мимо.',
    rarity: 'rare',
    tags: ['space', 'face'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 6 },
    render: { kind: 'face-eyes', primary: 0x0d0f24, secondary: 0x7cf9d0 }
  },
  {
    id: 'space-oxygen-pack',
    slot: 'back',
    name: 'КИСЛОРОДНЫЙ МОДУЛЬ',
    description: 'Два баллона, которые подпрыгивают при каждой посадке.',
    rarity: 'rare',
    tags: ['space', 'pack'],
    unlock: { type: 'stat', path: 'coop.revives', gte: 10 },
    render: {
      kind: 'back-tanks',
      primary: 0xe8eefb,
      secondary: 0x4f8cff,
      count: 2,
      motion: { bob: 1, landing: 1.2, lag: 0.4 }
    }
  },
  {
    id: 'space-stardust-trail',
    slot: 'trail',
    name: 'ЗВЁЗДНАЯ ПЫЛЬ',
    description: 'Мелкие звёзды, которые ещё немного висят там, где вы были.',
    rarity: 'epic',
    tags: ['space', 'particles'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 10 },
    render: {
      kind: 'particle-trail',
      primary: 0xffffff,
      secondary: 0x8fc7ff,
      shape: 'star',
      density: 1
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'space-rocket-trail',
    slot: 'trail',
    name: 'РАКЕТНЫЙ ВЫХЛОП',
    description: 'На скорости и в воздухе разгорается заметно сильнее.',
    rarity: 'legendary',
    tags: ['space', 'rocket', 'particles'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 40 },
    render: {
      kind: 'jet-trail',
      primary: 0xffb547,
      secondary: 0xff5f6d,
      density: 1.1
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'space-moonwalk',
    slot: 'emote',
    name: 'ЛУННАЯ ПОХОДКА',
    description: 'Шаг назад, который выглядит как шаг вперёд.',
    rarity: 'epic',
    tags: ['space', 'dance'],
    unlock: { type: 'daily', streak: 3 },
    render: { kind: 'emote-pose', motion: 'moonwalk', duration: 2.2, glyph: '🌙' }
  },
  {
    id: 'space-portal-finish',
    slot: 'finish',
    name: 'ВЫХОД ЧЕРЕЗ ПОРТАЛ',
    description: 'Помахать рукой и уйти туда, где нет препятствий.',
    rarity: 'legendary',
    tags: ['space', 'finish'],
    unlock: { type: 'achievement', id: 'race-veteran-25' },
    render: {
      kind: 'finish-portal',
      primary: 0x8f6bff,
      secondary: 0x6cf7ff,
      glyph: '◎',
      duration: 2.6
    }
  },
  {
    id: 'space-void',
    slot: 'body',
    name: 'ПУСТОТА',
    description: 'Материал, который не отражает ничего, и пыль, которая всё равно светится.',
    rarity: 'mythic',
    tags: ['space', 'mythic'],
    unlock: { type: 'rewarded' },
    render: {
      kind: 'body-mythic',
      primary: 0x140b2b,
      accent: 0x6a3cff,
      belly: 0x2a1a55,
      glow: 0xb08bff,
      effect: 'void',
      orbits: 4
    },
    performance: { simple: 'reduced', minimal: 'reduced' }
  }
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// FOOD FIGHT
// ─────────────────────────────────────────────────────────────────────────────────────────────
const FOOD_FIGHT = [
  {
    id: 'food-burger',
    slot: 'body',
    name: 'БУРГЕР-ПРИЯТЕЛЬ',
    description: 'Булочка, котлета и полное отсутствие сомнений.',
    rarity: 'rare',
    tags: ['food', 'suit'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 2 },
    render: {
      kind: 'body-suit',
      primary: 0xe8a447,
      accent: 0x7c3b1c,
      belly: 0x8fd15c,
      features: ['layers']
    }
  },
  {
    id: 'food-sushi',
    slot: 'body',
    name: 'РОЛЛ',
    description: 'Аккуратно завёрнут и совершенно не готов к столкновениям.',
    rarity: 'rare',
    tags: ['food', 'suit'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 7 },
    render: {
      kind: 'body-suit',
      primary: 0xf7f3e6,
      accent: 0x2c3a2f,
      belly: 0xff8f7a,
      features: ['belt', 'layers']
    }
  },
  {
    id: 'food-avocado',
    slot: 'body',
    name: 'ЗЛОЙ АВОКАДО',
    description: 'Косточка внутри, недовольство снаружи.',
    rarity: 'epic',
    tags: ['food', 'creature'],
    unlock: { type: 'stat', path: 'coop.matches', gte: 5 },
    render: {
      kind: 'body-creature',
      primary: 0x5d8a3a,
      accent: 0x2f4a1d,
      belly: 0xd9d16a,
      ears: 'none',
      muzzle: false,
      brow: true
    }
  },
  {
    id: 'food-donut',
    slot: 'body',
    name: 'КОРОЛЬ ПОНЧИКОВ',
    description: 'Глазурь держится лучше, чем достоинство.',
    rarity: 'epic',
    tags: ['food', 'suit'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 22 },
    render: {
      kind: 'body-suit',
      primary: 0xf3c98b,
      accent: 0xff7fc4,
      belly: 0xffd9ec,
      features: ['glaze', 'sprinkles']
    }
  },
  {
    id: 'food-fries-crown',
    slot: 'antenna',
    name: 'КОРОНА ИЗ ФРИ',
    description: 'Пять палочек, и каждая качается по-своему.',
    rarity: 'epic',
    tags: ['food', 'crown'],
    unlock: { type: 'stat', path: 'race.podiums', gte: 3 },
    render: {
      kind: 'head-crown',
      primary: 0xffd257,
      secondary: 0xe0453c,
      points: 5,
      style: 'fries',
      motion: { sway: 0.3, lag: 0.6, bob: 0.7 }
    }
  },
  {
    id: 'food-chef-hat',
    slot: 'antenna',
    name: 'КОЛПАК ШЕФА',
    description: 'Высокий, мягкий и слегка запачканный.',
    rarity: 'rare',
    tags: ['food', 'hat'],
    unlock: { type: 'stat', path: 'coop.chapters', gte: 1 },
    render: {
      kind: 'head-hat',
      primary: 0xfbfaf6,
      secondary: 0xe3ddcc,
      style: 'chef',
      motion: { sway: 0.14, lag: 0.4 }
    }
  },
  {
    id: 'food-ketchup-shades',
    slot: 'visor',
    name: 'КЕТЧУП-ОЧКИ',
    description: 'Мир становится томатным. Это даже помогает.',
    rarity: 'rare',
    tags: ['food', 'face'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 9 },
    render: { kind: 'face-shades', primary: 0xd63b2f, secondary: 0x2a0d0a }
  },
  {
    id: 'food-sauce-pack',
    slot: 'back',
    name: 'СОУСНЫЙ РАНЕЦ',
    description: 'Две бутылки на все случаи. И на пару лишних.',
    rarity: 'rare',
    tags: ['food', 'pack'],
    unlock: { type: 'stat', path: 'coop.revives', gte: 5 },
    render: {
      kind: 'back-tanks',
      primary: 0xd63b2f,
      secondary: 0xf7d94b,
      count: 2,
      nozzle: true,
      motion: { bob: 0.8, landing: 1, lag: 0.45 }
    }
  },
  {
    id: 'food-toaster-pack',
    slot: 'back',
    name: 'ТОСТЕР',
    description: 'Иногда из него выпрыгивает тост. Никто не знает зачем.',
    rarity: 'epic',
    tags: ['food', 'pack'],
    unlock: { type: 'stat', path: 'coop.chapters', gte: 6 },
    render: {
      kind: 'back-crate',
      primary: 0xd8dde8,
      secondary: 0xe8a447,
      style: 'toaster',
      motion: { bob: 0.6, landing: 1.4, pop: 1 }
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'food-crumb-trail',
    slot: 'trail',
    name: 'КРОШКИ',
    description: 'По ним вас найдут. Или найдут крошки.',
    rarity: 'rare',
    tags: ['food', 'particles'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 2 },
    render: {
      kind: 'particle-trail',
      primary: 0xd9a066,
      secondary: 0x8a5a2b,
      shape: 'crumb',
      density: 0.8
    }
  },
  {
    id: 'food-sprinkle-trail',
    slot: 'trail',
    name: 'ПОСЫПКА',
    description: 'Цветные палочки, которые никогда не заканчиваются.',
    rarity: 'epic',
    tags: ['food', 'particles'],
    unlock: { type: 'daily', streak: 5 },
    render: {
      kind: 'particle-trail',
      primary: 0xff7fc4,
      secondary: 0x6cf7ff,
      shape: 'sprinkle',
      density: 1
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'food-chefs-kiss',
    slot: 'emote',
    name: 'ПОЦЕЛУЙ ШЕФА',
    description: 'Жест, после которого спорить бессмысленно.',
    rarity: 'rare',
    tags: ['food', 'gesture'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 4 },
    render: { kind: 'emote-pose', motion: 'kiss', duration: 1.6, glyph: '💋' }
  },
  {
    id: 'food-hungry-dance',
    slot: 'emote',
    name: 'ГОЛОДНЫЙ ТАНЕЦ',
    description: 'Исполняется, когда до финиша далеко, а обед ещё дальше.',
    rarity: 'epic',
    tags: ['food', 'dance'],
    unlock: { type: 'daily', streak: 10 },
    render: { kind: 'emote-pose', motion: 'dance', duration: 2.4, glyph: '🍽' }
  },
  {
    id: 'food-dinner-finish',
    slot: 'finish',
    name: 'УЖИН ПОДАН',
    description: 'Крышка снимается, под ней — победа.',
    rarity: 'epic',
    tags: ['food', 'finish'],
    unlock: { type: 'stat', path: 'coop.chapters', gte: 8 },
    render: {
      kind: 'finish-burst',
      primary: 0xf7d94b,
      secondary: 0xd63b2f,
      style: 'reveal',
      glyph: '🍽',
      duration: 2.2
    }
  },
  {
    id: 'food-popcorn-finish',
    slot: 'finish',
    name: 'ПОПКОРН',
    description: 'Взрыв, после которого ещё минуту что-то падает.',
    rarity: 'legendary',
    tags: ['food', 'finish'],
    unlock: { type: 'shop' },
    render: {
      kind: 'finish-burst',
      primary: 0xfff4d6,
      secondary: 0xffb547,
      style: 'burst',
      glyph: '🍿',
      duration: 2.8
    }
  }
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// NEON ARCADE
// ─────────────────────────────────────────────────────────────────────────────────────────────
const NEON_ARCADE = [
  {
    id: 'neon-cyber',
    slot: 'body',
    name: 'КИБЕР-ВОБЛЕР',
    description: 'Полоски светятся ровно настолько, чтобы мешать соседям.',
    rarity: 'rare',
    tags: ['neon', 'glow'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 3 },
    render: {
      kind: 'body-glow',
      primary: 0x1b1b3a,
      accent: 0x22e0ff,
      belly: 0x2a2a5c,
      glow: 0x22e0ff,
      stripes: 3
    }
  },
  {
    id: 'neon-crt',
    slot: 'body',
    name: 'ЭЛТ-БЕГУН',
    description: 'Внутри корпуса всё ещё идёт заставка.',
    rarity: 'epic',
    tags: ['neon', 'retro'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 16 },
    render: {
      kind: 'body-plated',
      primary: 0xd7d2c4,
      accent: 0x3ad6a0,
      panel: 0x1a2a24,
      glow: 0x3ad6a0,
      screen: true
    }
  },
  {
    id: 'neon-pixel-knight',
    slot: 'body',
    name: 'ПИКСЕЛЬНЫЙ РЫЦАРЬ',
    description: 'Броня из очень крупных пикселей. Защищает от эстетики.',
    rarity: 'epic',
    tags: ['neon', 'pixel'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 26 },
    render: {
      kind: 'body-plated',
      primary: 0x9aa7c7,
      accent: 0x4f6bff,
      panel: 0x6b7aa3,
      glow: 0x8fb2ff,
      pixel: true
    }
  },
  {
    id: 'neon-synthwave',
    slot: 'body',
    name: 'СИНТВЕЙВ',
    description: 'Закат, сетка и градиент, который никогда не выходит из моды.',
    rarity: 'legendary',
    tags: ['neon', 'glow'],
    unlock: { type: 'stat', path: 'race.wins', gte: 10 },
    render: {
      kind: 'body-glow',
      primary: 0x2a1050,
      accent: 0xff4fd8,
      belly: 0x3d1a6b,
      glow: 0xff4fd8,
      stripes: 5,
      gradient: true
    },
    performance: { simple: 'reduced', minimal: 'reduced' }
  },
  {
    id: 'neon-horns',
    slot: 'antenna',
    name: 'НЕОНОВЫЕ РОГА',
    description: 'Маленькие, светятся, ни на что не влияют.',
    rarity: 'rare',
    tags: ['neon', 'horns'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 11 },
    render: {
      kind: 'head-horns',
      primary: 0xff4fd8,
      secondary: 0x2a1050,
      motion: { sway: 0.1, lag: 0.25 }
    }
  },
  {
    id: 'neon-arcade-crown',
    slot: 'antenna',
    name: 'АРКАДНАЯ КОРОНА',
    description: 'Геометрия из тех времён, когда круг был роскошью.',
    rarity: 'epic',
    tags: ['neon', 'crown', 'pixel'],
    unlock: { type: 'stat', path: 'race.wins', gte: 5 },
    render: {
      kind: 'head-crown',
      primary: 0x22e0ff,
      secondary: 0x0d2440,
      points: 4,
      style: 'pixel',
      motion: { sway: 0.12, bob: 0.4, lag: 0.3 }
    }
  },
  {
    id: 'neon-holo-antenna',
    slot: 'antenna',
    name: 'ГОЛО-АНТЕННА',
    description: 'Кончик полупрозрачный и, кажется, не совсем здесь.',
    rarity: 'epic',
    tags: ['neon', 'tech'],
    unlock: { type: 'achievement', id: 'coop-flawless-5' },
    render: {
      kind: 'head-antenna',
      primary: 0x7fe7ff,
      secondary: 0x2a6bff,
      holo: true,
      motion: { sway: 0.26, lag: 0.55 }
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-laser-visor',
    slot: 'visor',
    name: 'ЛАЗЕРНЫЙ ВИЗОР',
    description: 'Одна светящаяся полоса. Больше ничего и не нужно.',
    rarity: 'epic',
    tags: ['neon', 'face'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 18 },
    render: { kind: 'face-shades', primary: 0x140b2b, secondary: 0xff3b6b, laser: true }
  },
  {
    id: 'neon-scan-face',
    slot: 'visor',
    name: 'СКАНЛАЙН',
    description: 'По лицу медленно ползёт строка развёртки.',
    rarity: 'rare',
    tags: ['neon', 'retro'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 13 },
    render: { kind: 'face-scan', primary: 0x0d1a24, secondary: 0x3ad6a0 },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-battery-pack',
    slot: 'back',
    name: 'БЛОК ПИТАНИЯ',
    description: 'Индикатор всегда показывает «почти разряжено».',
    rarity: 'epic',
    tags: ['neon', 'pack'],
    unlock: { type: 'stat', path: 'coop.matches', gte: 12 },
    render: {
      kind: 'back-crate',
      primary: 0x22304a,
      secondary: 0x3aff9e,
      style: 'battery',
      motion: { bob: 0.5, landing: 0.9, lag: 0.35 }
    }
  },
  {
    id: 'neon-pixel-trail',
    slot: 'trail',
    name: 'ПИКСЕЛЬНЫЙ СЛЕД',
    description: 'Квадраты, которые честно признают своё разрешение.',
    rarity: 'epic',
    tags: ['neon', 'pixel', 'particles'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 15 },
    render: {
      kind: 'particle-trail',
      primary: 0x22e0ff,
      secondary: 0xff4fd8,
      shape: 'square',
      density: 1
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-ghost-trail',
    slot: 'trail',
    name: 'ЦИФРОВЫЕ ПРИЗРАКИ',
    description: 'Пара силуэтов, которые не успевают за вами.',
    rarity: 'legendary',
    tags: ['neon', 'ghost'],
    unlock: { type: 'stat', path: 'race.podiums', gte: 8 },
    render: { kind: 'ghost-trail', primary: 0x7fe7ff, secondary: 0xff4fd8, ghosts: 2 },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'neon-robot-dance',
    slot: 'emote',
    name: 'ТАНЕЦ РОБОТА',
    description: 'Движения строго по сетке. Ошибка — тоже по сетке.',
    rarity: 'epic',
    tags: ['neon', 'dance'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 14 },
    render: { kind: 'emote-pose', motion: 'robot', duration: 2.4, glyph: '🤖' }
  },
  {
    id: 'neon-game-over-finish',
    slot: 'finish',
    name: 'GAME OVER',
    description: 'Надпись, которая на этот раз означает противоположное.',
    rarity: 'legendary',
    tags: ['neon', 'finish'],
    unlock: { type: 'achievement', id: 'race-win' },
    render: {
      kind: 'finish-burst',
      primary: 0xff3b6b,
      secondary: 0x22e0ff,
      style: 'arcade',
      glyph: '⏻',
      duration: 2.6
    }
  },
  {
    id: 'neon-gl1tch',
    slot: 'body',
    name: 'GL1TCH',
    description: 'Изображение иногда сдвигается. Так и задумано.',
    rarity: 'mythic',
    tags: ['neon', 'mythic'],
    unlock: { type: 'event' },
    render: {
      kind: 'body-mythic',
      primary: 0x120f2e,
      accent: 0x22e0ff,
      belly: 0x2a1050,
      glow: 0xff3b6b,
      effect: 'glitch',
      orbits: 0
    },
    performance: { simple: 'reduced', minimal: 'reduced' }
  }
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// PIRATE PANIC
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PIRATE_PANIC = [
  {
    id: 'pirate-captain',
    slot: 'body',
    name: 'КАПИТАН',
    description: 'Мундир, пояс и полная уверенность в курсе.',
    rarity: 'rare',
    tags: ['pirate', 'suit'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 4 },
    render: {
      kind: 'body-suit',
      primary: 0x8c2f39,
      accent: 0xf0d98a,
      belly: 0xf5efe0,
      features: ['collar', 'belt']
    }
  },
  {
    id: 'pirate-shark',
    slot: 'body',
    name: 'КОСТЮМ АКУЛЫ',
    description: 'Опасен ровно настолько, насколько смешон.',
    rarity: 'epic',
    tags: ['pirate', 'creature'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 24 },
    render: {
      kind: 'body-creature',
      primary: 0x5b7fa8,
      accent: 0x2b3f57,
      belly: 0xe8eef5,
      ears: 'fin',
      muzzle: true,
      teeth: true
    }
  },
  {
    id: 'pirate-skeleton',
    slot: 'body',
    name: 'СКЕЛЕТ-КОРСАР',
    description: 'Костей ровно столько, сколько нужно для приличия.',
    rarity: 'epic',
    tags: ['pirate', 'bones'],
    unlock: { type: 'achievement', id: 'coop-campaign-complete' },
    render: {
      kind: 'body-suit',
      primary: 0x2a2f3d,
      accent: 0xe8e4d5,
      belly: 0xe8e4d5,
      features: ['ribs', 'belt']
    }
  },
  {
    id: 'pirate-kraken-kid',
    slot: 'body',
    name: 'ДИТЯ КРАКЕНА',
    description: 'Щупальца небольшие, но с характером.',
    rarity: 'legendary',
    tags: ['pirate', 'creature'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 50 },
    render: {
      kind: 'body-creature',
      primary: 0x6b3fa0,
      accent: 0x3ad6a0,
      belly: 0xc9a6ff,
      ears: 'tentacle',
      muzzle: false,
      tentacles: 4
    },
    performance: { simple: 'reduced', minimal: 'reduced' }
  },
  {
    id: 'pirate-captain-hat',
    slot: 'antenna',
    name: 'ТРЕУГОЛКА',
    description: 'Три угла, одно перо и много самомнения.',
    rarity: 'rare',
    tags: ['pirate', 'hat'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 17 },
    render: {
      kind: 'head-hat',
      primary: 0x2a2f3d,
      secondary: 0xf0d98a,
      style: 'tricorn',
      motion: { sway: 0.12, lag: 0.35 }
    }
  },
  {
    id: 'pirate-parrot',
    slot: 'antenna',
    name: 'ПОПУГАЙ',
    description: 'Сидит, покачивается и, кажется, всё запоминает.',
    rarity: 'epic',
    tags: ['pirate', 'creature'],
    unlock: { type: 'achievement', id: 'coop-helper-25' },
    render: {
      kind: 'head-perch',
      primary: 0xe0453c,
      secondary: 0x3ad6a0,
      accent: 0xf7d94b,
      motion: { sway: 0.34, bob: 1.1, lag: 0.7 }
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'pirate-eyepatch',
    slot: 'visor',
    name: 'ПОВЯЗКА',
    description: 'Половина обзора в обмен на целую репутацию.',
    rarity: 'rare',
    tags: ['pirate', 'face'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 19 },
    render: { kind: 'face-patch', primary: 0x14161f, secondary: 0x3a3f52 }
  },
  {
    id: 'pirate-treasure-pack',
    slot: 'back',
    name: 'СУНДУК',
    description: 'Мини-сундук с содержимым, о котором лучше не спрашивать.',
    rarity: 'epic',
    tags: ['pirate', 'pack'],
    unlock: { type: 'stat', path: 'race.podiums', gte: 5 },
    render: {
      kind: 'back-crate',
      primary: 0x7c4a24,
      secondary: 0xf0d98a,
      style: 'chest',
      motion: { bob: 0.7, landing: 1.3, lag: 0.4 }
    }
  },
  {
    id: 'pirate-barrel-pack',
    slot: 'back',
    name: 'БОЧОНОК',
    description: 'Маленький, круглый, издаёт плеск на поворотах.',
    rarity: 'rare',
    tags: ['pirate', 'pack'],
    unlock: { type: 'daily', streak: 7 },
    render: {
      kind: 'back-barrel',
      primary: 0x9c6b3a,
      secondary: 0x5c4326,
      motion: { bob: 0.6, landing: 1.1, lag: 0.5 }
    }
  },
  {
    id: 'pirate-coin-trail',
    slot: 'trail',
    name: 'ЗОЛОТЫЕ МОНЕТЫ',
    description: 'Падают, крутятся и исчезают до того, как их поднимут.',
    rarity: 'epic',
    tags: ['pirate', 'particles'],
    unlock: { type: 'stat', path: 'race.wins', gte: 2 },
    render: {
      kind: 'particle-trail',
      primary: 0xf7d94b,
      secondary: 0xb98a1f,
      shape: 'coin',
      density: 0.9
    },
    performance: { simple: 'reduced', minimal: 'hidden' }
  },
  {
    id: 'pirate-foam-trail',
    slot: 'trail',
    name: 'МОРСКАЯ ПЕНА',
    description: 'Пузырьки, которые лопаются с опозданием.',
    rarity: 'rare',
    tags: ['pirate', 'particles'],
    unlock: { type: 'daily', streak: 14 },
    render: {
      kind: 'particle-trail',
      primary: 0xe8f6ff,
      secondary: 0x6cc6ff,
      shape: 'bubble',
      density: 0.8
    }
  },
  {
    id: 'pirate-yoho-dance',
    slot: 'emote',
    name: 'ЙО-ХО',
    description: 'Танец, который на суше выглядит странно.',
    rarity: 'epic',
    tags: ['pirate', 'dance'],
    unlock: { type: 'daily', streak: 21 },
    render: { kind: 'emote-pose', motion: 'yoho', duration: 2.4, glyph: '🏴' }
  },
  {
    id: 'pirate-telescope',
    slot: 'emote',
    name: 'ПОДЗОРНАЯ ТРУБА',
    description: 'Посмотреть вдаль и убедиться, что все позади.',
    rarity: 'rare',
    tags: ['pirate', 'gesture'],
    unlock: { type: 'stat', path: 'race.finishes', gte: 23 },
    render: { kind: 'emote-pose', motion: 'telescope', duration: 2, glyph: '🔭', prop: 'telescope' }
  },
  {
    id: 'pirate-cannon-finish',
    slot: 'finish',
    name: 'ЗАЛП',
    description: 'Дым, грохот и совершенно ненужный отскок.',
    rarity: 'legendary',
    tags: ['pirate', 'finish'],
    unlock: { type: 'pass' },
    render: {
      kind: 'finish-cannon',
      primary: 0x3a3f52,
      secondary: 0xffb547,
      glyph: '💥',
      duration: 2.4
    }
  },
  {
    id: 'pirate-abyssal',
    slot: 'body',
    name: 'КАПИТАН БЕЗДНЫ',
    description: 'Свет сюда не доходит, а он всё равно бежит.',
    rarity: 'mythic',
    tags: ['pirate', 'mythic'],
    unlock: { type: 'rewarded' },
    render: {
      kind: 'body-mythic',
      primary: 0x08283a,
      accent: 0x1fd6c4,
      belly: 0x0f4459,
      glow: 0x6cf7ff,
      effect: 'abyss',
      orbits: 3
    },
    performance: { simple: 'reduced', minimal: 'reduced' }
  }
];

// Коллекция проставляется здесь, а не руками у каждой записи: шестьдесят одинаковых строк —
// шестьдесят возможностей опечататься, и валидатор поймал бы это уже после того, как предмет
// пропал бы из своей коллекции.
const withCollection = (collection, items) =>
  items.map(item => Object.freeze({ ...item, collection, expansion: 'customization-2' }));

export const NEW_COSMETIC_CONTENT = Object.freeze([
  ...withCollection('space-trouble', SPACE_TROUBLE),
  ...withCollection('food-fight', FOOD_FIGHT),
  ...withCollection('neon-arcade', NEON_ARCADE),
  ...withCollection('pirate-panic', PIRATE_PANIC)
]);
