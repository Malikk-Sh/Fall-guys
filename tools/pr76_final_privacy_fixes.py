from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# Live SQLite privacy: secure deleted cells on the shared connection.
replace_once(
    'server/db.js',
    "  const db = new DatabaseSync(file);\n",
    "  const db = new DatabaseSync(file);\n  // Privacy-retained tables rely on physical deletion, not only logical DELETE visibility.\n  // secure_delete overwrites deleted cells before pages can be reused. WAL frames are truncated\n  // by the owning diagnostics service after bounded cleanup batches.\n  db.exec('PRAGMA secure_delete = ON');\n",
    'secure_delete pragma',
)

# Incident cleanup: remember deletes caused by both retention and per-account cap, then truncate WAL
# in a bounded way. Retention expiry forces the checkpoint immediately; cap cleanup retries at most
# once per minute and heartbeat/record calls keep making progress if a checkpoint was busy.
replace_once(
    'server/incidentDiagnostics.js',
    "const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;\n",
    "const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;\nconst DELETE_CHECKPOINT_RETRY_MS = 60 * 1000;\n",
    'checkpoint constant',
)
replace_once(
    'server/incidentDiagnostics.js',
    "    this.lastPrunedAt = 0;\n    this.statements = prepare(db);\n",
    "    this.lastPrunedAt = 0;\n    this.lastDeleteCheckpointAt = 0;\n    this.deleteCheckpointPending = false;\n    this.statements = prepare(db);\n",
    'checkpoint state',
)
replace_once(
    'server/incidentDiagnostics.js',
    "    this.statements.capAccount.run(id, id, this.maxPerAccount);\n    return true;\n",
    "    const capped = this.statements.capAccount.run(id, id, this.maxPerAccount);\n    if (Number(capped?.changes || 0) > 0) this.#noteDeletedData(rateNow);\n    return true;\n",
    'cap deletion checkpoint',
)
replace_once(
    'server/incidentDiagnostics.js',
    "  pruneExpired(now = this.now(), { force = false } = {}) {\n    const at = Number(now);\n    if (!Number.isSafeInteger(at) || at < 0) return 0;\n    if (!force && at - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return 0;\n    const result = this.statements.prune.run(at - this.retentionDays * DAY_MS);\n    this.lastPrunedAt = at;\n    return Number(result?.changes || 0);\n  }\n",
    "  pruneExpired(now = this.now(), { force = false } = {}) {\n    const at = Number(now);\n    if (!Number.isSafeInteger(at) || at < 0) return 0;\n    // A cap deletion may have left a busy WAL checkpoint pending. Heartbeat reaches this path even\n    // when no new player activity occurs, so retry it independently of the hourly retention DELETE.\n    this.#flushDeletedData(at);\n    if (!force && at - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return 0;\n    const result = this.statements.prune.run(at - this.retentionDays * DAY_MS);\n    const changes = Number(result?.changes || 0);\n    this.lastPrunedAt = at;\n    if (changes > 0) this.#noteDeletedData(at, { force: true });\n    return changes;\n  }\n\n  #noteDeletedData(now, { force = false } = {}) {\n    this.deleteCheckpointPending = true;\n    return this.#flushDeletedData(now, { force });\n  }\n\n  #flushDeletedData(now, { force = false } = {}) {\n    if (!this.deleteCheckpointPending) return true;\n    const at = Number(now);\n    if (!Number.isSafeInteger(at) || at < 0) return false;\n    if (!force && at - this.lastDeleteCheckpointAt < DELETE_CHECKPOINT_RETRY_MS) return false;\n    this.lastDeleteCheckpointAt = at;\n    try {\n      const result = this.statements.checkpoint.get() || {};\n      const busy = Number(Object.values(result)[0] ?? 1);\n      if (busy === 0) {\n        this.deleteCheckpointPending = false;\n        return true;\n      }\n    } catch {\n      // Observability cleanup is best-effort for gameplay availability. A later heartbeat retries.\n    }\n    return false;\n  }\n",
    'physical retention cleanup',
)
replace_once(
    'server/incidentDiagnostics.js',
    "    prune: db.prepare('DELETE FROM player_incident_events WHERE occurred_at < ?'),\n",
    "    prune: db.prepare('DELETE FROM player_incident_events WHERE occurred_at < ?'),\n    checkpoint: db.prepare('PRAGMA wal_checkpoint(TRUNCATE)'),\n",
    'checkpoint statement',
)

