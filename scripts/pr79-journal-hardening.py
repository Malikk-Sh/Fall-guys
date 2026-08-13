from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:180]!r}")
    path.write_text(text.replace(old, new, 1))


helper = Path('deploy/wobble-ops-helper.mjs')
replace_once(
    helper,
    """export function readOperationJournal(journalPath = OPERATION_JOURNAL) {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (parsed?.version !== OPERATION_JOURNAL_VERSION || !Array.isArray(parsed.operations)) return [];
    return parsed.operations.map(normalizeOperationRecord).filter(Boolean).slice(-OPERATION_HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function writeOperationJournal(records, journalPath = OPERATION_JOURNAL) {
  const directory = path.dirname(journalPath);
  const temporaryPath = `${journalPath}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    const operations = records.map(normalizeOperationRecord).filter(Boolean).slice(-OPERATION_HISTORY_LIMIT);
    fs.writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: OPERATION_JOURNAL_VERSION, operations })}\\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    fs.renameSync(temporaryPath, journalPath);
    // Journal contains only allowlisted action IDs, state, timestamps and safe reason codes.
    // It is intentionally readable by the unprivileged Control Plane, but only root can replace it.
    fs.chmodSync(journalPath, 0o644);
    return true;
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return false;
  }
}
""",
    """function loadOperationJournal(journalPath = OPERATION_JOURNAL) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, records: [] };
    return { ok: false, records: [] };
  }
  if (parsed?.version !== OPERATION_JOURNAL_VERSION || !Array.isArray(parsed.operations)) {
    return { ok: false, records: [] };
  }
  const records = parsed.operations.map(normalizeOperationRecord);
  if (records.some(record => !record)) return { ok: false, records: [] };
  const ids = new Set(records.map(record => record.id));
  if (ids.size !== records.length) return { ok: false, records: [] };
  return { ok: true, records: records.slice(-OPERATION_HISTORY_LIMIT) };
}

export function readOperationJournal(journalPath = OPERATION_JOURNAL) {
  const loaded = loadOperationJournal(journalPath);
  return loaded.ok ? loaded.records : [];
}

function writeOperationJournal(records, journalPath = OPERATION_JOURNAL) {
  const directory = path.dirname(journalPath);
  const temporaryPath = `${journalPath}.tmp-${process.pid}`;
  let fileDescriptor = null;
  let directoryDescriptor = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    const operations = records.map(normalizeOperationRecord);
    if (operations.some(record => !record)) return false;
    const bounded = operations.slice(-OPERATION_HISTORY_LIMIT);
    fileDescriptor = fs.openSync(temporaryPath, 'w', 0o600);
    fs.writeFileSync(
      fileDescriptor,
      `${JSON.stringify({ version: OPERATION_JOURNAL_VERSION, operations: bounded })}\\n`,
      'utf8'
    );
    // The journal contains no secrets. Make the completed temp inode readable by the unprivileged
    // Control Plane before publishing it, then fsync the file and parent directory around rename.
    fs.fchmodSync(fileDescriptor, 0o644);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(temporaryPath, journalPath);
    directoryDescriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryDescriptor);
    fs.closeSync(directoryDescriptor);
    directoryDescriptor = null;
    return true;
  } catch {
    if (fileDescriptor != null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch {
        // Best effort cleanup only.
      }
    }
    if (directoryDescriptor != null) {
      try {
        fs.closeSync(directoryDescriptor);
      } catch {
        // Best effort cleanup only.
      }
    }
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return false;
  }
}
""",
)
replace_once(
    helper,
    """export function beginDurableOperation(request, { journalPath = OPERATION_JOURNAL, now = Date.now() } = {}) {
  const records = readOperationJournal(journalPath);
  const active = activeOperation(records);
""",
    """export function beginDurableOperation(request, { journalPath = OPERATION_JOURNAL, now = Date.now() } = {}) {
  const loaded = loadOperationJournal(journalPath);
  if (!loaded.ok) return { ok: false, reason: 'operation-state-failed' };
  const records = loaded.records;
  const active = activeOperation(records);
""",
)
replace_once(
    helper,
    """  const records = readOperationJournal(context.journalPath);
  const index = records.findIndex(record => record.id === context.id && record.action === context.action);
""",
    """  const loaded = loadOperationJournal(context.journalPath);
  if (!loaded.ok) return false;
  const records = loaded.records;
  const index = records.findIndex(record => record.id === context.id && record.action === context.action);
""",
)
replace_once(
    helper,
    """  const marker = readRestartMarker(markerPath);
  const records = readOperationJournal(journalPath);
  for (const record of records) {
""",
    """  const marker = readRestartMarker(markerPath);
  const loaded = loadOperationJournal(journalPath);
  if (!loaded.ok) {
    console.error('wobble operation journal is malformed or unreadable; privileged actions remain fail-closed');
    return [];
  }
  const records = loaded.records;
  for (const record of records) {
""",
)
replace_once(
    helper,
    """export async function recoverRestartMonitor({
  markerPath = RESTART_MARKER,
  journalPath = OPERATION_JOURNAL,
  now = Date.now()
} = {}) {""",
    """export async function recoverRestartMonitor({
  markerPath = RESTART_MARKER,
  journalPath = OPERATION_JOURNAL,
  now = Date.now(),
  advanceSignal = advancePendingRestartSignal
} = {}) {""",
)
replace_once(
    helper,
    """  if (marker.phase === 'signal-pending') {
    const advanced = await advancePendingRestartSignal(marker, markerPath);
    if (advanced.rolledBack) return false;
    marker = advanced.marker || marker;
  }
""",
    """  if (marker.phase === 'signal-pending') {
    const advanced = await advanceSignal(marker, markerPath);
    if (advanced.rolledBack) {
      if (marker.operationId) {
        transitionDurableOperation(
          { id: marker.operationId, action: 'wobble.restart', startedAt, journalPath },
          'failed',
          { now, reason: 'restart-signal-failed' }
        );
      }
      restartInFlight = false;
      return false;
    }
    marker = advanced.marker || marker;
  }
""",
)

