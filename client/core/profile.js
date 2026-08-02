const PROFILE_KEY = 'wobble-profile-v1';

export function emptyProfile() {
  return {
    version: 1,
    completedRuns: 0,
    completedObjectives: 0,
    flawlessRuns: 0,
    daily: { lastDay: null, streak: 0, bestStreak: 0, completedDays: 0 },
    coop: { completedChapters: 0, totalRevives: 0, bestByChapter: {}, recordedMatches: [] }
  };
}

export function readProfile(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(PROFILE_KEY) || 'null');
    if (!parsed || parsed.version !== 1) return emptyProfile();
    const base = emptyProfile();
    return {
      ...base,
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
      coop: {
        completedChapters: safeCount(parsed.coop?.completedChapters),
        totalRevives: safeCount(parsed.coop?.totalRevives),
        bestByChapter: safeChapterBests(parsed.coop?.bestByChapter),
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
  { objectives = [], unranked = null } = {},
  storage = globalThis.localStorage
) {
  const profile = readProfile(storage);
  profile.completedRuns++;
  const completed = objectives.filter(goal => goal?.complete).length;
  profile.completedObjectives += completed;
  if (objectives.some(goal => goal?.id === 'no-falls' && goal.complete)) profile.flawlessRuns++;

  if (spec?.challenge === 'daily' && spec.dayKey && !unranked && profile.daily.lastDay !== spec.dayKey) {
    profile.daily.streak = isPreviousDay(profile.daily.lastDay, spec.dayKey) ? profile.daily.streak + 1 : 1;
    profile.daily.lastDay = spec.dayKey;
    profile.daily.completedDays++;
    profile.daily.bestStreak = Math.max(profile.daily.bestStreak, profile.daily.streak);
  }
  writeProfile(profile, storage);
  return profile;
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
