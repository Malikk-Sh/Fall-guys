# Wobble Rush — справочник команд

Команды сгруппированы по назначению. Перед destructive operation смотрите
[`OPERATIONS.md`](OPERATIONS.md) и [`INCIDENT-RUNBOOK.md`](INCIDENT-RUNBOOK.md).

## Service

```bash
systemctl status wobble --no-pager
systemctl is-active wobble
systemctl restart wobble
systemctl show wobble -p MainPID -p ActiveEnterTimestamp -p NRestarts
```

## Logs

```bash
journalctl -u wobble -n 200 --no-pager
journalctl -u wobble -f
journalctl -u wobble --since "30 minutes ago" --no-pager
journalctl -u wobble -p warning..alert --since today --no-pager
```

## Health

```bash
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
curl -s http://127.0.0.1:3000/health | python3 -m json.tool
```

## Nginx

```bash
nginx -t
systemctl status nginx --no-pager
systemctl reload nginx
nginx -T | less
```

`reload` выполняйте только после успешного `nginx -t`.

## Network / firewall

```bash
ss -lntp
ufw status numbered
```

Shared-443 diagnostics:

```bash
cat /etc/wobble-deploy.conf
ss -lntp | grep -E ':(443|14443|18443)[[:space:]]' || true
curl -fsS --resolve wobbles.ru:443:127.0.0.1 \
  https://wobbles.ru/health/live
```

Internal ports могут отличаться — смотрите deploy config.

## TLS

```bash
certbot certificates
certbot renew --dry-run
```

## Deploy

```bash
tmux new -s deploy
bash /opt/wobble/deploy/install.sh
```

Exact release:

```bash
RELEASE_TAG=v2.6.0-beta.1 bash /opt/wobble/deploy/install.sh
```

Production smoke:

```bash
bash /opt/wobble/deploy/smoke.sh --require-backup
```

## Backup

```bash
systemctl status wobble-backup.timer wobble-backup-watch.timer --no-pager
systemctl list-timers 'wobble-backup*'
systemctl start wobble-backup.service
journalctl -u wobble-backup.service -u wobble-backup-watch.service -n 100 --no-pager
```

Verify backup:

```bash
sudo -u wobble node /opt/wobble/server/backupCli.mjs \
  verify /var/lib/wobble/backups/daily/<backup>.db
```

Restore:

```bash
sudo bash /opt/wobble/deploy/restore.sh \
  /var/lib/wobble/backups/daily/<backup>.db
```

## Moderation

Queue:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db queue
```

Case:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db show <account-id>
```

Reviewing:

```bash
sudo -u wobble node /opt/wobble/server/moderationCli.mjs \
  --db /var/lib/wobble/leaderboard.db set <account-id> reviewing \
  --moderator malik
```

## Analytics

```bash
curl -s 'http://127.0.0.1:3000/metrics/gameplay?days=7&limit=200' \
  | python3 -m json.tool
```

## SQLite read-only

```bash
sqlite3 -readonly /var/lib/wobble/leaderboard.db '.tables'
sqlite3 -readonly /var/lib/wobble/leaderboard.db '.schema'
sqlite3 -readonly /var/lib/wobble/leaderboard.db \
  'SELECT version, applied_at FROM schema_migrations ORDER BY version;'
```

## Development

```bash
npm ci
npm start
npm run format
npm run format:check
npm run lint
npm test
npm run test:e2e:desktop
npm run load
```

## Git

```bash
git status
git rev-parse HEAD
git log -1 --oneline
git diff --check
```

## Быстрый диагностический блок

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
echo '=== LOGS ==='
journalctl -u wobble -n 80 --no-pager || true
```
