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
#   DOMAIN=example.com   — если есть домен. Тогда же выпускается сертификат.
#   HTTPS_PORT=8443      — если 443 занят (например, там VPN). Ссылка выйдет https://домен:8443.
#   ENABLE_FIREWALL=1    — включить ufw, если он выключен. По умолчанию НЕ включаем: на сервере
#                          с другими сервисами это закрыло бы их порты вслепую.
#   REPO=...             — адрес репозитория (по умолчанию — этот).
#   BRANCH=main          — какую ветку разворачивать.
#
# Указывать их нужно только когда что-то меняется: удачные значения запоминаются, и обновление
# сводится к `bash deploy/install.sh` без переменных.

set -euo pipefail

APP_DIR=/opt/wobble
APP_USER=wobble
NODE_MAJOR=22
# Минимальная пригодная версия целиком, а не только старший номер: node:sqlite появился в 22.5,
# и на 22.4 служба упадёт на первом же require. Должно совпадать с engines в package.json.
NODE_MIN=22.5

# Настройки прошлого удачного развёртывания.
#
# Без этого файла обновление командой без переменных выглядело как обычный повторный запуск, а на
# деле разворачивало заново «как в первый раз»: без домена и на 443. Рабочий конфиг с TLS при этом
# молча заменялся на HTTP по адресу сервера, и сайт переставал открываться. Хуже всего, что финальная
# подсказка самого скрипта предлагала обновляться именно так — он противоречил сам себе.
DEPLOY_CONF=/etc/wobble-deploy.conf
SAVED_DOMAIN=""
SAVED_HTTPS_PORT=""
# shellcheck source=/dev/null
[ -f "$DEPLOY_CONF" ] && . "$DEPLOY_CONF"

REPO="${REPO:-https://github.com/Malikk-Sh/Fall-guys.git}"
BRANCH="${BRANCH:-main}"
# Окружение важнее запомненного: так настройки меняют, а не только наследуют.
DOMAIN="${DOMAIN:-$SAVED_DOMAIN}"
HTTPS_PORT="${HTTPS_PORT:-$SAVED_HTTPS_PORT}"
HTTPS_PORT="${HTTPS_PORT:-443}"
ENABLE_FIREWALL="${ENABLE_FIREWALL:-}"

# Признак перезапуска самого себя — см. блок про подмену скрипта ниже.
reexeced=0
[ "${1:-}" = "--reexec" ] && reexeced=1
[ "${WOBBLE_REEXEC:-0}" = "1" ] && reexeced=1

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запускать нужно от root: sudo bash deploy/install.sh" >&2
  exit 1
fi

# Что именно разворачиваем — до того, как что-то изменится. Развёртывание не туда, куда человек
# рассчитывал, должно быть видно с первой строки, а не по итоговой ссылке.
if [ -n "$DOMAIN" ]; then
  say "Развёртывание: ${DOMAIN}, HTTPS на порту ${HTTPS_PORT}"
else
  say "Развёртывание без домена: игра будет доступна по адресу сервера, без HTTPS"
  [ -n "$SAVED_DOMAIN" ] || warn "если домен есть, запустите с DOMAIN=ваш-домен"
fi

say "Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git nginx ufw

say "Node.js ${NODE_MAJOR}"
# Сравниваем ПОЛНУЮ версию с требуемой, а не старший номер с зашитой цифрой.
#
# Раньше здесь стояло «меньше 20 — ставим», и это тихо ломало обновление: на сервере, где Node 20
# уже стоял, шаг пропускался целиком. Пока игре хватало 20.19, это было незаметно. Потом таблица
# рекордов переехала на встроенный node:sqlite (появился в 22.5) — и установщик стал молча
# оставлять непригодную версию: сборка проходила, служба падала на первом require, а наружу это
# выглядело как «сервер не отвечает», без единого намёка на настоящую причину.
#
# Сравнение через sort -V, потому что нужны и минорные: 22.4 не подходит, 22.5 подходит.
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
  # Именно install, а не «install только если нет»: apt обновит уже стоявший nodejs до версии из
  # репозитория NodeSource.
  apt-get install -y -qq nodejs
