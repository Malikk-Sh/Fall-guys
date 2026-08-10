module.exports = {
  version: 6,
  sql: `
    CREATE TABLE IF NOT EXISTS recent_partners (
      account_id TEXT NOT NULL,
      partner_account_id TEXT NOT NULL,
      matches_together INTEGER NOT NULL DEFAULT 0,
      last_chapter_id TEXT NOT NULL,
      last_played_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, partner_account_id),
      CHECK (account_id <> partner_account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_recent_partners_account_time
      ON recent_partners (account_id, last_played_at DESC);
  `
};
