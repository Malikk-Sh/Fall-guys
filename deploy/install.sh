#!/usr/bin/env bash
#
# Установка/обновление Wobble Rush 3D на Ubuntu/Debian VPS.
#
# Основные режимы HTTPS:
#   1) DOMAIN=example.com HTTPS_PORT=443
#      Обычный сайт на 443.
#   2) DOMAIN=example.com HTTPS_PORT=8443
#      Сайт публично на нестандартном порту.
#   3) DOMAIN=example.com HTTPS_PORT=8443 SHARED_HTTPS_443=1 \
#        SHARED_443_FALLBACK=127.0.0.1:14443
#      Общий внешний 443: Nginx stream читает только TLS SNI. DOMAIN идёт на Wobble,
#      всё остальное без расшифровки передаётся другому TLS-сервису (например Xray/REALITY).
#      HTTPS_PORT в этом режиме — ВНУТРЕННИЙ TLS-порт Wobble; пользователю он не виден.
#
# Удачные параметры сохраняются в /etc/wobble-deploy.conf, поэтому последующие обновления — просто:
#   bash /opt/wobble/deploy/install.sh

set -euo pipefail

APP_DIR=/opt/wobble
APP_USER=wobble
NODE_MAJOR=22
NODE_MIN=22.5
DEPLOY_CONF=/etc/wobble-deploy.conf

SAVED_DOMAIN=""
SAVED_HTTPS_PORT=""
SAVED_SHARED_HTTPS_443="0"
SAVED_SHARED_443_FALLBACK="127.0.0.1:14443"
SAVED_RELEASE_TAG=""
# shellcheck source=/dev/null
[ -f "$DEPLOY_CONF" ] && . "$DEPLOY_CONF"

REPO="${REPO:-https://github.com/Malikk-Sh/Fall-guys.git}"
BRANCH="${BRANCH:-main}"
# An explicitly empty RELEASE_TAG switches back to branch deployment; otherwise the last
# successful release remains pinned across ordinary no-argument updates.
RELEASE_TAG="${RELEASE_TAG-${SAVED_RELEASE_TAG:-}}"
RELEASE_REPOSITORY="${RELEASE_REPOSITORY:-Malikk-Sh/Fall-guys}"
DOMAIN="${DOMAIN:-$SAVED_DOMAIN}"
HTTPS_PORT="${HTTPS_PORT:-$SAVED_HTTPS_PORT}"
HTTPS_PORT="${HTTPS_PORT:-443}"
SHARED_HTTPS_443="${SHARED_HTTPS_443:-${SAVED_SHARED_HTTPS_443:-0}}"
SHARED_443_FALLBACK="${SHARED_443_FALLBACK:-${SAVED_SHARED_443_FALLBACK:-127.0.0.1:14443}}"
ENABLE_FIREWALL="${ENABLE_FIREWALL:-}"

reexeced=0
[ "${1:-}" = "--reexec" ] && reexeced=1
[ "${WOBBLE_REEXEC:-0}" = "1" ] && reexeced=1

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -ne 0 ]; then
  fail "Запускать нужно от root: sudo bash deploy/install.sh"
fi

if [ -n "$RELEASE_TAG" ] &&
  ! [[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
  fail "RELEASE_TAG должен выглядеть как v2.6.0 или v2.6.0-beta.1"
fi
if [ -n "$RELEASE_TAG" ] &&
  ! [[ "$RELEASE_REPOSITORY" =~ ^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$ ]]; then
  fail "RELEASE_REPOSITORY должен выглядеть как owner/repo"
fi

case "$SHARED_HTTPS_443" in
  0 | 1) ;;
  *) fail "SHARED_HTTPS_443 должен быть 0 или 1" ;;
esac

if [ "$SHARED_HTTPS_443" = "1" ]; then
  [ -n "$DOMAIN" ] || fail "shared-443 требует DOMAIN: SNI маршрутизируется по имени сайта"
  [ "$HTTPS_PORT" != "443" ] || fail "в shared-443 HTTPS_PORT — внутренний порт Wobble и не может быть 443"
  case "$SHARED_443_FALLBACK" in
    *:*) ;;
    *) fail "SHARED_443_FALLBACK задаётся как host:port, например 127.0.0.1:14443" ;;
  esac