fi
node -v

# Останавливаемся здесь, а не через полминуты на неотвечающем сервере. Раньше установка шла дальше
# и падала в самом конце проверкой доступности — причину приходилось искать в journalctl.
if ! node_ok; then
  echo "!! Node $(node -v 2>/dev/null || echo 'не установлен') — игре нужен минимум v${NODE_MIN}." >&2
  echo "!! Таблица рекордов работает на встроенном node:sqlite, он появился в 22.5." >&2
  exit 1
fi

say "Пользователь ${APP_USER}"
# Системный пользователь без оболочки: игре незачем уметь логиниться.
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

say "Код в ${APP_DIR}"
# Каталог принадлежит пользователю wobble (chown ниже), а git здесь работает от root.
#
# Начиная с версии 2.35 git отказывается работать в репозитории, чей владелец отличается от
# запустившего команду: "detected dubious ownership". Без этого исключения первый запуск проходит
# (каталога ещё нет, клонируем и только потом отдаём владение), а любой повторный обрывается на
# обновлении кода — то есть ломается ровно то, ради чего скрипт делался идемпотентным.
#
# Проверка перед добавлением обязательна: --add дописывает строку всякий раз, и без неё
# ~/.gitconfig распухал бы на одну запись за запуск.
if ! git config --global --get-all safe.directory 2>/dev/null | grep -qx "$APP_DIR"; then
  git config --global --add safe.directory "$APP_DIR"
fi

self="$APP_DIR/deploy/install.sh"
before=""
[ -f "$self" ] && before="$(sha256sum "$self" | cut -d' ' -f1)"

if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/${BRANCH}"
else
  rm -rf "$APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# Установщик лежит в том же репозитории, который сам же и обновляет, — и это ловушка.
#
# bash читает скрипт с диска по мере выполнения. К этому моменту git уже подменил файл новой
# версией, но выполняться продолжает старая: та, что была прочитана при запуске. Значит любое
# исправление самого установщика вступает в силу только со следующего запуска — молча, без
# единого признака, что запущено не то, что лежит на диске. Отладка такого занимает часы:
# в репозитории исправление есть, на сервере оно не срабатывает.
#
# Сравниваем контрольную сумму до и после обновления. Изменилась — перезапускаемся новой версией.
# Переменные окружения (DOMAIN, HTTPS_PORT и прочие) переживают exec, повторять их не нужно.
#
# Метка о перезапуске передаётся АРГУМЕНТОМ, а не только переменной окружения. Наблюдался запуск
# с двойным перезапуском, хотя переменная должна была его остановить после первого; аргументы
# доходят до нового процесса при любом состоянии окружения, поэтому защита опирается на них.
if [ -n "$before" ] && [ "$reexeced" != "1" ] &&
  [ "$before" != "$(sha256sum "$self" | cut -d' ' -f1)" ]; then
  say "Установщик обновился — перезапускаю свежую версию"
  export WOBBLE_REEXEC=1
  exec bash "$self" --reexec
fi

say "Зависимости"
# --omit=dev: на сервере не нужны ни линтер, ни playwright.
cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

say "Настройки"
if [ ! -f /etc/wobble.env ]; then
  cp "$APP_DIR/deploy/wobble.env.example" /etc/wobble.env
  if [ -n "$DOMAIN" ]; then
    # Порт входит в Origin, если он нестандартный: браузер пришлёт https://домен:8443.
    origin="https://${DOMAIN}"
    [ "$HTTPS_PORT" != "443" ] && origin="https://${DOMAIN}:${HTTPS_PORT}"
    sed -i "s|ALLOWED_ORIGINS=.*|ALLOWED_ORIGINS=${origin}|" /etc/wobble.env
  else
    # Без домена играть можно по адресу сервера, но тогда список источников оставляем пустым:
    # иначе он запретит единственный работающий вариант.
    sed -i "s|^ALLOWED_ORIGINS=.*|# ALLOWED_ORIGINS задать после появления домена|" /etc/wobble.env
  fi
  chmod 600 /etc/wobble.env
  echo "создан /etc/wobble.env"
