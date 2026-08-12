import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { Accounts } = require('./accounts');
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

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'wobble-backup-'));
  const databaseFile = join(dir, 'game.db');
  const backupDir = join(dir, 'backups');
  const statusFile = join(backupDir, 'status.json');
  mkdirSync(backupDir, { recursive: true });
  const db = openDatabase(databaseFile);
  migrateDatabase(db, { now: 100 });
  return { dir, databaseFile, backupDir, statusFile, db };
}

function mountedOffsite(root) {
  const offsiteDir = join(root, 'remote-mounted-storage');
  mkdirSync(offsiteDir, { recursive: true });
  writeFileSync(join(offsiteDir, DEFAULT_OFFSITE_SENTINEL), 'wobble offsite mount\n');
  return offsiteDir;
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
    const offsiteDir = mountedOffsite(f.dir);
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
    assert.equal(
      copy.prepare('SELECT display_name FROM accounts WHERE id = ?').get(player.id).display_name,
      'Backup Player'
    );
    assert.equal(
      copy.prepare('SELECT COUNT(*) AS count FROM achievements WHERE account_id = ?').get(player.id).count,
      2
    );
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

test('legacy database gets an integrity-checked pre-migration snapshot without weakening normal verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wobble-legacy-backup-'));
  const databaseFile = join(dir, 'legacy.db');
  const outputFile = join(dir, 'backups', 'pre-migration.db');
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`
        CREATE TABLE legacy_records (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        );
        INSERT INTO legacy_records (name) VALUES ('preserved');
      `);

    assert.throws(() => verifyBackup(databaseFile), /no schema_migrations table/);
    assert.equal(verifyLegacyBackup(databaseFile).legacy, true);

    const snapshot = createLegacySnapshot({ databaseFile, outputFile });
    assert.equal(snapshot.legacy, true);
    assert.equal(snapshot.schemaVersion, 0);
    assert.equal(snapshot.integrity, 'ok');
    const copy = new DatabaseSync(snapshot.file);
    assert.equal(copy.prepare('SELECT name FROM legacy_records').get().name, 'preserved');
    copy.close();
    assert.throws(() => verifyBackup(snapshot.file), /no schema_migrations table/);

    migrateDatabase(db, { now: 500 });
    assert.throws(() => verifyLegacyBackup(databaseFile), /already has schema_migrations table/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
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

test('missing remote mount never becomes a fake offsite directory on the VPS', () => {
  const f = fixture();
  try {
    const now = 3_000_000;
    const missingMount = join(f.dir, 'mount-disappeared');
    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir: missingMount,
      now
    });

    assert.equal(existsSync(result.backupFile), true, 'local verified backup still succeeds');
    assert.equal(existsSync(missingMount), false, 'backup code must not mkdir a missing remote mountpoint');
    assert.equal(result.status.offsite.lastSuccessAt, null);
    assert.equal(result.status.lastFailureAt, now);

    const health = backupHealthStatus({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir: missingMount,
      requireOffsite: true,
      now
    });
    assert.equal(health.available, true);
    assert.equal(health.offsite.available, false);
    assert.equal(health.offsite.stale, true);
    assert.equal(health.stale, true);
    assert.equal(
      JSON.stringify(health).includes(f.dir),
      false,
      'public health must not expose internal paths'
    );
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('health checks timestamp and actual tracked files without leaking internal errors or paths', () => {
  const f = fixture();
  try {
    const now = 10_000_000;
    const offsiteDir = mountedOffsite(f.dir);
    createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir,
      now
    });
    const stored = JSON.parse(readFileSync(f.statusFile, 'utf8'));
    stored.local.lastSuccessAt = now - 30_000;
    stored.offsite.lastSuccessAt = now - 200_000;
    stored.lastFailureAt = now - 1_000;
    stored.lastError = `private filesystem path: ${f.dir}/secret`;
    stored.offsite.lastError = `private remote path: ${offsiteDir}`;
    writeFileSync(f.statusFile, JSON.stringify(stored));

    const fresh = backupHealthStatus({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir,
      requireOffsite: true,
      localMaxAgeSeconds: 60,
      offsiteMaxAgeSeconds: 300,
      now
    });
    assert.equal(fresh.stale, false);
    assert.equal(fresh.ageSeconds, 30);
    assert.equal(fresh.offsite.ageSeconds, 200);
    assert.equal(backupFresh(fresh), true);
    assert.equal(JSON.stringify(fresh).includes(f.dir), false);
    assert.equal(Object.hasOwn(fresh, 'lastError'), false);
    assert.equal(Object.hasOwn(fresh.offsite, 'lastError'), false);

    rmSync(join(f.backupDir, stored.local.file));
    const missingLocal = backupHealthStatus({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir,
      requireOffsite: true,
      localMaxAgeSeconds: 60,
      offsiteMaxAgeSeconds: 300,
      now
    });
    assert.equal(missingLocal.available, false);
    assert.equal(missingLocal.stale, true);
    assert.equal(backupFresh(missingLocal), false);
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

test('verified local and offsite backups exclude ephemeral player incident rows', () => {
  const f = fixture();
  try {
    const accounts = new Accounts({ db: f.db });
    const player = accounts.create('Private Incident Backup');
    f.db
      .prepare(
        `INSERT INTO player_incident_events
          (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        player.id,
        1234,
        'connection',
        'disconnected',
        'abcdef123456',
        null,
        'coop',
        'PLAYING',
        'mobile',
        null
      );
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 1);

    const offsiteDir = mountedOffsite(f.dir);
    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      offsiteDir,
      now: Date.UTC(2026, 7, 12, 12, 0, 0)
    });

    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 1);
    for (const file of [result.backupFile, join(offsiteDir, result.status.offsite.file)]) {
      const copy = new DatabaseSync(file);
      try {
        assert.equal(copy.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 0);
        assert.equal(verifyBackup(file).schemaVersion, CURRENT_SCHEMA_VERSION);
      } finally {
        copy.close();
      }
    }
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('snapshot is scrubbed before atomic publication to its visible path', () => {
  const f = fixture();
  const fs = require('node:fs');
  const originalRename = fs.renameSync;
  try {
    const accounts = new Accounts({ db: f.db });
    const player = accounts.create('Atomic Privacy Snapshot');
    f.db
      .prepare(
        `INSERT INTO player_incident_events
          (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(player.id, 1, 'connection', 'disconnected', null, null, null, null, 'desktop', null);

    const outputFile = join(f.backupDir, 'manual-privacy.db');
    let inspectedPublication = false;
    fs.renameSync = (source, target) => {
      if (target === outputFile) {
        inspectedPublication = true;
        assert.equal(existsSync(outputFile), false, 'visible backup must not exist before publication');
        const staged = new DatabaseSync(source);
        try {
          assert.equal(
            staged.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count,
            0,
            'publish-stage bytes must already be scrubbed'
          );
        } finally {
          staged.close();
        }
      }
      return originalRename(source, target);
    };

    const result = createSnapshot({ databaseFile: f.databaseFile, outputFile });
    assert.equal(inspectedPublication, true);
    assert.equal(result.file, outputFile);
    assert.equal(existsSync(outputFile), true);
    assert.equal(statSync(outputFile).mode & 0o777, 0o600, 'published snapshot must be mode 0600');
    assert.equal(
      readdirSync(f.backupDir).some(name => name.includes('.publish-')),
      false,
      'publication temp must be cleaned'
    );
  } finally {
    fs.renameSync = originalRename;
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('next snapshot proactively removes abandoned private raw stages', () => {
  const f = fixture();
  try {
    const stagingRoot = join(f.dir, '.wobble-backup-staging');
    const abandoned = join(stagingRoot, 'stage-abandoned');
    mkdirSync(abandoned, { recursive: true, mode: 0o700 });
    writeFileSync(join(abandoned, 'snapshot.db'), 'sensitive-test-placeholder', { mode: 0o600 });
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(abandoned, old, old);

    const outputFile = join(f.backupDir, 'cleanup-stage.db');
    createSnapshot({ databaseFile: f.databaseFile, outputFile });
    assert.equal(existsSync(abandoned), false, 'stale raw stage must be removed by the next snapshot');
    assert.equal(statSync(stagingRoot).mode & 0o777, 0o700);
    assert.equal(statSync(outputFile).mode & 0o777, 0o600);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
