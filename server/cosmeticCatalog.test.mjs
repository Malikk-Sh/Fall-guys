import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTIONS,
  COSMETIC_BY_ID,
  COSMETIC_CATALOG,
  COSMETIC_SLOTS,
  DEFAULT_COSMETIC_LOADOUT,
  EMOTE_LOADOUT_SIZE,
  NEW_COSMETIC_IDS,
  cosmeticDetailMode,
  cosmeticsInCollection,
  publicEmoteLoadout
} from '../shared/cosmetics.js';
import { RARITY_META, SLOT_META } from '../shared/cosmeticMeta.js';
import { RENDER_KINDS, validateCosmeticCatalog } from '../shared/cosmeticValidation.js';
import { RENDER_KIND_BUILDERS } from '../client/game/cosmetics/AccessoryFactory.js';
import {
  cosmeticStats,
  isServerGrantable,
  resolveServerGrants,
  statValue,
  unlockRequirementText,
  unlockSatisfied
} from '../shared/cosmeticUnlocks.js';

const newItems = () => NEW_COSMETIC_IDS.map(id => COSMETIC_BY_ID[id]);
const countBy = (items, key) =>
  items.reduce((totals, item) => {
    const value = typeof key === 'function' ? key(item) : item[key];
    totals[value] = (totals[value] || 0) + 1;
    return totals;
  }, {});

test('каталог проходит валидацию целиком', () => {
  assert.deepEqual(validateCosmeticCatalog(COSMETIC_CATALOG), []);
});

test('валидатор ловит дубликаты, чужие слоты, редкости и коллекции', () => {
  const base = COSMETIC_BY_ID['space-astronaut'];
  const problems = validateCosmeticCatalog([
    COSMETIC_BY_ID.classic,
    base,
    { ...base },
    { ...base, id: 'Space_Astronaut2' },
    { ...base, id: 'bad-slot', slot: 'cape' },
    { ...base, id: 'bad-rarity', rarity: 'ultra' },
    { ...base, id: 'bad-collection', collection: 'nope' },
    { ...base, id: 'bad-render', render: { kind: 'not-a-kind' } },
    { ...base, id: 'crossed-render', slot: 'back', render: { kind: 'head-crown' } },
    { ...base, id: 'bad-unlock', unlock: { type: 'vibes' } },
    { ...base, id: 'bad-stat', unlock: { type: 'stat', path: '', gte: 0 } },
    { ...base, id: 'bad-perf', performance: { minimal: 'maybe' } }
  ]);
  const joined = problems.join('\n');
  for (const expected of [
    'дубликат id',
    'kebab-case',
    'неизвестный слот',
    'неизвестная редкость',
    'неизвестная коллекция',
    'неизвестный render kind',
    'не подходит слоту',
    'неизвестный unlock.type',
    'stat-unlock без path',
    'performance.minimal'
  ]) {
    assert.ok(joined.includes(expected), `валидатор сообщает про «${expected}»`);
  }
});

test('инвариант тела: ровно один body выдаётся по умолчанию', () => {
  const defaults = COSMETIC_CATALOG.filter(item => item.slot === 'body' && item.unlock.type === 'default');
  assert.deepEqual(
    defaults.map(item => item.id),
    ['classic']
  );
  assert.equal(DEFAULT_COSMETIC_LOADOUT.body, 'classic');
  assert.deepEqual(
    validateCosmeticCatalog(COSMETIC_CATALOG.filter(item => item.id !== 'classic')).at(-1),
    'Ровно один body должен быть default, найдено 0'
  );
});

test('добавлено ровно 60 новых предметов с уникальными ID', () => {
  assert.equal(NEW_COSMETIC_IDS.length, 60);
  assert.equal(new Set(NEW_COSMETIC_IDS).size, 60);
  assert.equal(new Set(COSMETIC_CATALOG.map(item => item.id)).size, COSMETIC_CATALOG.length);
});

test('четыре коллекции по пятнадцать предметов', () => {
  assert.deepEqual(
    COLLECTIONS.map(collection => collection.id),
    ['space-trouble', 'food-fight', 'neon-arcade', 'pirate-panic']
  );
  for (const collection of COLLECTIONS) {
    assert.equal(cosmeticsInCollection(collection.id).length, 15, `${collection.id} содержит 15 предметов`);
  }
  assert.deepEqual(countBy(newItems(), 'collection'), {
    'space-trouble': 15,
    'food-fight': 15,
    'neon-arcade': 15,
    'pirate-panic': 15
  });
});