else
  echo "/etc/wobble.env уже есть — не трогаю"
  # Но о новых настройках предупреждаем.
  #
  # Файл сознательно не переписывается: там боевые значения, и затирать их обновлением нельзя.
  # Обратная сторона — новые настройки на давно работающий сервер не попадают никогда, а замечается
  # это не сразу: LEADERBOARD_DB, например, при отсутствии просто оставляет таблицу рекордов в
  # памяти, и она исчезает при каждом перезапуске. Сервер при этом работает, поэтому пропущенную
  # строку легко не заметить.
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
fi

say "Служба"
cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service
systemctl daemon-reload
systemctl enable wobble >/dev/null
systemctl restart wobble

say "Nginx"
site=/etc/nginx/sites-available/wobble
# Общая часть (проксирование игры и сокета) лежит отдельно и подключается include — чтобы два
# варианта server-блока не разъезжались между собой.
cp "$APP_DIR/deploy/nginx-locations.conf" /etc/nginx/wobble-locations.conf

cert_dir="/etc/letsencrypt/live/${DOMAIN}"
have_cert=0
[ -n "$DOMAIN" ] && [ -f "${cert_dir}/fullchain.pem" ] && have_cert=1

if [ "$HTTPS_PORT" = "443" ]; then
  cp "$APP_DIR/deploy/nginx.conf" "$site"
  if [ -n "$DOMAIN" ]; then
    sed -i "s/server_name example.com;/server_name ${DOMAIN};/" "$site"
  else
    # Без домена принимаем любое имя — игра будет доступна по адресу сервера.
    sed -i "s/server_name example.com;/server_name _;/" "$site"
  fi
else
  # 443 занят: TLS переезжает на другой порт, а 80 остаётся под проверку Let's Encrypt.
  [ -n "$DOMAIN" ] || { echo "HTTPS_PORT без DOMAIN бессмысленен: сертификат выдают на имя" >&2; exit 1; }
  mkdir -p /var/www/certbot
  cp "$APP_DIR/deploy/nginx-altport.conf" "$site"
  sed -i "s/server_name example.com;/server_name ${DOMAIN};/g" "$site"
  sed -i "s|https://\$host:8443|https://\$host:${HTTPS_PORT}|" "$site"
  sed -i "s/listen 8443 ssl;/listen ${HTTPS_PORT} ssl;/" "$site"
  sed -i "s/listen \[::\]:8443 ssl;/listen [::]:${HTTPS_PORT} ssl;/" "$site"
  sed -i "s|/etc/letsencrypt/live/example.com/|${cert_dir}/|g" "$site"

  if [ "$have_cert" -eq 0 ]; then
    # Сертификата ещё нет — nginx не запустится, сославшись на несуществующий файл.
    #
    # Пишем временный конфиг только на порт 80: он отдаёт каталог проверки Let's Encrypt и
    # саму игру. Игру — потому что иначе до выпуска сертификата нечем проверить, что установка
    # вообще удалась. Повторный запуск скрипта заменит это на полный вариант с TLS.
    warn "сертификата ещё нет — поднимаю только порт 80 под проверку Let's Encrypt"
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

ln -sfn "$site" /etc/nginx/sites-enabled/wobble
rm -f /etc/nginx/sites-enabled/default
# Отдельная директива `http2 on;` появилась только в nginx 1.25.1, а в Ubuntu 24.04 — актуальной
# LTS — ставится 1.24, которая обрывается на ней с `unknown directive "http2"`.
#
# Версию не выясняем: спрашиваем сам nginx. Сравнение номеров врёт на сборках вроде openresty и на
# nginx, собранном без модуля http_v2, а его собственный вердикт верен всегда. До 1.25.1 http2
# включался параметром у listen — эта форма понятна и новым версиям, но объявлена там устаревшей и
# печатает предупреждение при каждой перезагрузке, поэтому по умолчанию пишем современный вариант
# и откатываемся к старому, только если этот не приняли.
if ! nginx_out="$(nginx -t 2>&1)"; then
  if printf '%s' "$nginx_out" | grep -q 'unknown directive "http2"'; then
    warn "nginx не знает директиву http2 — записываю её параметром listen"
    sed -i -e '/^[[:space:]]*http2 on;$/d' \
      -e 's|^\([[:space:]]*listen [0-9]\+\) ssl;|\1 ssl http2;|' \
      -e 's|^\([[:space:]]*listen \[::\]:[0-9]\+\) ssl;|\1 ssl http2;|' \
      "$site"
    nginx -t
  else
    printf '%s\n' "$nginx_out" >&2
    exit 1
  fi
