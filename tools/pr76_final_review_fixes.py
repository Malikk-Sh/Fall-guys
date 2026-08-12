from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# Periodic retention: make pruning a safe public housekeeping action, run it at startup and from
# the server heartbeat so retention does not depend on a later incident or an admin opening a timeline.
replace_once(
    'server/incidentDiagnostics.js',
    """    this.writeBuckets = new Map();
    this.lastPrunedAt = 0;
    this.statements = prepare(db);
  }
""",
    """    this.writeBuckets = new Map();
    this.lastPrunedAt = 0;
    this.statements = prepare(db);
    this.pruneExpired(this.now(), { force: true });
  }
""",
    'startup incident prune',
)
replace_once(
    'server/incidentDiagnostics.js',
    """    this.#prune(at);
    this.statements.insert.run(
""",
    """    this.pruneExpired(at);
    this.statements.insert.run(
""",
    'record prune call',
)
replace_once(
    'server/incidentDiagnostics.js',
    """    this.#prune(at, true);
    const from = at - this.retentionDays * DAY_MS;
""",
    """    this.pruneExpired(at, { force: true });
    const from = at - this.retentionDays * DAY_MS;
""",
    'timeline prune call',
)
replace_once(
    'server/incidentDiagnostics.js',
    """  #allowWrite(accountId, now) {
""",
    """  pruneExpired(now = this.now(), { force = false } = {}) {
    const at = Number(now);
    if (!Number.isSafeInteger(at) || at < 0) return false;
    if (!force && at - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return false;
    // Throttle even a failing cleanup: diagnostics are observability only and must not hammer a
    // troubled SQLite database every heartbeat tick.
    this.lastPrunedAt = at;
    try {
      this.statements.prune.run(at - this.retentionDays * DAY_MS);
      return true;
    } catch {
      return false;
    }
  }

  #allowWrite(accountId, now) {
""",
    'public prune method',
)
old_prune = """  #prune(now, force = false) {
    if (!force && now - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return;
    this.lastPrunedAt = now;
    this.statements.prune.run(now - this.retentionDays * DAY_MS);
  }
"""
replace_once('server/incidentDiagnostics.js', old_prune, '', 'remove private prune')
replace_once(
    'server/index.js',
    """  gameplay.flush();
  expireSessions(now);
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) rooms.delete(code);
""",
    """  gameplay.flush();
  incidentDiagnostics.pruneExpired(now);
  expireSessions(now);
  for (const [code, room] of rooms) if (now - room.updatedAt > ROOM_TTL) rooms.delete(code);
""",
    'heartbeat incident retention',
)

incident_test_append = r'''

test('periodic housekeeping prunes expired incidents without later player activity', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const id = account(db, 'dddddddd-eeee-ffff-0000-111111111111');
  let now = 10_000;
  const incidents = new IncidentDiagnostics({ db, now: () => now, retentionDays: 1 });
  assert.equal(
    incidents.record({ accountId: id, kind: 'connection', code: 'disconnected', occurredAt: now }),
    true
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 1);

  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(incidents.pruneExpired(now, { force: true }), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 0);
  db.close();
});
'''
path = Path('server/incidentDiagnostics.test.mjs')
text = path.read_text(encoding='utf-8')
if 'periodic housekeeping prunes expired incidents without later player activity' in text:
    raise SystemExit('periodic pruning regression already present')
path.write_text(text.rstrip() + incident_test_append + '\n', encoding='utf-8')

# Explicit LEAVE_ROOM during an active match is an immediate abandonment, not a disconnect-grace path.
replace_once(
    'server/index.js',
    """    const leaver = room.players.get(ws.id);
    gameplay.count('match_abandoned', dims(room, leaver, `cp${leaver?.checkpoint ?? 0}`));
    markUnranked(room, 'left');
""",
    """    const leaver = room.players.get(ws.id);
    gameplay.count('match_abandoned', dims(room, leaver, `cp${leaver?.checkpoint ?? 0}`));
    incidentForSocket(ws, {
      accountId: leaver?.accountId,
      kind: 'match',
      code: 'abandoned',
      roomId: room.code,
      matchId: room.matchId,
      mode: room.mode,
      phase: room.state
    });
    markUnranked(room, 'left');
""",
    'explicit leave abandonment incident',
)

