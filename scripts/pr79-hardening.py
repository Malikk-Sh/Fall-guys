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
    """  const startedAt = Date.now();
  transitionDurableOperation(operationContext, 'running');
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });
""",
    """  const startedAt = Date.now();
  if (!transitionDurableOperation(operationContext, 'running')) {
    return { ok: false, reason: 'operation-state-failed', durationMs: 0 };
  }
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });
""",
)
replace_once(
    helper,
    """  transitionDurableOperation(operationContext, 'running');

  // Durable ownership is written synchronously before SIGUSR2.""",
    """  if (!transitionDurableOperation(operationContext, 'running')) {
    if (!alreadyInMaintenance) setMaintenance(false);
    restartInFlight = false;
    return { ok: false, reason: 'operation-state-failed', maintenance: maintenanceEnabled() };
  }

  // Durable ownership is written synchronously before SIGUSR2.""",
)
replace_once(
    helper,
    """  transitionDurableOperation(operationContext, 'drain');

  const signal = await sendGracefulRestartSignal();""",
    """  if (!transitionDurableOperation(operationContext, 'drain')) {
    clearRestartMarker();
    if (!alreadyInMaintenance) setMaintenance(false);
    restartInFlight = false;
    return { ok: false, reason: 'operation-state-failed', maintenance: maintenanceEnabled() };
  }

  const signal = await sendGracefulRestartSignal();""",
)
replace_once(
    helper,
    """    if (restartInFlight) return { ok: false, reason: 'operation-busy' };
    transitionDurableOperation(operationContext, 'running');
    return setMaintenance(spec.enabled);
""",
    """    if (restartInFlight) return { ok: false, reason: 'operation-busy' };
    if (!transitionDurableOperation(operationContext, 'running')) {
      return { ok: false, reason: 'operation-state-failed' };
    }
    return setMaintenance(spec.enabled);
""",
)
replace_once(
    helper,
    """  busy = true;
  try {
    transitionDurableOperation(operationContext, 'running');
    if (spec.kind === 'nginx-reload') return await runNginxReload(spec);
""",
    """  busy = true;
  try {
    if (!transitionDurableOperation(operationContext, 'running')) {
      return { ok: false, reason: 'operation-state-failed' };
    }
    if (spec.kind === 'nginx-reload') return await runNginxReload(spec);
""",
)
replace_once(
    helper,
    """      socket.setTimeout(0);
      const result = await execute(request, Date.now(), begun.context);
      if (!(result?.accepted && result?.deferred)) {
        transitionDurableOperation(begun.context, result?.ok ? 'succeeded' : 'failed', {
          reason: result?.ok ? null : result?.reason,
          durationMs: result?.durationMs
        });
      }
      send(socket, {
        ...result,
""",
    """      socket.setTimeout(0);
      let result;
      try {
        result = await execute(request, Date.now(), begun.context);
      } catch {
        result = { ok: false, reason: 'operation-failed' };
      }
      if (!(result?.accepted && result?.deferred)) {
        const finalized = transitionDurableOperation(begun.context, result?.ok ? 'succeeded' : 'failed', {
          reason: result?.ok ? null : result?.reason,
          durationMs: result?.durationMs
        });
        if (!finalized) {
          result = {
            ok: false,
            reason: 'operation-state-uncertain',
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
          };
        }
      }
      send(socket, {
        ...result,
""",
)

routes = Path('server/controlPlaneRoutes.js')
replace_once(
    routes,
    """      'operation-state-failed',
      'operation-timeout',
""",
    """      'operation-state-failed',
      'operation-state-uncertain',
      'operation-timeout',
""",
)
replace_once(
    routes,
    """      return res.status(httpStatus).json({
        ok: false,
        error: reason,
""",
    """      return res.status(httpStatus).json({
        ok: false,
        error: reason,
        operationId: result?.operationId || result?.requestId || null,
""",
)

admin = Path('client/admin/admin.js')
replace_once(
    admin,
    """    'operation-state-failed': 'Не удалось надёжно сохранить состояние операции. Действие не запущено.',
    'operation-timeout': 'Системная операция превысила допустимое время.',
""",
    """    'operation-state-failed': 'Не удалось надёжно сохранить состояние операции. Действие не запущено.',
    'operation-state-uncertain':
      'Действие могло завершиться, но финальный durable state не удалось сохранить. Не повторяйте его вслепую — сначала проверьте «Сервер» и историю.',
    'operation-timeout': 'Системная операция превысила допустимое время.',
""",
)
replace_once(
    admin,
    """  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    if (state.operations) renderOperations(state.operations);
    setStatus(`${spec.title}: ${operationErrorLabel(error.payload?.error || error.message)}`, 'bad');
  }
}""",
    """  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    try {
      await loadOperations({ monitor: false });
    } catch {
      if (state.operations) renderOperations(state.operations);
    }
    setStatus(`${spec.title}: ${operationErrorLabel(error.payload?.error || error.message)}`, 'bad');
  }
}""",
)

# Add regression for unexpected helper failure: the durable entry must become terminal instead of blocking forever.
test_file = Path('server/durableOperations.test.mjs')
test_file.write_text(
    test_file.read_text()
    + r'''

test('helper execution exception is persisted as failed rather than leaving an active operation', async t => {
  const { createServer } = await import('../deploy/wobble-ops-helper.mjs');
  const ctx = tempState();
  const socketPath = path.join(ctx.dir, 'ops.sock');
  const server = createServer({
    journalPath: ctx.journalPath,
    execute: async () => {
      throw new Error('synthetic helper failure');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    ctx.cleanup();
  });

  const client = new AdminOperationsClient({
    socketPath,
    maintenanceFlag: path.join(ctx.dir, 'maintenance'),
    journalPath: ctx.journalPath,
    timeoutMs: 1000
  });
  const result = await client.run('backup.verify');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation-failed');
  const records = readOperationJournal(ctx.journalPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'failed');
  assert.equal(records[0].reason, 'operation-failed');
});
'''
)
