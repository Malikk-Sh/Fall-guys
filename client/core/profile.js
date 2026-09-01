const PROFILE_KEY = 'wobble-profile-v1';

export function emptyProfile() {
  return {
    version: 1,
    playerId: null,
    completedRuns: 0,
    completedObjectives: 0,
    flawlessRuns: 0,
    daily: { lastDay: null, streak: 0, bestStreak: 0, completedDays: 0 },
    // Presentation-only снимок результата цели последнего валидного daily. Он не участвует ни в
    // streak, ни в entitlement: карточке нужно лишь честно помнить, выполнена ли сегодняшняя цель.
    dailyObjective: { dayKey: null, id: null, complete: false },
    coop: {
      completedChapters: 0,
      totalRevives: 0,
      bestByChapter: {},
      chapterStats: {},
      recordedMatches: []
    }
  };
}

export function readProfile(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PROFILE_KEY) || 'null');
    if (!parsed || parsed.version !== 1) return emptyProfile();
    const base = emptyProfile();
    return {
      ...base,
      playerId: safePlayerId(parsed.playerId),
      completedRuns: safeCount(parsed.completedRuns),
      completedObjectives: safeCount(parsed.completedObjectives),
      flawlessRuns: safeCount(parsed.flawlessRuns),
      daily: {
        ...base.daily,
        lastDay: typeof parsed.daily?.lastDay === 'string' ? parsed.daily.lastDay : null,
        streak: safeCount(parsed.daily?.streak),
        bestStreak: safeCount(parsed.daily?.bestStreak),
        completedDays: safeCount(parsed.daily?.completedDays)
      },
      dailyObjective: {
        dayKey: typeof parsed.dailyObjective?.dayKey === 'string' ? parsed.dailyObjective.dayKey : null,
        id: typeof parsed.dailyObjective?.id === 'string' ? parsed.dailyObjective.id : null,
        complete: parsed.dailyObjective?.complete === true
      },
      coop: {
        completedChapters: safeCount(parsed.coop?.completedChapters),
        totalRevives: safeCount(parsed.coop?.totalRevives),
        bestByChapter: safeChapterBests(parsed.coop?.bestByChapter),
        chapterStats: safeChapterStats(parsed.coop?.chapterStats),
        recordedMatches: Array.isArray(parsed.coop?.recordedMatches)
          ? parsed.coop.recordedMatches.filter(id => typeof id === 'string').slice(-32)
          : []
      }
    };
  } catch {
    return emptyProfile();
  }
}

export function recordCoopProfile(
  chapter,
  { time, revives = 0, unranked = null, matchId = null } = {},
  storage = globalThis.localStorage
) {
  const profile = readProfile(storage);
  if (matchId && profile.coop.recordedMatches.includes(matchId)) return profile;
  profile.coop.completedChapters++;
  profile.coop.totalRevives += safeCount(revives);
  const chapterId = chapter?.chapterId;
  if (chapterId) {
    const stats = profile.coop.chapterStats[chapterId] || { runs: 0, revives: 0, flawless: 0 };
    stats.runs++;
    stats.revives += safeCount(revives);
    if (!unranked && safeCount(revives) === 0) stats.flawless++;
    profile.coop.chapterStats[chapterId] = stats;
  }
  if (chapterId && !unranked && Number.isFinite(time) && time > 0) {
    const previous = profile.coop.bestByChapter[chapterId];
    if (!Number.isFinite(previous) || time < previous)
      profile.coop.bestByChapter[chapterId] = Math.round(time);
  }
  if (matchId) profile.coop.recordedMatches.push(matchId);
  writeProfile(profile, storage);
  return profile;
}