# Preserve match-at-disconnect context so race can advance to RESULTS/LOBBY while grace is ticking.
replace_once(
    'server/index.js',
    "    disconnectedAt: null,\n    away: false,\n",
    "    disconnectedAt: null,\n    disconnectMatchContext: null,\n    away: false,\n",
    'player disconnect context init',
)
replace_once(
    'server/index.js',
    "  player.ws = null;\n  player.disconnectedAt = Date.now();\n  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'disconnected' });\n",
    "  player.ws = null;\n  player.disconnectedAt = Date.now();\n  player.disconnectMatchContext =\n    !player.finished && (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING)\n      ? { roomId: room.code, matchId: room.matchId, mode: room.mode, phase: room.state }\n      : null;\n  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'disconnected' });\n",
    'capture disconnect match context',
)
replace_once(
    'server/index.js',
    "  player.ws = ws;\n  player.disconnectedAt = null;\n",
    "  player.ws = ws;\n  player.disconnectedAt = null;\n  player.disconnectMatchContext = null;\n",
    'clear context on resume',
)
replace_once(
    'server/index.js',
    "      if (room.state === ROOM_STATE.COUNTDOWN || room.state === ROOM_STATE.PLAYING) {\n        if (!room.abandonTracked) {\n          room.abandonTracked = true;\n          trackEvent(productEvents, 'matchAbandoned');\n        }\n        gameplay.count('match_abandoned', dims(room, player, `cp${player.checkpoint ?? 0}`));\n        incidentForSocket(player.ws, {\n          accountId: player.accountId,\n          kind: 'match',\n          code: 'abandoned',\n          roomId: room.code,\n          matchId: room.matchId,\n          mode: room.mode,\n          phase: room.state\n        });\n      }\n      dropPlayer(room, player.id);\n",
    "      const abandoned = player.disconnectMatchContext;\n      if (abandoned) {\n        if (!room.abandonTracked) {\n          room.abandonTracked = true;\n          trackEvent(productEvents, 'matchAbandoned');\n        }\n        gameplay.count('match_abandoned', dims(room, player, `cp${player.checkpoint ?? 0}`));\n        incidentForSocket(player.ws, {\n          accountId: player.accountId,\n          kind: 'match',\n          code: 'abandoned',\n          roomId: abandoned.roomId,\n          matchId: abandoned.matchId,\n          mode: abandoned.mode,\n          phase: abandoned.phase\n        });\n        player.disconnectMatchContext = null;\n      }\n      dropPlayer(room, player.id);\n",
    'expire saved match context',
)

