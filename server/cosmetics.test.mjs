import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLoadout,
  cosmeticLoadout,
  cosmeticLoadoutFromIds,
  equipCosmetic,
  equipEmote,
  nextCosmeticGoal,
  randomLoadout,
  readCosmetics,
  readEmoteLoadout,
  setServerCosmeticEquipHandler,
  setServerEmoteEquipHandler,
  unequipCosmetic,
  unlockedCosmetics,
  wardrobeCollections,
  wardrobeItems
} from '../client/core/cosmetics.js';
import { readFavorites, resetFavoritesFallback, toggleFavorite } from '../client/core/cosmeticFavorites.js';
import { COSMETIC_BY_ID } from '../shared/cosmetics.js';

const memory = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
};

// Хранилище, которое всегда отказывает: приватный режим, переполненная квота, отключённый storage.
const brokenStorage = () => ({
  getItem() {
    throw new Error('storage disabled');
  },
  setItem() {
    throw new Error('storage disabled');
  }
});

const EMPTY_PROFILE = { daily: { bestStreak: 0 }, coop: { chapterStats: {}, totalRevives: 0 } };

test('cosmetics unlock from play achievements without currency', () => {
  const progress = {
    stats: { coopRevives: 25 },
    chapters: [{ chapterId: 'ch10', flawless: 5 }],
    achievements: [
      { id: 'coop-ch10-clear' },
      { id: 'coop-flawless-5' },
      { id: 'coop-helper-25' },
      { id: 'coop-campaign-complete' }
    ]
  };
  const profile = { daily: { bestStreak: 7 }, coop: { chapterStats: {}, totalRevives: 0 } };
  const ids = unlockedCosmetics(progress, profile).map(item => item.id);
  assert.deepEqual(ids, [
    'classic',
    'sky-hero',
    'clear-visor',
    'rescue-antenna',
    'sunrise-trail',
    'campaign-finish',
    // Новый контент открывается сервером, и единственное исключение — daily-серия: её сервер не
    // считает вовсе, поэтому она осталась там же, где была, — в браузере.
    'space-moonwalk',
    'food-sprinkle-trail',
    'pirate-barrel-pack'
  ]);
});

test('новый контент не выдаётся клиентом без серверного инвентаря', () => {
  // Статистика, которой хватило бы на добрую половину каталога, — но подтвердить её некому.
  const progress = {
    stats: { coopRevives: 99, coopChaptersCompleted: 10, coopMatchesCompleted: 40 },
    chapters: [{ chapterId: 'ch10', flawless: 9 }],
    achievements: [{ id: 'race-win' }, { id: 'race-veteran-25' }],
    race: { finishes: 120, wins: 40, podiums: 60 }
  };
  const ids = new Set(unlockedCosmetics(progress, EMPTY_PROFILE).map(item => item.id));
  for (const id of ['space-astronaut', 'pirate-kraken-kid', 'neon-synthwave', 'space-portal-finish']) {
    assert.equal(ids.has(id), false, `${id} не выдаёт себе клиент`);
  }
  // Унаследованные награды за те же достижения продолжают работать: у них так было всегда.
  assert.equal(ids.has('champion-visor'), true);
  assert.equal(ids.has('veteran-antenna'), true);
});

test('серверный инвентарь — источник правды по владению', () => {
  const inventory = { ownedIds: ['classic', 'space-astronaut', 'space-oxygen-pack'], equipped: {} };
  const ids = new Set(unlockedCosmetics(null, EMPTY_PROFILE, inventory).map(item => item.id));
  assert.equal(ids.has('space-astronaut'), true);
  assert.equal(ids.has('space-oxygen-pack'), true);
  assert.equal(ids.has('space-alien'), false);
  // Достижение без серверной выдачи больше не открывает предмет: список владения авторитетен.
  assert.equal(ids.has('sky-hero'), false);
});

test('locked reward cannot be equipped and unlocked loadout persists', () => {
  const storage = memory();
  equipCosmetic('sky-hero', null, EMPTY_PROFILE, storage);
  assert.equal(cosmeticLoadout(null, EMPTY_PROFILE, storage).body.id, 'classic');

  const earned = {
    daily: { bestStreak: 0 },
    coop: { chapterStats: { ch10: { runs: 1 } }, totalRevives: 0 }
  };
  equipCosmetic('sky-hero', null, earned, storage);
  assert.equal(cosmeticLoadout(null, earned, storage).body.id, 'sky-hero');
});

