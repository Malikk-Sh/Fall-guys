from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    if text.count(old) != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {text.count(old)}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# P2: retention must expire on periodic housekeeping, not only on reads/writes.
replace_once(
    'server/incidentDiagnostics.js',
    '    this.#prune(at);\n',
    '    this.pruneExpired(at);\n',
    'record prune call',
)
replace_once(
    'server/incidentDiagnostics.js',
    '    this.#prune(at, true);\n',
    '    this.pruneExpired(at, { force: true });\n',
    'timeline prune call',
)
replace_once(
    'server/incidentDiagnostics.js',
    '''  #prune(now, force = false) {\n    if (!force && now - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return;\n    this.lastPrunedAt = now;\n    this.statements.prune.run(now - this.retentionDays * DAY_MS);\n  }\n''',
    '''  pruneExpired(now = this.now(), { force = false } = {}) {\n    const at = Number(now);\n    if (!Number.isSafeInteger(at) || at < 0) return 0;\n    if (!force && at - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return 0;\n    const result = this.statements.prune.run(at - this.retentionDays * DAY_MS);\n    this.lastPrunedAt = at;\n    return Number(result?.changes || 0);\n  }\n''',
    'public retention housekeeping',
)

# P2: an explicit LEAVE_ROOM during an active match is an immediate abandon too.
replace_once(
    'server/index.js',
    '''    const leaver = room.players.get(ws.id);\n    gameplay.count('match_abandoned', dims(room, leaver, `cp${leaver?.checkpoint ?? 0}`));\n    markUnranked(room, 'left');\n''',
    '''    const leaver = room.players.get(ws.id);\n    gameplay.count('match_abandoned', dims(room, leaver, `cp${leaver?.checkpoint ?? 0}`));\n    incidentForSocket(ws, {\n      accountId: leaver?.accountId,\n      kind: 'match',\n      code: 'abandoned',\n      roomId: room.code,\n      matchId: room.matchId,\n      mode: room.mode,\n      phase: room.state\n    });\n    markUnranked(room, 'left');\n''',
    'explicit leave incident',
)

replace_once(
    'server/index.js',
    '''const heartbeatTimer = setInterval(() => {\n''',
    '''function pruneIncidentDiagnostics(now = Date.now()) {\n  try {\n    return incidentDiagnostics.pruneExpired(now);\n  } catch {\n    // Diagnostics are observability only. A retention cleanup failure must never stop gameplay.\n    process.stderr.write('[wobble] incident_diagnostics_housekeeping_failed\\n');\n    return 0;\n  }\n}\n\nconst heartbeatTimer = setInterval(() => {\n''',
    'housekeeping helper',
)
replace_once(
    'server/index.js',
    '''  const now = Date.now();\n\n  // Игроки, не вернувшиеся за отведённое время, освобождают слот и считаются\n''',
    '''  const now = Date.now();\n  pruneIncidentDiagnostics(now);\n\n  // Игроки, не вернувшиеся за отведённое время, освобождают слот и считаются\n''',
    'heartbeat retention call',
)
replace_once(
    'server/index.js',
    '''  incidentDiagnostics,\n  socialSafety,\n''',
    '''  incidentDiagnostics,\n  pruneIncidentDiagnostics,\n  socialSafety,\n''',
    'housekeeping export',
)

