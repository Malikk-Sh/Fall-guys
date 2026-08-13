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
    "import fs from 'node:fs';\nimport http from 'node:http';\n",
    "import { randomUUID } from 'node:crypto';\nimport fs from 'node:fs';\nimport http from 'node:http';\n",
)
replace_once(
    helper,
    """  const now = Number.isSafeInteger(Number(detail.now)) ? Number(detail.now) : Date.now();
  const reason = safeOperationReason(detail.reason);
""",
    """  const requestedNow = Number.isSafeInteger(Number(detail.now)) ? Number(detail.now) : Date.now();
  // Wall-clock corrections must never make a persisted lifecycle move backwards. Keeping
  // timestamps monotonic also lets reboot recovery close an old record instead of stranding it.
  const now = Math.max(current.createdAt, current.updatedAt, requestedNow);
  const reason = safeOperationReason(detail.reason);
""",
)
replace_once(
    helper,
    """    if (record.action === 'wobble.restart' && marker?.operationId === record.id) continue;
""",
    """    if (
      record.action === 'wobble.restart' &&
      (marker?.operationId === record.id || (marker && !marker.operationId))
    ) {
      continue;
    }
""",
)
replace_once(
    helper,
    """export function clearRestartMarker(markerPath = RESTART_MARKER) {
  try {
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(`${markerPath}.tmp`, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function runNginxReload(spec) {
""",
    """export function clearRestartMarker(markerPath = RESTART_MARKER) {
  try {
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(`${markerPath}.tmp`, { force: true });
    return true;
  } catch {
    return false;
  }
}

function restartOperationContext(operationId, startedAt, journalPath) {
  return { id: operationId, action: 'wobble.restart', startedAt, journalPath };
}

function operationRecord(operationId, journalPath) {
  const loaded = loadOperationJournal(journalPath);
  if (!loaded.ok) return { ok: false, record: null };
  return {
    ok: true,
    record: loaded.records.find(record => record.id === operationId) || null
  };
}

export function ensureRestartOperation(
  marker,
  { journalPath = OPERATION_JOURNAL, markerPath = RESTART_MARKER, now = Date.now() } = {}
) {
  if (!marker) return { ok: false, reason: 'restart-marker-missing' };
  const loaded = loadOperationJournal(journalPath);
  if (!loaded.ok) return { ok: false, reason: 'operation-state-failed' };

  const recoveryNow = Number.isSafeInteger(Number(now)) && Number(now) > 0 ? Number(now) : Date.now();
  const startedAt = Math.min(marker.startedAt, recoveryNow);
  let operationId = validRequestId(marker.operationId) ? marker.operationId : null;
  let record = operationId ? loaded.records.find(item => item.id === operationId) || null : null;
  const active = activeOperation(loaded.records);

  if (record && record.action !== 'wobble.restart') {
    return { ok: false, reason: 'operation-state-failed' };
  }
  if (!record && active) {
    if (!operationId && active.action === 'wobble.restart') {
      operationId = active.id;
      record = active;
    } else {
      return { ok: false, reason: 'operation-busy', activeId: active.id };
    }
  }

  if (!operationId) operationId = randomUUID();
  if (marker.operationId !== operationId) {
    const updatedMarker = { ...marker, operationId };
    if (!writeRestartMarker(updatedMarker, markerPath)) {
      return { ok: false, reason: 'operation-state-failed' };
    }
    marker = updatedMarker;
  }

  if (!record) {
    const begun = beginDurableOperation(
      { requestId: operationId, action: 'wobble.restart' },
      { journalPath, now: startedAt }
    );
    if (!begun.ok) return begun;
    record = operationRecord(operationId, journalPath).record;
  }

  if (record?.state === 'queued') {
    if (!transitionDurableOperation(restartOperationContext(operationId, startedAt, journalPath), 'running', { now })) {
      return { ok: false, reason: 'operation-state-failed' };
    }
    record = operationRecord(operationId, journalPath).record;
  }
  if (record?.state === 'running') {
    if (!transitionDurableOperation(restartOperationContext(operationId, startedAt, journalPath), 'drain', { now })) {
      return { ok: false, reason: 'operation-state-failed' };
    }
    record = operationRecord(operationId, journalPath).record;
  }
  if (!record || record.action !== 'wobble.restart') {
    return { ok: false, reason: 'operation-state-failed' };
  }
  return { ok: true, marker, record, startedAt };
}

export function finalizeRestartOperation({
  operationId,
  state,
  reason = null,
  startedAt,
  journalPath = OPERATION_JOURNAL,
  markerPath = RESTART_MARKER,
  clearMaintenance = false,
  maintenancePath = MAINTENANCE_FLAG,
  now = Date.now()
} = {}) {
  if (!validRequestId(operationId) || !OPERATION_TERMINAL_STATES.has(state)) return false;
  const context = restartOperationContext(operationId, startedAt, journalPath);
  if (!transitionDurableOperation(context, state, { now, reason })) return false;
  // The durable terminal record is authoritative. Release the recovery marker only afterwards so
  // a helper crash or journal I/O failure can never turn a completed restart into lost ownership.
  if (!clearRestartMarker(markerPath)) return false;
  if (clearMaintenance) {
    const maintenance = setMaintenance(false, maintenancePath);
    if (!maintenance.ok) return false;
  }
  return true;
}

async function runNginxReload(spec) {
""",
)
replace_once(
    helper,
    """    const safeToRollback = await confirmOldProcessNotDraining(marker.oldPid);
    if (safeToRollback) {
      clearRestartMarker(markerPath);
      if (marker.clearMaintenance) setMaintenance(false);
      restartInFlight = false;
      return { marker: null, rolledBack: true };
    }
""",
    """    const safeToRollback = await confirmOldProcessNotDraining(marker.oldPid);
    if (safeToRollback) {
      // The caller owns durable terminalization. Keep marker + maintenance until the failed
      // lifecycle state is committed, otherwise a crash here would erase recovery ownership.
      return { marker, rolledBack: true };
    }
""",
)
replace_once(
    helper,
    """        if (advanced.rolledBack) {
          clearInterval(timer);
          if (operationId) {
            transitionDurableOperation(
              { id: operationId, action: 'wobble.restart', startedAt, journalPath },
              'failed',
              { reason: 'restart-signal-failed' }
            );
          }
          return;
        }
""",
    """        if (advanced.rolledBack) {
          const finalized = finalizeRestartOperation({
            operationId,
            state: 'failed',
            reason: 'restart-signal-failed',
            startedAt,
            journalPath,
            markerPath,
            clearMaintenance
          });
          if (finalized) {
            clearInterval(timer);
            restartInFlight = false;
          } else {
            console.error('could not persist restart rollback; marker and maintenance remain owned');
          }
          return;
        }
""",
)
replace_once(
    helper,
    """        if (candidatePid !== pid) {
          candidatePid = pid;
          readyStreak = 0;
          if (operationId) {
            transitionDurableOperation(
              { id: operationId, action: 'wobble.restart', startedAt, journalPath },
              'verifying'
            );
          }
        }
        const health = await readWobbleOperationalHealth();
""",
    """        if (candidatePid !== pid) {
          candidatePid = pid;
          readyStreak = 0;
        }
        if (
          operationId &&
          !transitionDurableOperation(
            { id: operationId, action: 'wobble.restart', startedAt, journalPath },
            'verifying'
          )
        ) {
          readyStreak = 0;
          return;
        }
        const health = await readWobbleOperationalHealth();
""",
)
replace_once(
    helper,
    """        if (readyStreak >= READY_STREAK_REQUIRED) {
          clearInterval(timer);
          // Delete durable operation ownership first. A crash between these two steps can leave
          // maintenance enabled (safe, operator can disable it), but can never reopen too early.
          clearRestartMarker(markerPath);
          if (clearMaintenance) setMaintenance(false);
          if (operationId) {
            transitionDurableOperation(
              { id: operationId, action: 'wobble.restart', startedAt, journalPath },
              'succeeded'
            );
          }
          restartInFlight = false;
          return;
        }
""",
    """        if (readyStreak >= READY_STREAK_REQUIRED) {
          const finalized = finalizeRestartOperation({
            operationId,
            state: 'succeeded',
            startedAt,
            journalPath,
            markerPath,
            clearMaintenance
          });
          if (!finalized) {
            console.error('replacement is ready but durable restart completion is not persisted yet');
            return;
          }
          clearInterval(timer);
          restartInFlight = false;
          return;
        }
""",
)
replace_once(
    helper,
    """      if (Date.now() - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
        clearInterval(timer);
        clearRestartMarker(markerPath);
        if (operationId) {
          transitionDurableOperation(
            { id: operationId, action: 'wobble.restart', startedAt, journalPath },
            'failed',
            { reason: 'restart-readiness-timeout' }
          );
        }
        restartInFlight = false;
        // Безопасный отказ: если новый Wobble не подтвердил readiness своим PID, maintenance остаётся.
        // Это не даёт клиентам устроить reconnect-storm на неисправный или циклически падающий сервис.
        console.error('wobble graceful restart timed out; maintenance remains enabled');
      }
""",
    """      if (Date.now() - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
        const finalized = finalizeRestartOperation({
          operationId,
          state: 'failed',
          reason: 'restart-readiness-timeout',
          startedAt,
          journalPath,
          markerPath,
          clearMaintenance: false
        });
        if (!finalized) {
          console.error('restart timed out but durable failure is not persisted yet; maintenance remains enabled');
          return;
        }
        clearInterval(timer);
        restartInFlight = false;
        // Безопасный отказ: если новый Wobble не подтвердил readiness своим PID, maintenance остаётся.
        // Это не даёт клиентам устроить reconnect-storm на неисправный или циклически падающий сервис.
        console.error('wobble graceful restart timed out; maintenance remains enabled');
      }
""",
)
replace_once(
    helper,
    """  let marker = readRestartMarker(markerPath);
  if (!marker) return false;

  // Do not restart a monitor forever after a clock jump or a very old interrupted operation.
  // The maintenance flag is intentionally left in place so recovery remains fail-closed.
  const startedAt = Math.min(marker.startedAt, now);
  if (now - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
    clearRestartMarker(markerPath);
    if (marker.operationId) {
      transitionDurableOperation(
        { id: marker.operationId, action: 'wobble.restart', startedAt, journalPath },
        'failed',
        { now, reason: 'restart-monitor-timeout' }
      );
    }
    console.error('stale wobble restart marker cleared; maintenance remains enabled');
    return false;
  }

  restartInFlight = true;
  restartCooldownUntil = Math.max(restartCooldownUntil, marker.startedAt + RESTART_COOLDOWN_MS);
""",
    """  let marker = readRestartMarker(markerPath);
  if (!marker) return false;

  const ownership = ensureRestartOperation(marker, { journalPath, markerPath, now });
  if (!ownership.ok) {
    throw new Error(`cannot recover durable restart ownership: ${ownership.reason}`);
  }
  marker = ownership.marker;
  const ownedRecord = ownership.record;
  const startedAt = ownership.startedAt;

  if (OPERATION_TERMINAL_STATES.has(ownedRecord.state)) {
    const clearMaintenance =
      marker.clearMaintenance &&
      (ownedRecord.state === 'succeeded' || ownedRecord.reason === 'restart-signal-failed');
    if (!clearRestartMarker(markerPath)) {
      throw new Error('cannot release terminal restart marker');
    }
    if (clearMaintenance && !setMaintenance(false).ok) {
      throw new Error('cannot release maintenance after terminal restart recovery');
    }
    return false;
  }

  // Do not restart a monitor forever after a clock jump or a very old interrupted operation.
  // The maintenance flag is intentionally left in place so recovery remains fail-closed.
  if (now - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
    const finalized = finalizeRestartOperation({
      operationId: marker.operationId,
      state: 'failed',
      reason: 'restart-monitor-timeout',
      startedAt,
      journalPath,
      markerPath,
      clearMaintenance: false,
      now
    });
    if (!finalized) throw new Error('cannot persist stale restart recovery failure');
    console.error('stale wobble restart marker cleared; maintenance remains enabled');
    return false;
  }

  restartInFlight = true;
  restartCooldownUntil = Math.max(restartCooldownUntil, startedAt + RESTART_COOLDOWN_MS);
""",
)
replace_once(
    helper,
    """    if (advanced.rolledBack) {
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
""",
    """    if (advanced.rolledBack) {
      const finalized = finalizeRestartOperation({
        operationId: marker.operationId,
        state: 'failed',
        reason: 'restart-signal-failed',
        startedAt,
        journalPath,
        markerPath,
        clearMaintenance: marker.clearMaintenance,
        now
      });
      restartInFlight = false;
      if (!finalized) throw new Error('cannot persist restart rollback');
      return false;
    }
""",
)

