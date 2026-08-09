import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');

test('миграции поднимают чистую базу по порядку и повторно ничего не делают', () => {
  const db = openDatabase(':memory:');
  assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4]);
  const applied = db
    .prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version')
    .all()
    .map(row => ({ ...row }));
  assert.deepEqual(applied, [
    { version: 1, applied_at: 123 },
    { version: 2, applied_at: 123 },
    { version: 3, applied_at: 123 },
    { version: 4, applied_at: 123 }
  ]);
  assert.deepEqual(migrateDatabase(db, { now: 999 }), []);
  for (const table of [
    'chapter_progress',
    'account_identities',
    'account_sessions',
    'account_cosmetics',
    'account_loadout'
  ]) {
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ?').get(table).count,
      1,
      `${table} создана миграциями`
    );
  }
  db.close();
});

test('миграции прогресса, Auth V2 и inventory сохраняют старые аккаунты и рекорды', () => {
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
