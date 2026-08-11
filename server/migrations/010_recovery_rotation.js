module.exports = {
  version: 10,
  sql: `
    ALTER TABLE accounts ADD COLUMN pending_secret_hash TEXT;
    ALTER TABLE accounts ADD COLUMN pending_secret_created_at INTEGER;
  `
};
