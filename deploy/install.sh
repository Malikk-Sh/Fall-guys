#!/usr/bin/env bash
#
# Установка Wobble Rush 3D на чистый Ubuntu/Debian VPS.
#
# Запускать от root на сервере:
#   curl -fsSL https://raw.githubusercontent.com/Malikk-Sh/Fall-guys/main/deploy/install.sh | bash
# либо, если репозиторий уже склонирован:
#   bash deploy/install.sh
#
# Скрипт идемпотентный: повторный запуск обновляет код и перезапускает службу, ничего не ломая.
# Настройки берутся из окружения:
#
#   DOMAIN=example.com   — если есть домен. Тогда же будет предложен сертификат.
#   REPO=...             — адрес репозитория (по умолчанию — этот).
#   BRANCH=main          — какую ветку разворачивать.

set -euo pipefail

REPO="${REPO:-https://github.com/Malikk-Sh/Fall-guys.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-}"
APP_DIR=/opt/wobble
APP_USER=wobble
NODE_MAJOR=22

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запускать нужно от root: sudo bash deploy/install.sh" >&2
  exit 1
fi

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx ufw

say "Node.js ${NODE_MAJOR}"
# Проверяем не только наличие node, но и версию: в репозиториях Debian она обычно слишком старая,
# а игре нужен минимум 20.19.
current_major="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${current_major:-0}" -lt 20 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    >/etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v

say "Пользователь ${APP_USER}"
# Системный пользователь без оболочки: игре незачем уметь логиниться.
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

say "Код в ${APP_DIR}"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
else
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

say "Зависимости"
# --omit=dev: на сервере не нужны ни линтер, ни playwright.
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

say "Настройки"
if [ ! -f /etc/wobble.env ]; then
  cp "$APP_DIR/deploy/wobble.env.example" /etc/wobble.env
  if [ -n "$DOMAIN" ]; then
    sed -i "s|ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=https://${DOMAIN}|" /etc/wobble.env
  else
    # Без домена играть можно по адресу сервера, но тогда список источников оставляем пустым:
    # иначе он запретит единственный работающий вариант.
    sed -i "s|^ALLOWED_ORIGINS=.*|# ALLOWED_ORIGINS задать после появления домена|" /etc/wobble.env
  fi
  chmod 600 /etc/wobble.env
  echo "создан /etc/wobble.env"
else
  echo "/etc/wobble.env уже есть — не трогаю"
fi

say "Служба"
cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service
systemctl daemon-reload
systemctl enable wobble >/dev/null
systemctl restart wobble

say "Nginx"
site=/etc/nginx/sites-available/wobble
cp "$APP_DIR/deploy/nginx.conf" "$site"
if [ -n "$DOMAIN" ]; then
  sed -i "s/server_name example.com;/server_name ${DOMAIN};/" "$site"
else
  # Без домена принимаем любое имя — игра будет доступна по адресу сервера.
  sed -i "s/server_name example.com;/server_name _;/" "$site"
fi
ln -sfn "$site" /etc/nginx/sites-enabled/wobble
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

say "Файрвол"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ufw status | head -n 8

say "Проверка"
sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null; then
  echo "сервер отвечает"
else
  warn "сервер не отвечает — смотрите: journalctl -u wobble -n 50 --no-pager"
  exit 1
fi

say "Готово"
if [ -n "$DOMAIN" ]; then
  echo "Игра: http://${DOMAIN}"
  echo
  echo "Теперь сертификат (HTTPS обязателен: без него не работают кнопка «поделиться»"
  echo "ссылкой-приглашением и часть возможностей мобильных браузеров):"
  echo
  echo "  apt-get install -y certbot python3-certbot-nginx"
  echo "  certbot --nginx -d ${DOMAIN}"
else
  ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo 'адрес-сервера')"
  echo "Игра: http://${ip}"
  echo
  warn "Домена нет, поэтому HTTPS тоже нет. Играть можно, но кнопка «поделиться ссылкой»"
  warn "в мобильных браузерах работать не будет — она требует защищённого соединения."
  warn "Когда появится домен: перезапустите скрипт с DOMAIN=ваш-домен и выпустите сертификат."
fi
echo
echo "Логи:        journalctl -u wobble -f"
echo "Перезапуск:  systemctl restart wobble"
echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"
