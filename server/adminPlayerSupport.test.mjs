import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { AdminPlayerSupport, normalizeSearchQuery, escapeLike } = require('./adminPlayerSupport');

function seed() {
  const db = openDatabase(':memory:');
  const now = 50_000;
  const insertAccount = db.prepare(`
    INSERT INTO accounts
      (id, display_name, secret_hash, created_at, last_seen_at, pending_secret_hash, pending_secret_created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertAccount.run('player-main', 'Процент%_Игрок', 'SECRET-RECOVERY-HASH', 1000, 40_000, 'SECRET-PENDING-HASH', 45_000);
  insertAccount.run('partner-one', 'Напарник', 'PARTNER-HASH', 2000, 30_000, null, null);
  insertAccount.run('other-player', 'ПроцентXXИгрок', 'OTHER-HASH', 3000, 20_000, null, null);

  db.prepare(
    'INSERT INTO account_identities (provider, provider_subject, account_id, created_at) VALUES (?, ?, ?, ?)'
  ).run('google', 'SECRET-GOOGLE-SUBJECT', 'player-main', 5000);
  const insertSession = db.prepare(
    'INSERT INTO account_sessions (token_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  );
  insertSession.run('SECRET-ACTIVE-SESSION-HASH', 'player-main', 10_000, 48_000, 80_000);
  insertSession.run('SECRET-EXPIRED-SESSION-HASH', 'player-main', 6000, 7000, 40_000);

  db.prepare(
    `INSERT OR REPLACE INTO account_stats
      (account_id, coop_matches_completed, coop_chapters_completed, coop_revives, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('player-main', 8, 3, 12, 47_000);
  db.prepare(
    `INSERT INTO chapter_progress
      (account_id, chapter_id, completions, best_time_ms, revives, flawless, last_completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('player-main', 'ch1', 2, 65_000, 3, 1, 46_000);
  db.prepare('INSERT INTO achievements (account_id, achievement_id, unlocked_at) VALUES (?, ?, ?)').run(
    'player-main',
    'coop-first-clear',
    46_000
  );
  db.prepare(
    'INSERT INTO personal_records (account_id, mode, course_key, time_ms, achieved_at) VALUES (?, ?, ?, ?, ?)'
  ).run('player-main', 'race', 'easy', 32_000, 44_000);

  db.prepare(
    'INSERT INTO account_cosmetics (account_id, cosmetic_id, unlocked_at, source) VALUES (?, ?, ?, ?)'
  ).run('player-main', 'body-neon', 43_000, 'achievement');
  db.prepare(
    `INSERT INTO account_loadout (account_id, body, visor, antenna, trail, finish, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('player-main', 'body-neon', null, null, 'trail-stars', null, 44_000);
  db.prepare(
    `INSERT INTO reward_grants
      (idempotency_key, account_id, source, reward, cosmetic_id, granted_at, day_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run('SECRET-IDEMPOTENCY-KEY', 'player-main', 'achievement:coop-first-clear', 'cosmetic', 'body-neon', 43_000, '2026-08-11');

  db.prepare(
    `INSERT INTO recent_partners
      (account_id, partner_account_id, matches_together, last_chapter_id, last_played_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run('player-main', 'partner-one', 4, 'ch3', 42_000);
  db.prepare(
    `INSERT INTO matchmaking_avoids
      (account_a, account_b, created_by_account_id, created_at, account_a_avoided_at, account_b_avoided_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run('partner-one', 'player-main', 'player-main', 43_000, null, 43_000);

  db.prepare(
    `INSERT INTO social_reports
      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,
       last_reported_at, target_name_snapshot, chapter_id_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('partner-one', 'player-main', 'griefing', 2, 41_000, 42_000, 'Старое имя', 'ch3');
  db.prepare(
    `INSERT INTO social_reports
      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,
       last_reported_at, target_name_snapshot, chapter_id_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run('player-main', 'partner-one', 'afk', 1, 43_000, 43_000, 'Напарник', 'ch3');

  return { db, now, support: new AdminPlayerSupport({ db }) };
}

test('player support returns useful account context without credentials', () => {
  const { db, now, support } = seed();
  const profile = support.get('player-main', { now });
  assert.equal(profile.account.name, 'Процент%_Игрок');
  assert.equal(profile.account.recoveryRotationPending, true);
  assert.equal(profile.account.recoveryRotationStartedAt, 45_000);
  assert.deepEqual(profile.login.providers, [{ provider: 'google', linkedAt: 5000 }]);
  assert.equal(profile.login.sessions.active, 1);
  assert.equal(profile.login.sessions.totalStored, 2);
  assert.equal(profile.login.sessions.latestSeenAt, 48_000);
  assert.equal(profile.progress.stats.coopMatchesCompleted, 8);
  assert.equal(profile.progress.chapters[0].chapterId, 'ch1');
  assert.equal(profile.progress.personalRecords[0].timeMs, 32_000);
  assert.equal(profile.inventory.loadout.body, 'body-neon');
  assert.equal(profile.inventory.recentRewards[0].cosmeticId, 'body-neon');
  assert.equal(profile.social.recentPartners[0].name, 'Напарник');
  assert.equal(profile.social.recentPartners[0].avoidedByThisPlayer, true);
  assert.equal(profile.social.avoidedByThisPlayer, 1);
  assert.equal(profile.social.reportsReceived.reporters, 1);
  assert.equal(profile.social.reportsReceived.total, 2);
  assert.equal(profile.social.reportsSubmitted, 1);

  const serialized = JSON.stringify(profile);
  for (const forbidden of [
    'SECRET-RECOVERY-HASH',
    'SECRET-PENDING-HASH',
    'SECRET-ACTIVE-SESSION-HASH',
    'SECRET-EXPIRED-SESSION-HASH',
    'SECRET-GOOGLE-SUBJECT',
    'SECRET-IDEMPOTENCY-KEY',
    'secret_hash',
    'pending_secret_hash',
    'token_hash',
    'provider_subject',
    'idempotency_key'
  ]) {
    assert.equal(serialized.includes(forbidden), false, `must not expose ${forbidden}`);
  }
  db.close();
});

test('player support search escapes LIKE wildcards and returns only bounded summaries', () => {
  const { db, now, support } = seed();
  const literal = support.search('%_', { now });
  assert.equal(literal.ok, true);
  assert.deepEqual(literal.results.map(item => item.id), ['player-main']);
  assert.equal(literal.results[0].activeSessions, 1);
  assert.equal(literal.results[0].hasExternalLogin, true);

  assert.equal(support.search('x').reason, 'invalid-query');
  assert.equal(normalizeSearchQuery(' bad\nquery '), null);
  assert.equal(escapeLike('a%b_c\\d'), 'a\\%b\\_c\\\\d');
  db.close();
});

test('unknown account ids do not create synthetic support profiles', () => {
  const { db, support } = seed();
  assert.equal(support.get('missing-account'), null);
  db.close();
});
