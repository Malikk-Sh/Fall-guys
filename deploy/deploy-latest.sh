#!/usr/bin/env bash
# Выкат последнего опубликованного релиза. Тег спрашивать не надо — он берётся из GitHub.
#
#   bash /opt/wobble/deploy/deploy-latest.sh          # поставить последний релиз
#   bash /opt/wobble/deploy/deploy-latest.sh --check  # только сказать, что доступно
#
# Зачем. Раньше выкат требовал набрать тег руками, а имя тега — ровно то место, где уже трижды
# ошибались. Здесь набирать нечего.
#
# Токен не нужен: репозиторий публичный, и список релизов читается анонимно. Ничего секретного
# этот скрипт не хранит и наружу не отправляет.
#
# Предрелизы (`-beta.N`, `-rc.N`) по умолчанию НЕ ставятся: боевой сервер не должен уезжать на
# бету от того, что её опубликовали. Для беты — `--prerelease`.
set -euo pipefail

REPO="${WOBBLE_REPO:-Malikk-Sh/Fall-guys}"
INSTALL="${WOBBLE_INSTALL:-/opt/wobble/deploy/install.sh}"
CONF="${WOBBLE_DEPLOY_CONF:-/etc/wobble-deploy.conf}"

allow_prerelease=0
check_only=0
for arg in "$@"; do
  case "$arg" in
    --prerelease) allow_prerelease=1 ;;
    --check) check_only=1 ;;
    -h | --help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    *)
      echo "неизвестный аргумент: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n== %s ==\n' "$1"; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "!! нет команды $1" >&2
    exit 1
  }
}
need curl
need node

say "Спрашиваем GitHub о релизах"
# Тридцати последних хватает с запасом; при этом ответ остаётся маленьким.
releases="$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO}/releases?per_page=30")" || {
  echo "!! GitHub не ответил. Сеть или лимит запросов; выкат не начат." >&2
  exit 1
}

# Разбор JSON — Node, а не grep: у grep нет понятия «черновик» и «предрелиз», а именно они здесь и
# решают. Само правило живёт в deploy/latest-release-tag.mjs и покрыто тестами.
args=()
if [[ "$allow_prerelease" == 1 ]]; then
  args+=(--prerelease)
fi
latest="$(printf '%s' "$releases" | node "$(dirname "$0")/latest-release-tag.mjs" "${args[@]}")"

if [[ -z "$latest" ]]; then
  kind=$([[ "$allow_prerelease" == 1 ]] && echo "релизов" || echo "стабильных релизов")
  echo "!! подходящих $kind нет" >&2
  exit 1
fi

current=""
if [[ -r "$CONF" ]]; then
  current="$(sed -n 's/^SAVED_RELEASE_TAG=//p' "$CONF" | tail -n1 | tr -d "\"'")"
fi

echo "последний опубликованный: $latest"
echo "стоит сейчас:             ${current:-(не из релиза)}"

if [[ "$latest" == "$current" ]]; then
  say "Уже стоит $latest — делать нечего"
  exit 0
fi

if [[ "$check_only" == 1 ]]; then
  say "Доступен $latest (проверка, выкат не запускался)"
  exit 0
fi

say "Выкатываем $latest"
# Дальше всё делает install.sh: проверенный backup, переключение, перезапуск и сверка /health с
# ожидаемым коммитом. Своей логики выката здесь намеренно нет — вторая её версия разъехалась бы
# с первой ровно так же, как разъезжались правила чекпоинта.
RELEASE_TAG="$latest" bash "$INSTALL"
