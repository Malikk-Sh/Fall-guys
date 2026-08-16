// Декларативный резолвер выдачи косметики.
//
// Условие живёт в самом предмете (`unlock`), а здесь — единственный код, который умеет его
// прочитать. Клиент и сервер вызывают одну и ту же функцию с разными источниками статистики.

import { COLLECTION_META, FUTURE_UNLOCKS, SERVER_GRANTABLE_UNLOCKS } from './cosmeticMeta.js';

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

// `collection` заполняется из server-owned inventory для отображения milestone-прогресса. Сами
// milestone entitlement выдаёт InventoryService отдельным проходом после подсчёта ownership: это
// намеренно не часть обычного progress resolver, чтобы ownership не зависел от самого себя.
export function emptyCosmeticStats() {
  return {
    race: { finishes: 0, wins: 0, podiums: 0 },
    coop: { matches: 0, chapters: 0, revives: 0, flawless: 0, ch10Runs: 0 },
    daily: { bestStreak: 0 },
    collection: {}
  };
}

function mergeMax(target, source) {
  for (const [group, values] of Object.entries(source)) {
    if (!target[group]) target[group] = {};
    for (const [key, value] of Object.entries(values)) {
      target[group][key] = Math.max(number(target[group][key]), number(value));
    }
  }
  return target;
}

export function statsFromProgress(progress) {
  const stats = emptyCosmeticStats();
  if (!progress) return stats;
  const chapters = Array.isArray(progress.chapters) ? progress.chapters : [];
  stats.race.finishes = number(progress.race?.finishes);
  stats.race.wins = number(progress.race?.wins);
  stats.race.podiums = number(progress.race?.podiums);
  stats.coop.matches = number(progress.stats?.coopMatchesCompleted);
  stats.coop.chapters = number(progress.stats?.coopChaptersCompleted);
  stats.coop.revives = number(progress.stats?.coopRevives);
  stats.coop.flawless = chapters.reduce((sum, chapter) => sum + number(chapter?.flawless), 0);
  stats.coop.ch10Runs = chapters.some(chapter => chapter?.chapterId === 'ch10') ? 1 : 0;
  return stats;
}

export function statsFromProfile(profile) {
  const stats = emptyCosmeticStats();
  if (!profile) return stats;
  const chapterStats = profile.coop?.chapterStats || {};
  stats.coop.revives = number(profile.coop?.totalRevives);
  stats.coop.chapters = number(profile.coop?.completedChapters);
  stats.coop.flawless = Object.values(chapterStats).reduce((sum, entry) => sum + number(entry?.flawless), 0);
  stats.coop.ch10Runs = number(chapterStats.ch10?.runs) > 0 ? 1 : 0;
  stats.daily.bestStreak = number(profile.daily?.bestStreak);
  return stats;
}

export function cosmeticStats(progress = null, profile = null) {
  return mergeMax(statsFromProgress(progress), statsFromProfile(profile));
}

export function statValue(stats, path) {
  if (!stats || typeof path !== 'string') return 0;
  let cursor = stats;
  for (const key of path.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return 0;
    cursor = cursor[key];
  }
  return number(cursor);
}

export function isServerGrantable(item) {
  // Collection reward тоже описан `stat`-условием для общего UI, но выдаётся после чтения
  // account_cosmetics, а не из игрового progress. Generic resolver его намеренно не трогает.
  return !item?.collectionReward && SERVER_GRANTABLE_UNLOCKS.includes(item?.unlock?.type);
}

export function isFutureUnlock(item) {
  return FUTURE_UNLOCKS.includes(item?.unlock?.type);
}

export function isLocalUnlock(item) {
  return item?.unlock?.type === 'daily' || Boolean(item?.unlock?.localStat);
}

export function unlockSatisfied(item, { stats = null, achievements = null, local = false } = {}) {
  const unlock = item?.unlock;
  if (!unlock) return false;
  const owned = achievements instanceof Set ? achievements : new Set(achievements || []);
  const resolved = stats || emptyCosmeticStats();

  const localFallback = () => {
    if (!local || !unlock.localStat) return false;
    return statValue(resolved, unlock.localStat.path) >= number(unlock.localStat.gte);
  };

  switch (unlock.type) {
    case 'default':
      return true;
    case 'achievement':
      return owned.has(unlock.id) || localFallback();
    case 'stat':
      return statValue(resolved, unlock.path) >= number(unlock.gte) || localFallback();
    case 'daily':
      return local && statValue(resolved, 'daily.bestStreak') >= number(unlock.streak);
    default:
      return false;
  }
}

export function resolveUnlockedIds(catalog, context = {}) {
  const ids = [];
  for (const item of catalog) if (unlockSatisfied(item, context)) ids.push(item.id);
  return ids;
}

/**
 * Обычные server grants из прогресса аккаунта. Collection milestones сюда не входят, потому что
 * их вход — server inventory, а не progress; их выдаёт InventoryService после materialization.
 */