export function recordSoloProfile(
  spec,
  { objectives = [], unranked = null, respawns = null } = {},
  storage = globalThis.localStorage
) {
  const profile = readProfile(storage);
  profile.completedRuns++;
  const completed = objectives.filter(goal => goal?.complete).length;
  profile.completedObjectives += completed;

  // Безупречный забег — это забег без единого возвращения, и только. Раньше он засчитывался по
  // выполненной цели `no-falls`, а такая цель бывает лишь у испытания дня: обычный забег без
  // падений в счётчик не попадал вовсе, а с пулом целей перестали бы попадать и те дни, когда
  // задача дня другая. Считаем по факту, а не по формулировке задания.
  if (respawns === null) {
    if (objectives.some(goal => goal?.id === 'no-falls' && goal.complete)) profile.flawlessRuns++;
  } else if (respawns === 0) {
    profile.flawlessRuns++;
  }

  if (spec?.challenge === 'daily' && spec.dayKey && !unranked) {
    const expectedObjectiveId = spec.objectives?.[0]?.id;
    const objective = objectives.find(goal => goal?.id === expectedObjectiveId);
    if (expectedObjectiveId && objective) {
      const sameObjective =
        profile.dailyObjective.dayKey === spec.dayKey && profile.dailyObjective.id === expectedObjectiveId;
      profile.dailyObjective = {
        dayKey: spec.dayKey,
        id: expectedObjectiveId,
        // Успех за день липкий: повторный неудачный забег не должен стирать уже выполненную цель.
        complete: Boolean(objective.complete || (sameObjective && profile.dailyObjective.complete))
      };
    }

    if (profile.daily.lastDay !== spec.dayKey) {
      profile.daily.streak = isPreviousDay(profile.daily.lastDay, spec.dayKey) ? profile.daily.streak + 1 : 1;
      profile.daily.lastDay = spec.dayKey;
      profile.daily.completedDays++;
      profile.daily.bestStreak = Math.max(profile.daily.bestStreak, profile.daily.streak);
    }
  }
  writeProfile(profile, storage);
  return profile;
}

// Постоянный анонимный идентификатор. Заводится при первом обращении и дальше живёт в localStorage.
//
// Нужен ровно для одного: чтобы в таблице рекордов у игрока была одна строка на трассу, а не по
// строке на каждый забег. Раньше дедупликация шла по matchId, и человек, прошедший трассу пять раз,
// занимал пять верхних мест — таблица показывала не самых быстрых, а самого настойчивого.
//
// Ни имени, ни устройства, ни чего-либо ещё о человеке в нём нет: это случайные 128 бит. Стёр
// хранилище браузера — стал новым игроком, и это допустимо: идентификатор не средство от читерства.
export function playerId(storage = globalThis.localStorage) {
  const profile = readProfile(storage);
  if (profile.playerId) return profile.playerId;
  profile.playerId = randomId();
  writeProfile(profile, storage);
  return profile.playerId;
}

function randomId() {
  const bytes = new Uint8Array(16);
  // getRandomValues есть везде, где есть localStorage, но подстраховка ничего не стоит: без неё
  // отсутствие crypto уронило бы вход в комнату целиком.
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function safePlayerId(value) {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeChapterBests(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [id, time] of Object.entries(value))
    if (/^[a-z0-9-]{1,32}$/i.test(id) && Number.isFinite(time) && time > 0) result[id] = Math.round(time);
  return result;
}

function safeChapterStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [id, stats] of Object.entries(value)) {
    if (!/^[a-z0-9-]{1,32}$/i.test(id) || !stats || typeof stats !== 'object') continue;
    result[id] = {
      runs: safeCount(stats.runs),
      revives: safeCount(stats.revives),
      flawless: safeCount(stats.flawless)
    };
  }
  return result;
}

function writeProfile(profile, storage) {
  try {
    storage?.setItem(PROFILE_KEY, JSON.stringify(profile));
  } catch {
    // Приватный режим или переполненное хранилище не должны ломать экран результатов.
  }
}

function isPreviousDay(previous, current) {
  if (!previous) return false;
  const previousTime = Date.parse(`${previous}T00:00:00Z`);
  const currentTime = Date.parse(`${current}T00:00:00Z`);
  return (
    Number.isFinite(previousTime) && Number.isFinite(currentTime) && currentTime - previousTime === 86_400_000
  );
}
