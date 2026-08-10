import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { Accounts } = require('./accounts');
const {
  CURRENT_SCHEMA_VERSION,
  createBackup,
  restoreDatabaseFile,
  verifyBackup
} = require('./backup');
const { backupFresh, backupHealthStatus } = require('./backupStatus');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wobble-backup-'));
  const databaseFile = join(dir, 'game.db');
  const backupDir = join(dir, 'backups');
  const statusFile = join(backupDir, 'status.json');
  const db = openDatabase(databaseFile);
  migrateDatabase(db, { now: 100 });
  return { dir, databaseFile, backupDir, statusFile, db };
}

test('live WAL database produces a verified snapshot plus retention tiers and offsite copy', () => {
  const f = fixture();
  try {
    const accounts = new Accounts({ db: f.db });
    const player = accounts.create('Backup Player');
    accounts.recordCoopCompletion({
      accountId: player.id,
      chapterId: 'ch3',
      timeMs: 45_000,
      revives: 2,
      completedAt: 200
    });
    const offsiteDir = join(f.dir, 'remote-mounted-storage');
    const now = Date.UTC(2026, 7, 10, 12, 0, 0);

    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir,
      now
    });

    assert.equal(verifyBackup(result.backupFile).schemaVersion, CURRENT_SCHEMA_VERSION);
    const copy = new DatabaseSync(result.backupFile);
    assert.equal(copy.prepare('SELECT display_name FROM accounts WHERE id = ?').get(player.id).display_name, 'Backup Player');
    assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM achievements WHERE account_id = ?').get(player.id).count, 2);
    copy.close();

    for (const tier of ['hourly', 'daily', 'weekly', 'monthly']) {
      assert.equal(readdirSync(join(f.backupDir, tier)).filter(name => name.endsWith('.db')).length, 1, tier);
    }
    assert.equal(readdirSync(offsiteDir).filter(name => name.endsWith('.db')).length, 1);
    const status = JSON.parse(readFileSync(f.statusFile, 'utf8'));
    assert.equal(status.local.integrity, 'ok');
    assert.equal(status.local.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(status.offsite.configured, true);
    assert.equal(status.offsite.lastSuccessAt, now);
    assert.equal(status.offsite.integrity, 'ok');
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('hourly retention is bounded while daily tier keeps only one copy for the same UTC day', () => {
  const f = fixture();
  try {
    const base = Date.UTC(2026, 7, 10, 1, 0, 0);
    for (let hour = 0; hour < 4; hour++) {
      createBackup({
        databaseFile: f.databaseFile,
        backupDir: f.backupDir,
        statusFile: f.statusFile,
        now: base + hour * 60 * 60 * 1000,
        retention: { hourly: 2, daily: 7, weekly: 4, monthly: 3 }
      });
    }
    assert.equal(readdirSync(join(f.backupDir, 'hourly')).filter(name => name.endsWith('.db')).length, 2);
    assert.equal(readdirSync(join(f.backupDir, 'daily')).filter(name => name.endsWith('.db')).length, 1);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('restore replaces the database from a verified backup and removes later writes', () => {
  const f = fixture();
  try {
    const accounts = new Accounts({ db: f.db });
    accounts.create('Before snapshot');
    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      now: 1_000
    });
    accounts.create('After snapshot');
    assert.equal(accounts.count(), 2);
    f.db.close();

    restoreDatabaseFile({ backupFile: result.backupFile, databaseFile: f.databaseFile });
    const restored = openDatabase(f.databaseFile);
    assert.equal(new Accounts({ db: restored }).count(), 1);
    assert.equal(restored.prepare('SELECT display_name FROM accounts').get().display_name, 'Before snapshot');
    restored.close();
  } finally {
    try {
      f.db.close();
    } catch {
      // The restore case closes it before replacement.
    }
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('verification rejects corruption and a database from a newer schema', () => {
  const f = fixture();
  try {
    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      now: 2_000
    });
    const newer = join(f.dir, 'newer.db');
    const source = new DatabaseSync(result.backupFile);
    source.exec(`VACUUM INTO '${newer.replaceAll("'", "''")}'`);
    source.close();
    const db = new DatabaseSync(newer);
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
      CURRENT_SCHEMA_VERSION + 1,
      1
    );
    db.close();
    assert.throws(() => verifyBackup(newer), /newer than server schema/);

    const corrupt = join(f.dir, 'corrupt.db');
    writeFileSync(corrupt, 'not sqlite');
    assert.throws(() => verifyBackup(corrupt));
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('health reports local and required offsite backup age without leaking file paths', () => {
  const f = fixture();
  try {
    const now = 10_000_000;
    writeFileSync(
      f.statusFile,
      JSON.stringify({
        version: 1,
        local: { lastSuccessAt: now - 30_000, integrity: 'ok', schemaVersion: CURRENT_SCHEMA_VERSION, bytes: 123 },
        offsite: {
          configured: true,
          lastSuccessAt: now - 200_000,
          integrity: 'ok',
          schemaVersion: CURRENT_SCHEMA_VERSION,
          bytes: 123
        }
      })
    );
    const fresh = backupHealthStatus({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir: join(f.dir, 'remote'),
      requireOffsite: true,
      localMaxAgeSeconds: 60,
      offsiteMaxAgeSeconds: 300,
      now
    });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.ageSeconds, 30);
    assert.equal(fresh.offsite.ageSeconds, 200);
    assert.equal(backupFresh(fresh), true);
    assert.equal(JSON.stringify(fresh).includes(f.dir), false, 'health не раскрывает пути файловой системы');

    const stale = backupHealthStatus({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir: join(f.dir, 'remote'),
      requireOffsite: true,
      localMaxAgeSeconds: 10,
      offsiteMaxAgeSeconds: 100,
      now
    });
    assert.equal(stale.stale, true);
    assert.equal(stale.offsite.stale, true);
    assert.equal(backupFresh(stale), false);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('in-memory development database does not create a false production backup alert', () => {
  const status = backupHealthStatus({ databaseFile: ':memory:', now: 5_000 });
  assert.equal(status.required, false);
  assert.equal(status.stale, false);
  assert.equal(backupFresh(status), true);
});
