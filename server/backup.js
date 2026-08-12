'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS } = require('./migrations');

const CURRENT_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version || 0;
const DEFAULT_RETENTION = Object.freeze({ hourly: 48, daily: 7, weekly: 4, monthly: 3 });
const DEFAULT_OFFSITE_KEEP = 30;
const DEFAULT_OFFSITE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OFFSITE_SENTINEL = '.wobble-offsite';

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function ensureFileDatabase(file) {
  const value = String(file || '');
  if (!value || value === ':memory:') throw new Error('backup requires a persistent SQLite database');
  return path.resolve(value);
}

function ensureDirectory(dir) {
  const resolved = path.resolve(String(dir || ''));
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function timestamp(now = Date.now()) {
  return new Date(now)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function readStatusFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStatusFile(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
}

function verificationRows(db) {
  return db
    .prepare('PRAGMA integrity_check')
    .all()
    .map(row => String(Object.values(row)[0] || ''));
}

function verifyIntegrity(db) {
  const integrity = verificationRows(db);
  if (integrity.length !== 1 || integrity[0].toLowerCase() !== 'ok') {
    throw new Error(`SQLite integrity_check failed: ${integrity.join('; ') || 'no result'}`);
  }
}

function migrationTableExists(db) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  );
}

function verifyLegacyBackup(file) {
  const target = path.resolve(String(file || ''));
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size < 1) throw new Error('backup file is empty');

  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA query_only = ON');
    verifyIntegrity(db);
    if (migrationTableExists(db)) throw new Error('database already has schema_migrations table');
    return { ok: true, integrity: 'ok', schemaVersion: 0, bytes: stat.size, legacy: true };
  } finally {
    db.close();
  }
}

function verifyBackup(file, { maxSchemaVersion = CURRENT_SCHEMA_VERSION } = {}) {
  const target = path.resolve(String(file || ''));
  const stat = fs.statSync(target);
  if (!stat.isFile() || stat.size < 1) throw new Error('backup file is empty');

  const db = new DatabaseSync(target);
  try {
    db.exec('PRAGMA query_only = ON');
    verifyIntegrity(db);
    if (!migrationTableExists(db)) throw new Error('backup has no schema_migrations table');
    const schemaVersion = Number(
      db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version || 0
    );
    if (!Number.isSafeInteger(schemaVersion) || schemaVersion < 1)
      throw new Error('backup schema version is invalid');
    if (schemaVersion > maxSchemaVersion)
      throw new Error(`backup schema ${schemaVersion} is newer than server schema ${maxSchemaVersion}`);
    return { ok: true, integrity: 'ok', schemaVersion, bytes: stat.size };
  } finally {
    db.close();
  }
}

function scrubEphemeralBackupData(file) {
  const db = new DatabaseSync(path.resolve(String(file || '')));
  try {
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'player_incident_events'")
      .get();
    if (!exists) return false;
    // `secure_delete` overwrites deleted cells and VACUUM rebuilds the snapshot, so copied backup
    // bytes do not preserve incident payload in free pages. The live database is never modified.
    db.exec('PRAGMA secure_delete = ON; DELETE FROM player_incident_events; VACUUM;');
    return true;
  } finally {
    db.close();
  }
}

function createSnapshot({ databaseFile, outputFile }) {
  const sourceFile = ensureFileDatabase(databaseFile);
  if (!fs.existsSync(sourceFile)) throw new Error(`database does not exist: ${sourceFile}`);
  const output = path.resolve(String(outputFile || ''));
  ensureDirectory(path.dirname(output));
  if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);

  const db = new DatabaseSync(sourceFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // VACUUM INTO reads a transactionally consistent snapshot even when the live DB uses WAL.
    // Copying only leaderboard.db could miss committed rows that still live in leaderboard.db-wal.
    db.exec(`VACUUM INTO ${sqlString(output)}`);
  } catch (error) {
    try {
      fs.rmSync(output, { force: true });
    } catch {
      // Preserve the original SQLite error.
    }
    throw error;
  } finally {
    db.close();
  }
  try {
    scrubEphemeralBackupData(output);
    return { file: output, ...verifyBackup(output) };
  } catch (error) {
    try {
      fs.rmSync(output, { force: true });
      fs.rmSync(`${output}-journal`, { force: true });
      fs.rmSync(`${output}-wal`, { force: true });
      fs.rmSync(`${output}-shm`, { force: true });
    } catch {
      // Preserve the scrub/verification error.
    }
    throw error;
  }
}

