'use strict';

module.exports = {
  version: 15,
  sql: `
    CREATE TABLE service_reliability_samples (
      sampled_at INTEGER PRIMARY KEY,
      version TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      release_tag TEXT NOT NULL DEFAULT '',
      event_loop_p95_ms REAL NOT NULL,
      rss_mb INTEGER NOT NULL,
      heap_used_mb INTEGER NOT NULL,
      socket_count INTEGER NOT NULL,
      active_matches INTEGER NOT NULL,
      matchmaking_waiting INTEGER NOT NULL,
      resume_succeeded INTEGER NOT NULL,
      resume_failed INTEGER NOT NULL,
      handler_errors INTEGER NOT NULL,
      socket_send_failures INTEGER NOT NULL,
      capacity_rejected INTEGER NOT NULL,
      snapshots_skipped_for_load INTEGER NOT NULL
    );

    CREATE TABLE service_reliability_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bucket_at INTEGER NOT NULL,
      first_occurred_at INTEGER NOT NULL,
      last_occurred_at INTEGER NOT NULL,
      event TEXT NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'error')),
      fingerprint TEXT NOT NULL DEFAULT '',
      version TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      release_tag TEXT NOT NULL DEFAULT '',
      occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
      UNIQUE (bucket_at, event, severity, fingerprint, version, commit_sha, release_tag)
    );

    CREATE INDEX service_reliability_events_last_idx
      ON service_reliability_events(last_occurred_at DESC);
  `
};