fi

if [ -n "$DOMAIN" ]; then
  if [ "$SHARED_HTTPS_443" = "1" ]; then
    say "Развёртывание: ${DOMAIN}, общий внешний 443; Wobble :${HTTPS_PORT} → fallback ${SHARED_443_FALLBACK}"
  else
    say "Развёртывание: ${DOMAIN}, HTTPS на порту ${HTTPS_PORT}"
  fi
else
  say "Развёртывание без домена: игра будет доступна по адресу сервера, без HTTPS"
  [ -n "$SAVED_DOMAIN" ] || warn "если домен есть, запустите с DOMAIN=ваш-домен"
fi

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
packages=(ca-certificates curl gnupg git nginx ufw)
[ "$SHARED_HTTPS_443" = "1" ] && packages+=(libnginx-mod-stream)
apt-get install -y -qq "${packages[@]}"

say "Node.js ${NODE_MAJOR}"
node_ok() {
  local current
  current="$(node -v 2>/dev/null | sed 's/^v//')"
  [ -n "$current" ] || return 1
  [ "$(printf '%s\n%s\n' "$NODE_MIN" "$current" | sort -V | head -n1)" = "$NODE_MIN" ]
}

if ! node_ok; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v
node_ok || fail "Node $(node -v 2>/dev/null || echo 'не установлен') — игре нужен минимум v${NODE_MIN}"

say "Пользователь ${APP_USER}"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

say "Код в ${APP_DIR}"
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR"; then
  git config --global --add safe.directory "$APP_DIR"
fi

self="$APP_DIR/deploy/install.sh"
before=""
[ -f "$self" ] && before="$(sha256sum "$self" | cut -d' ' -f1)"

if [ -n "$RELEASE_TAG" ]; then
  if [ ! -d "$APP_DIR/.git" ]; then
    rm -rf "$APP_DIR"
    git init -q "$APP_DIR"
    git -C "$APP_DIR" remote add origin "$REPO"
  fi
  say "Проверяю опубликованный release ${RELEASE_TAG}"
  release_json="$(
    curl -fsS --max-time 10       -H 'Accept: application/vnd.github+json'       -H 'X-GitHub-Api-Version: 2022-11-28'       "https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${RELEASE_TAG}"
  )" || fail "release ${RELEASE_TAG} ещё не опубликован в GitHub Releases"
  node - "$release_json" "$RELEASE_TAG" <<'NODE'
const release = JSON.parse(process.argv[2]);
const expectedTag = process.argv[3];
if (release.tag_name !== expectedTag || release.draft === true || !release.published_at) {
  throw new Error(`release ${expectedTag} is not published`);
}
NODE

  say "Фиксированный release ${RELEASE_TAG}"
  candidate_ref="refs/wobble-release-candidates/${RELEASE_TAG}"
  git -C "$APP_DIR" fetch --force --depth 1 origin     "+refs/tags/${RELEASE_TAG}:${candidate_ref}"
  remote_release_object="$(git -C "$APP_DIR" rev-parse "$candidate_ref")"
  if local_release_object="$(git -C "$APP_DIR" rev-parse -q --verify "refs/tags/${RELEASE_TAG}" 2>/dev/null)"; then
    [ "$local_release_object" = "$remote_release_object" ] ||
      fail "release tag ${RELEASE_TAG} изменился после первого получения — отказываюсь перезаписывать pin"
  else
    git -C "$APP_DIR" update-ref "refs/tags/${RELEASE_TAG}" "$remote_release_object"
  fi
  git -C "$APP_DIR" update-ref -d "$candidate_ref" >/dev/null 2>&1 || true
  release_commit="$(git -C "$APP_DIR" rev-parse "${RELEASE_TAG}^{commit}")"
  git -C "$APP_DIR" checkout --detach --force "$release_commit"
