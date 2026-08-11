# Wobble Control — статус инфраструктуры

Вкладка **Сервер** — read-only диагностика production VPS для `owner` и `operator`.
Она отвечает на практические вопросы: работает ли игра и Nginx, есть ли место на диске, не заканчивается ли
HTTPS-сертификат, доступны ли локальные порты и свежий ли backup.

## Что вкладка не делает

Открытие и обновление страницы:

- не перезапускает Wobble;
- не запускает deploy;
- не меняет Nginx;
- не меняет UFW;
- не меняет shared TCP/443;
- не меняет Xray/VPN;
- не создаёт backup.

Для действий используется отдельная owner-only вкладка **Операции**.

## Источники данных

Статус собирается самим Node-процессом `User=wobble` без root-доступа.

### systemd

Для фиксированного набора собственных production units выполняется read-only:

```text
/usr/bin/systemctl show <fixed-unit> --property=ActiveState --property=SubState --property=UnitFileState
```

Пользователь панели не может передать имя systemd unit. Проверяются только:

```text
wobble.service
nginx.service
wobble-backup.timer
wobble-backup-watch.timer
wobble-ops.socket
certbot.timer
```

### Сеть

Выполняются локальные TCP probes:

- `127.0.0.1:80` — HTTP listener;
- `127.0.0.1:443` — внешний shared-443 listener;
- `127.0.0.1:$PORT` — внутренний Node listener.

Проверка HTTPS делает настоящий TLS handshake с `127.0.0.1:443`, но передаёт production SNI из
канонического `WOBBLE_PUBLIC_ORIGIN`, который поддерживает installer. Это отдельная generated-настройка:
`ALLOWED_ORIGINS` может содержать несколько разрешённых browser origins и поэтому не является надёжным
источником production hostname. В ручной/local установке допустим fallback только когда HTTPS origin в
`ALLOWED_ORIGINS` ровно один. Поэтому проверяется именно маршрут Wobble через Nginx stream и реально
выдаваемый сертификат, а не просто наличие файла сертификата на диске.

### HTTPS-сертификат

Панель показывает:

- удалось ли TLS-подключение;
- доверяет ли Node цепочке сертификата;
- дату окончания;
- сколько полных дней осталось.

Private key и содержимое сертификата в API не возвращаются.

### Память и диск

Память и load average читаются через стандартный Node `os` API.
Свободное место проверяется через `statfs` на файловой системе каталога production SQLite DB.

Показываются только агрегаты: total / free / used / percent. Список файлов и содержимое `/var/lib/wobble`
панель не выдаёт.

### Backup

Вкладка повторно использует уже существующий safe backup health из `/health`:

- local backup available/stale;
- возраст последней успешной копии;
- offsite configured/required/available/stale.

Она не выводит внутренние пути backup-файлов.

## Права

Capability:

```text
infrastructure.read
```

Её получают только:

```text
owner
operator
```

`moderator`, `analyst` и `viewer` не видят host-level operational details.

## Как интерпретировать предупреждения

Красная карточка не всегда означает аварию. Например, `certbot.timer` может отсутствовать на системе, где
renewal настроен другим способом. Поэтому UI рядом с каждым показателем объясняет, что именно проверено.

Критичнее всего сочетания:

- `Wobble Rush` inactive + local Node port недоступен;
- `Nginx` inactive + 80/443 недоступны;
- TLS недоступен или сертификат просрочен;
- disk usage очень близок к 100%;
- backup `stale=true` или required backup недоступен.

После обнаружения проблемы сначала используйте [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md), а не меняйте
наугад Nginx/firewall/VPN.
