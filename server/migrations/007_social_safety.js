module.exports = {
  version: 7,
  sql: `
    CREATE TABLE IF NOT EXISTS matchmaking_avoids (
      account_a TEXT NOT NULL,
      account_b TEXT NOT NULL,
      created_by_account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (account_a, account_b),
      CHECK (account_a < account_b),
      CHECK (created_by_account_id = account_a OR created_by_account_id = account_b)
    );
    CREATE INDEX IF NOT EXISTS idx_matchmaking_avoids_created
      ON matchmaking_avoids (created_at DESC);

    CREATE TABLE IF NOT EXISTS social_reports (
      reporter_account_id TEXT NOT NULL,
      target_account_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      report_count INTEGER NOT NULL DEFAULT 1,
      first_reported_at INTEGER NOT NULL,
      last_reported_at INTEGER NOT NULL,
      PRIMARY KEY (reporter_account_id, target_account_id, reason),
      CHECK (reporter_account_id <> target_account_id),
      CHECK (reason IN ('afk', 'griefing', 'offensive-name', 'exploit-cheat')),
      CHECK (report_count >= 1)
    );
    CREATE INDEX IF NOT EXISTS idx_social_reports_target_time
      ON social_reports (target_account_id, last_reported_at DESC);
  `
};