else
  if [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
  else
    rm -rf "$APP_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
  fi
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

if [ -n "$before" ] && [ "$reexeced" != "1" ] &&
  [ "$before" != "$(sha256sum "$self" | cut -d' ' -f1)" ]; then
  say "Установщик обновился — перезапускаю свежую версию"
  export WOBBLE_REEXEC=1
  exec bash "$self" --reexec
fi

if [ -n "$RELEASE_TAG" ]; then
  say "Проверка release ${RELEASE_TAG}"
  node "$APP_DIR/deploy/check-release.mjs" "$RELEASE_TAG" >/dev/null ||
    fail "release ${RELEASE_TAG} не совпадает с выбранным commit/package version"
fi

say "Зависимости"
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

cert_dir="/etc/letsencrypt/live/${DOMAIN}"
have_cert=0
[ -n "$DOMAIN" ] && [ -f "${cert_dir}/fullchain.pem" ] && [ -f "${cert_dir}/privkey.pem" ] && have_cert=1

origin_for_current_mode() {
  if [ -z "$DOMAIN" ]; then
    printf ''
  elif [ "$have_cert" -eq 0 ]; then
    printf 'http://%s' "$DOMAIN"
  elif [ "$SHARED_HTTPS_443" = "1" ] || [ "$HTTPS_PORT" = "443" ]; then
    printf 'https://%s' "$DOMAIN"
  else
    printf 'https://%s:%s' "$DOMAIN" "$HTTPS_PORT"
  fi
}

desired_origin="$(origin_for_current_mode)"

say "Настройки"
if [ ! -f /etc/wobble.env ]; then
  cp "$APP_DIR/deploy/wobble.env.example" /etc/wobble.env
  if [ -n "$desired_origin" ]; then
    sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=${desired_origin}|" /etc/wobble.env
  else
    sed -i "s|^ALLOWED_ORIGINS=.*|# ALLOWED_ORIGINS задать после появления домена|" /etc/wobble.env
  fi
  chmod 600 /etc/wobble.env
  echo "создан /etc/wobble.env"
else
  echo "/etc/wobble.env уже есть — боевые значения не перезаписываю"
  missing=""
  while IFS='=' read -r key _; do
    case "$key" in
      '' | \#*) continue ;;
    esac
    grep -q "^[[:space:]]*${key}=" /etc/wobble.env || missing="${missing} ${key}"
  done <"$APP_DIR/deploy/wobble.env.example"
  if [ -n "$missing" ]; then
    warn "в /etc/wobble.env нет настроек, появившихся позже:${missing}"
    warn "сверьтесь с ${APP_DIR}/deploy/wobble.env.example и допишите нужные вручную"
  fi

  # Origin — единственная настройка, которую безопасно мигрируем автоматически между нашими
  # собственными схемами адреса. Это не даёт переходу :8443 → shared-443 сломать WebSocket.
  if [ -n "$desired_origin" ]; then
    if grep -q '^ALLOWED_ORIGINS=' /etc/wobble.env; then
      current_origins="$(sed -n 's/^ALLOWED_ORIGINS=//p' /etc/wobble.env | head -n1)"
      legacy_origin="https://${DOMAIN}:${HTTPS_PORT}"
      case ",$current_origins," in
        *",${desired_origin},"*) ;;
        *)
          if [ "$SHARED_HTTPS_443" = "1" ] &&
            { [ "$current_origins" = "$legacy_origin" ] ||
              [ "$current_origins" = "${desired_origin},${legacy_origin}" ] ||
              [ "$current_origins" = "${legacy_origin},${desired_origin}" ]; }; then
            sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=${desired_origin}|" /etc/wobble.env
            echo "ALLOWED_ORIGINS перенесён на ${desired_origin}"
          else
            sed -i "s|^ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=${current_origins},${desired_origin}|" /etc/wobble.env
            warn "добавил новый production Origin ${desired_origin}; старые custom origins сохранены"
          fi
          ;;
      esac
    else
      printf '\nALLOWED_ORIGINS=%s\n' "$desired_origin" >>/etc/wobble.env
    fi
  fi
