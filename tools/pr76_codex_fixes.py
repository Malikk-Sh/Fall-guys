from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Bound synchronous diagnostic writes per account before any SQLite work, expose the whole
# bounded retained timeline, remove global row IDs from API events, and count socket transport
# errors in the network-error summary.
replace_once(
    'server/incidentDiagnostics.js',
    """const DEFAULT_MAX_PER_ACCOUNT = 400;
const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 200;
const MAX_VALUE_MS = 7 * DAY_MS;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
""",
    """const DEFAULT_MAX_PER_ACCOUNT = 400;
const DEFAULT_QUERY_LIMIT = DEFAULT_MAX_PER_ACCOUNT;
const MAX_QUERY_LIMIT = 2000;
const DEFAULT_MAX_WRITES_PER_MINUTE = 60;
const MAX_RATE_TRACKED_ACCOUNTS = 10_000;
const MAX_VALUE_MS = 7 * DAY_MS;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
""",
    'diagnostic limits',
)
replace_once(
    'server/incidentDiagnostics.js',
    """function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_QUERY_LIMIT;
  return Math.min(parsed, MAX_QUERY_LIMIT);
}
""",
    """function clampLimit(value, ceiling = MAX_QUERY_LIMIT) {
  const parsed = Number.parseInt(value, 10);
  const boundedCeiling = Math.max(1, Math.min(MAX_QUERY_LIMIT, Number(ceiling) || MAX_QUERY_LIMIT));
  if (!Number.isSafeInteger(parsed) || parsed < 1) return Math.min(DEFAULT_QUERY_LIMIT, boundedCeiling);
  return Math.min(parsed, boundedCeiling);
}
""",
    'dynamic query limit',
)
replace_once(
    'server/incidentDiagnostics.js',
    """    retentionDays = DEFAULT_RETENTION_DAYS,
    maxPerAccount = DEFAULT_MAX_PER_ACCOUNT
  } = {}) {
""",
    """    retentionDays = DEFAULT_RETENTION_DAYS,
    maxPerAccount = DEFAULT_MAX_PER_ACCOUNT,
    maxWritesPerMinute = DEFAULT_MAX_WRITES_PER_MINUTE
  } = {}) {
""",
    'write-rate constructor arg',
)
replace_once(
    'server/incidentDiagnostics.js',
    """    this.maxPerAccount = Math.max(10, Math.min(2000, Number(maxPerAccount) || DEFAULT_MAX_PER_ACCOUNT));
    this.lastPrunedAt = 0;
    this.statements = prepare(db);
""",
    """    this.maxPerAccount = Math.max(10, Math.min(2000, Number(maxPerAccount) || DEFAULT_MAX_PER_ACCOUNT));
    this.maxWritesPerMinute = Math.max(
      5,
      Math.min(600, Number(maxWritesPerMinute) || DEFAULT_MAX_WRITES_PER_MINUTE)
    );
    this.writeBuckets = new Map();
    this.lastPrunedAt = 0;
    this.statements = prepare(db);
""",
    'write-rate state',
)
replace_once(
    'server/incidentDiagnostics.js',
    """    if (!id || !normalizedCode || !Number.isSafeInteger(at) || at < 0) return false;
    if (!this.statements.accountExists.get(id)) return false;

    this.#prune(at);
""",
    """    if (!id || !normalizedCode || !Number.isSafeInteger(at) || at < 0) return false;
    const rateNow = Number(this.now());
    if (!Number.isSafeInteger(rateNow) || rateNow < 0 || !this.#allowWrite(id, rateNow)) return false;
    if (!this.statements.accountExists.get(id)) return false;

    this.#prune(at);
""",
    'rate bound before sqlite',
)
replace_once(
    'server/incidentDiagnostics.js',
    """  timeline(accountId, { limit = DEFAULT_QUERY_LIMIT, now = this.now() } = {}) {
    const id = cleanAccountId(accountId);
    const at = Number(now);
    if (!id || !Number.isSafeInteger(at) || at < 0) return null;
    const account = this.statements.account.get(id);
    if (!account) return null;
    this.#prune(at, true);
    const from = at - this.retentionDays * DAY_MS;
    const rows = this.statements.timeline.all(id, from, clampLimit(limit));
    const summary = this.statements.summary.get(id, from) || {};
    return {
      generatedAt: at,
      retentionDays: this.retentionDays,
      account: { id: account.id, name: account.display_name },
      summary: {
""",
    """  timeline(accountId, { limit = this.maxPerAccount, now = this.now() } = {}) {
    const id = cleanAccountId(accountId);
    const at = Number(now);
    if (!id || !Number.isSafeInteger(at) || at < 0) return null;
    const account = this.statements.account.get(id);
    if (!account) return null;
    this.#prune(at, true);
    const from = at - this.retentionDays * DAY_MS;
    const requestedLimit = clampLimit(limit, this.maxPerAccount);
    const rowsWithSentinel = this.statements.timeline.all(id, from, requestedLimit + 1);
    const truncated = rowsWithSentinel.length > requestedLimit;
    const rows = truncated ? rowsWithSentinel.slice(0, requestedLimit) : rowsWithSentinel;
    const summary = this.statements.summary.get(id, from) || {};
    return {
      generatedAt: at,
      retentionDays: this.retentionDays,
      maxEventsPerAccount: this.maxPerAccount,
      returnedEvents: rows.length,
      truncated,
      account: { id: account.id, name: account.display_name },
      summary: {
""",
    'timeline completeness metadata',
)
replace_once(
    'server/incidentDiagnostics.js',
    """      events: rows.map(row => ({
        id: Number(row.id),
        occurredAt: Number(row.occurred_at),
""",
    """      events: rows.map(row => ({
        occurredAt: Number(row.occurred_at),
""",
    'remove global row ids',
)
replace_once(
    'server/incidentDiagnostics.js',
    """  #prune(now, force = false) {
""",
    """  #allowWrite(accountId, now) {
    let bucket = this.writeBuckets.get(accountId);
    if (!bucket) {
      if (this.writeBuckets.size >= MAX_RATE_TRACKED_ACCOUNTS) {
        const oldest = this.writeBuckets.keys().next().value;
        if (oldest !== undefined) this.writeBuckets.delete(oldest);
      }
      bucket = { tokens: this.maxWritesPerMinute, updatedAt: now };
      this.writeBuckets.set(accountId, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(
        this.maxWritesPerMinute,
        bucket.tokens + (elapsed * this.maxWritesPerMinute) / 60_000
      );
      bucket.updatedAt = now;
    }
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  #prune(now, force = false) {
""",
    'per-account token bucket',
)
replace_once(
    'server/incidentDiagnostics.js',
    """            SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,
""",
    """            SUM(
              CASE
                WHEN kind = 'network-error' OR (kind = 'connection' AND code = 'socket-error') THEN 1
                ELSE 0
              END
            ) AS network_errors,
""",
    'transport errors in summary',
)
replace_once(
    'server/incidentDiagnostics.js',
    """  MAX_QUERY_LIMIT,
  validCode,
""",
    """  MAX_QUERY_LIMIT,
  DEFAULT_MAX_WRITES_PER_MINUTE,
  validCode,
""",
    'export write rate constant',
)

