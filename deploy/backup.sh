#!/usr/bin/env bash
# Consistent SQLite backup for the live Wobble database.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/wobble.env}"

# systemd already injects EnvironmentFile before dropping privileges. Manual root runs may source it.
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

DB="${LEADERBOARD_DB:-:memory:}"
if [ "$DB" = ":memory:" ] || [ -z "$DB" ]; then
  echo "backup refused: LEADERBOARD_DB must point to a persistent SQLite file" >&2
  exit 2
fi

# First installation reaches this script before the application has created its database. That is
# the only missing-file case which is not an error; the installer runs backup again after startup.
if [ ! -f "$DB" ]; then
  echo "backup skipped: database does not exist yet: $DB"
  exit 0
fi

exec /usr/bin/node "$APP_DIR/server/backupCli.mjs" create
