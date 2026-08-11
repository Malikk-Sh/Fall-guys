# Moderation workflow

Wobble Rush accepts only fixed report reasons from a player's most recent co-op partner. Reports are
signals for human review, not automatic punishment. The production server intentionally exposes no
moderation HTTP endpoint: moderation is performed locally on the VPS against the SQLite database.

## What is stored

A report keeps the reporter and target account IDs, the fixed reason, aggregate report count and
first/last report time. From migration 009 onward it also snapshots the target display name and the
co-op chapter at report time. This matters for `offensive-name` reports because a player can rename
before a moderator reviews the case.

The moderation queue groups report rows by target account. It shows the number of independent
reporters, total reports, reason counts and latest activity. Cases with more independent reporters
are shown first; cheat and offensive-name signals break ties. This ordering is only triage — the
tool never bans, suspends or renames a player automatically.

## Statuses

- `open` — waiting for review. A target with reports and no moderation decision is open.
- `reviewing` — a moderator is actively investigating the reports.
- `resolved` — the moderator completed the response outside this tool.
- `dismissed` — the reviewed reports did not justify action.

Closing a case as `resolved` or `dismissed` requires a note. The tool records every status change in
`moderation_events` with moderator ID, note and timestamp.

A closed case automatically appears as `open` again if a newer accepted report arrives. The old
moderation history remains intact, so a new report cannot erase an earlier decision.

## Production commands

The production database is normally `/var/lib/wobble/leaderboard.db`. Run the CLI as the `wobble`
user so any SQLite/WAL files keep the same ownership as the game service.

List the open queue:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue
```

Show all report evidence and moderation history for one target:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db show <account-id>
```

Mark a case as being reviewed:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> reviewing \
  --moderator malik
```

Resolve or dismiss it with an audit note:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> resolved \
  --moderator malik \
  --note "Reviewed evidence; moderation response completed."
```

Other useful queue views:

```bash
# Cases currently under review
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue --status reviewing

# Closed and open cases together, at most 100
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue --status all --limit 100
```

The CLI outputs JSON so its results can later be consumed by a private admin interface without
changing the moderation data model.

## Safety rules

1. Do not expose this CLI or the SQLite file through Nginx.
2. Do not treat report count alone as proof. A moderator should review context before taking action.
3. Do not put recovery codes, session cookies, IP addresses or other credentials in moderation
   notes.
4. Use a stable moderator identifier so the audit trail remains understandable.
5. If the CLI reports a SQLite lock, wait a moment and retry rather than copying or editing the live
   database manually.