# Diagnostics service regressions for write-rate, truncation and privacy-minimized event objects.
replace_once(
    'server/incidentDiagnostics.test.mjs',
    """  assert.equal(timeline.summary.networkErrors, 1);
  assert.equal(timeline.events.length, 1);
""",
    """  assert.equal(timeline.summary.networkErrors, 1);
  assert.equal(timeline.events.length, 1);
  assert.equal(Object.hasOwn(timeline.events[0], 'id'), false);
""",
    'no global event id regression',
)
append = r'''

test('incident diagnostics rate-limits synchronous writes per account before storage', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const id = account(db, 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  let now = 60_000;
  const incidents = new IncidentDiagnostics({ db, now: () => now, maxWritesPerMinute: 5 });

  for (let index = 0; index < 5; index += 1) {
    assert.equal(incidents.record({ accountId: id, kind: 'network-error', code: 'INVALID_MESSAGE' }), true);
  }
  assert.equal(incidents.record({ accountId: id, kind: 'network-error', code: 'INVALID_MESSAGE' }), false);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM player_incident_events WHERE account_id = ?').get(id).count,
    5
  );

  now += 12_000;
  assert.equal(incidents.record({ accountId: id, kind: 'connection', code: 'socket-error' }), true);
  const timeline = incidents.timeline(id, { now });
  assert.equal(timeline.summary.networkErrors, 6, 'transport socket errors belong in the network-error total');
  db.close();
});

test('incident timeline reports truncation and can return the full bounded retained history', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const id = account(db, 'cccccccc-dddd-eeee-ffff-000000000000');
  let now = 100_000;
  const incidents = new IncidentDiagnostics({
    db,
    now: () => now,
    maxPerAccount: 10,
    maxWritesPerMinute: 100
  });
  for (let index = 0; index < 10; index += 1) {
    now += 1;
    assert.equal(incidents.record({ accountId: id, kind: 'connection', code: 'disconnected' }), true);
  }

  const partial = incidents.timeline(id, { limit: 3, now });
  assert.equal(partial.events.length, 3);
  assert.equal(partial.returnedEvents, 3);
  assert.equal(partial.summary.events, 10);
  assert.equal(partial.truncated, true);

  const full = incidents.timeline(id, { limit: 2000, now });
  assert.equal(full.events.length, 10);
  assert.equal(full.returnedEvents, 10);
  assert.equal(full.maxEventsPerAccount, 10);
  assert.equal(full.truncated, false);
  db.close();
});
'''
path = Path('server/incidentDiagnostics.test.mjs')
text = path.read_text(encoding='utf-8')
if 'rate-limits synchronous writes per account before storage' in text:
    raise SystemExit('diagnostic review regressions already present')