# P2: never publish a raw snapshot. Raw VACUUM output lives only in OS temp; only a scrubbed,
# verified copy reaches an adjacent publish temp, then atomically renames to the visible .db.
replace_once(
    'server/backup.js',
    "const path = require('path');\n",
    "const path = require('path');\nconst os = require('os');\n",
    'os import',
)
old_snapshot = '''function createSnapshot({ databaseFile, outputFile }) {\n  const sourceFile = ensureFileDatabase(databaseFile);\n  if (!fs.existsSync(sourceFile)) throw new Error(`database does not exist: ${sourceFile}`);\n  const output = path.resolve(String(outputFile || ''));\n  ensureDirectory(path.dirname(output));\n  if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);\n\n  const db = new DatabaseSync(sourceFile);\n  try {\n    db.exec('PRAGMA busy_timeout = 5000');\n    // VACUUM INTO reads a transactionally consistent snapshot even when the live DB uses WAL.\n    // Copying only leaderboard.db could miss committed rows that still live in leaderboard.db-wal.\n    db.exec(`VACUUM INTO ${sqlString(output)}`);\n  } catch (error) {\n    try {\n      fs.rmSync(output, { force: true });\n    } catch {\n      // Preserve the original SQLite error.\n    }\n    throw error;\n  } finally {\n    db.close();\n  }\n  try {\n    scrubEphemeralBackupData(output);\n    return { file: output, ...verifyBackup(output) };\n  } catch (error) {\n    try {\n      fs.rmSync(output, { force: true });\n      fs.rmSync(`${output}-journal`, { force: true });\n      fs.rmSync(`${output}-wal`, { force: true });\n      fs.rmSync(`${output}-shm`, { force: true });\n    } catch {\n      // Preserve the scrub/verification error.\n    }\n    throw error;\n  }\n}\n'''
new_snapshot = '''function createSnapshot({ databaseFile, outputFile }) {\n  const sourceFile = ensureFileDatabase(databaseFile);\n  if (!fs.existsSync(sourceFile)) throw new Error(`database does not exist: ${sourceFile}`);\n  const output = path.resolve(String(outputFile || ''));\n  ensureDirectory(path.dirname(output));\n  if (fs.existsSync(output)) throw new Error(`backup already exists: ${output}`);\n\n  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-backup-stage-'));\n  const rawStage = path.join(stagingDir, 'snapshot.db');\n  const publishStage = `${output}.publish-${process.pid}-${Date.now()}`;\n  try {\n    const db = new DatabaseSync(sourceFile);\n    try {\n      db.exec('PRAGMA busy_timeout = 5000');\n      // VACUUM INTO reads a transactionally consistent snapshot even when the live DB uses WAL.\n      // The raw snapshot is created outside the managed backup tree so a killed process cannot\n      // expose unsanitized incident history as a visible hourly/daily backup.\n      db.exec(`VACUUM INTO ${sqlString(rawStage)}`);\n    } finally {\n      db.close();\n    }\n\n    scrubEphemeralBackupData(rawStage);\n    verifyBackup(rawStage);\n\n    // Only scrubbed bytes enter the destination filesystem. The adjacent temporary name is not a\n    // managed .db snapshot, and rename publishes it atomically after a second verification.\n    fs.copyFileSync(rawStage, publishStage, fs.constants.COPYFILE_EXCL);\n    const verification = verifyBackup(publishStage);\n    fs.renameSync(publishStage, output);\n    return { file: output, ...verification };\n  } finally {\n    fs.rmSync(publishStage, { force: true });\n    fs.rmSync(`${publishStage}-journal`, { force: true });\n    fs.rmSync(`${publishStage}-wal`, { force: true });\n    fs.rmSync(`${publishStage}-shm`, { force: true });\n    fs.rmSync(stagingDir, { recursive: true, force: true });\n  }\n}\n'''
replace_once('server/backup.js', old_snapshot, new_snapshot, 'atomic scrubbed snapshot')

# P2: documentation must not teach an operator to bypass the privacy scrubber with raw cp.
replace_once(
    'docs/DEPLOY.md',
    '''Перед обновлением всё равно полезно сохранить SQLite-файл:\n\n```bash\nsystemctl stop wobble\ncp /var/lib/wobble/leaderboard.db /var/lib/wobble/leaderboard.db.bak\nsystemctl start wobble\nsqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'\n```\n''',
    '''Перед обновлением всё равно полезно сохранить проверенный SQLite snapshot. Не копируй\n`leaderboard.db` обычным `cp`: при WAL это может быть неполная копия, а после migration 014 raw\nкопия также обойдёт privacy-scrub диагностического журнала. Используй тот же snapshot pipeline:\n\n```bash\nsystemctl stop wobble\nmkdir -p /var/lib/wobble/backups/manual\nnode /opt/wobble/server/backupCli.mjs snapshot \\\n  /var/lib/wobble/leaderboard.db \\\n  "/var/lib/wobble/backups/manual/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).db"\nsystemctl start wobble\nsqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'\n```\n''',
    'safe migration backup docs',
)

# Regression: force pruning must remove old rows even if no later event/read happened.
incident_test = Path('server/incidentDiagnostics.test.mjs')
text = incident_test.read_text(encoding='utf-8')
needle = "test('incident timeline returns null for an unknown account', () => {\n"
if text.count(needle) != 1:
    raise SystemExit('incident housekeeping test insertion point mismatch')
new_test = '''test('periodic incident housekeeping expires quiet-account rows without new activity', () => {\n  const db = openDatabase(':memory:');\n  migrateDatabase(db);\n  const id = account(db, 'dddddddd-eeee-ffff-0000-111111111111');\n  let now = 1_000;\n  const day = 24 * 60 * 60 * 1000;\n  const incidents = new IncidentDiagnostics({ db, now: () => now, retentionDays: 1 });\n  assert.equal(incidents.record({ accountId: id, kind: 'connection', code: 'disconnected' }), true);\n  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 1);\n\n  now += 2 * day;\n  assert.equal(incidents.pruneExpired(now, { force: true }), 1);\n  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 0);\n  db.close();\n});\n\n'''
incident_test.write_text(text.replace(needle, new_test + needle, 1), encoding='utf-8')