fi

# Канонический публичный HTTPS Origin нужен operational diagnostics. ALLOWED_ORIGINS может
# содержать несколько разрешённых browser origins, поэтому выбирать из него "первый" для SNI
# нельзя. Эта generated-настройка не секретная и всегда следует текущему deploy mode.
public_origin=""
case "$desired_origin" in
  https://*) public_origin="$desired_origin" ;;
esac
if grep -q '^WOBBLE_PUBLIC_ORIGIN=' /etc/wobble.env; then
  sed -i "s|^WOBBLE_PUBLIC_ORIGIN=.*|WOBBLE_PUBLIC_ORIGIN=${public_origin}|" /etc/wobble.env
else
  printf '\n# Generated by deploy/install.sh for operational TLS/SNI checks.\nWOBBLE_PUBLIC_ORIGIN=%s\n'     "$public_origin" >>/etc/wobble.env
fi

build_sha="$(git -C "$APP_DIR" rev-parse HEAD)"
if grep -q '^WOBBLE_RELEASE_TAG=' /etc/wobble.env; then
  sed -i "s/^WOBBLE_RELEASE_TAG=.*/WOBBLE_RELEASE_TAG=${RELEASE_TAG}/" /etc/wobble.env
else
  printf '\n# Generated by deploy/install.sh for release identity.\nWOBBLE_RELEASE_TAG=%s\n' "$RELEASE_TAG" >>/etc/wobble.env
fi
if grep -q '^WOBBLE_BUILD_SHA=' /etc/wobble.env; then
  sed -i "s/^WOBBLE_BUILD_SHA=.*/WOBBLE_BUILD_SHA=${build_sha}/" /etc/wobble.env
else
  printf '\n# Generated by deploy/install.sh for exact build identity.\nWOBBLE_BUILD_SHA=%s\n' "$build_sha" >>/etc/wobble.env
fi

say "Служба и резервные копии"
cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service
cp "$APP_DIR/deploy/wobble-control.service" /etc/systemd/system/wobble-control.service
cp "$APP_DIR/deploy/wobble-backup.service" /etc/systemd/system/wobble-backup.service
cp "$APP_DIR/deploy/wobble-backup.timer" /etc/systemd/system/wobble-backup.timer
cp "$APP_DIR/deploy/wobble-backup-watch.service" /etc/systemd/system/wobble-backup-watch.service
cp "$APP_DIR/deploy/wobble-backup-watch.timer" /etc/systemd/system/wobble-backup-watch.timer
cp "$APP_DIR/deploy/wobble-backup-verify.service" /etc/systemd/system/wobble-backup-verify.service
cp "$APP_DIR/deploy/wobble-smoke.service" /etc/systemd/system/wobble-smoke.service
cp "$APP_DIR/deploy/wobble-ops.service" /etc/systemd/system/wobble-ops.service
cp "$APP_DIR/deploy/wobble-ops.socket" /etc/systemd/system/wobble-ops.socket
# Важно: privileged helper не запускается из /opt/wobble, которым владеет service-user.
# Иначе компрометация игрового процесса позволила бы заменить root-код перед запуском helper.
install -d -m 0755 -o root -g root /usr/local/lib/wobble-ops
install -m 0755 -o root -g root "$APP_DIR/deploy/wobble-ops-helper.mjs" /usr/local/lib/wobble-ops/helper.mjs
systemctl daemon-reload
systemctl stop wobble-ops.service >/dev/null 2>&1 || true
systemctl enable wobble >/dev/null
systemctl enable wobble-control >/dev/null
systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket >/dev/null
systemctl restart wobble-ops.socket
# Start the helper immediately so a persisted graceful-restart monitor is recovered even before
# another admin request arrives. Restart=on-failure handles an unexpected helper crash afterwards.
systemctl start wobble-ops.service

say "Преддеплойная резервная копия"
database_file="$(
  # shellcheck source=/dev/null
  . /etc/wobble.env
  printf '%s' "${LEADERBOARD_DB:-:memory:}"
)"
backup_root="$(
  # shellcheck source=/dev/null
  . /etc/wobble.env
  printf '%s' "${BACKUP_DIR:-/var/lib/wobble/backups}"
)"

