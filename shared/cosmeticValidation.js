// Проверка каталога косметики.
//
// Каталог — это данные, а данные ошибаются молча: опечатка в слоте превращает предмет в невидимку,
// дубликат ID тихо перекрывает соседа, неизвестный render kind даёт пустое место на персонаже.
// Ни одно из этих последствий не выглядит как ошибка — поэтому проверка выделена отдельно и
// вызывается тестами, а не надеется на то, что кто-то заметит.

import {
  ALL_COSMETIC_SLOTS,
  COLLECTION_META,
  EMOTE_SLOT,
  RARITY_META,
  UNLOCK_TYPES
} from './cosmeticMeta.js';

// Объявленные render kinds. Реализация живёт в клиенте (client/game/cosmetics), но САМ СПИСОК —
// часть контракта данных: каталог не имеет права ссылаться на то, чего в контракте нет, а тест
// клиента проверяет, что реестр рендерера покрывает список целиком.
export const RENDER_KINDS = Object.freeze([
  // тело
  'body-suit',
  'body-plated',
  'body-creature',
  'body-glow',
  'body-mythic',
  // голова
  'head-antenna',
  'head-dish',
  'head-crown',
  'head-fin',
  'head-hat',
  'head-horns',
  'head-perch',
  // лицо
  'face-plate',
  'face-shades',
  'face-eyes',
  'face-patch',
  'face-scan',
  'face-nebula',
  // спина
  'back-tanks',
  'back-crate',
  'back-barrel',
  // след
  'particle-trail',
  'jet-trail',
  'ghost-trail',
  // финиш
  'finish-glyph',
  'finish-portal',
  'finish-burst',
  'finish-cannon',
  // эмоции
  'emote-pose'
]);

const RENDER_KIND_SET = new Set(RENDER_KINDS);

// Какие render kinds допустимы в каком слоте. Это ловит самую вероятную ошибку копипасты — предмет
// со слотом `back` и рендером короны, — которую иначе видно только глазами в игре.
const SLOT_RENDER_PREFIX = Object.freeze({
  body: ['body-'],
  visor: ['face-'],
  antenna: ['head-'],
  back: ['back-'],
  trail: ['particle-trail', 'jet-trail', 'ghost-trail'],
  finish: ['finish-'],
  [EMOTE_SLOT]: ['emote-']
});

function renderKindFitsSlot(slot, kind) {
  const allowed = SLOT_RENDER_PREFIX[slot];
  if (!allowed) return false;
  return allowed.some(prefix => (prefix.endsWith('-') ? kind.startsWith(prefix) : kind === prefix));
}

/**
 * Проверяет каталог целиком и возвращает список текстовых проблем. Пустой список — каталог здоров.
 */
export function validateCosmeticCatalog(catalog) {
  const problems = [];
  const seen = new Set();
  let defaultBodies = 0;

  for (const item of catalog) {
    const where = item?.id ? `«${item.id}»` : '<без id>';

    if (typeof item?.id !== 'string' || !item.id) {
      problems.push('Предмет без строкового id');
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id)) {
      problems.push(`${where}: id должен быть kebab-case`);
    }
    if (seen.has(item.id)) problems.push(`${where}: дубликат id`);
    seen.add(item.id);

    if (!ALL_COSMETIC_SLOTS.includes(item.slot)) {
      problems.push(`${where}: неизвестный слот «${item.slot}»`);
    }
    if (!RARITY_META[item.rarity]) problems.push(`${where}: неизвестная редкость «${item.rarity}»`);
    if (item.collection != null && !COLLECTION_META[item.collection]) {
      problems.push(`${where}: неизвестная коллекция «${item.collection}»`);
    }
    if (typeof item.name !== 'string' || !item.name) problems.push(`${where}: пустое имя`);

    const kind = item.render?.kind;
    if (!RENDER_KIND_SET.has(kind)) problems.push(`${where}: неизвестный render kind «${kind}»`);
    else if (!renderKindFitsSlot(item.slot, kind)) {
      problems.push(`${where}: render kind «${kind}» не подходит слоту «${item.slot}»`);
    }

    const unlock = item.unlock;
    if (!unlock || !UNLOCK_TYPES.includes(unlock.type)) {
      problems.push(`${where}: неизвестный unlock.type «${unlock?.type}»`);
    } else if (unlock.type === 'stat') {
      if (typeof unlock.path !== 'string' || !unlock.path) {
        problems.push(`${where}: stat-unlock без path`);
      }
      if (!Number.isFinite(unlock.gte) || unlock.gte <= 0) {
        problems.push(`${where}: stat-unlock требует положительный gte`);
      }
    } else if (unlock.type === 'achievement' && (typeof unlock.id !== 'string' || !unlock.id)) {
      problems.push(`${where}: achievement-unlock без id`);
    } else if (unlock.type === 'daily' && !Number.isFinite(unlock.streak)) {
      problems.push(`${where}: daily-unlock требует числовой streak`);
    }

    for (const level of ['simple', 'minimal']) {
      const mode = item.performance?.[level];
      if (mode && !['full', 'reduced', 'hidden'].includes(mode)) {
        problems.push(`${where}: performance.${level} = «${mode}» вне full/reduced/hidden`);
      }
    }

    if (item.rarity === 'prestige' && (item.purchasable || item.rewardable)) {
      problems.push(`${where}: prestige не может продаваться или выдаваться за рекламу`);
    }

    if (item.slot === 'body' && item.unlock?.type === 'default') defaultBodies++;
  }

  // Инвариант тела: ровно один body выдаётся по умолчанию. Ноль — новый игрок появляется без
  // корпуса; два — какой именно достанется, зависит от порядка в массиве.
  if (defaultBodies !== 1) problems.push(`Ровно один body должен быть default, найдено ${defaultBodies}`);

  return problems;
}

export function assertCosmeticCatalog(catalog) {
  const problems = validateCosmeticCatalog(catalog);
  if (problems.length) throw new Error(`Каталог косметики некорректен:\n- ${problems.join('\n- ')}`);
  return true;
}