fi
systemctl reload nginx

say "Файрвол"
# Правила добавляем всегда, а вот ВКЛЮЧАТЬ ufw вслепую нельзя.
#
# На сервере может уже работать что-то ещё — VPN, панель управления, чужой сайт. Включение
# файрвола с одними только нашими правилами закроет их порты, и человек потеряет доступ туда,
# куда заходил минуту назад. Поэтому включаем, только если ufw уже активен либо это явно
# разрешили переменной.
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 80/tcp >/dev/null 2>&1 || true
[ "$HTTPS_PORT" != "443" ] || ufw allow 443/tcp >/dev/null 2>&1 || true
[ "$HTTPS_PORT" = "443" ] || ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 || true
# Порт приложения снаружи не нужен: наружу смотрит только Nginx.
ufw delete allow 3000/tcp >/dev/null 2>&1 || true

# Именно "Status: active", а не поиск подстроки "active": строка "Status: inactive" её тоже
# содержит, и проверка срабатывала бы всегда. LC_ALL=C — чтобы вывод не зависел от локали.
if LC_ALL=C ufw status 2>/dev/null | head -1 | grep -q "Status: active"; then
  ufw status | head -n 10
elif [ "$ENABLE_FIREWALL" = "1" ]; then
  ufw --force enable >/dev/null
  ufw status | head -n 10
else
  warn "ufw выключен, и я его не включаю: на сервере могут работать другие сервисы,"
  warn "чьи порты закрылись бы вслед за включением. Правила уже добавлены — когда"
  warn "убедитесь, что все нужные порты в списке, включите сам: ufw enable"
  ufw status | head -n 10 || true
fi

say "Проверка"
sleep 2
if curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null; then
  echo "сервер отвечает"
else
  warn "сервер не отвечает — смотрите: journalctl -u wobble -n 50 --no-pager"
  exit 1
fi

# Запоминаем настройки только теперь, когда развёртывание доказанно удалось. Сохранять их раньше
# значило бы закрепить набор, на котором всё сломалось, и молча воспроизводить его при каждом
# следующем запуске.
cat >"$DEPLOY_CONF" <<CONF
# Настройки последнего удачного развёртывания Wobble Rush 3D.
# Их подставляет deploy/install.sh, когда запущен без переменных окружения.
SAVED_DOMAIN='${DOMAIN}'
SAVED_HTTPS_PORT='${HTTPS_PORT}'
CONF

say "Готово"
if [ -n "$DOMAIN" ] && [ "$HTTPS_PORT" != "443" ]; then
  if [ "$have_cert" -eq 1 ]; then
    echo "Игра: https://${DOMAIN}:${HTTPS_PORT}"
  else
    echo "Порт 80 поднят, игра пока доступна только по адресу сервера."
    echo
    echo "Теперь сертификат. Плагин --nginx здесь НЕ подходит: он попытается занять 443,"
    echo "который у вас занят, и уронит конфигурацию. Выпускаем через каталог проверки:"
    echo
    echo "  apt-get install -y certbot"
    echo "  certbot certonly --webroot -w /var/www/certbot -d ${DOMAIN} \\"
    echo "    --agree-tos --register-unsafely-without-email --non-interactive"
    echo "  bash ${APP_DIR}/deploy/install.sh   # повторный запуск допишет TLS на ${HTTPS_PORT}"
    echo
    echo "После этого игра будет на https://${DOMAIN}:${HTTPS_PORT}"
  fi
elif [ -n "$DOMAIN" ]; then
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
