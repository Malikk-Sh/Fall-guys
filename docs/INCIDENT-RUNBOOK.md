# Incident runbook Wobble Rush

Цель runbook — диагностировать по слоям и не ломать соседние services случайными изменениями.

## 1. Базовый сбор состояния

```bash
echo '=== WOBBLE ==='
systemctl status wobble --no-pager -l || true

echo
echo '=== HEALTH ==='
curl -s http://127.0.0.1:3000/health | python3 -m json.tool || true

echo
echo '=== NGINX ==='
nginx -t || true

echo
echo '=== LISTENERS ==='
ss -lntp | grep -E ':(80|443|3000|14443|18443)[[:space:]]' || true

echo
echo '=== UFW ==='
ufw status numbered || true

echo
echo '=== BACKUP TIMERS ==='
systemctl list-timers 'wobble-backup*' || true

echo
echo '=== LAST LOGS ==='
journalctl -u wobble -n 80 --no-pager || true
```

Internal port numbers кроме `3000` могут отличаться; `/etc/wobble-deploy.conf` — источник истины.

## 2. Сайт не открывается

Проверьте каждый слой:

```bash
systemctl status wobble --no-pager
curl -fsS http://127.0.0.1:3000/health/live
nginx -t
systemctl status nginx --no-pager
ss -lntp
ufw status numbered
certbot certificates
curl -I https://wobbles.ru/
```

Не начинайте с reboot VPS: он одновременно трогает игру, Nginx и соседние services и стирает часть
симптомов.

## 3. HTTP 502

Сначала upstream:

```bash
curl -fsS http://127.0.0.1:3000/health/live
```

Если не отвечает:

```bash
systemctl status wobble --no-pager
journalctl -u wobble -n 200 --no-pager
```

Если Node отвечает, проверяйте Nginx:

```bash
nginx -t
grep -R "proxy_pass" /etc/nginx/wobble-locations.conf /etc/nginx/sites-enabled/
```

## 4. Страница открывается, co-op/WebSocket не работает

Проверить:

1. `/ws` в browser devtools;
2. точный `ALLOWED_ORIGINS`;
3. Nginx Upgrade/Connection headers;
4. `proxy_read_timeout`;
5. protocol version mismatch;
6. server logs.

На VPS:

```bash
grep '^ALLOWED_ORIGINS=' /etc/wobble.env
journalctl -u wobble --since "10 minutes ago" --no-pager
```

В production URL на normal public 443 origin обычно должен быть `https://wobbles.ru` без internal
backend port.

## 5. Service restart loop

```bash
systemctl status wobble --no-pager
journalctl -u wobble -n 300 --no-pager
free -m
df -h
ls -ld /var/lib/wobble
ls -l /var/lib/wobble/leaderboard.db*
```

Проверить migrations read-only:

```bash
sqlite3 -readonly /var/lib/wobble/leaderboard.db \
  'SELECT version, applied_at FROM schema_migrations ORDER BY version;'
```

Не удаляйте migration rows, чтобы "разрешить" старому коду стартовать.

## 6. SQLite locked

```bash
journalctl -u wobble -n 200 --no-pager | grep -i 'database.*locked' || true
```

Для moderation CLI краткий lock обычно лечится ожиданием и повтором.

Не запускайте второй game process против той же production DB и не делайте live-copy как обход lock.

## 7. Backup stale

```bash
systemctl status wobble-backup.timer wobble-backup-watch.timer --no-pager
systemctl list-timers 'wobble-backup*'
journalctl -u wobble-backup.service -u wobble-backup-watch.service -n 200 --no-pager
```

Запустить backup:

```bash
systemctl start wobble-backup.service
```

Если offsite required, отдельно проверьте mount, write permission и sentinel. Не создавайте sentinel
после исчезновения mount.

## 8. Shared 443 сломан

Зафиксируйте состояние до изменений:

```bash
ss -lntp | grep -E ':(443|14443|18443)[[:space:]]' || true
nginx -t
cat /etc/wobble-deploy.conf
ufw status numbered
```

Проверить Wobble через public SNI route локально:

```bash
curl -fsS --resolve wobbles.ru:443:127.0.0.1 \
  https://wobbles.ru/health/live
```

Соседний TLS/VPN service проверяйте его уже настроенным client profile на public 443.

Не открывайте backend ports в UFW и не меняйте случайные Xray/panel settings, пока не понятен
сломанный слой.

## 9. Deploy завершился ошибкой

Failure финального smoke не означает автоматически, что весь production down.

Соберите:

```bash
systemctl status wobble --no-pager
journalctl -u wobble -n 200 --no-pager
nginx -t
cat /etc/wobble-deploy.conf
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
bash /opt/wobble/deploy/smoke.sh --require-backup
```

Определите конкретный failed check и только затем меняйте конфигурацию.

## 10. Rollback

Code rollback и schema rollback — разные операции. Если новый release уже применил новую migration,
старый code может быть несовместим.

Нельзя откатывать schema так:

```sql
DELETE FROM schema_migrations WHERE version = ...;
```

Для data rollback используйте verified pre-deploy backup и `deploy/restore.sh`. Для обычного бага,
если schema совместима, предпочтительнее forward fix.

## 11. После исправления

Минимум:

```bash
systemctl status wobble --no-pager
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
bash /opt/wobble/deploy/smoke.sh --require-backup
nginx -t
```

Затем вручную:

- public `https://wobbles.ru`;
- реальный WebSocket/co-op;
- соседний service на shared 443;
- свежесть backup.

## 12. Шаблон записи инцидента

```text
Дата/время:
Release:
Commit:
Симптом:
Impact:
Что менялось до инцидента:

Health:
systemd:
Nginx:
listeners:
backup:
logs:

Root cause:
Исправление:
Smoke:
Shared-443/VPN check:
Backup check:

Regression test:
Docs update:
```
