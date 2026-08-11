module.exports = {
  version: 13,
  sql: `
    CREATE TABLE IF NOT EXISTS player_sanctions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('warning', 'ban')),
      reason TEXT NOT NULL CHECK (reason IN ('afk', 'griefing', 'offensive-name', 'exploit-cheat', 'other')),
      note TEXT NOT NULL,
      created_by_admin_id TEXT NOT NULL REFERENCES admin_users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      revoked_by_admin_id TEXT REFERENCES admin_users(id),
      revoke_note TEXT,
      CHECK (kind = 'ban' OR expires_at IS NULL),
      CHECK (expires_at IS NULL OR expires_at > created_at),
      CHECK (revoked_at IS NULL OR kind = 'ban')
    );

    CREATE INDEX IF NOT EXISTS idx_player_sanctions_account_history
      ON player_sanctions (account_id, created_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS idx_player_sanctions_active_bans
      ON player_sanctions (account_id, revoked_at, expires_at)
      WHERE kind = 'ban';
  `
};