export function resolveServerGrants(catalog, { stats = null, achievements = null } = {}) {
  return catalog
    .filter(item => isServerGrantable(item) && unlockSatisfied(item, { stats, achievements }))
    .map(item => item.id);
}

const STAT_LABELS = Object.freeze({
  'race.finishes': 'Финиши в гонке',
  'race.wins': 'Победы в гонке',
  'race.podiums': 'Пьедесталы',
  'coop.matches': 'Кооперативные матчи',
  'coop.chapters': 'Пройденные главы',
  'coop.revives': 'Спасения напарника',
  'coop.flawless': 'Безупречные главы',
  'coop.ch10Runs': 'Глава 10'
});

const ACHIEVEMENT_GOALS = Object.freeze({
  'race-first-finish': 'Финишируйте в онлайн-гонке',
  'race-win': 'Одержите победу в онлайн-гонке',
  'race-veteran-25': 'Финишируйте в 25 онлайн-гонках',
  'race-podium': 'Попадите в тройку в гонке минимум с тремя соперниками',
  'coop-ch10-clear': 'Пройдите главу 10',
  'coop-flawless-5': 'Пройдите 5 глав без падений',
  'coop-helper-25': 'Спасите напарника 25 раз',
  'coop-campaign-complete': 'Пройдите все 10 глав'
});

function collectionPath(path) {
  if (typeof path !== 'string' || !path.startsWith('collection.')) return null;
  return path.slice('collection.'.length) || null;
}

export function statLabel(path) {
  const collection = collectionPath(path);
  if (collection) {
    const meta = COLLECTION_META[collection];
    return meta ? `Коллекция «${meta.shortName}»` : 'Коллекция';
  }
  return STAT_LABELS[path] || path;
}

function plural(value, one, few, many) {
  const count = Math.abs(Math.trunc(number(value)));
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

export function statGoalText(path, target) {
  const count = Math.max(1, Math.trunc(number(target)));
  const collection = collectionPath(path);
  if (collection) {
    const meta = COLLECTION_META[collection];
    const label = meta?.shortName || collection;
    return `Соберите ${count} подтверждённых ${plural(count, 'предмет', 'предмета', 'предметов')} коллекции «${label}»`;
  }

  switch (path) {
    case 'race.finishes':
      return `Финишируйте в ${count} ${plural(count, 'гонке', 'гонках', 'гонках')}`;
    case 'race.wins':
      return `Одержите ${count} ${plural(count, 'победу', 'победы', 'побед')}`;
    case 'race.podiums':
      return `Попадите на пьедестал ${count} ${plural(count, 'раз', 'раза', 'раз')}`;
    case 'coop.matches':
      return `Завершите ${count} ${plural(
        count,
        'кооперативный матч',
        'кооперативных матча',
        'кооперативных матчей'
      )}`;
    case 'coop.chapters':
      return `Пройдите ${count} ${plural(count, 'главу', 'главы', 'глав')} в кооперативе`;
    case 'coop.revives':
      return `Спасите напарника ${count} ${plural(count, 'раз', 'раза', 'раз')}`;
    case 'coop.flawless':
      return `Пройдите ${count} ${plural(count, 'главу', 'главы', 'глав')} без падений`;
    case 'coop.ch10Runs':
      return 'Пройдите главу 10';
    default:
      return `${statLabel(path)}: ${count}`;
  }
}

export function unlockRequirementText(item) {
  const unlock = item?.unlock;
  if (!unlock) return item?.detail || '';
  switch (unlock.type) {
    case 'default':
      return 'Доступно сразу';
    case 'achievement':
      return ACHIEVEMENT_GOALS[unlock.id] || item.detail || 'Получите достижение';
    case 'stat':
      return statGoalText(unlock.path, unlock.gte);
    case 'daily':
      return `Поддерживайте серию daily ${unlock.streak} ${plural(unlock.streak, 'день', 'дня', 'дней')}`;
    case 'rewarded':
      return 'Награда за просмотр · скоро';
    case 'event':
      return 'Событие · скоро';
    case 'shop':
      return 'Магазин · скоро';
    case 'pass':
      return 'Сезонный пропуск · скоро';
    case 'admin':
      return 'Выдаётся вручную';
    default:
      return item.detail || '';
  }
}

export function unlockProgress(item, stats) {
  const unlock = item?.unlock;
  if (!unlock) return null;
  if (unlock.type === 'stat') {
    return {
      label: statLabel(unlock.path),
      current: statValue(stats, unlock.path),
      target: number(unlock.gte)
    };
  }
  if (unlock.type === 'daily') {
    return {
      label: 'Серия daily',
      current: statValue(stats, 'daily.bestStreak'),
      target: number(unlock.streak)
    };
  }
  if (unlock.type === 'achievement' && unlock.localStat) {
    return {
      label: statLabel(unlock.localStat.path),
      current: statValue(stats, unlock.localStat.path),
      target: number(unlock.localStat.gte)
    };
  }
  return null;
}
