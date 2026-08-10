#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
site="$ROOT/deploy/nginx-shared443-site.conf"
stream="$ROOT/deploy/nginx-shared443-stream.conf"
install="$ROOT/deploy/install.sh"

for file in "$site" "$stream" "$install"; do
  test -s "$file"
done

grep -Fq 'return 301 https://$host$request_uri;' "$site"
grep -Fq 'listen 127.0.0.1:8443 ssl;' "$site"
! grep -Eq '^[[:space:]]*listen (\[::\]:)?8443 ssl;' "$site"

grep -Fq 'ssl_preread on;' "$stream"
grep -Fq 'server_name_placeholder  127.0.0.1:8443;' "$stream"
grep -Fq 'default                  fallback_placeholder;' "$stream"
grep -Fq "SAVED_SHARED_HTTPS_443='\${SHARED_HTTPS_443}'" "$install"
grep -Fq "SAVED_SHARED_443_FALLBACK='\${SHARED_443_FALLBACK}'" "$install"
grep -Fq 'ufw delete allow "${HTTPS_PORT}/tcp"' "$install"
grep -Fq 'shared HTTPS 443 + public WebSocket verified' "$install"

# If nginx + the dynamic stream module are available (CI installs them), validate the actual
# stream syntax after rendering placeholders. Use an unprivileged test port so CI needs no root.
if command -v nginx >/dev/null 2>&1 && [ -f /usr/lib/nginx/modules/ngx_stream_module.so ]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp "$stream" "$tmp/stream.conf"
  sed -i \
    -e 's/server_name_placeholder/wobbles.example/g' \
    -e 's/127\.0\.0\.1:8443/127.0.0.1:18443/g' \
    -e 's/fallback_placeholder/127.0.0.1:14443/g' \
    -e 's/listen 443;/listen 19443;/' \
    -e 's/listen \[::\]:443;/listen [::]:19443;/' \
    "$tmp/stream.conf"
  cat >"$tmp/nginx.conf" <<NGINX
load_module /usr/lib/nginx/modules/ngx_stream_module.so;
pid $tmp/nginx.pid;
error_log $tmp/error.log;
events {}
include $tmp/stream.conf;
NGINX
  nginx -t -c "$tmp/nginx.conf"
fi

echo 'shared-443 deploy config: ok'
