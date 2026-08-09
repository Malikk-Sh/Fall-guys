module.exports = {
  version: 3,
  sql: `
    CREATE TABLE IF NOT EXISTS account_identities (
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (provider, provider_subject),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_identities_account
      ON account_identities (account_id);

    CREATE TABLE IF NOT EXISTS account_sessions (
      token_hash TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_sessions_account
      ON account_sessions (account_id);
    CREATE INDEX IF NOT EXISTS idx_account_sessions_expiry
      ON account_sessions (expires_at);
  `
};
