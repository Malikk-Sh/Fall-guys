import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyCourseSpec } from '../client/core/Config.js';
import { emptyProfile, readProfile, recordCoopProfile, recordSoloProfile } from '../client/core/profile.js';

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    }
  };
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

test('кооперативный профиль хранит лучшие главы и спасения без дубля после reconnect', () => {
  const storage = memoryStorage();
  const chapter = { chapterId: 'ch2' };
  let profile = recordCoopProfile(chapter, { time: 80_000, revives: 2, matchId: 'match-a' }, storage);
  profile = recordCoopProfile(chapter, { time: 70_000, revives: 9, matchId: 'match-a' }, storage);
  assert.equal(profile.coop.completedChapters, 1);
  assert.equal(profile.coop.totalRevives, 2);
  assert.equal(profile.coop.bestByChapter.ch2, 80_000);
  profile = recordCoopProfile(chapter, { time: 75_000, revives: 1, matchId: 'match-b' }, storage);
  assert.equal(profile.coop.completedChapters, 2);
  assert.equal(profile.coop.totalRevives, 3);
  assert.equal(profile.coop.bestByChapter.ch2, 75_000);
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
