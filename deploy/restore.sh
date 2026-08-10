#!/usr/bin/env bash
# Restore Wobble Rush from a verified SQLite backup.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/wobble.env}"
APP_USER="${APP_USER:-wobble}"
APP_GROUP="${APP_GROUP:-wobble}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "restore must run as root: sudo bash deploy/restore.sh <backup.db>" >&2
  exit 1
fi

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

DB="${LEADERBOARD_DB:-/var/lib/wobble/leaderboard.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/wobble/backups}"
BACKUP="${1:-}"
if [ -z "$BACKUP" ]; then
  echo "usage: $0 /path/to/backup.db" >&2
  exit 2
fi
BACKUP="$(readlink -f "$BACKUP")"

say "Verify requested backup"
/usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$BACKUP"

# Prepare all rollback storage before touching the running service.
mkdir -p "$BACKUP_DIR/restore-rollback"
chown "$APP_USER:$APP_GROUP" "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"

say "Stop application"
systemctl stop wobble
rollback=""
if [ -f "$DB" ]; then
  rollback="$BACKUP_DIR/restore-rollback/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"
  if ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" snapshot "$DB" "$rollback" ||
    ! chown "$APP_USER:$APP_GROUP" "$rollback" ||
    ! chmod 600 "$rollback"; then
    warn "pre-restore rollback snapshot failed; original database has not been replaced"
    systemctl start wobble || warn "could not restart the untouched server"
    exit 1
  fi
  echo "rollback snapshot: $rollback"
fi

rollback_previous() {
  local reason="$1"
  warn "$reason"
  if [ -z "$rollback" ] || [ ! -f "$rollback" ]; then
    warn "no previous database snapshot is available for automatic rollback"
    return 1
  fi
  systemctl stop wobble >/dev/null 2>&1 || true
  if ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" restore-file "$rollback" "$DB"; then
    warn "automatic rollback restore-file failed"
    return 1
  fi
  chown "$APP_USER:$APP_GROUP" "$DB" || return 1
  chmod 600 "$DB" || return 1
  systemctl start wobble || return 1
  sleep 2
  systemctl start wobble-backup.service >/dev/null 2>&1 || true
  bash "$APP_DIR/deploy/smoke.sh" --require-backup >/dev/null 2>&1 || true
  warn "previous database was restored from $rollback"
  return 0
}

say "Install restored database atomically"
if ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" restore-file "$BACKUP" "$DB" ||
  ! chown "$APP_USER:$APP_GROUP" "$DB" ||
  ! chmod 600 "$DB"; then
  rollback_previous "restored database could not be installed safely" || true
  exit 1
fi

say "Start server and migrate if backup schema is older"
if ! systemctl start wobble; then
  rollback_previous "server failed to start after restore" || true
  exit 1
fi
sleep 2

# Produce a new, verified backup of the restored-and-migrated state before declaring success.
if ! systemctl start wobble-backup.service; then
  rollback_previous "post-restore backup failed" || true
  exit 1
fi

say "Post-restore smoke"
if ! bash "$APP_DIR/deploy/smoke.sh" --require-backup; then
  rollback_previous "post-restore smoke failed" || true
  exit 1
fi

say "Restore complete"
echo "database: $DB"
echo "source backup: $BACKUP"
if [ -n "$rollback" ]; then
  echo "pre-restore rollback snapshot kept at: $rollback"
fi