function createLegacySnapshot({ databaseFile, outputFile }) {
  const sourceFile = ensureFileDatabase(databaseFile);
  if (!fs.existsSync(sourceFile)) throw new Error(`database does not exist: ${sourceFile}`);

  // This path exists only for a one-time transition from releases predating schema_migrations.
  // It must never become a weaker replacement for normal verified production backups.
  verifyLegacyBackup(sourceFile);

  const output = path.resolve(String(outputFile || ''));
  ensureDirectory(path.dirname(output));
  if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);

  const db = new DatabaseSync(sourceFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`VACUUM INTO ${sqlString(output)}`);
    return { file: output, ...verifyLegacyBackup(output) };
  } catch (error) {
    try {
      fs.rmSync(output, { force: true });
    } catch {
      // Preserve the original SQLite error.
    }
    throw error;
  } finally {
    db.close();
  }
}

function isoWeekKey(now) {
  const date = new Date(now);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function tierKey(tier, now) {
  const date = new Date(now);
  if (tier === 'daily') return date.toISOString().slice(0, 10);
  if (tier === 'weekly') return isoWeekKey(now);
  if (tier === 'monthly') return date.toISOString().slice(0, 7);
  return '';
}

function filesNewestFirst(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter(name => name.endsWith('.db'))
      .map(name => {
        const file = path.join(dir, name);
        return { name, file, mtime: fs.statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
  } catch {
    return [];
  }
}

function pruneDirectory(dir, keep) {
  const count = Math.max(0, Number(keep) || 0);
  const files = filesNewestFirst(dir);
  for (const entry of files.slice(count)) fs.rmSync(entry.file, { force: true });
  return files.slice(0, count).map(entry => entry.file);
}

function ensureTierCopy(source, root, tier, now) {
  const dir = ensureDirectory(path.join(root, tier));
  const key = tierKey(tier, now);
  const existing = filesNewestFirst(dir).find(entry => entry.name.startsWith(`${key}-`));
  if (existing) return existing.file;
  const target = path.join(dir, `${key}-${path.basename(source)}`);
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (error?.code === 'EEXIST') return target;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
  return target;
}

function applyRetention(root, source, now, retention = DEFAULT_RETENTION) {
  const tiers = { hourly: source };
  for (const tier of ['daily', 'weekly', 'monthly']) tiers[tier] = ensureTierCopy(source, root, tier, now);
  for (const [tier, keep] of Object.entries(retention))
    pruneDirectory(path.join(root, tier), Math.max(1, Number(keep) || DEFAULT_RETENTION[tier]));
  return tiers;
}

function offsiteDue(status, now, intervalMs) {
  const last = Number(status?.offsite?.lastSuccessAt || 0);
  return !last || now - last >= intervalMs;
}

function safeSentinelName(value) {
  const sentinel = String(value || DEFAULT_OFFSITE_SENTINEL).trim();
  if (!sentinel || sentinel === '.' || sentinel === '..' || path.basename(sentinel) !== sentinel) {
    throw new Error('BACKUP_OFFSITE_SENTINEL must be a single file name');
  }
  return sentinel;
}

function requireOffsiteMount(offsiteDir, sentinel = DEFAULT_OFFSITE_SENTINEL) {
  const dir = path.resolve(String(offsiteDir || ''));
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) throw new Error('BACKUP_OFFSITE_DIR is not a directory');
  const marker = path.join(dir, safeSentinelName(sentinel));
  const markerStat = fs.statSync(marker);
  if (!markerStat.isFile()) throw new Error('offsite sentinel is not a file');
  return dir;
}

function copyOffsite({
  source,
  offsiteDir,
  offsiteSentinel = DEFAULT_OFFSITE_SENTINEL,
  now,
  keep = DEFAULT_OFFSITE_KEEP
}) {
  // Never mkdir the configured offsite path. If a remote mount disappears, creating its mountpoint
  // and writing there would silently turn an "off-server" backup into another copy on this VPS.
  const dir = requireOffsiteMount(offsiteDir, offsiteSentinel);
  const target = path.join(dir, path.basename(source));
  if (!fs.existsSync(target)) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const verified = verifyBackup(target);
  pruneDirectory(dir, Math.max(1, Number(keep) || DEFAULT_OFFSITE_KEEP));
  return { file: target, ...verified, copiedAt: now };
}

function safeError(error) {
  return String(error?.message || error || 'unknown backup error').slice(0, 500);
}

function createBackup({
  databaseFile,
  backupDir,
  statusFile,
  offsiteDir = '',
  offsiteSentinel = DEFAULT_OFFSITE_SENTINEL,
  now = Date.now(),
  retention = DEFAULT_RETENTION,
  offsiteKeep = DEFAULT_OFFSITE_KEEP,
  offsiteIntervalMs = DEFAULT_OFFSITE_INTERVAL_MS
}) {
  const source = ensureFileDatabase(databaseFile);
  const root = ensureDirectory(backupDir);
  const statusPath = path.resolve(statusFile || path.join(root, 'status.json'));
  const previous = readStatusFile(statusPath);
  const offsite = String(offsiteDir || '').trim();
  if (offsite) {
    const offsiteResolved = path.resolve(offsite);
    if (offsiteResolved === root || offsiteResolved.startsWith(`${root}${path.sep}`))
      throw new Error('BACKUP_OFFSITE_DIR must be outside the local backup directory');
  }

  try {
    const hourlyDir = ensureDirectory(path.join(root, 'hourly'));
    const output = path.join(hourlyDir, `wobble-${timestamp(now)}-${process.pid}.db`);
    const snapshot = createSnapshot({ databaseFile: source, outputFile: output });
    const tiers = applyRetention(root, output, now, retention);
    let next = {
      version: 1,
      local: {
        lastSuccessAt: now,
        file: path.relative(root, snapshot.file),
        integrity: snapshot.integrity,
        schemaVersion: snapshot.schemaVersion,
        bytes: snapshot.bytes
      },
      offsite: {
        configured: Boolean(offsite),
        lastSuccessAt: previous?.offsite?.lastSuccessAt || null,
        file: previous?.offsite?.file || null,
        integrity: previous?.offsite?.integrity || null,
        schemaVersion: previous?.offsite?.schemaVersion || null,
        bytes: previous?.offsite?.bytes || null,
        lastError: null
      },
      retention: Object.fromEntries(Object.entries(tiers).map(([tier, file]) => [tier, path.basename(file)])),
      lastFailureAt: null,
      lastError: null
    };
    writeStatusFile(statusPath, next);

    if (offsite && offsiteDue(previous, now, Math.max(60_000, Number(offsiteIntervalMs) || 0))) {
      try {
        const copied = copyOffsite({
          source: snapshot.file,
          offsiteDir: offsite,
          offsiteSentinel,
          now,
          keep: offsiteKeep
        });
        next = {
          ...next,
          offsite: {
            configured: true,
            lastSuccessAt: now,
            file: path.basename(copied.file),
            integrity: copied.integrity,
            schemaVersion: copied.schemaVersion,
            bytes: copied.bytes,
            lastError: null
          }
        };
      } catch (error) {
        // A remote-store outage must never erase the fact that the local snapshot succeeded.
        // Freshness policy decides whether missing offsite is fatal (BACKUP_REQUIRE_OFFSITE=1).
        next = {
          ...next,
          offsite: { ...next.offsite, configured: true, lastError: safeError(error) },
          lastFailureAt: now,
          lastError: `offsite: ${safeError(error)}`
        };
      }
      writeStatusFile(statusPath, next);
    }

    return { backupFile: snapshot.file, statusFile: statusPath, status: next };
  } catch (error) {
    const latest = readStatusFile(statusPath);
    try {
      writeStatusFile(statusPath, {
        ...latest,
        version: 1,
        offsite: {
          ...(latest.offsite || {}),
          configured: Boolean(offsite)
        },
        lastFailureAt: now,
        lastError: safeError(error)
      });
    } catch {
      // A broken status directory must not hide the real backup error.
    }
    throw error;
  }
}

function restoreDatabaseFile({ backupFile, databaseFile }) {
  const backup = path.resolve(String(backupFile || ''));
  const target = ensureFileDatabase(databaseFile);
  const verification = verifyBackup(backup);
  ensureDirectory(path.dirname(target));
  const temp = `${target}.restore-${process.pid}`;
  fs.copyFileSync(backup, temp);
  try {
    verifyBackup(temp);
    fs.rmSync(`${target}-wal`, { force: true });
    fs.rmSync(`${target}-shm`, { force: true });
    fs.renameSync(temp, target);
    fs.chmodSync(target, 0o600);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { databaseFile: target, ...verification };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_RETENTION,
  DEFAULT_OFFSITE_KEEP,
  DEFAULT_OFFSITE_INTERVAL_MS,
  DEFAULT_OFFSITE_SENTINEL,
  readStatusFile,
  writeStatusFile,
  verifyLegacyBackup,
  verifyBackup,
  createLegacySnapshot,
  scrubEphemeralBackupData,
  createSnapshot,
  createBackup,
  restoreDatabaseFile,
  pruneDirectory,
  tierKey,
  requireOffsiteMount
};
