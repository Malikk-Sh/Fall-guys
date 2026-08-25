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
# Страницами, а не одной.
#
# Одной страницы в сто штук почти всегда хватает, но «почти» здесь плохое слово: если после
# последнего стабильного релиза накопится больше сотни бет, обычный режим получил бы одни беты,
# отфильтровал бы всё и сообщил, что стабильных релизов нет вовсе — при живом стабильном релизе.
# Пять страниц (пятьсот релизов) закрывают это с запасом и остаются ограниченными: бесконечно
# ходить по страницам на боевой машине нельзя.
PER_PAGE=100
MAX_PAGES=5
pages=""
for ((page = 1; page <= MAX_PAGES; page++)); do
  body="$(curl -fsS --max-time 30 -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}")" || {
    echo "!! GitHub не ответил. Сеть или лимит запросов; выкат не начат." >&2
    exit 1
  }
  # Пустая страница означает, что релизы кончились.
  [[ "$body" == "[]" ]] && break
  # Каждая страница — одной строкой: разборщик ниже читает по массиву на строку. Переводы строк
  # внутри JSON ничего не значат, поэтому убрать их безопасно.
  pages+="$(printf '%s' "$body" | tr -d '\n')"$'\n'
  # Неполная страница — последняя.
  [[ "$(printf '%s' "$body" | tr -d '\n' | node -e '
    let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
      let n = 0;
      try { n = JSON.parse(s).length; } catch {}
      process.stdout.write(String(n));
    });
  ')" -lt "$PER_PAGE" ]] && break
done

# Разбор JSON — Node, а не grep: у grep нет понятия «черновик», «предрелиз» и «дата публикации», а
# именно они здесь и решают. Правило живёт в deploy/latest-release-tag.mjs и покрыто тестами.
args=()
if [[ "$allow_prerelease" == 1 ]]; then
  args+=(--prerelease)
fi
latest="$(printf '%s' "$pages" | node "$(dirname "$0")/latest-release-tag.mjs" "${args[@]}")"

if [[ -z "$latest" ]]; then
  kind=$([[ "$allow_prerelease" == 1 ]] && echo "релизов" || echo "стабильных релизов")
  echo "!! подходящих $kind нет" >&2
  exit 1
fi

current=""
current_repo=""
if [[ -r "$CONF" ]]; then
  current="$(sed -n 's/^SAVED_RELEASE_TAG=//p' "$CONF" | tail -n1 | tr -d "\"'")"
  current_repo="$(sed -n 's/^SAVED_RELEASE_REPOSITORY=//p' "$CONF" | tail -n1 | tr -d "\"'")"
fi

echo "последний опубликованный: $latest ($REPO)"
echo "стоит сейчас:             ${current:-(не из релиза)}${current_repo:+ ($current_repo)}"

# Репозиторий обязан совпадать, и это не придирка.
#
# install.sh берёт git-remote из своей собственной настройки, а `RELEASE_REPOSITORY` использует
# только для проверки публикации. Значит при расхождении он проверил бы релиз в одном репозитории,
# а код взял бы из другого — и одноимённый тег выкатил бы чужой код. Сойтись эти две настройки
# должны снаружи; молча продолжать здесь нельзя.
if [[ -n "$current_repo" && "$current_repo" != "$REPO" ]]; then
  echo "!! установка помнит репозиторий $current_repo, а запрошен $REPO." >&2
  echo "   Приведите их к одному значению — иначе проверка релиза и источник кода разойдутся." >&2
  exit 1
fi

# Сравнивается ПАРА: одинаковые имена тегов в разных репозиториях — разный код.
if [[ "$latest" == "$current" && "$REPO" == "${current_repo:-$REPO}" ]]; then
  say "Уже стоит $latest — делать нечего"
  exit 0
fi

if [[ "$check_only" == 1 ]]; then
  say "Доступен $latest (проверка, выкат не запускался)"
  exit 0
fi

say "Выкатываем $latest"
# Репозиторий передаётся вместе с тегом.
#
# install.sh берёт RELEASE_REPOSITORY из своего сохранённого конфига или из своего умолчания.
# Без явной передачи выбор тега и выбор репозитория расходились бы: при WOBBLE_REPO=owner/fork
# тег выбирался бы в форке, а искался — в основном репозитории, где он либо отсутствует, либо
# существует одноимённым и совсем другим.
#
# Дальше всё делает install.sh: проверенный backup, переключение, перезапуск и сверка /health с
# ожидаемым коммитом. Своей логики выката здесь намеренно нет — вторая её версия разъехалась бы
# с первой ровно так же, как разъезжались правила чекпоинта.
RELEASE_TAG="$latest" RELEASE_REPOSITORY="$REPO" bash "$INSTALL"