# Backup raw stages: keep them in one private DB-local staging root so the hourly production backup
# can proactively remove abandoned direct-CLI stages too. Explicit modes do not depend on caller umask.
replace_once('server/backup.js', "const os = require('os');\n", '', 'remove os tmp import')
replace_once(
    'server/backup.js',
    "const DEFAULT_OFFSITE_SENTINEL = '.wobble-offsite';\n",
    "const DEFAULT_OFFSITE_SENTINEL = '.wobble-offsite';\nconst RAW_STAGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;\nconst RAW_STAGE_DIRECTORY = '.wobble-backup-staging';\n",
    'backup staging constants',
)
replace_once(
    'server/backup.js',
    "function timestamp(now = Date.now()) {\n",
    "function backupStagingRoot(databaseFile) {\n  const root = ensureDirectory(path.join(path.dirname(ensureFileDatabase(databaseFile)), RAW_STAGE_DIRECTORY));\n  fs.chmodSync(root, 0o700);\n  return root;\n}\n\nfunction cleanupAbandonedBackupStages(root, now = Date.now()) {\n  let removed = 0;\n  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {\n    if (!entry.name.startsWith('stage-')) continue;\n    const target = path.join(root, entry.name);\n    let stat;\n    try {\n      stat = fs.statSync(target);\n    } catch {\n      continue;\n    }\n    if (now - stat.mtimeMs < RAW_STAGE_MAX_AGE_MS) continue;\n    fs.rmSync(target, { recursive: true, force: true });\n    removed += 1;\n  }\n  return removed;\n}\n\nfunction timestamp(now = Date.now()) {\n",
    'stale staging cleanup helper',
)
replace_once(
    'server/backup.js',
    "  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-backup-stage-'));\n  const rawStage = path.join(stagingDir, 'snapshot.db');\n",
    "  const stagingRoot = backupStagingRoot(sourceFile);\n  cleanupAbandonedBackupStages(stagingRoot);\n  const stagingDir = fs.mkdtempSync(path.join(stagingRoot, 'stage-'));\n  fs.chmodSync(stagingDir, 0o700);\n  const rawStage = path.join(stagingDir, 'snapshot.db');\n",
    'private stable stage root',
)
replace_once(
    'server/backup.js',
    "      db.exec(`VACUUM INTO ${sqlString(rawStage)}`);\n",
    "      db.exec(`VACUUM INTO ${sqlString(rawStage)}`);\n      fs.chmodSync(rawStage, 0o600);\n",
    'raw stage permissions',
)
replace_once(
    'server/backup.js',
    "    fs.copyFileSync(rawStage, publishStage, fs.constants.COPYFILE_EXCL);\n    const verification = verifyBackup(publishStage);\n    fs.renameSync(publishStage, output);\n    return { file: output, ...verification };\n",
    "    fs.copyFileSync(rawStage, publishStage, fs.constants.COPYFILE_EXCL);\n    fs.chmodSync(publishStage, 0o600);\n    const verification = verifyBackup(publishStage);\n    fs.renameSync(publishStage, output);\n    fs.chmodSync(output, 0o600);\n    return { file: output, ...verification };\n",
    'published snapshot mode',
)
replace_once(
    'server/backup.js',
    "    db.exec(`VACUUM INTO ${sqlString(output)}`);\n    return { file: output, ...verifyLegacyBackup(output) };\n",
    "    db.exec(`VACUUM INTO ${sqlString(output)}`);\n    fs.chmodSync(output, 0o600);\n    return { file: output, ...verifyLegacyBackup(output) };\n",
    'legacy mode hardening',
)

# Remove the two known direct production snapshot invocations. Manual migration backup now uses the
# hardened systemd backup service; restore creates a fresh service snapshot, then copies those already
# scrubbed bytes into its dedicated rollback slot.
replace_once(
    'docs/DEPLOY.md',
    '''Перед обновлением всё равно полезно сохранить проверенный SQLite snapshot. Не копируй\n`leaderboard.db` обычным `cp`: при WAL это может быть неполная копия, а после migration 014 raw\nкопия также обойдёт privacy-scrub диагностического журнала. Используй тот же snapshot pipeline:\n\n```bash\nsystemctl stop wobble\nmkdir -p /var/lib/wobble/backups/manual\nnode /opt/wobble/server/backupCli.mjs snapshot \\\n  /var/lib/wobble/leaderboard.db \\\n  "/var/lib/wobble/backups/manual/pre-migration-$(date -u +%Y%m%dT%H%M%SZ).db"\nsystemctl start wobble\nsqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'\n```\n''',
    '''Перед обновлением всё равно полезно создать свежий проверенный SQLite snapshot. Не копируй\n`leaderboard.db` обычным `cp`: при WAL это может быть неполная копия, а после migration 014 raw\nкопия также обойдёт privacy-scrub диагностического журнала. Используй штатный backup service —\nон запускает тот же verified pipeline в `PrivateTmp` и публикует snapshot только после scrub:\n\n```bash\nsystemctl start wobble-backup.service\nsystemctl stop wobble\nsystemctl start wobble\nsqlite3 /var/lib/wobble/leaderboard.db 'SELECT version, applied_at FROM schema_migrations;'\n```\n''',
    'migration docs use service',
)

