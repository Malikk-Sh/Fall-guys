#!/usr/bin/env bash
# Fails when the configured production backup is stale and optionally sends a generic webhook alert.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/wobble.env}"

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/var/lib/wobble/backups}"
ALERT_STAMP="${BACKUP_ALERT_STAMP:-$BACKUP_DIR/last-alert-at}"
ALERT_COOLDOWN="${BACKUP_ALERT_COOLDOWN_SECONDS:-21600}"

set +e
status_output="$(/usr/bin/node "$APP_DIR/server/backupCli.mjs" status 2>&1)"
status_code=$?
set -e

if [ "$status_code" -eq 0 ]; then
  rm -f "$ALERT_STAMP"
  exit 0
fi

message="Wobble Rush backup is stale or unavailable: $status_output"
printf '%s\n' "$message" >&2
logger -t wobble-backup -p daemon.err -- "$message" 2>/dev/null || true

now="$(date +%s)"
last=0
if [ -f "$ALERT_STAMP" ]; then
  last="$(cat "$ALERT_STAMP" 2>/dev/null || echo 0)"
fi

if [ -n "${BACKUP_ALERT_WEBHOOK_URL:-}" ] &&
  { ! [[ "$last" =~ ^[0-9]+$ ]] || [ $((now - last)) -ge "$ALERT_COOLDOWN" ]; }; then
  payload="$(/usr/bin/node -e 'console.log(JSON.stringify({event:"wobble_backup_stale",message:process.argv[1]}))' "$message")"
  if curl -fsS --max-time 10 \
    -H 'content-type: application/json' \
    --data "$payload" \
    "$BACKUP_ALERT_WEBHOOK_URL" >/dev/null; then
    printf '%s\n' "$now" >"$ALERT_STAMP"
  else
    logger -t wobble-backup -p daemon.err -- "backup alert webhook delivery failed" 2>/dev/null || true
  fi
fi

exit "$status_code"