path.write_text(text.rstrip() + append + '\n', encoding='utf-8')

# 2) Make late blocked AUTH bind the proven denied account to the room/session for enforcement, so
# a reconnect token cannot fall back to an anonymous slot after the transport is closed.
replace_once(
    'server/index.js',
    """  if (room.state === ROOM_STATE.LOBBY) emitLobby(room);
  return true;
}

function createCoopRoom(chapterId, hostId) {
""",
    """  if (room.state === ROOM_STATE.LOBBY) emitLobby(room);
  return true;
}

function bindDeniedSocketToRoomForEnforcement(ws, accountId) {
  const id = String(accountId || '');
  if (!id || !ws?.room) return false;
  const room = rooms.get(ws.room);
  const player = room?.players.get(ws.id);
  if (!player || player.ws !== ws) return false;

  // A valid ticket proved who owns this socket even though policy denied authentication. Preserve
  // that identity only for server-side enforcement; public player payloads never expose accountId.
  player.accountId = id;
  for (const session of sessions.values()) {
    if (session.playerId === player.id && session.roomCode === room.code) session.accountId = id;
  }
  return true;
}

function createCoopRoom(chapterId, hostId) {
""",
    'denied late-auth enforcement binding',
)
replace_once(
    'server/index.js',
    """        if (authenticated.reason === 'blocked-account') {
          incidentForSocket(ws, {
            accountId: ws.accountAccessDeniedAccountId,
""",
    """        if (authenticated.reason === 'blocked-account') {
          bindDeniedSocketToRoomForEnforcement(ws, ws.accountAccessDeniedAccountId);
          incidentForSocket(ws, {
            accountId: ws.accountAccessDeniedAccountId,
""",
    'apply denied auth enforcement binding',
)

# 3) Record the terminal reason when operational drain empties the matchmaking queue.
replace_once(
    'server/index.js',
    """  const queued = coopMatchmaking.splice(0);
  for (const entry of queued) {
    gameplay.count('matchmaking_queue_exit', {
""",
    """  const queued = coopMatchmaking.splice(0);
  for (const entry of queued) {
    incidentForSocket(entry.ws, { kind: 'matchmaking', code: 'restart', phase: 'matchmaking' });
    gameplay.count('matchmaking_queue_exit', {
""",
    'restart matchmaking incident',
)

# 4) Admin asks for the whole bounded retained timeline and surfaces completeness in UI/package.
replace_once(
    'client/admin/admin.js',
    """  $('#incident-meta').textContent =
    `История хранится ${formatNumber(incident.retentionDays)} дней · сформировано ${formatTime(incident.generatedAt)} · сейчас ${formatNumber(incident.live?.sockets)} игровых WebSocket.`;
""",
    """  const coverage = incident.truncated
    ? `показано ${formatNumber(incident.returnedEvents)} из ${formatNumber(summary.events)} событий`
    : `показаны все ${formatNumber(incident.returnedEvents)} сохранённых событий`;
  $('#incident-meta').textContent =
    `История хранится ${formatNumber(incident.retentionDays)} дней · ${coverage} · сформировано ${formatTime(incident.generatedAt)} · сейчас ${formatNumber(incident.live?.sockets)} игровых WebSocket.`;
""",
    'incident completeness UI',
)
replace_once(
    'client/admin/admin.js',
    """    const payload = await api('/api/admin/incidents/player', { accountId, limit: 150 });
""",
    """    const payload = await api('/api/admin/incidents/player', { accountId, limit: 2000 });
""",
    'request full retained timeline',
)
replace_once(
    'client/admin/admin.js',
    """    retentionDays: incident.retentionDays,
    player: {
""",
    """    retentionDays: incident.retentionDays,
    maxEventsPerAccount: incident.maxEventsPerAccount,
    returnedEvents: incident.returnedEvents,
    truncated: incident.truncated,
    player: {
""",
    'package completeness metadata',
)