if [ "$database_file" != ":memory:" ] && [ -f "$database_file" ] &&
  sudo -u "$APP_USER" /usr/bin/node "$APP_DIR/server/backupCli.mjs" legacy-check "$database_file" \
    >/dev/null 2>&1; then
  legacy_dir="${backup_root%/}/pre-migration"
  install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$legacy_dir"
  legacy_output="${legacy_dir}/wobble-legacy-$(date -u +%Y%m%dT%H%M%SZ)-${build_sha:0:12}-$$.db"
  warn "обнаружена старая БД без schema_migrations — сохраняю проверенный снимок перед миграцией"
  sudo -u "$APP_USER" /usr/bin/node "$APP_DIR/server/backupCli.mjs" legacy-snapshot \
    "$database_file" "$legacy_output"
  echo "legacy pre-migration backup: $legacy_output"
else
  systemctl start wobble-backup.service
fi

fresh_database=0
if [ "$database_file" != ":memory:" ] && [ ! -f "$database_file" ]; then
  fresh_database=1
  say "Первичная инициализация persistent DB"
  # На совершенно новой установке старой админ-панели ещё нет. Коротко запускаем gameplay,
  # чтобы единственный migration owner создал схему, затем уже поднимаем независимый Control Plane.
  systemctl restart wobble
  bootstrap_ready=0
  for _ in $(seq 1 30); do
    if [ -f "$database_file" ] &&
      curl -fsS --max-time 2 http://127.0.0.1:3000/health/live >/dev/null 2>&1; then
      bootstrap_ready=1
      break
    fi
    sleep 1
  done
  [ "$bootstrap_ready" -eq 1 ] ||
    fail "Wobble не смог создать/migrate persistent DB на первой установке"
fi

say "Независимый Wobble Control"
# Control Plane должен подняться даже если новый gameplay process сломан. Его единственная
# обязательная dependency здесь — существующая persistent DB (или намеренно :memory: в dev).
# Не ждём /health/live: иначе неудачный deploy снова лишил бы оператора панели диагностики.
if [ "$database_file" != ":memory:" ]; then
  database_ready=0
  for _ in $(seq 1 20); do
    if [ -f "$database_file" ]; then
      database_ready=1
      break
    fi
    sleep 1
  done
  [ "$database_ready" -eq 1 ] || fail "persistent DB не появилась перед стартом Wobble Control"
fi

systemctl restart wobble-control
control_ready=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3001/health/control >/dev/null 2>&1; then
    control_ready=1
    break
  fi
  sleep 1
done
[ "$control_ready" -eq 1 ] ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"

remove_shared_stream_include() {
  sed -i \
    -e '\|^[[:space:]]*# Wobble shared HTTPS 443 frontend[[:space:]]*$|d' \
    -e '\|^[[:space:]]*include /etc/nginx/stream-wobble.conf;[[:space:]]*$|d' \
    /etc/nginx/nginx.conf
  rm -f /etc/nginx/stream-wobble.conf
}

ensure_shared_stream_include() {
  if ! grep -qE '^[[:space:]]*include /etc/nginx/stream-wobble\.conf;[[:space:]]*$' /etc/nginx/nginx.conf; then
    cat >>/etc/nginx/nginx.conf <<'NGINX'

# Wobble shared HTTPS 443 frontend
include /etc/nginx/stream-wobble.conf;
NGINX
  fi
}

say "Nginx"
site=/etc/nginx/sites-available/wobble
cp "$APP_DIR/deploy/nginx-locations.conf" /etc/nginx/wobble-locations.conf