socket_test_append = r'''

test('explicit leave during an active match records an immediate abandonment incident', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Explicit Leave Diagnostic');
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const client = await openClient(url);
  t.after(async () => {
    await closeClient(client);
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  await authReply;
  const lobbyReply = waitFor(client, 'lobby');
  client.send(JSON.stringify({ type: 'create', name: account.name, protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  room.state = 'PLAYING';
  room.matchId = 'explicit-leave-diagnostic-match';

  client.send(JSON.stringify({ type: 'leave' }));
  await new Promise(resolve => setTimeout(resolve, 30));

  const timeline = core.incidentDiagnostics.timeline(account.id);
  assert.ok(
    timeline.events.some(event => event.kind === 'match' && event.code === 'abandoned'),
    'explicit leave must explain the abandoned started match immediately'
  );
});
'''
path = Path('server/socketAuthIntegration.test.mjs')
text = path.read_text(encoding='utf-8')
if 'explicit leave during an active match records an immediate abandonment incident' in text:
    raise SystemExit('explicit leave incident regression already present')
path.write_text(text.rstrip() + socket_test_append + '\n', encoding='utf-8')

# Backups: never expose the raw VACUUM snapshot under a managed *.db name. Build under a hidden
# pending name in the same directory, scrub + verify it, then publish with one atomic rename.
replace_once(
    'server/backup.js',
    """const DEFAULT_OFFSITE_SENTINEL = '.wobble-offsite';
""",
    """const DEFAULT_OFFSITE_SENTINEL = '.wobble-offsite';
const PENDING_SNAPSHOT_PREFIX = '.wobble-pending-';
const PENDING_SNAPSHOT_STALE_MS = 10 * 60 * 1000;
""",
    'pending snapshot constants',
)
replace_once(
    'server/backup.js',
    """function createSnapshot({ databaseFile, outputFile }) {
""",
    """function removeSnapshotArtifacts(file) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      fs.rmSync(`${file}${suffix}`, { force: true });
    } catch {
      // Best-effort cleanup; callers preserve the original backup error.
    }
  }
}

function cleanupStalePendingSnapshots(dir, now = Date.now()) {
  const root = path.resolve(String(dir || ''));
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    if (!name.startsWith(PENDING_SNAPSHOT_PREFIX)) continue;
    const file = path.join(root, name);
    try {
      const age = Number(now) - fs.statSync(file).mtimeMs;
      if (!Number.isFinite(age) || age < PENDING_SNAPSHOT_STALE_MS) continue;
      removeSnapshotArtifacts(file);
      removed += 1;
    } catch {
      // A concurrent cleanup or filesystem race is harmless.
    }
  }
  return removed;
}

function pendingSnapshotPath(output) {
  return path.join(
    path.dirname(output),
    `${PENDING_SNAPSHOT_PREFIX}${path.basename(output)}-${process.pid}-${Date.now()}`
  );
}

function createSnapshot({ databaseFile, outputFile }) {
""",
    'pending snapshot helpers',
)
old_create = """  const output = path.resolve(String(outputFile || ''));
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
"""
new_create = """  const output = path.resolve(String(outputFile || ''));
  const outputDir = ensureDirectory(path.dirname(output));
  cleanupStalePendingSnapshots(outputDir);
  if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);
  const pending = pendingSnapshotPath(output);

  const db = new DatabaseSync(sourceFile);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    // VACUUM INTO reads a transactionally consistent snapshot even when the live DB uses WAL.
    // The raw snapshot is intentionally hidden under a non-*.db pending name until incident rows
    // have been scrubbed and the complete snapshot has passed verification.
    db.exec(`VACUUM INTO ${sqlString(pending)}`);
    fs.chmodSync(pending, 0o600);
  } catch (error) {
    removeSnapshotArtifacts(pending);
    throw error;
  } finally {
    db.close();
  }
  try {
    scrubEphemeralBackupData(pending);
    const verified = verifyBackup(pending);
    if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);
    fs.renameSync(pending, output);
    return { file: output, ...verified };
  } catch (error) {
    removeSnapshotArtifacts(pending);
    throw error;
  }
"""
replace_once('server/backup.js', old_create, new_create, 'atomic sanitized snapshot publish')
replace_once(
    'server/backup.js',
    """  verifyLegacyBackup,
  verifyBackup,
  createLegacySnapshot,
  scrubEphemeralBackupData,
  createSnapshot,
""",
    """  verifyLegacyBackup,
  verifyBackup,
  createLegacySnapshot,
  scrubEphemeralBackupData,
  cleanupStalePendingSnapshots,
  createSnapshot,
""",
    'export pending cleanup helper',
)

