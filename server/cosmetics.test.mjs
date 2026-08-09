import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cosmeticLoadout,
  equipCosmetic,
  nextCosmeticGoal,
  unlockedCosmetics
} from '../client/core/cosmetics.js';

const memory = () => {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
};

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
    'campaign-finish'
  ]);
});

test('locked reward cannot be equipped and unlocked loadout persists', () => {
  const storage = memory();
  const empty = { daily: { bestStreak: 0 }, coop: { chapterStats: {}, totalRevives: 0 } };
  equipCosmetic('sky-hero', null, empty, storage);
  assert.equal(cosmeticLoadout(null, empty, storage).body.id, 'classic');

  const earned = {
    daily: { bestStreak: 0 },
    coop: { chapterStats: { ch10: { runs: 1 } }, totalRevives: 0 }
  };
  equipCosmetic('sky-hero', null, earned, storage);
  assert.equal(cosmeticLoadout(null, earned, storage).body.id, 'sky-hero');
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
