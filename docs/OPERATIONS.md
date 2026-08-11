# Эксплуатация Wobble Rush

Это ролевое руководство оператора. Детали installer-а и backup/restore path остаются в
[`DEPLOY.md`](DEPLOY.md) и [`../deploy/PRODUCTION-SAFETY.md`](../deploy/PRODUCTION-SAFETY.md).

## 1. Production layout

Обычные пути:

```text
/opt/wobble
/etc/wobble.env
/etc/wobble-deploy.conf
/etc/systemd/system/wobble.service
/var/lib/wobble/leaderboard.db
/var/lib/wobble/backups
/etc/nginx/sites-available/wobble
/etc/nginx/wobble-locations.conf
```

Node должен слушать только loopback:

```text
127.0.0.1:3000
```

Публичный HTTPS/WSS обслуживает Nginx.

## 2. Ежедневный status

```bash
systemctl status wobble --no-pager
systemctl status nginx --no-pager
systemctl list-timers 'wobble-backup*'
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

Логи:

```bash
journalctl -u wobble -n 200 --no-pager
journalctl -u wobble -f
journalctl -u wobble -p warning..alert --since today --no-pager
```

## 3. Environment

Минимальная production-конфигурация должна сохранять модель:

```dotenv
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=1
ALLOWED_ORIGINS=https://wobbles.ru
LEADERBOARD_DB=/var/lib/wobble/leaderboard.db
```

Пределы одного процесса и backup settings задаются в `/etc/wobble.env`; пример находится в
`deploy/wobble.env.example`.

`TRUST_PROXY=1` безопасен только потому, что Node не доступен извне напрямую. Иначе внешний клиент
может подделывать `X-Forwarded-For`.

Не публикуйте полный `/etc/wobble.env` в issue, чат или скриншот: со временем там могут появляться
credentials.

## 4. systemd

Service запускается как Linux-user `wobble`, а persistent state живёт в `StateDirectory=wobble`.

Повседневные команды:

```bash
systemctl status wobble --no-pager
systemctl restart wobble
journalctl -u wobble -f
```

После изменения unit:

```bash
systemctl daemon-reload
systemctl restart wobble
```

## 5. Nginx

Перед каждым reload:

```bash
nginx -t
```

Только после успешного test:

```bash
systemctl reload nginx
```

Проверить listeners:

```bash
ss -lntp
```

Для WebSocket `location /ws` обязан передавать Upgrade/Connection, отключать proxy buffering и
иметь timeout больше heartbeat сервера.

`/health` и `/metrics/` должны оставаться internal-only.

## 6. Shared public TCP/443

Wobble поддерживает режим, где Nginx stream владеет public `:443`, маршрутизирует SNI Wobble на
внутренний HTTPS backend, а остальные TLS ClientHello передаёт соседнему backend.

Типовая команда:

```bash
DOMAIN=wobbles.ru \
HTTPS_PORT=<internal-wobble-tls-port> \
SHARED_HTTPS_443=1 \
SHARED_443_FALLBACK=127.0.0.1:14443 \
bash /opt/wobble/deploy/install.sh
```

`HTTPS_PORT` в этом режиме внутренний. Актуальные сохранённые значения смотрите в:

```bash
cat /etc/wobble-deploy.conf
```

Нельзя по памяти считать конкретный internal port вечной константой.

Проверка Wobble SNI route локально:

```bash
curl -fsS --resolve wobbles.ru:443:127.0.0.1 \
  https://wobbles.ru/health/live
```

Installer не должен редактировать Xray/другой fallback service и не должен знать его secrets.

## 7. UFW

Перед изменением:

```bash
ufw status numbered
```

На совместном VPS не удаляйте правила только потому, что они не принадлежат Wobble.

В обычной shared-443 схеме Wobble не требует публичного доступа к:

```text
3000
fallback backend port
internal Wobble TLS port
```

Не открывайте internal backend ports как "быстрое исправление".

## 8. TLS

Проверка сертификатов:

```bash
certbot certificates
certbot renew --dry-run
```

В shared-443 topology используется HTTP-01 webroot; `certbot --nginx` не должен пытаться
перестраивать public stream listener.

## 9. Deploy

Для уже настроенного сервера обычное обновление:

```bash
tmux new -s deploy
bash /opt/wobble/deploy/install.sh
```

Перед deploy:

```bash
systemctl start wobble-backup.service
nginx -t
ufw status numbered
cat /etc/wobble-deploy.conf
```

После deploy:

```bash
systemctl status wobble --no-pager
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
bash /opt/wobble/deploy/smoke.sh --require-backup
nginx -t
```

Плюс ручная проверка public web, co-op/WebSocket и соседнего service на shared 443.

## 10. Release deploy

Production лучше pin-ить на опубликованный immutable release:

```bash
RELEASE_TAG=v2.6.0-beta.1 bash /opt/wobble/deploy/install.sh
```

Успешный deploy сохраняет release identity в `/etc/wobble-deploy.conf`. Следующее обновление без
переменных остаётся на pinned release, пока новый tag не передан явно.

Полный процесс — в [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md).

## 11. Backups

Автоматически устанавливаются:

```text
wobble-backup.timer
wobble-backup-watch.timer
```

Проверка:

```bash
systemctl status wobble-backup.timer wobble-backup-watch.timer --no-pager
systemctl list-timers 'wobble-backup*'
journalctl -u wobble-backup.service -u wobble-backup-watch.service -n 100 --no-pager
```

Создать backup сейчас:

```bash
systemctl start wobble-backup.service
```

Backup создаётся SQLite-aware способом и проверяется на integrity/schema. Обычная копия live
`leaderboard.db` не заменяет verified backup.

## 12. Off-server backup

Remote storage должен физически находиться вне VPS. Включайте `BACKUP_REQUIRE_OFFSITE=1` только
после того, как mount, права и sentinel действительно проверены.

Никогда не создавайте sentinel после того, как mount пропал: так можно замаскировать локальный
каталог под offsite.

## 13. Restore

Опасная операция:

```bash
sudo bash /opt/wobble/deploy/restore.sh \
  /var/lib/wobble/backups/daily/<backup>.db
```

`restore.sh` проверяет backup, делает pre-restore rollback snapshot, останавливает service,
устанавливает DB атомарно, запускает current code и smoke, а при failure возвращает rollback snapshot.

Никогда не заменяйте live DB при работающем service.

## 14. Weekly checklist

```text
[ ] wobble/nginx active
[ ] backup timers active
[ ] backup health fresh
[ ] disk space нормальный
[ ] cert expiry проверен
[ ] NRestarts не вырос неожиданно
[ ] moderation queue просмотрена
[ ] gameplay analytics просмотрена
[ ] public web + WebSocket работают
[ ] shared-443 соседний service проверен после инфраструктурных изменений
```