if [ "$SHARED_HTTPS_443" = "1" ]; then
  mkdir -p /var/www/certbot
  ensure_shared_stream_include

  cp "$APP_DIR/deploy/nginx-shared443-site.conf" "$site"
  sed -i "s/server_name example.com;/server_name ${DOMAIN};/g" "$site"
  sed -i "s/127\.0\.0\.1:8443/127.0.0.1:${HTTPS_PORT}/g" "$site"
  sed -i "s|/etc/letsencrypt/live/example.com/|${cert_dir}/|g" "$site"

  cp "$APP_DIR/deploy/nginx-shared443-stream.conf" /etc/nginx/stream-wobble.conf
  sed -i "s/server_name_placeholder/${DOMAIN}/g" /etc/nginx/stream-wobble.conf
  sed -i "s/127\.0\.0\.1:8443/127.0.0.1:${HTTPS_PORT}/g" /etc/nginx/stream-wobble.conf
  sed -i "s|fallback_placeholder|${SHARED_443_FALLBACK}|g" /etc/nginx/stream-wobble.conf

  if [ "$have_cert" -eq 0 ]; then
    warn "сертификата ещё нет: 443 пока целиком уходит в fallback; порт 80 оставлен для ACME"
    sed -i "s|${DOMAIN}[[:space:]][[:space:]]*127.0.0.1:${HTTPS_PORT};|${DOMAIN}  ${SHARED_443_FALLBACK};|" \
      /etc/nginx/stream-wobble.conf
    cat >"$site" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    include /etc/nginx/wobble-locations.conf;
    gzip on;
    gzip_types application/javascript text/css application/json;
    gzip_min_length 1024;
    client_max_body_size 64k;
}
NGINX
  fi

  fallback_host="${SHARED_443_FALLBACK%:*}"
  fallback_port="${SHARED_443_FALLBACK##*:}"
  if [ "$fallback_host" = "127.0.0.1" ] || [ "$fallback_host" = "localhost" ]; then
    if ! ss -lntH | awk '{print $4}' | grep -Eq "(^|:)${fallback_port}$"; then
      fail "shared-443 fallback ${SHARED_443_FALLBACK} не слушает. Сначала перенесите Xray/другой TLS-сервис с 443 на этот backend-порт."
    fi
  fi

  if ss -lntpH '( sport = :443 )' 2>/dev/null | grep -q . &&
    ! ss -lntpH '( sport = :443 )' 2>/dev/null | grep -q 'nginx'; then
    fail "порт 443 ещё занят не Nginx. Перенесите внешний TLS/VPN inbound на ${SHARED_443_FALLBACK}, затем повторите установку."
  fi
else
  remove_shared_stream_include
  if [ "$HTTPS_PORT" = "443" ]; then
    cp "$APP_DIR/deploy/nginx.conf" "$site"
    if [ -n "$DOMAIN" ]; then
      sed -i "s/server_name example.com;/server_name ${DOMAIN};/" "$site"
    else
      sed -i "s/server_name example.com;/server_name _;/" "$site"
    fi
  else
    [ -n "$DOMAIN" ] || fail "HTTPS_PORT без DOMAIN бессмысленен: сертификат выдают на имя"
    mkdir -p /var/www/certbot
    cp "$APP_DIR/deploy/nginx-altport.conf" "$site"
    sed -i "s/server_name example.com;/server_name ${DOMAIN};/g" "$site"
    sed -i "s|https://\$host:8443|https://\$host:${HTTPS_PORT}|" "$site"
    sed -i "s/listen 8443 ssl;/listen ${HTTPS_PORT} ssl;/" "$site"
    sed -i "s/listen \[::\]:8443 ssl;/listen [::]:${HTTPS_PORT} ssl;/" "$site"
    sed -i "s|/etc/letsencrypt/live/example.com/|${cert_dir}/|g" "$site"

    if [ "$have_cert" -eq 0 ]; then
      warn "сертификата ещё нет — поднимаю порт 80 под проверку Let's Encrypt"
      cat >"$site" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    include /etc/nginx/wobble-locations.conf;
    gzip on;
    gzip_types application/javascript text/css application/json;
    gzip_min_length 1024;
    client_max_body_size 64k;
}
NGINX
    fi
  fi
fi

ln -sfn "$site" /etc/nginx/sites-enabled/wobble
rm -f /etc/nginx/sites-enabled/default