test('remote loadout resolves only canonical IDs and refuses cross-slot injection', () => {
  const safe = cosmeticLoadoutFromIds({
    body: 'sky-hero',
    visor: 'neon-visor',
    antenna: 'party-antenna',
    back: 'space-oxygen-pack',
    trail: null,
    finish: null
  });
  assert.equal(safe.body.id, 'sky-hero');
  assert.equal(safe.visor.id, 'neon-visor');
  assert.equal(safe.antenna.id, 'party-antenna');
  assert.equal(safe.back.id, 'space-oxygen-pack');

  const hostile = cosmeticLoadoutFromIds({
    body: 'neon-visor',
    visor: 'sky-hero',
    antenna: '<script>alert(1)</script>',
    back: 'space-star-crown',
    trail: 'party-antenna',
    finish: 'classic'
  });
  assert.equal(hostile.body.id, 'classic');
  assert.equal(hostile.visor, null);
  assert.equal(hostile.antenna, null);
  assert.equal(hostile.back, null);
  assert.equal(hostile.trail, null);
  assert.equal(hostile.finish, null);

  // Ни один разрешённый предмет не отдаёт наружу материал или цвет как данные payload: наружу
  // уходит запись каталога, а её содержимое задано локально и одинаково у всех клиентов.
  assert.equal(hostile.body, COSMETIC_BY_ID.classic);
});

test('старый payload без слота back остаётся валидным', () => {
  const safe = cosmeticLoadoutFromIds({
    body: 'racer-body',
    visor: 'champion-visor',
    antenna: 'veteran-antenna',
    trail: 'podium-trail',
    finish: 'champion-finish'
  });
  assert.equal(safe.body.id, 'racer-body');
  assert.equal(safe.back, null);
});

test('next reward reports concrete progress', () => {
  const progress = { stats: { coopRevives: 12 }, chapters: [], achievements: [{ id: 'coop-ch10-clear' }] };
  const profile = { daily: { bestStreak: 2 }, coop: { chapterStats: {}, totalRevives: 12 } };
  assert.deepEqual(nextCosmeticGoal(progress, profile), {
    id: 'clear-visor',
    label: 'Безупречные главы',
    current: 0,
    target: 5
  });
});

// ── Шкаф ────────────────────────────────────────────────────────────────────────────────────

test('слот back надевается и снимается, тело снять нельзя', () => {
  const storage = memory();
  const inventory = { ownedIds: ['classic', 'space-oxygen-pack'], equipped: {} };
  const equipped = equipCosmetic('space-oxygen-pack', null, null, storage, inventory);
  assert.equal(equipped.back, 'space-oxygen-pack');

  assert.equal(unequipCosmetic('back', null, null, storage, inventory).back, null);
  assert.equal(unequipCosmetic('body', null, null, storage, inventory).body, 'classic');
});

test('equip сообщает серверу слот и ID, а локальную награду — нет', () => {
  const storage = memory();
  const calls = [];
  setServerCosmeticEquipHandler((slot, id) => calls.push([slot, id]));
  const inventory = { ownedIds: ['classic', 'space-astronaut'], equipped: {} };
  const profile = { daily: { bestStreak: 7 }, coop: { chapterStats: {}, totalRevives: 0 } };

  equipCosmetic('space-astronaut', null, profile, storage, inventory);
  equipCosmetic('sunrise-trail', null, profile, storage, inventory);
  assert.deepEqual(calls, [['body', 'space-astronaut']], 'daily-награда остаётся локальной');
  setServerCosmeticEquipHandler(null);
});

test('превью не меняет надетое: wardrobeItems только читает', () => {
  const storage = memory();
  const inventory = { ownedIds: ['classic', 'space-astronaut'], equipped: {} };
  const before = readCosmetics(null, null, storage, inventory);
  const items = wardrobeItems({ storage, inventory });
  const locked = items.find(entry => entry.id === 'pirate-kraken-kid');
  assert.equal(locked.owned, false);
  assert.equal(locked.equipped, false);
  assert.equal(typeof locked.requirement, 'string');
  assert.ok(locked.requirement.length > 0, 'у закрытого предмета видно требование');
  assert.deepEqual(readCosmetics(null, null, storage, inventory), before);
});

test('закрытый предмет невозможно надеть даже напрямую', () => {
  const storage = memory();
  const inventory = { ownedIds: ['classic'], equipped: {} };
  const equipped = equipCosmetic('space-void', null, null, storage, inventory);
  assert.equal(equipped.body, 'classic');
  assert.equal(
    applyLoadout({ body: 'space-void', back: 'pirate-barrel-pack' }, null, null, storage, inventory).body,
    'classic'
  );
});

