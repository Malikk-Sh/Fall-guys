import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { MIGRATIONS, migrateDatabase } = require('./migrations');

test('миграции поднимают чистую базу по порядку и повторно ничего не делают', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(
    migrateDatabase(db, { now: 123 }),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]
  );
  const applied = db
    .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
    .all()
    .map(row => ({ ...row }));
  assert.deepEqual(applied, [
    { version: 1, applied_at: 123 },
    { version: 2, applied_at: 123 },
    { version: 3, applied_at: 123 },
    { version: 4, applied_at: 123 },
    { version: 5, applied_at: 123 },
    { version: 6, applied_at: 123 },
    { version: 7, applied_at: 123 },
    { version: 8, applied_at: 123 },
    { version: 9, applied_at: 123 },
    { version: 10, applied_at: 123 },
    { version: 11, applied_at: 123 },
    { version: 12, applied_at: 123 },
    { version: 13, applied_at: 123 },
    { version: 14, applied_at: 123 },
    { version: 15, applied_at: 123 },
    { version: 16, applied_at: 123 },
    { version: 17, applied_at: 123 }
  ]);
  assert.deepEqual(migrateDatabase(db, { now: 999 }), []);
  for (const table of [
    'chapter_progress',
    'account_identities',
    'account_sessions',
    'account_cosmetics',
    'account_loadout',
    'reward_grants',
    'recent_partners',
    'matchmaking_avoids',
    'social_reports',
    'social_report_evidence',
    'moderation_cases',
    'moderation_events',
    'admin_users',
    'admin_sessions',
    'admin_audit_events',
    'account_support_search',
    'player_sanctions',
    'player_incident_events',
    'service_reliability_samples',
    'service_reliability_events'
  ]) {
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get(table).count,
      1,
      `${table} создана миграциями`
    );
  }
  db.close();
});

