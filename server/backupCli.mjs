import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_OFFSITE_SENTINEL,
  createBackup,
  createLegacySnapshot,
  createSnapshot,
  restoreDatabaseFile,
  verifyBackup,
  verifyLegacyBackup
} = require('./backup');
const { backupFresh, backupHealthStatus } = require('./backupStatus');

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pathsFromEnv() {
  const backupDir = process.env.BACKUP_DIR || '/var/lib/wobble/backups';
  return {
    databaseFile: process.env.LEADERBOARD_DB || ':memory:',
    backupDir,
    statusFile: process.env.BACKUP_STATUS_FILE || path.join(backupDir, 'status.json'),
    offsiteDir: process.env.BACKUP_OFFSITE_DIR || '',
    offsiteSentinel: process.env.BACKUP_OFFSITE_SENTINEL || DEFAULT_OFFSITE_SENTINEL
  };
}

function usage() {
  console.log(`Wobble Rush production backup CLI

Commands:
  create
  verify <backup.db>
  legacy-check <database.db>
  legacy-snapshot <source.db> <output.db>
  snapshot <source.db> <output.db>
  restore-file <backup.db> <target.db>
  status

Environment:
  LEADERBOARD_DB, BACKUP_DIR, BACKUP_STATUS_FILE, BACKUP_OFFSITE_DIR,
  BACKUP_OFFSITE_SENTINEL, BACKUP_OFFSITE_EVERY_SECONDS, BACKUP_OFFSITE_KEEP,
  BACKUP_MAX_AGE_SECONDS, BACKUP_OFFSITE_MAX_AGE_SECONDS, BACKUP_REQUIRE_OFFSITE

Current schema version: ${CURRENT_SCHEMA_VERSION}`);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  const config = pathsFromEnv();

  if (command === 'help' || command === '--help' || command === '-h') return usage();

  if (command === 'create') {
    const result = createBackup({
      ...config,
      offsiteIntervalMs: numberEnv('BACKUP_OFFSITE_EVERY_SECONDS', 86400) * 1000,
      offsiteKeep: numberEnv('BACKUP_OFFSITE_KEEP', 30)
    });
    const health = backupHealthStatus({ ...config });
    const fresh = backupFresh(health);
    console.log(
      JSON.stringify({
        ok: fresh,
        backup: result.backupFile,
        schemaVersion: result.status.local.schemaVersion,
        bytes: result.status.local.bytes,
        offsiteConfigured: result.status.offsite.configured,
        offsiteRequired: health.offsite.required,
        offsiteLastSuccessAt: result.status.offsite.lastSuccessAt
      })
    );
    if (!fresh) process.exitCode = 2;
    return;
  }

  if (command === 'verify') {
    if (!args[0]) throw new Error('verify requires a backup path');
    console.log(JSON.stringify({ ok: true, file: path.resolve(args[0]), ...verifyBackup(args[0]) }));
    return;
  }

  if (command === 'legacy-check') {
    if (!args[0]) throw new Error('legacy-check requires a database path');
    console.log(
      JSON.stringify({ ok: true, file: path.resolve(args[0]), ...verifyLegacyBackup(args[0]) })
    );
    return;
  }

  if (command === 'legacy-snapshot') {
    if (!args[0] || !args[1]) throw new Error('legacy-snapshot requires source and output paths');
    console.log(
      JSON.stringify({
        ok: true,
        ...createLegacySnapshot({ databaseFile: args[0], outputFile: args[1] })
      })
    );
    return;
  }

  if (command === 'snapshot') {
    if (!args[0] || !args[1]) throw new Error('snapshot requires source and output paths');
    console.log(
      JSON.stringify({ ok: true, ...createSnapshot({ databaseFile: args[0], outputFile: args[1] }) })
    );
    return;
  }

  if (command === 'restore-file') {
    if (!args[0] || !args[1]) throw new Error('restore-file requires backup and target paths');
    console.log(
      JSON.stringify({ ok: true, ...restoreDatabaseFile({ backupFile: args[0], databaseFile: args[1] }) })
    );
    return;
  }

  if (command === 'status') {
    const status = backupHealthStatus({ ...config });
    console.log(JSON.stringify(status));
    if (!backupFresh(status)) process.exitCode = 2;
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
  process.exitCode = 1;
});