# 5) Incident data is ephemeral operational telemetry: verified local/offsite backups keep the table
# and schema but deliberately contain zero rows. This avoids months-long recovery from retained tiers.
replace_once(
    'server/backup.js',
    """function createSnapshot({ databaseFile, outputFile }) {
""",
    """function scrubEphemeralBackupData(file) {
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
""",
    'ephemeral backup scrub helper',
)
replace_once(
    'server/backup.js',
    """  } finally {
    db.close();
  }
  return { file: output, ...verifyBackup(output) };
}

function createLegacySnapshot({ databaseFile, outputFile }) {
""",
    """  } finally {
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
""",
    'scrub snapshot before verification',
)
replace_once(
    'server/backup.js',
    """  verifyLegacyBackup,
  createSnapshot,
""",
    """  verifyLegacyBackup,
  scrubEphemeralBackupData,
  createSnapshot,
""",
    'export scrub helper',
)

backup_append = r'''

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
      .run(player.id, 1234, 'connection', 'disconnected', 'abcdef123456', null, 'coop', 'PLAYING', 'mobile', null);
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
'''
path = Path('server/backup.test.mjs')
text = path.read_text(encoding='utf-8')
if 'verified local and offsite backups exclude ephemeral player incident rows' in text:
    raise SystemExit('backup privacy regression already present')
path.write_text(text.rstrip() + backup_append + '\n', encoding='utf-8')

# 6) Regression coverage for blocked late AUTH and drain-driven matchmaking terminal events.
socket_append = r'''

test('blocked late WebSocket AUTH cannot resume the anonymous room slot', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  const account = core.accounts.create('Blocked Late Auth');
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket), id => id !== account.id);
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const first = await openClient(url);
  const clients = [first];
  t.after(async () => {
    await Promise.all(clients.map(closeClient));
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const lobbyReply = waitFor(first, 'lobby');
  first.send(JSON.stringify({ type: 'create', name: 'Anonymous Before Block', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  const player = [...room.players.values()][0];
  const reconnectToken = first.token || player.ws.token;
  assert.equal(player.accountId, null);

  const blockedReply = waitFor(first, 'error');
  first.send(JSON.stringify({ type: 'auth', ticket }));
  const blocked = await blockedReply;
  assert.equal(blocked.code, 'ACCOUNT_SANCTIONED');
  assert.equal(player.accountId, account.id, 'the proven denied identity remains attached for resume enforcement');
  assert.equal(core.sessions.get(reconnectToken)?.accountId, account.id);

  const second = await openClient(url);
  clients.push(second);
  const resumeDenied = waitFor(second, 'error');
  second.send(JSON.stringify({ type: 'resume', token: reconnectToken }));
  const denied = await resumeDenied;
  assert.equal(denied.code, 'ACCOUNT_SANCTIONED');
});

test('operational drain records restart as the terminal matchmaking event', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Drain Diagnostic');
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
  const waitingReply = waitFor(client, 'matchmaking_waiting');
  client.send(JSON.stringify({ type: 'find_coop', name: account.name, chapterId: '', protocolVersion: 10 }));
  await waitingReply;

  assert.equal(core.beginOperationalDrain(), true);
  const timeline = core.incidentDiagnostics.timeline(account.id);
  assert.ok(
    timeline.events.some(event => event.kind === 'matchmaking' && event.code === 'restart'),
    'drain must explain why a queued player stopped waiting'
  );
});
'''
path = Path('server/socketAuthIntegration.test.mjs')
text = path.read_text(encoding='utf-8')
if 'blocked late WebSocket AUTH cannot resume the anonymous room slot' in text:
    raise SystemExit('socket review regressions already present')
path.write_text(text.rstrip() + socket_append + '\n', encoding='utf-8')
