module.exports = {
  version: 9,
  sql: `
    ALTER TABLE social_reports ADD COLUMN target_name_snapshot TEXT;
    ALTER TABLE social_reports ADD COLUMN chapter_id_snapshot TEXT;

    UPDATE social_reports
    SET target_name_snapshot = (
      SELECT display_name FROM accounts WHERE accounts.id = social_reports.target_account_id
    )
    WHERE target_name_snapshot IS NULL;

    UPDATE social_reports
    SET chapter_id_snapshot = (
      SELECT last_chapter_id
      FROM recent_partners
      WHERE recent_partners.account_id = social_reports.reporter_account_id
        AND recent_partners.partner_account_id = social_reports.target_account_id
    )
    WHERE chapter_id_snapshot IS NULL;

    CREATE TABLE social_report_evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_account_id TEXT NOT NULL,
      target_account_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      reported_at INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1,
      target_name_snapshot TEXT,
      chapter_id_snapshot TEXT,
      CHECK (reporter_account_id <> target_account_id),
      CHECK (reason IN ('afk', 'griefing', 'offensive-name', 'exploit-cheat')),
      CHECK (occurrences >= 1)
    );
    CREATE INDEX idx_social_report_evidence_target_time
      ON social_report_evidence (target_account_id, reported_at DESC, id DESC);

    -- Pre-009 reports were aggregated in-place, so their individual historical snapshots no longer
    -- exist. Preserve one explicitly aggregated legacy evidence row rather than pretending that we
    -- can reconstruct each occurrence. Every report accepted after this migration gets its own row.
    INSERT INTO social_report_evidence
      (
        reporter_account_id,
        target_account_id,
        reason,
        reported_at,
        occurrences,
        target_name_snapshot,
        chapter_id_snapshot
      )
    SELECT
      reporter_account_id,
      target_account_id,
      reason,
      last_reported_at,
      report_count,
      target_name_snapshot,
      chapter_id_snapshot
    FROM social_reports;

    CREATE TABLE moderation_cases (
      target_account_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_through INTEGER NOT NULL DEFAULT 0,
      moderator_id TEXT,
      note TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
      CHECK (reviewed_through >= 0),
      CHECK (moderator_id IS NULL OR (length(moderator_id) BETWEEN 1 AND 80)),
      CHECK (note IS NULL OR length(note) <= 1000)
    );
    CREATE INDEX idx_moderation_cases_status_time
      ON moderation_cases (status, updated_at DESC);

    CREATE TABLE moderation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_account_id TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      note TEXT,
      reviewed_through INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      CHECK (from_status IN ('open', 'reviewing', 'resolved', 'dismissed')),
      CHECK (to_status IN ('open', 'reviewing', 'resolved', 'dismissed')),
      CHECK (length(moderator_id) BETWEEN 1 AND 80),
      CHECK (note IS NULL OR length(note) <= 1000),
      CHECK (reviewed_through >= 0)
    );
    CREATE INDEX idx_moderation_events_target_time
      ON moderation_events (target_account_id, created_at ASC, id ASC);
  `
};
