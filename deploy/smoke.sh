#!/usr/bin/env bash
# Small production smoke used after deploy and restore.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENV_FILE="${ENV_FILE:-/etc/wobble.env}"
REQUIRE_BACKUP=0
[ "${1:-}" = "--require-backup" ] && REQUIRE_BACKUP=1
EXPECT_VERSION="${SMOKE_EXPECT_VERSION:-}"
EXPECT_COMMIT="${SMOKE_EXPECT_COMMIT:-}"
EXPECT_RELEASE="${SMOKE_EXPECT_RELEASE:-}"

if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  set +a
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "deploy smoke: node executable not found" >&2
  exit 127
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
html="$(curl -fsS --max-time 5 "$BASE_URL/")"
grep -q 'WOBBLE' <<<"$html"

"$NODE_BIN" - "$health" "$REQUIRE_BACKUP" "$EXPECT_VERSION" "$EXPECT_COMMIT" "$EXPECT_RELEASE" <<'NODE'
const health = JSON.parse(process.argv[2]);
const requireBackup = process.argv[3] === '1';
const expectedVersion = process.argv[4];
const expectedCommit = process.argv[5];
const expectedRelease = process.argv[6];
if (health.ok !== true || health.service !== 'wobble-rush-3d') {
  throw new Error('unexpected /health payload');
}
if (expectedVersion && health.version !== expectedVersion) {
  throw new Error(`unexpected version: ${health.version}, expected ${expectedVersion}`);
}
if (expectedCommit && health.commit !== expectedCommit) {
  throw new Error(`unexpected commit: ${health.commit}, expected ${expectedCommit}`);
}
if (expectedRelease && health.release !== expectedRelease) {
  throw new Error(`unexpected release: ${health.release}, expected ${expectedRelease}`);
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
"$NODE_BIN" - "$BASE_URL" "$ORIGIN" <<'NODE'
const WebSocket = require('ws');
const [base, origin] = process.argv.slice(2);
const wsBase = base.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:').replace(/\/$/, '');
const socket = new WebSocket(`${wsBase}/ws`, { headers: { Origin: origin } });
let opened = false;
const timeout = setTimeout(() => {
  socket.terminate();
  console.error('WebSocket smoke timed out');
  process.exit(1);
}, 5000);
socket.once('open', () => {
  opened = true;
  clearTimeout(timeout);
  socket.close(1000, 'deploy smoke');
});
socket.once('error', error => {
  clearTimeout(timeout);
  console.error(error.message);
  process.exit(1);
});
socket.once('close', () => {
  clearTimeout(timeout);
  if (!opened) {
    console.error('WebSocket smoke closed before the upgrade completed');
    process.exit(1);
  }
  process.exit(0);
});
NODE

echo "deploy smoke: ok"