old_restore = '''# Prepare all rollback storage before touching the running service.\nmkdir -p "$BACKUP_DIR/restore-rollback"\nchown "$APP_USER:$APP_GROUP" "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"\nchmod 700 "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"\n\nsay "Stop application"\nsystemctl stop wobble\nrollback=""\nif [ -f "$DB" ]; then\n  rollback="$BACKUP_DIR/restore-rollback/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"\n  if ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" snapshot "$DB" "$rollback" ||\n    ! chown "$APP_USER:$APP_GROUP" "$rollback" ||\n    ! chmod 600 "$rollback"; then\n    warn "pre-restore rollback snapshot failed; original database has not been replaced"\n    systemctl start wobble || warn "could not restart the untouched server"\n    exit 1\n  fi\n  echo "rollback snapshot: $rollback"\nfi\n'''
new_restore = '''# Prepare rollback storage and create a fresh verified snapshot before touching the running service.\nmkdir -p "$BACKUP_DIR/restore-rollback"\nchown "$APP_USER:$APP_GROUP" "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"\nchmod 700 "$BACKUP_DIR" "$BACKUP_DIR/restore-rollback"\n\nrollback=""\nif [ -f "$DB" ]; then\n  say "Create verified pre-restore rollback snapshot"\n  backup_started_at="$(date +%s)"\n  if ! systemctl start wobble-backup.service; then\n    warn "pre-restore backup service failed; original database has not been replaced"\n    exit 1\n  fi\n  fresh_backup="$(find "$BACKUP_DIR/hourly" -maxdepth 1 -type f -name '*.db' -printf '%T@ %p\\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2-)"\n  if [ -z "$fresh_backup" ] || [ "$(stat -c %Y "$fresh_backup" 2>/dev/null || echo 0)" -lt "$backup_started_at" ] ||\n    ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$fresh_backup"; then\n    warn "fresh verified rollback source was not produced; original database has not been replaced"\n    exit 1\n  fi\n  rollback="$BACKUP_DIR/restore-rollback/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)-$$.db"\n  if ! install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$fresh_backup" "$rollback" ||\n    ! /usr/bin/node "$APP_DIR/server/backupCli.mjs" verify "$rollback"; then\n    warn "pre-restore rollback copy failed; original database has not been replaced"\n    rm -f "$rollback"\n    rollback=""\n    exit 1\n  fi\n  echo "rollback snapshot: $rollback"\nfi\n\nsay "Stop application"\nsystemctl stop wobble\n'''
replace_once('deploy/restore.sh', old_restore, new_restore, 'restore uses backup service')

# Admin-session privacy: make logout/session-expiry invalidate in-flight incident reads and erase DOM.
replace_once(
    'client/admin/admin.js',
    "function showLogin(message = '') {\n  closeModerationCase();\n  clearPlayerSupportView();\n",
    "function clearIncidentView() {\n  state.incidentRevision += 1;\n  state.incidentSearchQuery = '';\n  state.incidentData = null;\n  const detail = $('#incident-detail');\n  if (detail) detail.hidden = true;\n  const query = $('#incident-search-query');\n  if (query) query.value = '';\n  const meta = $('#incident-search-meta');\n  if (meta) meta.textContent = '';\n  const results = $('#incident-results-body');\n  if (results) results.replaceChildren();\n  const summary = $('#incident-summary-cards');\n  if (summary) summary.replaceChildren();\n  const events = $('#incident-events-body');\n  if (events) events.replaceChildren();\n  const name = $('#incident-detail-name');\n  if (name) name.textContent = 'Игрок';\n  const id = $('#incident-detail-id');\n  if (id) id.textContent = '';\n  const incidentMeta = $('#incident-meta');\n  if (incidentMeta) incidentMeta.textContent = '';\n}\n\nfunction showLogin(message = '') {\n  closeModerationCase();\n  clearPlayerSupportView();\n  clearIncidentView();\n",
    'clear incidents on login boundary',
)
replace_once(
    'client/admin/admin.js',
    "  abandoned: 'Матч покинут после grace period',\n",
    "  abandoned: 'Матч покинут или не восстановлен',\n",
    'abandon label accuracy',
)