# Regression: an authenticated explicit leave during PLAYING must create match/abandoned.
socket_test = Path('server/socketAuthIntegration.test.mjs')
text = socket_test.read_text(encoding='utf-8')
needle = "test('operational drain records restart as the terminal matchmaking event', async t => {\n"
if text.count(needle) != 1:
    raise SystemExit('explicit leave test insertion point mismatch')
new_test = '''test('explicit LEAVE_ROOM during an active match records an immediate abandon incident', async t => {\n  core.resetRateLimits();\n  const auth = new AuthService({ db: core.accounts.db });\n  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));\n  const account = core.accounts.create('Explicit Leave Diagnostic');\n  const ticket = auth.createSocketTicket(account.id).token;\n\n  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));\n  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;\n  const client = await openClient(url);\n  t.after(async () => {\n    await closeClient(client);\n    await new Promise(resolve => core.server.close(resolve));\n    networkIdentity.reset();\n  });\n\n  const authReply = waitFor(client, 'authenticated');\n  client.send(JSON.stringify({ type: 'auth', ticket }));\n  await authReply;\n  const lobbyReply = waitFor(client, 'lobby');\n  client.send(JSON.stringify({ type: 'create', name: account.name, protocolVersion: 10 }));\n  const lobby = await lobbyReply;\n  const room = core.rooms.get(lobby.code);\n  assert.ok(room);\n  room.state = 'PLAYING';\n  room.matchId = 'explicit-leave-match';\n\n  client.send(JSON.stringify({ type: 'leave' }));\n  await new Promise(resolve => setTimeout(resolve, 50));\n  const timeline = core.incidentDiagnostics.timeline(account.id);\n  assert.ok(\n    timeline.events.some(event => event.kind === 'match' && event.code === 'abandoned'),\n    'explicit leave must be visible as match abandonment immediately'\n  );\n});\n\n'''
socket_test.write_text(text.replace(needle, new_test + needle, 1), encoding='utf-8')

# Regression: inspect the adjacent publish stage at rename time. It must already be scrubbed,
# while the final visible path must not exist before the atomic rename.
backup_test = Path('server/backup.test.mjs')
text = backup_test.read_text(encoding='utf-8')
replace_target = '''  createBackup,\n  createLegacySnapshot,\n'''
if text.count(replace_target) != 1:
    raise SystemExit('backup import insertion point mismatch')
text = text.replace(replace_target, '''  createBackup,\n  createLegacySnapshot,\n  createSnapshot,\n''', 1)
append_test = '''\n\ntest('snapshot is scrubbed before atomic publication to its visible path', () => {\n  const f = fixture();\n  const fs = require('node:fs');\n  const originalRename = fs.renameSync;\n  try {\n    const accounts = new Accounts({ db: f.db });\n    const player = accounts.create('Atomic Privacy Snapshot');\n    f.db\n      .prepare(\n        `INSERT INTO player_incident_events\n          (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)\n         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`\n      )\n      .run(player.id, 1, 'connection', 'disconnected', null, null, null, null, 'desktop', null);\n\n    const outputFile = join(f.backupDir, 'manual-privacy.db');\n    let inspectedPublication = false;\n    fs.renameSync = (source, target) => {\n      if (target === outputFile) {\n        inspectedPublication = true;\n        assert.equal(existsSync(outputFile), false, 'visible backup must not exist before publication');\n        const staged = new DatabaseSync(source);\n        try {\n          assert.equal(\n            staged.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count,\n            0,\n            'publish-stage bytes must already be scrubbed'\n          );\n        } finally {\n          staged.close();\n        }\n      }\n      return originalRename(source, target);\n    };\n\n    const result = createSnapshot({ databaseFile: f.databaseFile, outputFile });\n    assert.equal(inspectedPublication, true);\n    assert.equal(result.file, outputFile);\n    assert.equal(existsSync(outputFile), true);\n    assert.equal(\n      readdirSync(f.backupDir).some(name => name.includes('.publish-')),\n      false,\n      'publication temp must be cleaned'\n    );\n  } finally {\n    fs.renameSync = originalRename;\n    f.db.close();\n    rmSync(f.dir, { recursive: true, force: true });\n  }\n});\n'''
backup_test.write_text(text.rstrip() + append_test + '\n', encoding='utf-8')
