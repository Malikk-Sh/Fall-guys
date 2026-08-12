module.exports = {
  version: 14,
  sql: `
    CREATE TABLE player_incident_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      occurred_at INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
      code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 48),
      room_ref TEXT CHECK(room_ref IS NULL OR length(room_ref) = 12),
      match_ref TEXT CHECK(match_ref IS NULL OR length(match_ref) = 12),
      mode TEXT CHECK(mode IS NULL OR mode IN ('race', 'coop')),
      phase TEXT CHECK(phase IS NULL OR phase IN ('roomless', 'matchmaking', 'LOBBY', 'COUNTDOWN', 'PLAYING', 'RESULTS', 'CLOSING')),
      device TEXT CHECK(device IS NULL OR device IN ('mobile', 'desktop')),
      value_ms INTEGER CHECK(value_ms IS NULL OR (value_ms >= 0 AND value_ms <= 604800000))
    );

    CREATE INDEX idx_player_incident_account_time
      ON player_incident_events(account_id, occurred_at DESC, id DESC);
    CREATE INDEX idx_player_incident_time
      ON player_incident_events(occurred_at);
  `
};
