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
  source = `${source.trimEnd()}\n\n${block.trim()}\n`;
  fs.writeFileSync(file, source);
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
  'persistent database path'
);
replaceOnce(
  'server/index.js',
  lines(
    '  events: productEvents,',
    '  uptime: Math.round(process.uptime()),',
    '  metrics',
    '});'
  ),
  lines(
    '  events: productEvents,',
    '  uptime: Math.round(process.uptime()),',
    '  backup: backupHealthStatus({ databaseFile }),',
    '  metrics',
    '});'
  ),
  'health backup status'
);

replaceOnce(
  'package.json',
  'server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/migrations.test.mjs',
  'server/socialCosmetics.test.mjs server/socialProfile.test.mjs server/backup.test.mjs server/migrations.test.mjs',
  'backup regression suite'
);

replaceOnce(
  '.github/workflows/ci.yml',
  lines('      - name: Lint source', '        run: npm run check'),
  lines(
    '      - name: Validate production scripts',
    '        run: bash -n deploy/backup.sh deploy/restore.sh deploy/check-backup.sh deploy/smoke.sh',
    '',
    '      - name: Lint source',
    '        run: npm run check'
  ),
  'shell syntax CI'
);

appendOnce(
  'deploy/wobble.env.example',
  '# Production backups',
  lines(
    '# Production backups ---------------------------------------------------------------',
    '# Local verified backups. The hourly systemd timer keeps 48 hourly / 7 daily / 4 weekly / 3 monthly.',
    'BACKUP_DIR=/var/lib/wobble/backups',
    'BACKUP_STATUS_FILE=/var/lib/wobble/backups/status.json',
    '# Hourly timer should always produce a successful local copy well before this 2-hour limit.',
    'BACKUP_MAX_AGE_SECONDS=7200',
    '',
    '# Off-server copy. Point this at storage physically outside this VPS (mounted remote host/bucket).',
    '# Leave empty only while external storage is being commissioned; see deploy/PRODUCTION-SAFETY.md.',
    'BACKUP_OFFSITE_DIR=',
    'BACKUP_OFFSITE_EVERY_SECONDS=86400',
    'BACKUP_OFFSITE_KEEP=30',
    'BACKUP_OFFSITE_MAX_AGE_SECONDS=129600',
    '# Set to 1 after BACKUP_OFFSITE_DIR is configured: stale/missing offsite then becomes an alert.',
    'BACKUP_REQUIRE_OFFSITE=0',
    '',
    '# Optional generic JSON webhook for stale-backup alerts. systemd/journald alerting works without it.',
    'BACKUP_ALERT_WEBHOOK_URL=',
    'BACKUP_ALERT_COOLDOWN_SECONDS=21600'
  )
);

for (const file of ['deploy/wobble-backup.service', 'deploy/wobble-backup-watch.service']) {
  replaceOnce(
    file,
    lines('WorkingDirectory=/opt/wobble', 'EnvironmentFile=/etc/wobble.env'),
    lines('WorkingDirectory=/opt/wobble', 'StateDirectory=wobble', 'EnvironmentFile=/etc/wobble.env'),
    `${file} state directory`
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
    '# The code has already been updated, but the old server process is still holding the old schema.',
    '# Take a consistent snapshot now, before restart can run any new migrations.',
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
    '# First install had no DB before server start; updates get a second post-migration snapshot too.',
    'say "Проверенная резервная копия после запуска"',
    'systemctl start wobble-backup.service',
    'systemctl start wobble-backup.timer wobble-backup-watch.timer',
    '',
    'say "Deploy smoke"',
    'if bash "$APP_DIR/deploy/smoke.sh" --require-backup; then',
    '  echo "сервер, health и WebSocket отвечают; backup свежий"',
    'else',
    '  warn "deploy smoke не прошёл — смотрите journalctl -u wobble -n 100 --no-pager"',
    '  exit 1',
    'fi',
    '',
    'if ! grep -Eq "^[[:space:]]*BACKUP_OFFSITE_DIR=.+" /etc/wobble.env; then',
    '  warn "off-server backup ещё не настроен. Это отдельная машина/remote storage, не вторая папка VPS."',
    '  warn "Инструкция: $APP_DIR/deploy/PRODUCTION-SAFETY.md"',
    'fi'
  ),
  'post deploy backup smoke'
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
  'install final safety hints'
);

replaceOnce(
  'server/backup.test.mjs',
  "import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';",
  "import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';",
  'backup test mkdir import'
);
replaceOnce(
  'server/backup.test.mjs',
  lines(
    "  const backupDir = join(dir, 'backups');",
    "  const statusFile = join(backupDir, 'status.json');",
    '  const db = openDatabase(databaseFile);'
  ),
  lines(
    "  const backupDir = join(dir, 'backups');",
    "  const statusFile = join(backupDir, 'status.json');",
    '  mkdirSync(backupDir, { recursive: true });',
    '  const db = openDatabase(databaseFile);'
  ),
  'backup test fixture directory'
);