if ! nginx_out="$(nginx -t 2>&1)"; then
  if printf '%s' "$nginx_out" | grep -q 'unknown directive "http2"'; then
    warn "nginx не знает директиву http2 — записываю её параметром listen"
    sed -i -e '/^[[:space:]]*http2 on;$/d' \
      -e 's|^\([[:space:]]*listen [0-9]\+\) ssl;|\1 ssl http2;|' \
      -e 's|^\([[:space:]]*listen \[::\]:[0-9]\+\) ssl;|\1 ssl http2;|' \
      -e 's|^\([[:space:]]*listen 127\.0\.0\.1:[0-9]\+\) ssl;|\1 ssl http2;|' \
      "$site"
    nginx -t
  else
    printf '%s\n' "$nginx_out" >&2
    exit 1
  fi
fi

if systemctl is-active --quiet nginx; then
  systemctl reload nginx
else
  systemctl restart nginx
fi

if [ "$SHARED_HTTPS_443" = "1" ]; then
  ss -lntpH '( sport = :443 )' 2>/dev/null | grep -q nginx || fail "после reload Nginx не слушает внешний 443"
fi

# Для обычного upgrade это первый restart gameplay в deploy: к этому моменту /admin уже
# обслуживает независимый :3001. Поэтому даже плохой новый build не забирает у оператора панель.
# На fresh install gameplay уже был запущен выше только ради первичной migration; перезапускаем его
# ещё раз после cutover, чтобы порядок и итоговое состояние были одинаковыми во всех режимах.
say "Перезапуск gameplay после переключения Wobble Control"
systemctl restart wobble

if [ -n "$DOMAIN" ] && [ -d /etc/letsencrypt ]; then
  install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/wobble-nginx-reload.sh <<'HOOK'
#!/usr/bin/env bash
set -e
nginx -t
systemctl reload nginx
HOOK
  chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/wobble-nginx-reload.sh
fi

say "Файрвол"
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
if [ "$SHARED_HTTPS_443" = "1" ]; then
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw delete allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
else
  [ "$HTTPS_PORT" != "443" ] || ufw allow 443/tcp >/dev/null 2>&1 || true
  [ "$HTTPS_PORT" = "443" ] || ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
fi
ufw delete allow 3000/tcp >/dev/null 2>&1 || true
ufw delete allow 3001/tcp >/dev/null 2>&1 || true

if LC_ALL=C ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
  ufw status | head -n 14
elif [ "$ENABLE_FIREWALL" = "1" ]; then
  ufw --force enable >/dev/null
  ufw status | head -n 14
else
  warn "ufw выключен, и я его не включаю: на сервере могут работать другие сервисы"
  warn "правила добавлены; проверьте остальные сервисы и включите сами: ufw enable"
  ufw status | head -n 14 || true
fi

say "Проверка"
sleep 2
curl -fsS --max-time 5 http://127.0.0.1:3000/health/live >/dev/null ||
  fail "сервер не отвечает — смотрите journalctl -u wobble -n 50 --no-pager"
curl -fsS --max-time 5 http://127.0.0.1:3001/health/control >/dev/null ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"

say "Проверенная резервная копия после запуска"
systemctl start wobble-backup.service
systemctl start wobble-backup.timer wobble-backup-watch.timer

say "Deploy smoke"
expected_version="$(node -p "require('./package.json').version")"
if SMOKE_EXPECT_VERSION="$expected_version" \
  SMOKE_EXPECT_COMMIT="${build_sha:0:12}" \
  SMOKE_EXPECT_RELEASE="$RELEASE_TAG" \
  bash "$APP_DIR/deploy/smoke.sh" --require-backup; then
  echo "server, health, WebSocket and fresh backup verified"
else
  fail "deploy smoke не прошёл — смотрите journalctl -u wobble -n 100 --no-pager"
fi

if [ "$SHARED_HTTPS_443" = "1" ] && [ "$have_cert" -eq 1 ]; then
  say "Shared-443 public smoke"
  curl -fsS --max-time 7 --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/health/live" >/dev/null ||
    fail "https://${DOMAIN} не проходит через shared-443 SNI frontend"

  node - "$DOMAIN" <<'NODE'