test('прогресс по коллекциям считается по владению и не даёт бонусов', () => {
  const inventory = {
    ownedIds: ['classic', ...Array.from({ length: 15 }, () => null).filter(Boolean)],
    equipped: {}
  };
  const empty = wardrobeCollections(null, null, inventory);
  assert.equal(empty.length, 4);
  assert.deepEqual(
    empty.map(entry => entry.owned),
    [0, 0, 0, 0]
  );

  const spaceIds = [
    'space-astronaut',
    'space-alien',
    'space-retro-robot',
    'space-moon-cat',
    'space-satellite-dish',
    'space-star-crown',
    'space-rocket-fin',
    'space-nebula-visor',
    'space-alien-eyes',
    'space-oxygen-pack',
    'space-stardust-trail',
    'space-rocket-trail',
    'space-moonwalk',
    'space-portal-finish',
    'space-void'
  ];
  const full = wardrobeCollections(null, null, { ownedIds: ['classic', ...spaceIds], equipped: {} });
  const space = full.find(entry => entry.id === 'space-trouble');
  assert.equal(space.owned, 15);
  assert.equal(space.percent, 100);
  assert.equal(space.complete, true);
});

test('случайный образ берёт только полученное и всегда оставляет валидное тело', () => {
  const inventory = {
    ownedIds: ['classic', 'space-astronaut', 'space-star-crown', 'space-oxygen-pack'],
    equipped: {}
  };
  let counter = 0;
  // Детерминированный «случай»: тест проверяет правила выбора, а не распределение.
  const random = () => (counter++ * 0.37) % 1;
  for (let attempt = 0; attempt < 20; attempt++) {
    const loadout = randomLoadout({ inventory, random });
    assert.ok(['classic', 'space-astronaut'].includes(loadout.body));
    for (const [slot, id] of Object.entries(loadout)) {
      if (!id) continue;
      assert.ok(inventory.ownedIds.includes(id), `${id} получен`);
      assert.equal(COSMETIC_BY_ID[id].slot, slot);
    }
  }
});

// ── Эмоции ──────────────────────────────────────────────────────────────────────────────────

test('эмоции: четыре ячейки, только полученные, без дубликатов', () => {
  const storage = memory();
  const inventory = { ownedIds: ['classic', 'food-chefs-kiss', 'neon-robot-dance'], equipped: {} };
  assert.deepEqual(readEmoteLoadout(null, null, storage, inventory), [null, null, null, null]);

  assert.deepEqual(equipEmote(0, 'food-chefs-kiss', null, null, storage, inventory), [
    'food-chefs-kiss',
    null,
    null,
    null
  ]);
  assert.deepEqual(equipEmote(2, 'food-chefs-kiss', null, null, storage, inventory), [
    null,
    null,
    'food-chefs-kiss',
    null
  ]);
  // Не полученная эмоция и не-эмоция ячейку не занимают.
  assert.deepEqual(equipEmote(1, 'space-moonwalk', null, null, storage, inventory), [
    null,
    null,
    'food-chefs-kiss',
    null
  ]);
  assert.deepEqual(equipEmote(1, 'space-star-crown', null, null, storage, inventory), [
    null,
    null,
    'food-chefs-kiss',
    null
  ]);
  assert.deepEqual(equipEmote(7, 'neon-robot-dance', null, null, storage, inventory), [
    null,
    null,
    'food-chefs-kiss',
    null
  ]);
  assert.deepEqual(equipEmote(2, null, null, null, storage, inventory), [null, null, null, null]);
});

test('выбор эмоции уходит на сервер позицией и ID', () => {
  const storage = memory();
  const calls = [];
  setServerEmoteEquipHandler((position, id) => calls.push([position, id]));
  const inventory = { ownedIds: ['classic', 'pirate-yoho-dance'], equipped: {} };
  equipEmote(3, 'pirate-yoho-dance', null, null, storage, inventory);
  assert.deepEqual(calls, [[3, 'pirate-yoho-dance']]);
  setServerEmoteEquipHandler(null);
});

// ── Избранное и отказ хранилища ─────────────────────────────────────────────────────────────

test('избранное переключается и хранит только известные ID', () => {
  resetFavoritesFallback();
  const storage = memory();
  assert.deepEqual([...readFavorites(storage)], []);
  toggleFavorite('space-void', storage);
  toggleFavorite('definitely-not-a-cosmetic', storage);
  assert.deepEqual([...readFavorites(storage)], ['space-void']);
  toggleFavorite('space-void', storage);
  assert.deepEqual([...readFavorites(storage)], []);
});

test('недоступное хранилище не ломает шкаф', () => {
  resetFavoritesFallback();
  const storage = brokenStorage();
  const inventory = { ownedIds: ['classic', 'space-astronaut'], equipped: {} };

  // Чтение образа не падает и возвращает валидный образ.
  const equipped = readCosmetics(null, null, storage, inventory);
  assert.equal(equipped.body, 'classic');
  // Надеть можно: изменение живёт в текущей сессии, даже если записать его некуда.
  assert.equal(equipCosmetic('space-astronaut', null, null, storage, inventory).body, 'space-astronaut');
  // Карточки строятся, избранное работает через память вкладки.
  assert.equal(wardrobeItems({ storage, inventory }).length > 60, true);
  assert.deepEqual([...toggleFavorite('space-astronaut', storage)], ['space-astronaut']);
  resetFavoritesFallback();
});