# Extend focused regressions for strict corrupt-journal handling and restart recovery rollback.
test_file = Path('server/durableOperations.test.mjs')
replace_once(
    test_file,
    """  beginDurableOperation,
  readOperationJournal,
  recoverDurableOperations,
""",
    """  beginDurableOperation,
  readOperationJournal,
  recoverDurableOperations,
  recoverRestartMonitor,
""",
)
test_file.write_text(
    test_file.read_text()
    + r'''

test('malformed durable journal fails closed and is never overwritten by a new root action', () => {
  const ctx = tempState();
  try {
    const malformed = '{"version":1,"operations":[';
    fs.writeFileSync(ctx.journalPath, malformed);
    const started = beginDurableOperation(
      request('77777777-7777-4777-8777-777777777777', 'nginx.reload'),
      { journalPath: ctx.journalPath, now: 7000 }
    );
    assert.equal(started.ok, false);
    assert.equal(started.reason, 'operation-state-failed');
    assert.equal(fs.readFileSync(ctx.journalPath, 'utf8'), malformed);
  } finally {
    ctx.cleanup();
  }
});

test('restart recovery rollback closes the matching durable operation instead of blocking forever', async () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(
      request('88888888-8888-4888-8888-888888888888', 'wobble.restart'),
      { journalPath: ctx.journalPath, now: 8000 }
    );
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 8100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 8200 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 4321,
          startedAt: 8000,
          clearMaintenance: true,
          phase: 'signal-pending',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );

    const recovered = await recoverRestartMonitor({
      markerPath: ctx.markerPath,
      journalPath: ctx.journalPath,
      now: 8300,
      advanceSignal: async () => ({ marker: null, rolledBack: true })
    });
    assert.equal(recovered, false);
    const records = readOperationJournal(ctx.journalPath);
    assert.equal(records[0].state, 'failed');
    assert.equal(records[0].reason, 'restart-signal-failed');
  } finally {
    ctx.cleanup();
  }
});
'''
)
