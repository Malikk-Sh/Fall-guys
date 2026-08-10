module.exports = {
  version: 5,
  sql: `
    CREATE TABLE IF NOT EXISTS reward_grants (
      idempotency_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      reward TEXT NOT NULL,
      cosmetic_id TEXT,
      granted_at INTEGER NOT NULL,
      day_key TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reward_grants_account_day
      ON reward_grants (account_id, day_key, granted_at);
  `
};
