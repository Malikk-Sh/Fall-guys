// Декларативный резолвер выдачи косметики.
//
// Шестьдесят предметов — это шестьдесят условий. Записанные ветками `if (item.id === ...)`, они
// расползлись бы по клиенту и серверу двумя копиями, которые обязаны совпадать и однажды перестанут.
// Поэтому условие живёт в самом предмете (`unlock`), а здесь — единственный код, который умеет его
// прочитать. Клиент и сервер вызывают одну и ту же функцию с разными источниками статистики.

import { FUTURE_UNLOCKS, SERVER_GRANTABLE_UNLOCKS } from './cosmeticMeta.js';

const number = value => (Number.isFinite(Number(value)) ? Number(value) : 0);

// Плоская статистика, по которой считаются `stat`-условия. Пути стабильны и не зависят от того,
// пришли данные с сервера или из локального профиля гостя: у обоих источников разная форма, и
// сводить их к общей здесь — единственный способ не завести два набора путей.
export function emptyCosmeticStats() {
  return {
    race: { finishes: 0, wins: 0, podiums: 0 },
    coop: { matches: 0, chapters: 0, revives: 0, flawless: 0, ch10Runs: 0 },
    daily: { bestStreak: 0 }
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

// Серверный прогресс аккаунта → статистика косметики.
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

// Локальный профиль браузера → та же статистика. Гость не имеет серверного прогресса, но у него
// есть daily-серия и локальные кооперативные счётчики, на которых висят унаследованные награды.
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

// Лучшее из двух источников. Серверный прогресс авторитетен для выдачи, но локальный профиль
// содержит то, чего сервер не знает вовсе (daily-серия), — и терять его нельзя.
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
  return SERVER_GRANTABLE_UNLOCKS.includes(item?.unlock?.type);
}

export function isFutureUnlock(item) {
  return FUTURE_UNLOCKS.includes(item?.unlock?.type);
}

// Локальные условия — единственное, что клиенту разрешено решать самому: унаследованная daily-серия
// и локальные фолбэки старых кооперативных наград. Всё ценное новое проходит через сервер.
export function isLocalUnlock(item) {
  return item?.unlock?.type === 'daily' || Boolean(item?.unlock?.localStat);
}

/**
 * Выполнено ли условие выдачи предмета.
 *
 * @param {object} item предмет каталога
 * @param {{stats?: object, achievements?: Set<string>|string[], local?: boolean}} context
 *   `local` разрешает локальные фолбэки: клиент их учитывает, сервер — нет.
 */
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
      // Daily-серия никогда не была серверной и не должна ею притвориться: сервер её не считает,
      // поэтому вне локального контекста условие просто не выполняется.
      return local && statValue(resolved, 'daily.bestStreak') >= number(unlock.streak);
    default:
      // rewarded / event / shop / pass / admin выдаются извне. Каталог к ним готов, механики нет.
      return false;
  }
}

/**
 * Все ID, которые полагаются игроку по его данным.
 */
export function resolveUnlockedIds(catalog, context = {}) {
  const ids = [];
  for (const item of catalog) if (unlockSatisfied(item, context)) ids.push(item.id);
  return ids;
}

/**
 * Только то, что сервер вправе выдать сам. Rewarded/shop/pass сюда не попадают никогда:
 * entitlement по клиентскому «успеху» не выдаётся.
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

export function statLabel(path) {
  return STAT_LABELS[path] || path;
}

// Короткое требование для карточки. Одна функция вместо подписи, продублированной в каталоге,
// в шкафу и в экране результатов.
export function unlockRequirementText(item) {
  const unlock = item?.unlock;
  if (!unlock) return item?.detail || '';
  switch (unlock.type) {
    case 'default':
      return 'Доступно сразу';
    case 'achievement':
      return item.detail || 'За достижение';
    case 'stat':
      return `${statLabel(unlock.path)}: ${unlock.gte}`;
    case 'daily':
      return `Серия daily ${unlock.streak} ${unlock.streak === 1 ? 'день' : 'дней'}`;
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

// Прогресс к предмету: сколько есть и сколько нужно. Возвращает null там, где прогресс не
// выражается числом (достижение без локального фолбэка, будущие источники).
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