test('распределение новых предметов по категориям совпадает с планом контента', () => {
  const items = newItems();
  const slots = countBy(items, 'slot');
  const ordinaryBody = items.filter(item => item.slot === 'body' && item.rarity !== 'mythic').length;
  const mythicBody = items.filter(item => item.slot === 'body' && item.rarity === 'mythic').length;

  assert.deepEqual(
    { ordinaryBody, mythicBody },
    { ordinaryBody: 16, mythicBody: 3 },
    'шестнадцать обычных корпусов и ровно три мифических'
  );
  assert.deepEqual(
    {
      antenna: slots.antenna,
      visor: slots.visor,
      back: slots.back,
      trail: slots.trail,
      emote: slots.emote,
      finish: slots.finish
    },
    { antenna: 10, visor: 6, back: 6, trail: 8, emote: 6, finish: 5 }
  );
  assert.equal(ordinaryBody + mythicBody + 10 + 6 + 6 + 8 + 6 + 5, 60);
});

test('ровно три мифических предмета, и у каждого есть дешёвый вариант', () => {
  const mythic = COSMETIC_CATALOG.filter(item => item.rarity === 'mythic');
  assert.deepEqual(
    mythic.map(item => item.id),
    ['space-void', 'neon-gl1tch', 'pirate-abyssal']
  );
  for (const item of mythic) {
    assert.notEqual(cosmeticDetailMode(item, 'simple'), 'full', `${item.id} упрощается на среднем качестве`);
    assert.notEqual(cosmeticDetailMode(item, 'minimal'), 'full', `${item.id} упрощается на низком`);
  }
});

test('каждый слот и каждая редкость каталога описаны метаданными', () => {
  for (const item of COSMETIC_CATALOG) {
    assert.ok(SLOT_META[item.slot], `${item.id}: слот описан`);
    assert.ok(RARITY_META[item.rarity], `${item.id}: редкость описана`);
    assert.ok(item.name && item.name.length > 0);
    assert.ok(unlockRequirementText(item).length > 0, `${item.id}: требование сформулировано`);
  }
});

test('редкость различима не только цветом', () => {
  for (const meta of Object.values(RARITY_META)) {
    assert.ok(meta.label.length > 0, 'есть словесная метка');
    assert.ok(meta.icon.length > 0, 'есть значок');
    assert.ok(meta.short.length > 0, 'есть короткая метка');
  }
});

test('реестр рендерера покрывает все объявленные render kinds и ничего лишнего', () => {
  assert.deepEqual(Object.keys(RENDER_KIND_BUILDERS).sort(), [...RENDER_KINDS].sort());
  for (const item of COSMETIC_CATALOG) {
    assert.ok(
      typeof RENDER_KIND_BUILDERS[item.render.kind] === 'function',
      `${item.id}: render kind «${item.render.kind}» реализован`
    );
  }
});

test('унаследованные предметы сохранили ID, слоты и старые поля', () => {
  const legacy = {
    classic: 'body',
    'sky-hero': 'body',
    'clear-visor': 'visor',
    'rescue-antenna': 'antenna',
    'neon-visor': 'visor',
    'party-antenna': 'antenna',
    'sunrise-trail': 'trail',
    'campaign-finish': 'finish',
    'racer-body': 'body',
    'champion-visor': 'visor',
    'veteran-antenna': 'antenna',
    'podium-trail': 'trail',
    'streak-trail': 'trail',
    'champion-finish': 'finish'
  };
  for (const [id, slot] of Object.entries(legacy)) {
    const item = COSMETIC_BY_ID[id];
    assert.ok(item, `${id} не удалён из каталога`);
    assert.equal(item.slot, slot, `${id} остался в своём слоте`);
  }
  // Старые поля продолжают читаться: код, написанный до этой системы, ничего не заметил.
  assert.deepEqual(COSMETIC_BY_ID.classic.colors, { body: 0xff4f91, accent: 0xffde59 });
  assert.equal(COSMETIC_BY_ID['clear-visor'].color, 0xffd7fb);
  assert.equal(COSMETIC_BY_ID['campaign-finish'].glyph, '♛');
  assert.equal(COSMETIC_BY_ID['sunrise-trail'].localGoal, 'daily-7');
  assert.equal(COSMETIC_BY_ID['neon-visor'].rewardable, true);
  assert.equal(COSMETIC_BY_ID['sky-hero'].achievement, 'coop-ch10-clear');
});

