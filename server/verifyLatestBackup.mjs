#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyBackup } = require('./backup');

function resolveTrackedFile(root, storedFile) {
  if (!root || typeof storedFile !== 'string' || !storedFile.trim() || path.isAbsolute(storedFile))
    return null;
  const base = path.resolve(root);
  const target = path.resolve(base, storedFile);
  if (target === base || !target.startsWith(`${base}${path.sep}`)) return null;
  return target;
}

const backupDir = process.env.BACKUP_DIR || '/var/lib/wobble/backups';
const statusFile = process.env.BACKUP_STATUS_FILE || path.join(backupDir, 'status.json');

let status;
try {
  status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
} catch {
  throw new Error('backup status file is missing or invalid');
}

const backupFile = resolveTrackedFile(backupDir, status?.local?.file);
if (!backupFile || !fs.existsSync(backupFile)) throw new Error('latest tracked local backup is missing');

const result = verifyBackup(backupFile);
console.log(
  JSON.stringify({
    ok: true,
    integrity: result.integrity,
    schemaVersion: result.schemaVersion,
    bytes: result.bytes
  })
);