# Accurate privacy disclosure: coarse mobile/desktop is stored, raw UA/fingerprint/IP are not.
replace_once(
    'client/admin/index.html',
    '''              <span\n                >Открытие этой карточки записывается в «Журнал действий». IP-адреса и данные устройства\n                игровых сессий Wobble сейчас не собирает. Панель показывает только безопасные короткие ID и\n                время сессий — они не позволяют войти в аккаунт.</span\n              >\n''',
    '''              <span\n                >Открытие этой карточки записывается в «Журнал действий». Wobble не сохраняет IP-адрес, raw\n                User-Agent или device fingerprint игровой сессии. Incident Center может до 14 дней хранить\n                только грубый класс устройства «mobile/desktop» для диагностики; он не идентифицирует\n                конкретное устройство. Короткие ID и время сессий не позволяют войти в аккаунт.</span\n              >\n''',
    'player privacy notice',
)
replace_once(
    'client/admin/index.html',
    '''              История хранится ограниченное время и не содержит IP, User-Agent, токенов, recovery-данных,\n              invite-кодов комнат или сырых match ID. Корреляционные ссылки ниже необратимо маскируются\n''',
    '''              История хранится ограниченное время и не содержит IP, raw User-Agent, device fingerprints,\n              токенов, recovery-данных, invite-кодов комнат или сырых match ID. Для диагностики может\n              сохраняться только грубый класс «mobile/desktop». Корреляционные ссылки ниже необратимо маскируются\n''',
    'incident privacy notice',
)

# Regression tests: secure-delete/WAL, stale backup stage cleanup + modes, admin logout disclosure,
# and disconnect -> RESULTS -> grace expiry abandonment.
incident_test = Path('server/incidentDiagnostics.test.mjs')
text = incident_test.read_text(encoding='utf-8')
text = text.replace(
    "import { createRequire } from 'node:module';\n",
    "import { createRequire } from 'node:module';\nimport { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { join } from 'node:path';\n",
    1,
)
append = '''\n\ntest('live incident retention uses secure_delete and truncates WAL after physical cleanup', () => {\n  const dir = mkdtempSync(join(tmpdir(), 'wobble-incident-live-'));\n  const file = join(dir, 'live.db');\n  const db = openDatabase(file);\n  try {\n    migrateDatabase(db);\n    assert.equal(Number(Object.values(db.prepare('PRAGMA secure_delete').get())[0]), 1);\n    const id = account(db, 'eeeeeeee-ffff-0000-1111-222222222222');\n    let now = 10_000;\n    const day = 24 * 60 * 60 * 1000;\n    const incidents = new IncidentDiagnostics({ db, now: () => now, retentionDays: 1 });\n    assert.equal(incidents.record({ accountId: id, kind: 'connection', code: 'disconnected' }), true);\n    now += 2 * day;\n    assert.equal(incidents.pruneExpired(now, { force: true }), 1);\n    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_incident_events').get().count, 0);\n    const wal = `${file}-wal`;\n    if (existsSync(wal)) assert.equal(statSync(wal).size, 0, 'retention checkpoint must truncate old WAL frames');\n  } finally {\n    db.close();\n    rmSync(dir, { recursive: true, force: true });\n  }\n});\n'''
incident_test.write_text(text.rstrip() + append + '\n', encoding='utf-8')

backup_test = Path('server/backup.test.mjs')
text = backup_test.read_text(encoding='utf-8')
text = text.replace(
    "  rmSync,\n  writeFileSync\n",
    "  rmSync,\n  statSync,\n  utimesSync,\n  writeFileSync\n",
    1,
)
text = text.replace(
    "    assert.equal(existsSync(outputFile), true);\n",
    "    assert.equal(existsSync(outputFile), true);\n    assert.equal(statSync(outputFile).mode & 0o777, 0o600, 'published snapshot must be mode 0600');\n",
    1,
)
append = '''\n\ntest('next snapshot proactively removes abandoned private raw stages', () => {\n  const f = fixture();\n  try {\n    const stagingRoot = join(f.dir, '.wobble-backup-staging');\n    const abandoned = join(stagingRoot, 'stage-abandoned');\n    mkdirSync(abandoned, { recursive: true, mode: 0o700 });\n    writeFileSync(join(abandoned, 'snapshot.db'), 'sensitive-test-placeholder', { mode: 0o600 });\n    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);\n    utimesSync(abandoned, old, old);\n\n    const outputFile = join(f.backupDir, 'cleanup-stage.db');\n    createSnapshot({ databaseFile: f.databaseFile, outputFile });\n    assert.equal(existsSync(abandoned), false, 'stale raw stage must be removed by the next snapshot');\n    assert.equal(statSync(stagingRoot).mode & 0o777, 0o700);\n    assert.equal(statSync(outputFile).mode & 0o777, 0o600);\n  } finally {\n    f.db.close();\n    rmSync(f.dir, { recursive: true, force: true });\n  }\n});\n'''
backup_test.write_text(text.rstrip() + append + '\n', encoding='utf-8')

