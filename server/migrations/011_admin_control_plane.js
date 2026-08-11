module.exports = {
  version: 11,
  sql: `
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      access_secret_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      disabled_at INTEGER,
      CHECK (length(display_name) BETWEEN 1 AND 80),
      CHECK (role IN ('owner', 'operator', 'moderator', 'analyst', 'viewer'))
    );
    CREATE INDEX IF NOT EXISTS idx_admin_users_role
      ON admin_users (role, created_at);

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
      ON admin_sessions (admin_user_id, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
      ON admin_sessions (expires_at);

    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_user_id TEXT,
      actor_name TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail_json TEXT,
      created_at INTEGER NOT NULL,
      CHECK (length(actor_name) BETWEEN 1 AND 80),
      CHECK (actor_role IN ('owner', 'operator', 'moderator', 'analyst', 'viewer', 'system')),
      CHECK (length(action) BETWEEN 1 AND 120),
      CHECK (target_type IS NULL OR length(target_type) <= 80),
      CHECK (target_id IS NULL OR length(target_id) <= 160),
      CHECK (detail_json IS NULL OR length(detail_json) <= 4000),
      FOREIGN KEY (admin_user_id) REFERENCES admin_users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_time
      ON admin_audit_events (created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
      ON admin_audit_events (admin_user_id, created_at DESC, id DESC);
  `
};
