#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
site="$ROOT/deploy/nginx-shared443-site.conf"
stream="$ROOT/deploy/nginx-shared443-stream.conf"
locations="$ROOT/deploy/nginx-locations.conf"
install="$ROOT/deploy/install.sh"

for file in "$site" "$stream" "$locations" "$install"; do
  test -s "$file"
done

grep -Fq 'return 301 https://$host$request_uri;' "$site"
grep -Fq 'listen 127.0.0.1:8443 ssl;' "$site"
! grep -Eq '^[[:space:]]*listen (\[::\]:)?8443 ssl;' "$site"

grep -Fq 'ssl_preread on;' "$stream"
grep -Fq 'server_name_placeholder  127.0.0.1:8443;' "$stream"
grep -Fq 'default                  fallback_placeholder;' "$stream"

grep -Fq 'location = /admin {' "$locations"
grep -Fq 'absolute_redirect off;' "$locations"
grep -Fq 'return 308 /admin/;' "$locations"
grep -Fq 'location = /admin/ {' "$locations"
grep -Fq 'proxy_pass http://127.0.0.1:3001/admin/index.html;' "$locations"
grep -Fq 'location ^~ /admin/' "$locations"
grep -Fq 'location ^~ /api/admin/' "$locations"
grep -Fq 'proxy_pass http://127.0.0.1:3001;' "$locations"
grep -Fq 'location ~* ^/health/control$' "$locations"
grep -Fq 'location ~* ^/api/admin(?:/|$)' "$locations"
grep -Fq 'location ~* ^/admin(?:/|$)' "$locations"
grep -Fq 'proxy_pass http://127.0.0.1:3000;' "$locations"

grep -Fq "SAVED_SHARED_HTTPS_443='\${SHARED_HTTPS_443}'" "$install"
grep -Fq "SAVED_SHARED_443_FALLBACK='\${SHARED_443_FALLBACK}'" "$install"
grep -Fq 'ufw delete allow "${HTTPS_PORT}/tcp"' "$install"
grep -Fq 'shared HTTPS 443 + public WebSocket verified' "$install"

# If nginx + the dynamic stream module are available (CI installs them), validate the actual
# stream syntax after rendering placeholders. Use an unprivileged test port so CI needs no root.
if command -v nginx >/dev/null 2>&1 && [ -f /usr/lib/nginx/modules/ngx_stream_module.so ]; then
  tmp="$(mktemp -d)"
  upstream_pid=""
  nginx_pid=""
  cleanup() {
    [ -z "$nginx_pid" ] || kill "$nginx_pid" >/dev/null 2>&1 || true
    [ -z "$upstream_pid" ] || kill "$upstream_pid" >/dev/null 2>&1 || true
    [ -z "$nginx_pid" ] || wait "$nginx_pid" >/dev/null 2>&1 || true
    [ -z "$upstream_pid" ] || wait "$upstream_pid" >/dev/null 2>&1 || true
    rm -rf "$tmp"
  }
  trap cleanup EXIT

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

  cp "$locations" "$tmp/locations.conf"
  sed -i \
    -e 's/127\.0\.0\.1:3001/127.0.0.1:13001/g' \
    -e 's/127\.0\.0\.1:3000/127.0.0.1:13000/g' \
    "$tmp/locations.conf"
  mkdir -p "$tmp/client-body" "$tmp/proxy-temp"
  cat >"$tmp/http.conf" <<NGINX
daemon off;
pid $tmp/http.pid;
error_log $tmp/http-error.log;
events {}
http {
    access_log off;
    client_body_temp_path $tmp/client-body;
    proxy_temp_path $tmp/proxy-temp;
    server {
        listen 127.0.0.1:19843;
        server_name wobbles.example;
        include $tmp/locations.conf;
    }
}
NGINX

  node -e 'require("http").createServer((req,res)=>{res.writeHead(200,{"Content-Type":"text/plain"});res.end(req.url)}).listen(13001,"127.0.0.1")' &
  upstream_pid=$!
  nginx -c "$tmp/http.conf" &
  nginx_pid=$!

  ready=0
  for _ in {1..30}; do
    if curl -fsS --max-time 1 http://127.0.0.1:19843/admin/ >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.1
  done
  [ "$ready" -eq 1 ] || {
    cat "$tmp/http-error.log" >&2 || true
    exit 1
  }

  headers="$(curl -sS -D - -o /dev/null --max-redirs 0 http://127.0.0.1:19843/admin)"
  printf '%s\n' "$headers" | grep -Eq '^HTTP/[0-9.]+ 308 '
  printf '%s\n' "$headers" | grep -Eiq '^Location: /admin/\r?$'
  ! printf '%s\n' "$headers" | grep -Eq 'Location: .*:19843|Location: .*:18443'

  admin_body="$(curl -fsS --max-time 2 http://127.0.0.1:19843/admin/)"
  [ "$admin_body" = '/admin/index.html' ] || {
    echo "unexpected canonical admin upstream path: $admin_body" >&2
    exit 1
  }

  kill "$nginx_pid" >/dev/null 2>&1 || true
  wait "$nginx_pid" >/dev/null 2>&1 || true
  nginx_pid=""
  kill "$upstream_pid" >/dev/null 2>&1 || true
  wait "$upstream_pid" >/dev/null 2>&1 || true
  upstream_pid=""
fi

echo 'shared-443 deploy config: ok'
node deploy/verify-loopback-lookup.cjs
