'use strict';

const fs = require('fs');

function replaceOnce(file, before, after, label) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
}

function appendOnce(file, marker, block) {
  let source = fs.readFileSync(file, 'utf8');
  if (source.includes(marker)) return;
  fs.writeFileSync(file, `${source.trimEnd()}\n\n${block.trim()}\n`);
}

const lines = (...parts) => parts.join('\n');

replaceOnce(
  'server/index.js',
  "const { socialCosmetics } = require('./socialCosmetics');",
  lines(
    "const { socialCosmetics } = require('./socialCosmetics');",
    "const { backupHealthStatus } = require('./backupStatus');"
  ),
  'backup health import'
);
replaceOnce(
  'server/index.js',
  "const gameDb = openDatabase(process.env.LEADERBOARD_DB || ':memory:');",
  lines(
    "const databaseFile = process.env.LEADERBOARD_DB || ':memory:';",
    'const gameDb = openDatabase(databaseFile);'
  ),
  'database path'
);
replaceOnce(
  'server/index.js',
  lines('  events: productEvents,', '  uptime: Math.round(process.uptime()),', '  metrics'),
  lines(
    '  events: productEvents,',
    '  uptime: Math.round(process.uptime()),',
    '  backup: backupHealthStatus({ databaseFile }),',
    '  metrics'
  ),
  'health backup status'
);

replaceOnce(
  'package.json',
  'server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/migrations.test.mjs',
  'server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/backup.test.mjs server/migrations.test.mjs',
  'backup tests in npm test'
);

appendOnce(
  'deploy/wobble.env.example',
  '# Production backups ---------------------------------------------------------------',
  lines(
    '# Production backups ---------------------------------------------------------------',
    '# Hourly local snapshots: 48 hourly / 7 daily / 4 weekly / 3 monthly.',
    'BACKUP_DIR=/var/lib/wobble/backups',
    'BACKUP_STATUS_FILE=/var/lib/wobble/backups/status.json',
    'BACKUP_MAX_AGE_SECONDS=7200',
    '',
    '# Off-server storage must be physically outside this VPS and mounted here.',
    '# While the remote mount is active, create its sentinel once: touch /mnt/wobble-offsite/.wobble-offsite',
    'BACKUP_OFFSITE_DIR=',
    'BACKUP_OFFSITE_SENTINEL=.wobble-offsite',
    'BACKUP_OFFSITE_EVERY_SECONDS=86400',
    'BACKUP_OFFSITE_KEEP=30',
    'BACKUP_OFFSITE_MAX_AGE_SECONDS=129600',
    '# Set to 1 after off-server storage is commissioned.',
    'BACKUP_REQUIRE_OFFSITE=0',
    '',
    '# Optional generic JSON webhook for stale-backup alerts. Journald works without it.',
    'BACKUP_ALERT_WEBHOOK_URL=',
    'BACKUP_ALERT_COOLDOWN_SECONDS=21600'
  )
);

for (const file of ['deploy/wobble-backup.service', 'deploy/wobble-backup-watch.service']) {
  replaceOnce(
    file,
    lines('WorkingDirectory=/opt/wobble', 'EnvironmentFile=/etc/wobble.env'),
    lines('WorkingDirectory=/opt/wobble', 'StateDirectory=wobble', 'EnvironmentFile=/etc/wobble.env'),
    `${file} StateDirectory`
  );
}

replaceOnce(
  'deploy/install.sh',
  lines(
    'say "Служба"',
    'cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service',
    'systemctl daemon-reload',
    'systemctl enable wobble >/dev/null',
    'systemctl restart wobble'
  ),
  lines(
    'say "Служба и резервные копии"',
    'cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service',
    'cp "$APP_DIR/deploy/wobble-backup.service" /etc/systemd/system/wobble-backup.service',
    'cp "$APP_DIR/deploy/wobble-backup.timer" /etc/systemd/system/wobble-backup.timer',
    'cp "$APP_DIR/deploy/wobble-backup-watch.service" /etc/systemd/system/wobble-backup-watch.service',
    'cp "$APP_DIR/deploy/wobble-backup-watch.timer" /etc/systemd/system/wobble-backup-watch.timer',
    'systemctl daemon-reload',
    'systemctl enable wobble >/dev/null',
    'systemctl enable wobble-backup.timer wobble-backup-watch.timer >/dev/null',
    '',
    '# Existing production DB is snapshotted before the restart can run newer migrations.',
    '# On first install the DB does not exist yet, and backup.sh intentionally skips this one call.',
    'say "Преддеплойная резервная копия"',
    'systemctl start wobble-backup.service',
    'systemctl restart wobble'
  ),
  'install backup units'
);