test('слоты каталога: back добавлен, emote вынесен из носимых', () => {
  assert.deepEqual([...COSMETIC_SLOTS], ['body', 'visor', 'antenna', 'back', 'trail', 'finish']);
  assert.equal(EMOTE_LOADOUT_SIZE, 4);
  assert.deepEqual(publicEmoteLoadout(['space-moonwalk', 'classic', null, 'space-moonwalk']), [
    'space-moonwalk',
    null,
    null,
    null
  ]);
});

test('декларативный резолвер: stat-условие считается по путям статистики', () => {
  const stats = cosmeticStats(
    { race: { finishes: 12, wins: 2, podiums: 1 }, stats: { coopRevives: 6 }, chapters: [] },
    { daily: { bestStreak: 9 }, coop: { chapterStats: {}, totalRevives: 0 } }
  );
  assert.equal(statValue(stats, 'race.finishes'), 12);
  assert.equal(statValue(stats, 'daily.bestStreak'), 9);
  assert.equal(statValue(stats, 'nope.nothing'), 0);

  assert.equal(unlockSatisfied(COSMETIC_BY_ID['space-stardust-trail'], { stats }), true, 'finishes 12 ≥ 10');
  assert.equal(unlockSatisfied(COSMETIC_BY_ID['space-rocket-trail'], { stats }), false, 'finishes 12 < 40');
  assert.equal(
    unlockSatisfied(COSMETIC_BY_ID['space-moonwalk'], { stats }),
    false,
    'daily без локального контекста не выполняется'
  );
  assert.equal(unlockSatisfied(COSMETIC_BY_ID['space-moonwalk'], { stats, local: true }), true);
});

test('rewarded/shop/pass/event существуют в каталоге, но сервер их не выдаёт', () => {
  const future = COSMETIC_CATALOG.filter(item =>
    ['rewarded', 'event', 'shop', 'pass'].includes(item.unlock.type)
  );
  assert.ok(future.length >= 5, 'каталог готов к будущим источникам выдачи');
  for (const item of future) assert.equal(isServerGrantable(item), false);

  // Даже с невероятной статистикой и всеми достижениями сервер не выдаёт ни одного из них.
  const generous = cosmeticStats({
    race: { finishes: 9999, wins: 9999, podiums: 9999 },
    stats: { coopRevives: 9999, coopChaptersCompleted: 9999, coopMatchesCompleted: 9999 },
    chapters: [{ chapterId: 'ch10', flawless: 9999 }]
  });
  const granted = new Set(
    resolveServerGrants(COSMETIC_CATALOG, {
      stats: generous,
      achievements: new Set(COSMETIC_CATALOG.map(item => item.unlock.id).filter(Boolean))
    })
  );
  for (const item of future) assert.equal(granted.has(item.id), false, `${item.id} не выдан`);
  // Зато всё, что объявлено серверным, выдаётся — иначе половина каталога была бы недостижима.
  const grantable = COSMETIC_CATALOG.filter(isServerGrantable);
  for (const item of grantable) assert.equal(granted.has(item.id), true, `${item.id} достижим`);
});

test('prestige поддержан архитектурно и не продаётся', () => {
  assert.ok(RARITY_META.prestige, 'класс существует');
  assert.equal(RARITY_META.prestige.purchasable, false);
  assert.equal(RARITY_META.prestige.rewardable, false);
  // Проверяем на гипотетическом предмете: своих prestige-предметов среди новых шестидесяти нет.
  const problems = validateCosmeticCatalog([
    COSMETIC_BY_ID.classic,
    {
      ...COSMETIC_BY_ID['space-star-crown'],
      id: 'future-champion-crown',
      rarity: 'prestige',
      purchasable: true
    }
  ]);
  assert.ok(problems.some(problem => problem.includes('prestige не может продаваться')));
});
