'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_LOCAL_MAX_AGE_SECONDS = 2 * 60 * 60;
const DEFAULT_OFFSITE_MAX_AGE_SECONDS = 36 * 60 * 60;

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readStatus(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function ageSeconds(value, now) {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return Math.max(0, Math.floor((now - timestamp) / 1000));
}

function trackedFileExists(root, storedFile) {
  if (!root || typeof storedFile !== 'string' || !storedFile.trim() || path.isAbsolute(storedFile)) return false;
  const base = path.resolve(root);
  const target = path.resolve(base, storedFile);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) return false;
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function publicEntry(entry, now, maxAgeSeconds, required, fileExists) {
  const age = ageSeconds(entry?.lastSuccessAt, now);
  const available = age !== null && Boolean(fileExists);
  return {
    required: Boolean(required),
    available,
    stale: Boolean(required) && (!available || age > maxAgeSeconds),
    ageSeconds: age,
    maxAgeSeconds,
    lastSuccessAt: age !== null ? new Date(Number(entry.lastSuccessAt)).toISOString() : null,
    integrity: available ? entry?.integrity || null : null,
    schemaVersion:
      available && Number.isSafeInteger(Number(entry?.schemaVersion)) ? Number(entry.schemaVersion) : null,
    bytes: available && Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : null
  };
}

function backupHealthStatus({
  databaseFile = process.env.LEADERBOARD_DB || ':memory:',
  backupDir = process.env.BACKUP_DIR || '/var/lib/wobble/backups',
  statusFile = process.env.BACKUP_STATUS_FILE || '',
  offsiteDir = process.env.BACKUP_OFFSITE_DIR || '',
  requireOffsite = process.env.BACKUP_REQUIRE_OFFSITE === '1',
  localMaxAgeSeconds = positiveInt(process.env.BACKUP_MAX_AGE_SECONDS, DEFAULT_LOCAL_MAX_AGE_SECONDS),
  offsiteMaxAgeSeconds = positiveInt(
    process.env.BACKUP_OFFSITE_MAX_AGE_SECONDS,
    DEFAULT_OFFSITE_MAX_AGE_SECONDS
  ),
  now = Date.now()
} = {}) {
  const persistent = Boolean(databaseFile && databaseFile !== ':memory:');
  const root = path.resolve(backupDir);
  const file = path.resolve(statusFile || path.join(root, 'status.json'));
  const status = persistent ? readStatus(file) : null;
  const localExists = persistent && trackedFileExists(root, status?.local?.file);
  const local = publicEntry(status?.local, now, localMaxAgeSeconds, persistent, localExists);

  const offsiteRoot = String(offsiteDir || '').trim();
  const offsiteConfigured = Boolean(offsiteRoot);
  const offsiteExists =
    persistent && offsiteConfigured && trackedFileExists(path.resolve(offsiteRoot), status?.offsite?.file);
  const offsite = {
    configured: offsiteConfigured,
    ...publicEntry(
      status?.offsite,
      now,
      offsiteMaxAgeSeconds,
      persistent && Boolean(requireOffsite),
      offsiteExists
    )
  };

  return {
    required: persistent,
    available: local.available,
    stale: local.stale || offsite.stale,
    ageSeconds: local.ageSeconds,
    maxAgeSeconds: local.maxAgeSeconds,
    lastSuccessAt: local.lastSuccessAt,
    integrity: local.integrity,
    schemaVersion: local.schemaVersion,
    bytes: local.bytes,
    lastFailureAt:
      persistent && Number.isFinite(Number(status?.lastFailureAt)) && Number(status.lastFailureAt) > 0
        ? new Date(Number(status.lastFailureAt)).toISOString()
        : null,
    offsite
  };
}

function backupFresh(status) {
  return Boolean(status && !status.stale && (!status.required || status.available));
}

module.exports = {
  DEFAULT_LOCAL_MAX_AGE_SECONDS,
  DEFAULT_OFFSITE_MAX_AGE_SECONDS,
  backupHealthStatus,
  backupFresh,
  trackedFileExists
};
