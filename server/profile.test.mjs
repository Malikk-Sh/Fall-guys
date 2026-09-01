import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyCourseSpec } from '../client/core/Config.js';
import {
  emptyProfile,
  readProfile,
  recordCoopProfile,
  recordSoloProfile,
  playerId
} from '../client/core/profile.js';
import { dailyPresentationModel } from '../client/ui/DailyChallengePresentation.js';

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    }
  };
}

function objectiveTargetMs(spec) {
  const value = spec?.objectives?.[0]?.targetMs;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

test('профиль считает завершённые забеги и выполненные цели', () => {
  const storage = memoryStorage();
  const spec = dailyCourseSpec('normal', new Date('2026-08-02T12:00:00Z'));
  let profile = recordSoloProfile(
    spec,
    {
      objectives: [{ id: 'no-falls', complete: true }]
    },
    storage
  );
  assert.equal(profile.completedRuns, 1);
  assert.equal(profile.completedObjectives, 1);
  assert.equal(profile.flawlessRuns, 1);
  profile = recordSoloProfile(
    { ...spec, challenge: null },
    {
      objectives: [{ id: 'no-falls', complete: false }]
    },
    storage
  );
  assert.equal(profile.completedRuns, 2);
  assert.equal(profile.flawlessRuns, 1);
});

test('ежедневная серия растёт один раз в сутки и запоминает лучший результат', () => {
  const storage = memoryStorage();
  const day = value => dailyCourseSpec('normal', new Date(`${value}T12:00:00Z`));
  recordSoloProfile(day('2026-08-01'), {}, storage);
  recordSoloProfile(day('2026-08-01'), {}, storage);
  let profile = recordSoloProfile(day('2026-08-02'), {}, storage);
  assert.deepEqual(profile.daily, {
    lastDay: '2026-08-02',
    streak: 2,
    bestStreak: 2,
    completedDays: 2
  });
  profile = recordSoloProfile(day('2026-08-04'), {}, storage);
  assert.equal(profile.daily.streak, 1);
  assert.equal(profile.daily.bestStreak, 2);
  assert.equal(profile.daily.completedDays, 3);
});

test('daily reward presentation не показывает протухшую текущую серию', () => {
  const catalog = [{ id: 'daily-5', name: 'ПЯТЬ ДНЕЙ', unlock: { type: 'daily', streak: 5 } }];
  const now = new Date('2026-08-03T12:00:00Z');

  let model = dailyPresentationModel({
    now,
    profile: { daily: { lastDay: '2026-08-01', streak: 4, bestStreak: 4 } },
    catalog
  });
  assert.equal(model.reward.current, 0, 'после пропущенного UTC-дня серия визуально начинается заново');

  model = dailyPresentationModel({
    now,
    profile: { daily: { lastDay: '2026-08-02', streak: 4, bestStreak: 4 } },
    catalog
  });
  assert.equal(model.reward.current, 4, 'вчерашняя серия ещё может быть продолжена сегодня');
});

test('daily objective snapshot хранит только валидный результат дня и не стирает достигнутый успех', () => {
  const storage = memoryStorage();
  const spec = dailyCourseSpec('normal', new Date('2026-08-02T12:00:00Z'));
  const objectiveId = spec.objectives[0].id;
  const targetMs = objectiveTargetMs(spec);

  let profile = recordSoloProfile(spec, { objectives: [{ id: objectiveId, complete: false }] }, storage);
  assert.deepEqual(profile.dailyObjective, {
    dayKey: spec.dayKey,
    id: objectiveId,
    targetMs,
    complete: false
  });

  profile = recordSoloProfile(spec, { objectives: [{ id: objectiveId, complete: true }] }, storage);
  assert.equal(profile.dailyObjective.complete, true);

  profile = recordSoloProfile(spec, { objectives: [{ id: objectiveId, complete: false }] }, storage);
  assert.equal(profile.dailyObjective.complete, true, 'повторный провал не стирает уже выполненную цель');

  const next = dailyCourseSpec('normal', new Date('2026-08-03T12:00:00Z'));
  const nextId = next.objectives[0].id;
  profile = recordSoloProfile(
    next,
    { objectives: [{ id: nextId, complete: true }], unranked: 'disconnect' },
    storage
  );
  assert.deepEqual(
    profile.dailyObjective,
    { dayKey: spec.dayKey, id: objectiveId, targetMs, complete: true },
    'незачётный daily не становится источником presentation progress'
  );
});

test('time-objective snapshot не переносит успех между разными materialized target', () => {
  let day = null;
  for (let offset = 0; offset < 40; offset++) {
    const date = new Date(Date.parse('2026-08-01T12:00:00Z') + offset * 86_400_000);
    if (dailyCourseSpec('normal', date).objectives[0].id === 'under-time') {
      day = date;
      break;
    }
  }
  assert.ok(day, 'подготовка: в пуле должна быть цель на время');

  const storage = memoryStorage();
  const easy = dailyCourseSpec('easy', day);
  const chaos = dailyCourseSpec('chaos', day);
  assert.notEqual(easy.objectives[0].targetMs, chaos.objectives[0].targetMs);

  let profile = recordSoloProfile(easy, { objectives: [{ id: 'under-time', complete: true }] }, storage);
  assert.equal(profile.dailyObjective.complete, true);
  assert.equal(profile.dailyObjective.targetMs, easy.objectives[0].targetMs);

  profile = recordSoloProfile(chaos, { objectives: [{ id: 'under-time', complete: false }] }, storage);
  assert.equal(profile.dailyObjective.complete, false, 'другой time target не наследует прошлый успех');
  assert.equal(profile.dailyObjective.targetMs, chaos.objectives[0].targetMs);
});

test('забег без зачёта не продлевает ежедневную серию', () => {
  const storage = memoryStorage();
  const spec = dailyCourseSpec('normal', new Date('2026-08-02T12:00:00Z'));
  const profile = recordSoloProfile(spec, { unranked: 'disconnect' }, storage);
  assert.equal(profile.completedRuns, 1);
  assert.equal(profile.daily.streak, 0);
  assert.equal(profile.daily.lastDay, null);
});

test('повреждённое и недоступное хранилище не ломает профиль', () => {
  assert.deepEqual(readProfile(memoryStorage('{broken')), emptyProfile());
  const blocked = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    }
  };
  assert.deepEqual(readProfile(blocked), emptyProfile());
  assert.equal(recordSoloProfile({}, {}, blocked).completedRuns, 1);
});