const WebSocket = require('ws');
const loopbackLookup = require('./deploy/loopbackLookup.cjs');
const domain = process.argv[2];
const socket = new WebSocket(`wss://${domain}/ws`, {
  headers: { Origin: `https://${domain}` },
  servername: domain,
  lookup: loopbackLookup,
});
let opened = false;
const timer = setTimeout(() => {
  socket.terminate();
  console.error('shared-443 WebSocket smoke timed out');
  process.exit(1);
}, 7000);
socket.once('open', () => {
  opened = true;
  clearTimeout(timer);
  socket.close(1000, 'shared-443 deploy smoke');
});
socket.once('error', error => {
  clearTimeout(timer);
  console.error(error.message);
  process.exit(1);
});
socket.once('close', () => {
  clearTimeout(timer);
  process.exit(opened ? 0 : 1);
});
NODE
  echo "shared HTTPS 443 + public WebSocket verified"
fi

if ! grep -Eq "^[[:space:]]*BACKUP_OFFSITE_DIR=.+" /etc/wobble.env; then
  warn "off-server backup ещё не настроен: нужна отдельная машина/remote storage, не папка этого VPS."
  warn "Инструкция: $APP_DIR/deploy/PRODUCTION-SAFETY.md"
fi

cat >"$DEPLOY_CONF" <<CONF
# Настройки последнего удачного развёртывания Wobble Rush 3D.
# Их подставляет deploy/install.sh, когда запущен без переменных окружения.
SAVED_DOMAIN='${DOMAIN}'
SAVED_HTTPS_PORT='${HTTPS_PORT}'
SAVED_SHARED_HTTPS_443='${SHARED_HTTPS_443}'
SAVED_SHARED_443_FALLBACK='${SHARED_443_FALLBACK}'
SAVED_RELEASE_TAG='${RELEASE_TAG}'
CONF
chmod 600 "$DEPLOY_CONF"

say "Готово"
if [ "$SHARED_HTTPS_443" = "1" ]; then
  if [ "$have_cert" -eq 1 ]; then
    echo "Игра: https://${DOMAIN}"
    echo "443: SNI ${DOMAIN} → Wobble :${HTTPS_PORT}; default → ${SHARED_443_FALLBACK}"
  else
    echo "Порт 80 поднят для ACME; внешний 443 пока целиком сохраняет fallback-сервис."
    echo
    echo "Выпустите сертификат через webroot (НЕ certbot --nginx):"
    echo "  apt-get install -y certbot"
    echo "  certbot certonly --webroot -w /var/www/certbot -d ${DOMAIN} \\"
    echo "    --agree-tos --register-unsafely-without-email --non-interactive"
    echo "  bash ${APP_DIR}/deploy/install.sh"
  fi
elif [ -n "$DOMAIN" ] && [ "$HTTPS_PORT" != "443" ]; then
  if [ "$have_cert" -eq 1 ]; then
    echo "Игра: https://${DOMAIN}:${HTTPS_PORT}"
  else
    echo "Выпустите сертификат через certbot certonly --webroot и повторите установку."
  fi
elif [ -n "$DOMAIN" ]; then
  if [ "$have_cert" -eq 1 ]; then
    echo "Игра: https://${DOMAIN}"
  else
    echo "Игра: http://${DOMAIN}"
    echo "Для HTTPS установите certbot и выпустите сертификат."
  fi
else
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo 'адрес-сервера')"
  echo "Игра: http://${ip}"
fi

if [ -n "$RELEASE_TAG" ]; then
  echo "Release:     ${RELEASE_TAG} @ ${build_sha:0:12}"
fi

echo
echo "Логи:        journalctl -u wobble -f"
echo "Перезапуск:  systemctl restart wobble"
echo "Backup:      systemctl start wobble-backup.service"
echo "Restore:     sudo bash ${APP_DIR}/deploy/restore.sh /path/to/backup.db"
echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"
