module.exports = {
  version: 8,
  sql: `
    ALTER TABLE matchmaking_avoids ADD COLUMN account_a_avoided_at INTEGER;
    ALTER TABLE matchmaking_avoids ADD COLUMN account_b_avoided_at INTEGER;

    UPDATE matchmaking_avoids
    SET account_a_avoided_at = CASE
          WHEN created_by_account_id = account_a THEN created_at
          ELSE NULL
        END,
        account_b_avoided_at = CASE
          WHEN created_by_account_id = account_b THEN created_at
          ELSE NULL
        END;

    CREATE INDEX IF NOT EXISTS idx_matchmaking_avoids_a_active
      ON matchmaking_avoids (account_a, account_a_avoided_at DESC);
    CREATE INDEX IF NOT EXISTS idx_matchmaking_avoids_b_active
      ON matchmaking_avoids (account_b, account_b_avoided_at DESC);
  `
};