client = Path('server/adminOperationsClient.js')
replace_once(
    client,
    """          completedAt: Number.isSafeInteger(Number(item.completedAt)) ? Number(item.completedAt) : null,
          durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Number(item.durationMs)) : null,
""",
    """          completedAt:
            item.completedAt != null && Number.isSafeInteger(Number(item.completedAt))
              ? Number(item.completedAt)
              : null,
          durationMs:
            item.durationMs != null && Number.isFinite(Number(item.durationMs))
              ? Math.max(0, Number(item.durationMs))
              : null,
""",
)

routes = Path('server/controlPlaneRoutes.js')
replace_once(
    routes,
    """    if (!result?.ok) {
      const reason = safeReasons.has(result?.reason) ? result.reason : 'helper-error';
      try {
""",
    """    if (!result?.ok) {
      const reason = safeReasons.has(result?.reason) ? result.reason : 'helper-error';
      const operationId =
        reason === 'operation-busy'
          ? result?.activeOperationId || result?.operationId || null
          : result?.operationId || result?.requestId || null;
      try {
""",
)
replace_once(
    routes,
    """            operationId: result?.operationId || result?.requestId || null,
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
""",
    """            operationId,
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
""",
)
replace_once(
    routes,
    """        operationId: result?.operationId || result?.requestId || null,
        ...(reason === 'restart-cooldown' && Number.isFinite(Number(result?.retryAfterMs))
""",
    """        operationId,
        ...(reason === 'operation-busy' && operationId ? { activeOperationId: operationId } : {}),
        ...(reason === 'restart-cooldown' && Number.isFinite(Number(result?.retryAfterMs))
""",
)

