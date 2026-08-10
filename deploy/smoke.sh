#!/usr/bin/env bash
# Small production smoke used after deploy and restore.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/wobble.env}"
REQUIRE_BACKUP=0
[ "${1:-}" = "--require-backup" ] && REQUIRE_BACKUP=1

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

PORT="${PORT:-3000}"
BASE_URL="${SMOKE_URL:-http://127.0.0.1:${PORT}}"
ORIGIN="${SMOKE_ORIGIN:-}"
if [ -z "$ORIGIN" ] && [ -n "${ALLOWED_ORIGINS:-}" ]; then
  ORIGIN="${ALLOWED_ORIGINS%%,*}"
fi
ORIGIN="${ORIGIN:-http://127.0.0.1:${PORT}}"

curl -fsS --max-time 5 "$BASE_URL/health/live" >/dev/null
curl -fsS --max-time 5 "$BASE_URL/health/ready" >/dev/null
health="$(curl -fsS --max-time 5 "$BASE_URL/health")"
curl -fsS --max-time 5 "$BASE_URL/" | grep -q 'WOBBLE'

/usr/bin/node - "$health" "$REQUIRE_BACKUP" <<'NODE'
const health = JSON.parse(process.argv[2]);
const requireBackup = process.argv[3] === '1';
if (health.ok !== true || health.service !== 'wobble-rush-3d') {
  throw new Error('unexpected /health payload');
}
if (requireBackup) {
  if (!health.backup?.required) throw new Error('persistent server does not report backup as required');
  if (!health.backup?.available) throw new Error('no successful backup is visible in /health');
  if (health.backup?.stale) throw new Error(`backup is stale: ${JSON.stringify(health.backup)}`);
  if (health.backup?.integrity !== 'ok') throw new Error('last backup did not pass integrity_check');
}
NODE

# A successful HTTP page is not enough for this game: co-op depends on the WebSocket upgrade.
# Connect through the local listener but send the production Origin so strict origin checks stay active.
cd "$APP_DIR"
/usr/bin/node - "$BASE_URL" "$ORIGIN" <<'NODE'
const WebSocket = require('ws');
const [base, origin] = process.argv.slice(2);
const wsUrl = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
const socket = new WebSocket(wsUrl, { headers: { Origin: origin } });
const timeout = setTimeout(() => {
  socket.terminate();
  console.error('WebSocket smoke timed out');
  process.exit(1);
}, 5000);
socket.once('open', () => {
  clearTimeout(timeout);
  socket.close(1000, 'deploy smoke');
});
socket.once('error', error => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});
socket.once('close', () => process.exit(0));
NODE

echo "deploy smoke: ok"