replaceOnce(
  'deploy/install.sh',
  lines(
    'say "Проверка"',
    'sleep 2',
    'if curl -fsS --max-time 5 http://127.0.0.1:3000/health >/dev/null; then',
    '  echo "сервер отвечает"',
    'else',
    '  warn "сервер не отвечает — смотрите: journalctl -u wobble -n 50 --no-pager"',
    '  exit 1',
    'fi'
  ),
  lines(
    'say "Проверка"',
    'sleep 2',
    'if ! curl -fsS --max-time 5 http://127.0.0.1:3000/health/live >/dev/null; then',
    '  warn "сервер не отвечает — смотрите: journalctl -u wobble -n 50 --no-pager"',
    '  exit 1',
    'fi',
    '',
    '# First install gets its first snapshot here; updates also get a verified post-migration copy.',
    'say "Проверенная резервная копия после запуска"',
    'systemctl start wobble-backup.service',
    'systemctl start wobble-backup.timer wobble-backup-watch.timer',
    '',
    'say "Deploy smoke"',
    'if bash "$APP_DIR/deploy/smoke.sh" --require-backup; then',
    '  echo "server, health, WebSocket and fresh backup verified"',
    'else',
    '  warn "deploy smoke не прошёл — смотрите journalctl -u wobble -n 100 --no-pager"',
    '  exit 1',
    'fi',
    '',
    'if ! grep -Eq "^[[:space:]]*BACKUP_OFFSITE_DIR=.+" /etc/wobble.env; then',
    '  warn "off-server backup ещё не настроен: нужна отдельная машина/remote storage, не папка этого VPS."',
    '  warn "Инструкция: $APP_DIR/deploy/PRODUCTION-SAFETY.md"',
    'fi'
  ),
  'post-deploy smoke'
);

replaceOnce(
  'deploy/install.sh',
  lines(
    'echo "Логи:        journalctl -u wobble -f"',
    'echo "Перезапуск:  systemctl restart wobble"',
    'echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"'
  ),
  lines(
    'echo "Логи:        journalctl -u wobble -f"',
    'echo "Перезапуск:  systemctl restart wobble"',
    'echo "Backup:      systemctl start wobble-backup.service"',
    'echo "Restore:     sudo bash ${APP_DIR}/deploy/restore.sh /path/to/backup.db"',
    'echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"'
  ),
  'install hints'
);

replaceOnce(
  'deploy/PRODUCTION-SAFETY.md',
  'The backup service runs as the unprivileged `wobble` user, so the mounted directory must be writable by that user. After configuring the mount:',
  lines(
    'The backup service runs as the unprivileged `wobble` user, so the mounted directory must be writable by that user. It also requires a sentinel file on the mounted filesystem. This prevents a disappeared mount from silently turning `/mnt/wobble-offsite` into an ordinary local directory on the VPS.',
    '',
    'Create the sentinel **while the remote storage is definitely mounted**. The default name is `.wobble-offsite`; it can be changed with `BACKUP_OFFSITE_SENTINEL`.',
    '',
    'After configuring the mount:'
  ),
  'runbook sentinel explanation'
);
replaceOnce(
  'deploy/PRODUCTION-SAFETY.md',
  lines(
    '```bash',
    'sudo -u wobble test -w /mnt/wobble-offsite',
    'systemctl start wobble-backup.service',
    'systemctl start wobble-backup-watch.service',
    '```'
  ),
  lines(
    '```bash',
    'sudo -u wobble test -w /mnt/wobble-offsite',
    'sudo -u wobble touch /mnt/wobble-offsite/.wobble-offsite',
    'systemctl start wobble-backup.service',
    'systemctl start wobble-backup-watch.service',
    '```',
    '',
    'If the mount or sentinel disappears, the backup code does **not** recreate the directory. Local backup continues, while required offsite freshness becomes stale and the watch alerts.'
  ),
  'runbook sentinel commands'
);
