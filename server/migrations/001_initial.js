module.exports = {
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS personal_records (
      account_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      course_key TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      achieved_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, mode, course_key)
    );
    CREATE INDEX IF NOT EXISTS idx_records_account ON personal_records (account_id);
  `
};
