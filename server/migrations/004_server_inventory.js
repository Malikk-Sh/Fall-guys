module.exports = {
  version: 4,
  sql: `
    CREATE TABLE IF NOT EXISTS account_cosmetics (
      account_id TEXT NOT NULL,
      cosmetic_id TEXT NOT NULL,
      unlocked_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (account_id, cosmetic_id),
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_account_cosmetics_account
      ON account_cosmetics (account_id, unlocked_at);

    CREATE TABLE IF NOT EXISTS account_loadout (
      account_id TEXT PRIMARY KEY,
      body TEXT NOT NULL DEFAULT 'classic',
      visor TEXT,
      antenna TEXT,
      trail TEXT,
      finish TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
  `
};