test('миграции прогресса, Auth V2, inventory и rewards сохраняют старые аккаунты и рекорды', () => {
  const db = openDatabase(':memory:');
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, secret_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE personal_records (
      account_id TEXT NOT NULL, mode TEXT NOT NULL, course_key TEXT NOT NULL,
      time_ms INTEGER NOT NULL, achieved_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, mode, course_key)
    );
    INSERT INTO accounts VALUES ('old', 'Старожил', 'hash', 1, 2);
    INSERT INTO personal_records VALUES ('old', 'coop', 'ch1', 42000, 3);
  `);
  migrateDatabase(db, { now: 456 });
  assert.equal(
    db.prepare('SELECT display_name FROM accounts WHERE id = ?').get('old').display_name,
    'Старожил'
  );
  assert.equal(
    db.prepare('SELECT time_ms FROM personal_records WHERE account_id = ?').get('old').time_ms,
    42_000
  );
  assert.equal(
    db.prepare('SELECT coop_matches_completed FROM account_stats WHERE account_id = ?').get('old')
      .coop_matches_completed,
    0
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_identities').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_cosmetics').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_loadout').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reward_grants').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_partners').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM matchmaking_avoids').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_reports').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM social_report_evidence').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_cases').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_events').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_audit_events').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM account_support_search').get().count, 1);
  db.close();
});

test('migration 008 preserves old avoid as the creator personal choice', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 7), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('a', 'Первый', 'hash-a', 1, 1);
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('b', 'Второй', 'hash-b', 1, 1);
  db.prepare(
    'INSERT INTO matchmaking_avoids (account_a, account_b, created_by_account_id, created_at) VALUES (?, ?, ?, ?)'
  ).run('a', 'b', 'a', 55);

  assert.deepEqual(migrateDatabase(db, { now: 200 }), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const row = db
    .prepare(
      'SELECT account_a_avoided_at, account_b_avoided_at FROM matchmaking_avoids WHERE account_a = ? AND account_b = ?'
    )
    .get('a', 'b');
  assert.deepEqual({ ...row }, { account_a_avoided_at: 55, account_b_avoided_at: null });
  db.close();
});

test('migration 009 backfills the best available report evidence', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 8), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('reporter', 'Репортёр', 'hash-reporter', 1, 1);
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('target', 'Имя на миграции', 'hash-target', 1, 1);
  db.prepare(
    `
    INSERT INTO recent_partners
      (account_id, partner_account_id, matches_together, last_chapter_id, last_played_at)
    VALUES (?, ?, 1, ?, ?)
  `
  ).run('reporter', 'target', 'ch7', 500);
  db.prepare(
    `
    INSERT INTO social_reports
      (reporter_account_id, target_account_id, reason, report_count, first_reported_at, last_reported_at)
    VALUES (?, ?, ?, 3, ?, ?)
  `
  ).run('reporter', 'target', 'offensive-name', 400, 600);

  assert.deepEqual(migrateDatabase(db, { now: 200 }), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  const report = db.prepare('SELECT target_name_snapshot, chapter_id_snapshot FROM social_reports').get();
  assert.deepEqual({ ...report }, { target_name_snapshot: 'Имя на миграции', chapter_id_snapshot: 'ch7' });
  const evidence = db
    .prepare(
      `SELECT reporter_account_id, target_account_id, reason, reported_at, occurrences,
              target_name_snapshot, chapter_id_snapshot
       FROM social_report_evidence`
    )
    .get();
  assert.deepEqual(
    { ...evidence },
    {
      reporter_account_id: 'reporter',
      target_account_id: 'target',
      reason: 'offensive-name',
      reported_at: 600,
      occurrences: 3,
      target_name_snapshot: 'Имя на миграции',
      chapter_id_snapshot: 'ch7'
    }
  );
  db.close();
});

test('migration 010 stages recovery without changing the active recovery hash', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 9), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('legacy', 'Legacy', 'active-hash', 1, 1);

  assert.deepEqual(migrateDatabase(db, { now: 200 }), [10, 11, 12, 13, 14, 15, 16, 17]);
  const row = db
    .prepare('SELECT secret_hash, pending_secret_hash, pending_secret_created_at FROM accounts WHERE id = ?')
    .get('legacy');
  assert.deepEqual(
    { ...row },
    {
      secret_hash: 'active-hash',
      pending_secret_hash: null,
      pending_secret_created_at: null
    }
  );
  db.close();
});

test('migration 011 adds admin control plane without creating any administrator implicitly', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 10), now: 100 });
  assert.deepEqual(migrateDatabase(db, { now: 200 }), [11, 12, 13, 14, 15, 16, 17]);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_users').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_sessions').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM admin_audit_events').get().count, 0);
  db.close();
});

test('migration 012 indexes existing accounts for support search without creating accounts', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 11), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('legacy-search', 'Иван Игрок', 'hash-search', 1, 1);

  assert.deepEqual(migrateDatabase(db, { now: 200 }), [12, 13, 14, 15, 16, 17]);
  const row = db
    .prepare(
      'SELECT account_id, display_name FROM account_support_search WHERE account_support_search MATCH ?'
    )
    .get('иван*');
  assert.deepEqual({ ...row }, { account_id: 'legacy-search', display_name: 'Иван Игрок' });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 1);
  db.close();
});

test('неудачная миграция откатывает и схему, и отметку версии', () => {
  const db = openDatabase(':memory:');
  assert.throws(() =>
    migrateDatabase(db, {
      migrations: [{ version: 1, sql: 'CREATE TABLE temporary_change (id INTEGER); NOT SQL;' }]
    })
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'temporary_change'").get().count,
    0
  );
  db.close();
});

test('сервер отказывается от перепутанных миграций и более новой базы', () => {
  const db = openDatabase(':memory:');
  assert.throws(
    () =>
      migrateDatabase(db, {
        migrations: [
          { version: 2, sql: 'SELECT 1' },
          { version: 1, sql: 'SELECT 1' }
        ]
      }),
    /возрастающие/
  );
  migrateDatabase(db);
  db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(99, 1);
  assert.throws(() => migrateDatabase(db), /более новой/);
  db.close();
});
