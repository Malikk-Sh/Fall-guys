module.exports = {
  version: 2,
  sql: `
    CREATE TABLE IF NOT EXISTS account_stats (
      account_id TEXT PRIMARY KEY,
      coop_matches_completed INTEGER NOT NULL DEFAULT 0,
      coop_chapters_completed INTEGER NOT NULL DEFAULT 0,
      coop_revives INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapter_progress (
      account_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      completions INTEGER NOT NULL DEFAULT 0,
      best_time_ms INTEGER NOT NULL,
      revives INTEGER NOT NULL DEFAULT 0,
      flawless INTEGER NOT NULL DEFAULT 0,
      last_completed_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, chapter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chapter_progress_account ON chapter_progress (account_id);
    CREATE TABLE IF NOT EXISTS achievements (
      account_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, achievement_id)
    );
    CREATE INDEX IF NOT EXISTS idx_achievements_account ON achievements (account_id);
    INSERT OR IGNORE INTO account_stats (account_id, updated_at) SELECT id, 0 FROM accounts;
  `
};
