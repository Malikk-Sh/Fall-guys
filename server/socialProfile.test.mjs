import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');

const fresh = () => new Accounts({ db: openDatabase(':memory:') });

test('server profile starts empty and contains no invented recent partner', () => {
  const accounts = fresh();
  const player = accounts.create('Профиль');
  const profile = accounts.profile(player.id);

  assert.deepEqual(profile.stats, {
    coopMatchesCompleted: 0,
    coopChaptersCompleted: 0,
    coopRevives: 0,
    coopFlawless: 0
  });
  assert.deepEqual(profile.achievements, []);
  assert.deepEqual(profile.campaign, {
    completed: false,
    completedAt: null,
    chaptersCompleted: 0,
    totalChapters: 10
  });
  assert.equal(profile.recentPartner, null);
  accounts.db.close();
});

test('recent partner is server-owned, directional and keeps the latest chapter', () => {
  const accounts = fresh();
  const first = accounts.create('Первый');
  const second = accounts.create('Второй');

  assert.equal(
    accounts.recordCoopPartners({
      accountIds: [first.id, second.id],
      chapterId: 'ch3',
      playedAt: 1000
    }),
    2
  );
  accounts.recordCoopPartners({
    accountIds: [first.id, second.id],
    chapterId: 'ch4',
    playedAt: 2000
  });
  accounts.rename(second.id, 'Напарник');

  assert.deepEqual(accounts.profile(first.id).recentPartner, {
    id: second.id,
    name: 'Напарник',
    matchesTogether: 2,
    lastChapterId: 'ch4',
    lastPlayedAt: 2000,
    avoided: false
  });
  assert.equal(accounts.profile(second.id).recentPartner.id, first.id);
  assert.equal(
    accounts.recordCoopPartners({ accountIds: [first.id, first.id], chapterId: 'ch1' }),
    0,
    'самого себя нельзя сделать recent partner'
  );
  assert.equal(
    accounts.recordCoopPartners({ accountIds: [first.id, 'unknown'], chapterId: 'ch1' }),
    0,
    'неизвестный аккаунт не попадает в social graph'
  );
  assert.equal(
    accounts.recordCoopPartners({ accountIds: [first.id, second.id], chapterId: 'ch99' }),
    0,
    'несуществующая глава не записывается'
  );
  accounts.db.close();
});

test('campaign completion badge data is derived from authoritative achievements and stats', () => {
  const accounts = fresh();
  const player = accounts.create('Финалист');

  for (let chapter = 1; chapter <= 10; chapter++) {
    assert.equal(
      accounts.recordCoopCompletion({
        accountId: player.id,
        chapterId: `ch${chapter}`,
        timeMs: 60_000 + chapter,
        revives: chapter === 1 ? 2 : 0,
        falls: chapter === 2 ? 1 : 0,
        completedAt: 10_000 + chapter
      }),
      true
    );
  }

  const profile = accounts.profile(player.id);
  assert.equal(profile.stats.coopMatchesCompleted, 10);
  assert.equal(profile.stats.coopChaptersCompleted, 10);
  assert.equal(profile.stats.coopRevives, 2);
  assert.equal(profile.stats.coopFlawless, 9);
  assert.equal(profile.campaign.completed, true);
  assert.equal(profile.campaign.completedAt, 10_010);
  assert.equal(profile.campaign.chaptersCompleted, 10);
  assert.ok(profile.achievements.some(item => item.id === 'coop-campaign-complete'));
  accounts.db.close();
});
