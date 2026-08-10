const initial = require('./001_initial');
const accountProgress = require('./002_account_progress');
const authSessions = require('./003_auth_sessions');
const serverInventory = require('./004_server_inventory');
const rewardPlatform = require('./005_reward_platform');
const recentPartners = require('./006_recent_partners');

const MIGRATIONS = Object.freeze([
  initial,
  accountProgress,
  authSessions,
  serverInventory,
  rewardPlatform,
  recentPartners
]);

function migrateDatabase(db, { migrations = MIGRATIONS, now = Date.now() } = {}) {
  if (!db) throw new Error('Для миграций нужна открытая база');
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration?.version) || migration.version <= previous || !migration.sql) {
      throw new Error('Миграции должны иметь уникальные возрастающие версии и SQL');
    }
    previous = migration.version;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map(row => row.version)
  );
  if ([...applied].some(version => version > previous)) {
    throw new Error('База создана более новой версией сервера');
  }
  const mark = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const completed = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      mark.run(migration.version, now);
      db.exec('COMMIT');
      completed.push(migration.version);
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return completed;
}

module.exports = { MIGRATIONS, migrateDatabase };