admin = Path('client/admin/admin.js')
replace_once(
    admin,
    """      Number.isFinite(Number(entry.durationMs))
        ? `${Math.max(0, Math.round(Number(entry.durationMs) / 1000))} с`
        : '—'
""",
    """      entry.durationMs != null && Number.isFinite(Number(entry.durationMs))
        ? `${Math.max(0, Math.round(Number(entry.durationMs) / 1000))} с`
        : '—'
""",
)

service = Path('deploy/wobble-ops.service')
service_text = service.read_text()
if '[Install]' not in service_text:
    service.write_text(service_text.rstrip() + "\n\n[Install]\nWantedBy=multi-user.target\n")
else:
    raise SystemExit('deploy/wobble-ops.service already has [Install], review patch assumptions')

installer = Path('deploy/install.sh')
replace_once(
    installer,
    "systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket >/dev/null\n",
    "systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket wobble-ops.service >/dev/null\n",
)

# Durable regression coverage for the Codex review batch.
tests = Path('server/durableOperations.test.mjs')
replace_once(
    tests,
    """  recoverDurableOperations,
  recoverRestartMonitor,
  transitionDurableOperation,
""",
    """  finalizeRestartOperation,
  recoverDurableOperations,
  recoverRestartMonitor,
  transitionDurableOperation,
""",
)
replace_once(
    tests,
    """    assert.equal(status.history[0].state, 'verifying');
    assert.equal(status.history[1].state, 'succeeded');
""",
    """    assert.equal(status.history[0].state, 'verifying');
    assert.equal(status.history[0].completedAt, null);
    assert.equal(status.history[0].durationMs, null);
    assert.equal(status.history[1].state, 'succeeded');
""",
)
tests.write_text(
    tests.read_text()
    + r'''

test('operation timestamps stay monotonic across wall-clock rollback', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('99999999-9999-4999-8999-999999999999', 'backup.verify'), {
      journalPath: ctx.journalPath,
      now: 10_000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 9_000 }), true);
    assert.equal(transitionDurableOperation(started.context, 'succeeded', { now: 8_000 }), true);
    const [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.updatedAt, 10_000);
    assert.equal(record.completedAt, 10_000);
    assert.equal(record.durationMs, 0);
    assert.deepEqual(record.transitions.map(step => step.at), [10_000, 10_000, 10_000]);
  } finally {
    ctx.cleanup();
  }
});

test('legacy restart marker is imported into durable busy ownership before recovery work', async () => {
  const ctx = tempState();
  try {
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 2468,
          startedAt: 11_000,
          clearMaintenance: false
        },
        ctx.markerPath
      ),
      true
    );
    let importedId = null;
    const recovered = await recoverRestartMonitor({
      markerPath: ctx.markerPath,
      journalPath: ctx.journalPath,
      now: 11_100,
      advanceSignal: async marker => {
        const persisted = JSON.parse(fs.readFileSync(ctx.markerPath, 'utf8'));
        importedId = persisted.operationId;
        assert.match(importedId, /^[0-9a-f-]{36}$/i);
        const client = new AdminOperationsClient({
          socketPath: path.join(ctx.dir, 'missing.sock'),
          maintenanceFlag: path.join(ctx.dir, 'maintenance'),
          journalPath: ctx.journalPath
        });
        const status = client.status();
        assert.equal(status.busy, true);
        assert.equal(status.activeOperation.id, importedId);
        assert.equal(status.activeOperation.action, 'wobble.restart');
        return { marker, rolledBack: true };
      }
    });
    assert.equal(recovered, false);
    const [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.id, importedId);
    assert.equal(record.state, 'failed');
    assert.equal(record.reason, 'restart-signal-failed');
  } finally {
    ctx.cleanup();
  }
});

test('restart terminal state is durable before its recovery marker is released', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wobble.restart'), {
      journalPath: ctx.journalPath,
      now: 12_000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 12_100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 12_200 }), true);
    assert.equal(transitionDurableOperation(started.context, 'verifying', { now: 12_300 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 1357,
          startedAt: 12_000,
          clearMaintenance: false,
          phase: 'signal-delivered',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );

    const journal = fs.readFileSync(ctx.journalPath, 'utf8');
    fs.rmSync(ctx.journalPath);
    assert.equal(
      finalizeRestartOperation({
        operationId: started.context.id,
        state: 'succeeded',
        startedAt: 12_000,
        journalPath: ctx.journalPath,
        markerPath: ctx.markerPath,
        clearMaintenance: false,
        now: 12_400
      }),
      false
    );
    assert.equal(fs.existsSync(ctx.markerPath), true);

    fs.writeFileSync(ctx.journalPath, journal);
    assert.equal(
      finalizeRestartOperation({
        operationId: started.context.id,
        state: 'succeeded',
        startedAt: 12_000,
        journalPath: ctx.journalPath,
        markerPath: ctx.markerPath,
        clearMaintenance: false,
        now: 12_400
      }),
      true
    );
    assert.equal(readOperationJournal(ctx.journalPath)[0].state, 'succeeded');
    assert.equal(fs.existsSync(ctx.markerPath), false);
  } finally {
    ctx.cleanup();
  }
});

test('operations helper is enabled at boot so persisted recovery cannot remain permanently idle', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'deploy/wobble-ops.service'), 'utf8');
  const installer = fs.readFileSync(path.join(process.cwd(), 'deploy/install.sh'), 'utf8');
  assert.match(service, /\[Install\][\s\S]*WantedBy=multi-user\.target/);
  assert.match(installer, /systemctl enable[^\n]*wobble-ops\.service/);
});
'''
)

route_tests = Path('server/controlPlaneRoutes.test.mjs')
route_tests.write_text(
    route_tests.read_text()
    + r'''

test('busy operation response correlates to the active durable operation, not the rejected request', async () => {
  const activeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const rejectedId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const ctx = await start({
    operations: {
      status: () => ({
        available: true,
        maintenance: false,
        operations: [{ id: 'backup.create', title: 'Backup' }]
      }),
      run: async () => ({
        ok: false,
        reason: 'operation-busy',
        requestId: rejectedId,
        activeOperationId: activeId
      })
    }
  });
  try {
    const session = await login(ctx);
    const response = await post(ctx, '/api/admin/operations/run', session, {
      operation: 'backup.create',
      confirmation: 'backup.create'
    });
    assert.equal(response.status, 409);
    const payload = await response.json();
    assert.equal(payload.operationId, activeId);
    assert.equal(payload.activeOperationId, activeId);
    assert.notEqual(payload.operationId, rejectedId);
  } finally {
    await ctx.close();
  }
});
'''
)
