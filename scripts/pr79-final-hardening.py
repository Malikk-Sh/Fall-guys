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
    """  const completedAt = Number(value?.completedAt);
  const durationMs = Number(value?.durationMs);
  const reason = safeOperationReason(value?.reason);
""",
    """  const completedAt = Number(value?.completedAt);
  const durationMs = value?.durationMs == null ? null : Number(value.durationMs);
  const reason = safeOperationReason(value?.reason);
""",
)
replace_once(
    helper,
    """    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
""",
    """    durationMs:
      durationMs != null && Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
""",
)
replace_once(
    helper,
    """    if (safeToRollback) {
      clearRestartMarker();
      if (!alreadyInMaintenance) setMaintenance(false);
      restartInFlight = false;
    } else {
""",
    """    if (safeToRollback) {
      const terminalized = transitionDurableOperation(operationContext, 'failed', {
        reason: 'restart-signal-failed',
        durationMs: signal.durationMs
      });
      if (!terminalized) {
        marker = { ...marker, phase: 'signal-uncertain' };
        writeRestartMarker(marker);
        restartInFlight = false;
        return {
          ok: false,
          reason: 'operation-state-uncertain',
          durationMs: signal.durationMs,
          maintenance: maintenanceEnabled()
        };
      }
      clearRestartMarker();
      if (!alreadyInMaintenance) setMaintenance(false);
      restartInFlight = false;
    } else {
""",
)

tests = Path('server/durableOperations.test.mjs')
tests.write_text(
    tests.read_text()
    + r'''

test('root helper preserves null duration until an operation becomes terminal', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'backup.create'), {
      journalPath: ctx.journalPath,
      now: 13_000
    });
    assert.equal(started.ok, true);
    let [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.state, 'queued');
    assert.equal(record.durationMs, null);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 13_100 }), true);
    [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.state, 'running');
    assert.equal(record.durationMs, null);
  } finally {
    ctx.cleanup();
  }
});
'''
)