test('старый профиль без daily objective snapshot получает безопасное пустое состояние', () => {
  const profile = readProfile(
    memoryStorage(JSON.stringify({ version: 1, daily: { lastDay: '2026-08-01', streak: 2, bestStreak: 3 } }))
  );
  assert.deepEqual(profile.dailyObjective, { dayKey: null, id: null, targetMs: null, complete: false });
  assert.equal(profile.daily.streak, 2);
  assert.equal(profile.daily.bestStreak, 3);
});

test('кооперативный профиль хранит лучшие главы и спасения без дубля после reconnect', () => {
  const storage = memoryStorage();
  const chapter = { chapterId: 'ch2' };
  let profile = recordCoopProfile(chapter, { time: 80_000, revives: 2, matchId: 'match-a' }, storage);
  profile = recordCoopProfile(chapter, { time: 70_000, revives: 9, matchId: 'match-a' }, storage);
  assert.equal(profile.coop.completedChapters, 1);
  assert.equal(profile.coop.totalRevives, 2);
  assert.equal(profile.coop.bestByChapter.ch2, 80_000);
  assert.deepEqual(profile.coop.chapterStats.ch2, { runs: 1, revives: 2, flawless: 0 });
  profile = recordCoopProfile(chapter, { time: 75_000, revives: 1, matchId: 'match-b' }, storage);
  assert.equal(profile.coop.completedChapters, 2);
  assert.equal(profile.coop.totalRevives, 3);
  assert.equal(profile.coop.bestByChapter.ch2, 75_000);
  assert.deepEqual(profile.coop.chapterStats.ch2, { runs: 2, revives: 3, flawless: 0 });
});

test('кампания хранит flawless и безопасно читает старый профиль без статистики глав', () => {
  const storage = memoryStorage();
  let profile = recordCoopProfile(
    { chapterId: 'ch7' },
    { time: 60_000, revives: 0, matchId: 'clean' },
    storage
  );
  assert.deepEqual(profile.coop.chapterStats.ch7, { runs: 1, revives: 0, flawless: 1 });

  profile = readProfile(
    memoryStorage(JSON.stringify({ version: 1, coop: { bestByChapter: { ch3: 42_000 } } }))
  );
  assert.deepEqual(profile.coop.chapterStats, {});
  assert.equal(profile.coop.bestByChapter.ch3, 42_000);
});

test('кооператив без зачёта считается пройденным, но не обновляет рекорд', () => {
  const storage = memoryStorage();
  const profile = recordCoopProfile(
    { chapterId: 'ch1' },
    { time: 50_000, revives: 1, unranked: 'disconnect', matchId: 'match-c' },
    storage
  );
  assert.equal(profile.coop.completedChapters, 1);
  assert.equal(profile.coop.totalRevives, 1);
  assert.equal(profile.coop.bestByChapter.ch1, undefined);
});

// Идентификатор нужен таблице рекордов: по нему у игрока одна строка на трассу вместо строки на
// каждый забег. Значит, он обязан переживать и перезаход в игру, и запись прогресса поверх.
test('анонимный идентификатор заводится один раз и больше не меняется', () => {
  const storage = memoryStorage();
  const first = playerId(storage);
  assert.match(first, /^[a-f0-9]{32}$/, 'идентификатор — 128 случайных бит в шестнадцатеричном виде');
  assert.equal(playerId(storage), first, 'повторный вызов возвращает тот же');

  // Запись результата не должна его потерять: профиль перечитывается и пишется целиком.
  recordSoloProfile({ challenge: null }, { objectives: [] }, storage);
  assert.equal(playerId(storage), first, 'идентификатор пережил запись прогресса');
  assert.equal(readProfile(storage).playerId, first);
});

test('два игрока получают разные идентификаторы', () => {
  assert.notEqual(playerId(memoryStorage()), playerId(memoryStorage()));
});

test('испорченный идентификатор заменяется новым, а не тянется дальше', () => {
  const storage = memoryStorage(JSON.stringify({ version: 1, playerId: 'не-идентификатор' }));
  assert.match(playerId(storage), /^[a-f0-9]{32}$/);
});