admin_test = Path('server/adminIncidentRoutes.test.mjs')
text = admin_test.read_text(encoding='utf-8')
text = text.replace(
    "import { createRequire } from 'node:module';\n",
    "import { createRequire } from 'node:module';\nimport { readFileSync } from 'node:fs';\n",
    1,
)
append = '''\n\ntest('admin logout clears account-linked incident state and privacy copy describes coarse device class', () => {\n  const adminJs = readFileSync(new URL('../client/admin/admin.js', import.meta.url), 'utf8');\n  const adminHtml = readFileSync(new URL('../client/admin/index.html', import.meta.url), 'utf8');\n  const clearStart = adminJs.indexOf('function clearIncidentView()');\n  const loginStart = adminJs.indexOf("function showLogin(message = '')");\n  assert.ok(clearStart >= 0 && loginStart > clearStart);\n  const clearBody = adminJs.slice(clearStart, loginStart);\n  for (const fragment of [\n    'state.incidentRevision += 1',\n    "state.incidentSearchQuery = ''",\n    'state.incidentData = null',\n    "$('#incident-results-body')",\n    "$('#incident-events-body')"\n  ]) assert.ok(clearBody.includes(fragment), `missing incident cleanup: ${fragment}`);\n  assert.match(adminJs.slice(loginStart, loginStart + 220), /clearIncidentView\(\)/);\n  assert.match(adminHtml, /mobile\/desktop/);\n  assert.match(adminHtml, /raw\s+User-Agent/i);\n  assert.match(adminHtml, /device fingerprint/i);\n});\n'''
admin_test.write_text(text.rstrip() + append + '\n', encoding='utf-8')

socket_test = Path('server/socketAuthIntegration.test.mjs')
text = socket_test.read_text(encoding='utf-8')
needle = "test('explicit LEAVE_ROOM during an active match records an immediate abandon incident', async t => {\n"
if text.count(needle) != 1:
    raise SystemExit('race abandonment insertion point mismatch')
new_test = '''test('disconnect abandonment keeps original race context after room advances to results', async t => {\n  core.resetRateLimits();\n  const auth = new AuthService({ db: core.accounts.db });\n  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));\n  const account = core.accounts.create('Race Grace Diagnostic');\n  const ticket = auth.createSocketTicket(account.id).token;\n\n  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));\n  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;\n  const client = await openClient(url);\n  t.after(async () => {\n    await closeClient(client);\n    await new Promise(resolve => core.server.close(resolve));\n    networkIdentity.reset();\n  });\n\n  const authReply = waitFor(client, 'authenticated');\n  client.send(JSON.stringify({ type: 'auth', ticket }));\n  await authReply;\n  const lobbyReply = waitFor(client, 'lobby');\n  client.send(JSON.stringify({ type: 'create', name: account.name, protocolVersion: 10 }));\n  const lobby = await lobbyReply;\n  const room = core.rooms.get(lobby.code);\n  const player = room.players.values().next().value;\n  room.state = 'PLAYING';\n  room.matchId = 'race-before-results';\n  player.finished = false;\n\n  await closeClient(client);\n  assert.ok(player.disconnectedAt, 'disconnect must start reconnect grace');\n  assert.equal(player.disconnectMatchContext?.matchId, 'race-before-results');\n  room.state = 'RESULTS';\n  room.matchId = null;\n  core.expireDisconnectedPlayers(player.disconnectedAt + 31_000);\n\n  const timeline = core.incidentDiagnostics.timeline(account.id);\n  const abandoned = timeline.events.find(event => event.kind === 'match' && event.code === 'abandoned');\n  assert.ok(abandoned, 'grace expiry must still emit abandonment after RESULTS');\n  assert.match(abandoned.matchRef || '', /^[a-f0-9]{12}$/);\n});\n\n'''
socket_test.write_text(text.replace(needle, new_test + needle, 1), encoding='utf-8')