# Backup regression: managed visible snapshots are sanitized, while stale interrupted raw pending
# files are automatically removed on the next backup invocation.
replace_once(
    'server/backup.test.mjs',
    """  readdirSync,
  rmSync,
  writeFileSync
""",
    """  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
""",
    'backup test utimes import',
)
backup_test_append = r'''

test('backup publishes only sanitized snapshots and removes stale pending raw snapshots', () => {
  const f = fixture();
  try {
    const accounts = new Accounts({ db: f.db });
    const player = accounts.create('Atomic Backup Incident');
    f.db
      .prepare(
        `INSERT INTO player_incident_events
          (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(player.id, 5000, 'connection', 'disconnected', null, null, 'race', 'PLAYING', 'desktop', null);

    const hourlyDir = join(f.backupDir, 'hourly');
    mkdirSync(hourlyDir, { recursive: true });
    const stalePending = join(hourlyDir, '.wobble-pending-interrupted-raw-snapshot');
    writeFileSync(stalePending, 'raw incident snapshot placeholder', { mode: 0o600 });
    const stale = new Date(Date.now() - 20 * 60 * 1000);
    utimesSync(stalePending, stale, stale);

    const result = createBackup({
      databaseFile: f.databaseFile,
      backupDir: f.backupDir,
      statusFile: f.statusFile,
      now: Date.UTC(2026, 7, 12, 13, 0, 0)
    });

    assert.equal(existsSync(stalePending), false);
    assert.equal(
      readdirSync(hourlyDir).some(name => name.startsWith('.wobble-pending-')),
      false,
      'successful backup must leave no unpublished pending snapshot'
    );
    assert.match(result.backupFile, /\.db$/);
    const published = new DatabaseSync(result.backupFile);
    try {
      assert.equal(published.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 0);
    } finally {
      published.close();
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 1);
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
'''
path = Path('server/backup.test.mjs')
text = path.read_text(encoding='utf-8')
if 'backup publishes only sanitized snapshots and removes stale pending raw snapshots' in text:
    raise SystemExit('atomic backup regression already present')
path.write_text(text.rstrip() + backup_test_append + '\n', encoding='utf-8')

# Documentation must not recommend a raw DB copy that bypasses WAL-safe verified backup/scrubbing.
replace_once(
    'docs/DEPLOY.md',
    """Перед обновлением всё равно полезно сохранить SQLite-файл:

```bash
systemctl stop wobble
cp /var/lib/wobble/leaderboard.db /var/lib/wobble/leaderboard.db.bak
systemctl start wobble
sqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'
```
""",
    """Перед ручным обновлением сначала создайте штатную проверенную резервную копию. Не копируйте
`leaderboard.db` через `cp`: база работает в WAL-режиме, а начиная со schema 14 диагностические
события имеют отдельную privacy-retention и специально удаляются из backup snapshot перед публикацией.

```bash
systemctl start wobble-backup.service
journalctl -u wobble-backup.service -n 30 --no-pager
systemctl stop wobble
# выполнить ручное обновление только после успешного backup
systemctl start wobble
sqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'
```

Штатный `deploy/install.sh` сам выполняет нужную pre-migration backup-проверку; этот блок нужен только
для действительно ручного обслуживания.
""",
    'document verified migration backup',
)
