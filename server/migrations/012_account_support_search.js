module.exports = {
  version: 12,
  sql: `
    CREATE VIRTUAL TABLE IF NOT EXISTS account_support_search USING fts5(
      account_id UNINDEXED,
      display_name,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    DELETE FROM account_support_search;
    INSERT INTO account_support_search (account_id, display_name)
    SELECT id, display_name FROM accounts;

    CREATE TRIGGER IF NOT EXISTS account_support_search_insert
    AFTER INSERT ON accounts
    BEGIN
      INSERT INTO account_support_search (account_id, display_name)
      VALUES (NEW.id, NEW.display_name);
    END;

    CREATE TRIGGER IF NOT EXISTS account_support_search_rename
    AFTER UPDATE OF display_name ON accounts
    BEGIN
      DELETE FROM account_support_search WHERE account_id = OLD.id;
      INSERT INTO account_support_search (account_id, display_name)
      VALUES (NEW.id, NEW.display_name);
    END;

    CREATE TRIGGER IF NOT EXISTS account_support_search_delete
    AFTER DELETE ON accounts
    BEGIN
      DELETE FROM account_support_search WHERE account_id = OLD.id;
    END;

    CREATE INDEX IF NOT EXISTS idx_account_sessions_account_activity
      ON account_sessions (account_id, last_seen_at DESC, expires_at);
  `
};
