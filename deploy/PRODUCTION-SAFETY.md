# Wobble Rush — Production Safety

This document covers the database safety path for the production SQLite database. The database contains accounts, sessions, Google identities, progression, inventory, rewards and social history; losing it is therefore a player-data incident, not merely a leaderboard reset.

## What is automated

`deploy/install.sh` installs two systemd timers:

- `wobble-backup.timer` — hourly verified SQLite backup;
- `wobble-backup-watch.timer` — freshness check every 30 minutes.

A backup is created with SQLite `VACUUM INTO`, not by copying only `leaderboard.db`. The live database uses WAL, so a plain file copy can miss committed rows which still live in `leaderboard.db-wal`.

Every produced backup is opened again and must pass:

1. `PRAGMA integrity_check` = `ok`;
2. a valid `schema_migrations` version;
3. schema version not newer than the running server.

The default local retention is:

- 48 hourly snapshots;
- 7 daily snapshots;
- 4 weekly snapshots;
- 3 monthly snapshots.

Daily/weekly/monthly entries are hard links when the filesystem permits it, so the same verified snapshot is not needlessly duplicated on disk.

## Files and health status

Defaults:

```text
production DB:  /var/lib/wobble/leaderboard.db
backup root:    /var/lib/wobble/backups
status file:    /var/lib/wobble/backups/status.json
```

`/health` exposes only safe metadata — age, integrity result, schema version and whether offsite is current. Absolute filesystem paths are not returned.

Local backup becomes stale after `BACKUP_MAX_AGE_SECONDS` (default: 7200 = 2 hours). The watch unit exits non-zero and writes an error to journald. If `BACKUP_ALERT_WEBHOOK_URL` is set, the same stale condition also posts a generic JSON webhook, rate-limited by `BACKUP_ALERT_COOLDOWN_SECONDS` (default: 6 hours).

Useful commands:

```bash
systemctl status wobble-backup.timer wobble-backup-watch.timer
systemctl list-timers 'wobble-backup*'
journalctl -u wobble-backup.service -u wobble-backup-watch.service -n 100 --no-pager
curl -s http://127.0.0.1:3000/health
```

Run a backup immediately:

```bash
systemctl start wobble-backup.service
```

## Off-server backup

The application deliberately does not choose a cloud provider. Mount storage which physically lives outside the VPS and point `BACKUP_OFFSITE_DIR` at that mount, for example:

```text
BACKUP_OFFSITE_DIR=/mnt/wobble-offsite
BACKUP_OFFSITE_EVERY_SECONDS=86400
BACKUP_OFFSITE_KEEP=30
BACKUP_REQUIRE_OFFSITE=1
BACKUP_OFFSITE_MAX_AGE_SECONDS=129600
```

Examples of suitable mounts are a second server over SSHFS, an S3-compatible bucket mounted with rclone, or provider backup storage mounted into the host. A second directory on the same VPS is **not** an off-server backup.

The backup service runs as the unprivileged `wobble` user, so the mounted directory must be writable by that user. It also requires a sentinel file on the mounted filesystem. This prevents a disappeared mount from silently turning `/mnt/wobble-offsite` into an ordinary local directory on the VPS.

Create the sentinel **while the remote storage is definitely mounted**. The default name is `.wobble-offsite`; it can be changed with `BACKUP_OFFSITE_SENTINEL`.

After configuring the mount:

```bash
sudo -u wobble test -w /mnt/wobble-offsite
sudo -u wobble touch /mnt/wobble-offsite/.wobble-offsite
systemctl start wobble-backup.service
systemctl start wobble-backup-watch.service
```

If the mount or sentinel disappears, the backup code does **not** recreate the directory. Local backup continues, while required offsite freshness becomes stale and the watch alerts.

`BACKUP_REQUIRE_OFFSITE=1` makes stale/missing offsite copies an alert condition. Keep it `0` only while external storage is being commissioned.

## Restore

Never copy a `.db` file over the live database while the server is running.

Use:

```bash
sudo bash /opt/wobble/deploy/restore.sh /var/lib/wobble/backups/daily/<backup>.db
```

The restore path:

1. verifies the requested backup before stopping the game;
2. stops `wobble`;
3. makes a verified pre-restore rollback snapshot of the current database;
4. atomically installs the requested database and removes stale WAL/SHM sidecars;
5. starts the current server, allowing normal migrations if the backup schema is older;
6. creates a fresh verified backup of the restored state;
7. runs the production HTTP + WebSocket smoke test;
8. automatically restores the pre-restore snapshot if startup, backup or smoke fails.

The rollback snapshot is kept after a successful restore for manual inspection.

## Manual disaster-recovery drill

At least once before public beta, perform a full recovery drill in a fresh directory/VPS rather than trusting only unit tests:

1. copy one off-server backup to the recovery host;
2. run `node server/backupCli.mjs verify <backup.db>`;
3. restore it with `deploy/restore.sh` or into an isolated database path;
4. start the server;
5. sign in with a real test Google account;
6. verify inventory/loadout;
7. verify campaign progress and achievements;
8. run `deploy/smoke.sh --require-backup`.

Record the date and total recovery time. A backup that has never been restored is not yet a proven recovery process.

## Deploy safety

`deploy/install.sh` creates a verified pre-deploy backup before restarting the service. After startup it creates another verified backup and runs `deploy/smoke.sh --require-backup`.

The smoke checks:

- `/health/live`;
- `/health/ready`;
- `/health` payload and fresh verified backup status;
- main HTML response;
- a real WebSocket upgrade using the configured production Origin.

A failed pre-deploy backup, post-deploy backup or smoke aborts the installer instead of printing a successful deployment message.
