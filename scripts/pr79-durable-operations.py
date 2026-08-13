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
    "import net from 'node:net';\nimport { spawn } from 'node:child_process';",
    "import net from 'node:net';\nimport path from 'node:path';\nimport { spawn } from 'node:child_process';",
)
replace_once(
    helper,
    "export const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';\nexport const RESTART_MARKER = '/run/wobble-ops/restart.json';\n",
    """export const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';
export const RESTART_MARKER = '/run/wobble-ops/restart.json';
export const OPERATION_JOURNAL = '/var/lib/wobble-ops/operations.json';
const OPERATION_JOURNAL_VERSION = 1;
const OPERATION_HISTORY_LIMIT = 40;
const OPERATION_STATES = new Set(['queued', 'running', 'drain', 'verifying', 'succeeded', 'failed']);
const OPERATION_TERMINAL_STATES = new Set(['succeeded', 'failed']);
const OPERATION_TRANSITIONS = Object.freeze({
  queued: new Set(['running', 'failed']),
  running: new Set(['drain', 'verifying', 'succeeded', 'failed']),
  drain: new Set(['verifying', 'failed']),
  verifying: new Set(['succeeded', 'failed']),
  succeeded: new Set(),
  failed: new Set()
});
""",
)
replace_once(
    helper,
    """export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('action')) return null;
  if (!validRequestId(value.requestId)) return null;
  const action = String(value.action || '').trim();
  if (!Object.hasOwn(ACTIONS, action)) return null;
  return { requestId: value.requestId, action };
}

function runCommand""",
    """export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('action')) return null;
  if (!validRequestId(value.requestId)) return null;
  const action = String(value.action || '').trim();
  if (!Object.hasOwn(ACTIONS, action)) return null;
  return { requestId: value.requestId, action };
}

function safeOperationReason(value) {
  const reason = String(value || '').trim();
  return /^[a-z0-9-]{1,80}$/.test(reason) ? reason : null;
}

function normalizeTransition(value) {
  const state = String(value?.state || '');
  const at = Number(value?.at);
  if (!OPERATION_STATES.has(state) || !Number.isSafeInteger(at) || at <= 0) return null;
  const reason = safeOperationReason(value?.reason);
  return { state, at, ...(reason ? { reason } : {}) };
}

function normalizeOperationRecord(value) {
  const id = String(value?.id || '');
  const action = String(value?.action || '');
  const state = String(value?.state || '');
  const createdAt = Number(value?.createdAt);
  const updatedAt = Number(value?.updatedAt);
  if (
    !validRequestId(id) ||
    !Object.hasOwn(ACTIONS, action) ||
    !OPERATION_STATES.has(state) ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < createdAt
  ) {
    return null;
  }
  const completedAt = Number(value?.completedAt);
  const durationMs = Number(value?.durationMs);
  const reason = safeOperationReason(value?.reason);
  const transitions = Array.isArray(value?.transitions)
    ? value.transitions.map(normalizeTransition).filter(Boolean).slice(-12)
    : [];
  return {
    id,
    action,
    state,
    createdAt,
    updatedAt,
    completedAt:
      OPERATION_TERMINAL_STATES.has(state) && Number.isSafeInteger(completedAt) && completedAt >= createdAt
        ? completedAt
        : null,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : null,
    reason,
    transitions
  };
}

export function readOperationJournal(journalPath = OPERATION_JOURNAL) {
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

function activeOperation(records) {
  return [...records].reverse().find(record => !OPERATION_TERMINAL_STATES.has(record.state)) || null;
}

export function beginDurableOperation(request, { journalPath = OPERATION_JOURNAL, now = Date.now() } = {}) {
  const records = readOperationJournal(journalPath);
  const active = activeOperation(records);
  if (active) return { ok: false, reason: 'operation-busy', activeId: active.id };
  const record = {
    id: request.requestId,
    action: request.action,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    durationMs: null,
    reason: null,
    transitions: [{ state: 'queued', at: now }]
  };
  if (!writeOperationJournal([...records, record], journalPath)) {
    return { ok: false, reason: 'operation-state-failed' };
  }
  return {
    ok: true,
    context: { id: record.id, action: record.action, startedAt: now, journalPath }
  };
}

export function transitionDurableOperation(context, nextState, detail = {}) {
  if (!context?.id || !context?.action || !context?.journalPath || !OPERATION_STATES.has(nextState)) return false;
  const records = readOperationJournal(context.journalPath);
  const index = records.findIndex(record => record.id === context.id && record.action === context.action);
  if (index < 0) return false;
  const current = records[index];
  if (current.state === nextState) return true;
  if (!OPERATION_TRANSITIONS[current.state]?.has(nextState)) return false;
  const now = Number.isSafeInteger(Number(detail.now)) ? Number(detail.now) : Date.now();
  const reason = safeOperationReason(detail.reason);
  const terminal = OPERATION_TERMINAL_STATES.has(nextState);
  const durationMs = terminal
    ? Number.isFinite(Number(detail.durationMs))
      ? Math.max(0, Math.round(Number(detail.durationMs)))
      : Math.max(0, now - current.createdAt)
    : null;
  records[index] = {
    ...current,
    state: nextState,
    updatedAt: now,
    completedAt: terminal ? now : null,
    durationMs,
    reason: terminal ? reason : null,
    transitions: [
      ...(current.transitions || []),
      { state: nextState, at: now, ...(terminal && reason ? { reason } : {}) }
    ].slice(-12)
  };
  return writeOperationJournal(records, context.journalPath);
}

export function recoverDurableOperations({
  journalPath = OPERATION_JOURNAL,
  markerPath = RESTART_MARKER,
  now = Date.now()
} = {}) {
  const marker = readRestartMarker(markerPath);
  const records = readOperationJournal(journalPath);
  for (const record of records) {
    if (OPERATION_TERMINAL_STATES.has(record.state)) continue;
    if (record.action === 'wobble.restart' && marker?.operationId === record.id) continue;
    transitionDurableOperation(
      { id: record.id, action: record.action, startedAt: record.createdAt, journalPath },
      'failed',
      { now, reason: record.action === 'wobble.restart' ? 'restart-state-lost' : 'helper-restarted' }
    );
  }
  return readOperationJournal(journalPath);
}

function runCommand""",
)
replace_once(
    helper,
    """  return {
    version: RESTART_MARKER_VERSION,
    oldPid,
    startedAt,
    clearMaintenance: value.clearMaintenance,
    phase
  };
}""",
    """  const operationId = validRequestId(value?.operationId) ? String(value.operationId) : null;
  return {
    version: RESTART_MARKER_VERSION,
    oldPid,
    startedAt,
    clearMaintenance: value.clearMaintenance,
    phase,
    ...(operationId ? { operationId } : {})
  };
}""",
)
replace_once(
    helper,
    """function scheduleRestartCompletion(
  oldPid,
  { clearMaintenance, startedAt = Date.now(), markerPath = RESTART_MARKER }
) {""",
    """function scheduleRestartCompletion(
  oldPid,
  {
    clearMaintenance,
    startedAt = Date.now(),
    markerPath = RESTART_MARKER,
    operationId = null,
    journalPath = OPERATION_JOURNAL
  }
) {""",
)
replace_once(
    helper,
    """        if (advanced.rolledBack) {
          clearInterval(timer);
          return;
        }""",
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
        }""",
)
replace_once(
    helper,
    """        if (candidatePid !== pid) {
          candidatePid = pid;
          readyStreak = 0;
        }
        const health = await readWobbleOperationalHealth();""",
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
        const health = await readWobbleOperationalHealth();""",
)
replace_once(
    helper,
    """          clearRestartMarker(markerPath);
          if (clearMaintenance) setMaintenance(false);
          restartInFlight = false;
          return;""",
    """          clearRestartMarker(markerPath);
          if (clearMaintenance) setMaintenance(false);
          if (operationId) {
            transitionDurableOperation(
              { id: operationId, action: 'wobble.restart', startedAt, journalPath },
              'succeeded'
            );
          }
          restartInFlight = false;
          return;""",
)
replace_once(
    helper,
    """        clearRestartMarker(markerPath);
        restartInFlight = false;
        // Безопасный отказ: если новый Wobble не подтвердил readiness своим PID, maintenance остаётся.""",
    """        clearRestartMarker(markerPath);
        if (operationId) {
          transitionDurableOperation(
            { id: operationId, action: 'wobble.restart', startedAt, journalPath },
            'failed',
            { reason: 'restart-readiness-timeout' }
          );
        }
        restartInFlight = false;
        // Безопасный отказ: если новый Wobble не подтвердил readiness своим PID, maintenance остаётся.""",
)
replace_once(
    helper,
    """export async function recoverRestartMonitor({ markerPath = RESTART_MARKER, now = Date.now() } = {}) {""",
    """export async function recoverRestartMonitor({
  markerPath = RESTART_MARKER,
  journalPath = OPERATION_JOURNAL,
  now = Date.now()
} = {}) {""",
)
replace_once(
    helper,
    """  if (now - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
    clearRestartMarker(markerPath);
    console.error('stale wobble restart marker cleared; maintenance remains enabled');
    return false;
  }""",
    """  if (now - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
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
  }""",
)
replace_once(
    helper,
    """  scheduleRestartCompletion(marker.oldPid, {
    clearMaintenance: marker.clearMaintenance,
    startedAt,
    markerPath
  });""",
    """  scheduleRestartCompletion(marker.oldPid, {
    clearMaintenance: marker.clearMaintenance,
    startedAt,
    markerPath,
    operationId: marker.operationId || null,
    journalPath
  });""",
)
replace_once(
    helper,
    """async function startWobbleService() {
  if (restartInFlight) return { ok: false, reason: 'operation-busy' };
  const startedAt = Date.now();
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });""",
    """async function waitForWobbleReady({ timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let streak = 0;
  while (Date.now() < deadline) {
    const health = await readWobbleOperationalHealth();
    const pid = await wobbleMainPid();
    if (health?.pid === pid && pid > 0 && health.draining === false) {
      streak += 1;
      if (streak >= 2) return true;
    } else {
      streak = 0;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
}

async function startWobbleService(operationContext) {
  if (restartInFlight) return { ok: false, reason: 'operation-busy' };
  const startedAt = Date.now();
  transitionDurableOperation(operationContext, 'running');
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });""",
)
replace_once(
    helper,
    """  const start = await runCommand(SYSTEMCTL, ['start', 'wobble.service'], { timeoutMs: 20_000 });
  return {
    ok: start.ok,
    reason: start.ok ? null : start.reason || 'operation-failed',
    durationMs: Date.now() - startedAt
  };
}

async function startGracefulRestart(now) {""",
    """  const start = await runCommand(SYSTEMCTL, ['start', 'wobble.service'], { timeoutMs: 20_000 });
  if (!start.ok) {
    return {
      ok: false,
      reason: start.reason || 'operation-failed',
      durationMs: Date.now() - startedAt
    };
  }
  transitionDurableOperation(operationContext, 'verifying');
  const ready = await waitForWobbleReady();
  return {
    ok: ready,
    reason: ready ? null : 'operation-readiness-timeout',
    durationMs: Date.now() - startedAt
  };
}

async function startGracefulRestart(now, operationContext) {""",
)
replace_once(
    helper,
    """  const alreadyInMaintenance = maintenanceEnabled();
  const maintenance = setMaintenance(true);
  if (!maintenance.ok) {
    restartInFlight = false;
    return maintenance;
  }

  // Durable ownership is written synchronously before SIGUSR2.""",
    """  const alreadyInMaintenance = maintenanceEnabled();
  const maintenance = setMaintenance(true);
  if (!maintenance.ok) {
    restartInFlight = false;
    return maintenance;
  }
  transitionDurableOperation(operationContext, 'running');

  // Durable ownership is written synchronously before SIGUSR2.""",
)
replace_once(
    helper,
    """    clearMaintenance: !alreadyInMaintenance,
    phase: 'signal-pending'
  };""",
    """    clearMaintenance: !alreadyInMaintenance,
    phase: 'signal-pending',
    operationId: operationContext?.id || null
  };""",
)
replace_once(
    helper,
    """  if (!writeRestartMarker(marker)) {
    restartInFlight = false;
    if (!alreadyInMaintenance) setMaintenance(false);
    return { ok: false, reason: 'operation-state-failed', maintenance: maintenanceEnabled() };
  }

  const signal = await sendGracefulRestartSignal();""",
    """  if (!writeRestartMarker(marker)) {
    restartInFlight = false;
    if (!alreadyInMaintenance) setMaintenance(false);
    return { ok: false, reason: 'operation-state-failed', maintenance: maintenanceEnabled() };
  }
  transitionDurableOperation(operationContext, 'drain');

  const signal = await sendGracefulRestartSignal();""",
)
replace_once(
    helper,
    """      scheduleRestartCompletion(oldPid, {
        clearMaintenance: !alreadyInMaintenance,
        startedAt: now
      });
    }
    return {
      ok: false,
      reason: signal.reason || 'operation-failed',
      durationMs: signal.durationMs,
      maintenance: maintenanceEnabled()
    };
  }

  restartCooldownUntil = now + RESTART_COOLDOWN_MS;
  scheduleRestartCompletion(oldPid, {
    clearMaintenance: !alreadyInMaintenance,
    startedAt: now
  });""",
    """      scheduleRestartCompletion(oldPid, {
        clearMaintenance: !alreadyInMaintenance,
        startedAt: now,
        operationId: operationContext?.id || null,
        journalPath: operationContext?.journalPath || OPERATION_JOURNAL
      });
      return {
        ok: true,
        accepted: true,
        deferred: true,
        warning: signal.reason || 'signal-uncertain',
        maintenance: maintenanceEnabled()
      };
    }
    return {
      ok: false,
      reason: signal.reason || 'operation-failed',
      durationMs: signal.durationMs,
      maintenance: maintenanceEnabled()
    };
  }

  restartCooldownUntil = now + RESTART_COOLDOWN_MS;
  scheduleRestartCompletion(oldPid, {
    clearMaintenance: !alreadyInMaintenance,
    startedAt: now,
    operationId: operationContext?.id || null,
    journalPath: operationContext?.journalPath || OPERATION_JOURNAL
  });""",
)
replace_once(
    helper,
    """export async function executeRequest(request, now = Date.now()) {
  const spec = ACTIONS[request.action];
  if (!spec) return { ok: false, reason: 'unknown-operation' };
  if (busy) return { ok: false, reason: 'operation-busy' };

  if (spec.kind === 'graceful-restart') return startGracefulRestart(now);
  if (spec.kind === 'wobble-start') {
    busy = true;
    try {
      return await startWobbleService();
    } finally {
      busy = false;
    }
  }
  if (spec.kind === 'maintenance') {
""",
    """export async function executeRequest(request, now = Date.now(), operationContext = null) {
  const spec = ACTIONS[request.action];
  if (!spec) return { ok: false, reason: 'unknown-operation' };
  if (busy) return { ok: false, reason: 'operation-busy' };

  if (spec.kind === 'graceful-restart') return startGracefulRestart(now, operationContext);
  if (spec.kind === 'wobble-start') {
    busy = true;
    try {
      return await startWobbleService(operationContext);
    } finally {
      busy = false;
    }
  }
  if (spec.kind === 'maintenance') {
""",
)
replace_once(
    helper,
    """    if (restartInFlight) return { ok: false, reason: 'operation-busy' };
    return setMaintenance(spec.enabled);
  }

  busy = true;
  try {
    if (spec.kind === 'nginx-reload') return await runNginxReload(spec);
    return await runSystemctl(spec);
""",
    """    if (restartInFlight) return { ok: false, reason: 'operation-busy' };
    transitionDurableOperation(operationContext, 'running');
    return setMaintenance(spec.enabled);
  }

  busy = true;
  try {
    transitionDurableOperation(operationContext, 'running');
    if (spec.kind === 'nginx-reload') return await runNginxReload(spec);
    return await runSystemctl(spec);
""",
)
replace_once(
    helper,
    """export function createServer({ execute = executeRequest, requestTimeoutMs = REQUEST_READ_TIMEOUT_MS } = {}) {""",
    """export function createServer({
  execute = executeRequest,
  requestTimeoutMs = REQUEST_READ_TIMEOUT_MS,
  journalPath = OPERATION_JOURNAL
} = {}) {""",
)
replace_once(
    helper,
    """      // A backup can legitimately take far longer than the 5-second request-read guard. Keeping
      // that guard active here would report a false failure while systemd continues the job.
      socket.setTimeout(0);
      const result = await execute(request);
      send(socket, { ...result, requestId: request.requestId, action: request.action });
""",
    """      const begun = beginDurableOperation(request, { journalPath });
      if (!begun.ok) {
        send(socket, {
          ok: false,
          reason: begun.reason,
          requestId: request.requestId,
          action: request.action,
          ...(begun.activeId ? { activeOperationId: begun.activeId } : {})
        });
        return;
      }

      // A backup can legitimately take far longer than the 5-second request-read guard. Keeping
      // that guard active here would report a false failure while systemd continues the job.
      socket.setTimeout(0);
      const result = await execute(request, Date.now(), begun.context);
      if (!(result?.accepted && result?.deferred)) {
        transitionDurableOperation(begun.context, result?.ok ? 'succeeded' : 'failed', {
          reason: result?.ok ? null : result?.reason,
          durationMs: result?.durationMs
        });
      }
      send(socket, {
        ...result,
        operationId: begun.context.id,
        requestId: request.requestId,
        action: request.action
      });
""",
)
replace_once(
    helper,
    """  await recoverRestartMonitor();
  const server = createServer();""",
    """  recoverDurableOperations();
  await recoverRestartMonitor();
  const server = createServer();""",
)

unit = Path('deploy/wobble-ops.service')
replace_once(
    unit,
    """# nginx -t открывает configured error_log, поэтому даём helper ровно этот writable каталог.
ReadWritePaths=/var/log/nginx
UMask=0077
""",
    """# nginx -t открывает configured error_log. Durable operation journal живёт отдельно в
# root-owned persistent каталоге и переживает restart helper/Control Plane и reboot VPS.
ReadWritePaths=/var/log/nginx /var/lib/wobble-ops
UMask=0077
""",
)

install = Path('deploy/install.sh')
replace_once(
    install,
    """install -d -m 0755 -o root -g root /usr/local/lib/wobble-ops
install -m 0755 -o root -g root "$APP_DIR/deploy/wobble-ops-helper.mjs" /usr/local/lib/wobble-ops/helper.mjs
systemctl daemon-reload
""",
    """install -d -m 0755 -o root -g root /usr/local/lib/wobble-ops
install -m 0755 -o root -g root "$APP_DIR/deploy/wobble-ops-helper.mjs" /usr/local/lib/wobble-ops/helper.mjs
# Состояние операций не должно жить в /run: history и незавершённый lifecycle должны переживать
# restart helper/Control Plane и reboot. Каталог writable только для root-helper; journal 0644
# содержит лишь allowlisted action/state/timestamps/reason codes и безопасно читается Control Plane.
install -d -m 0755 -o root -g root /var/lib/wobble-ops
systemctl daemon-reload
""",
)

client = Path('server/adminOperationsClient.js')
replace_once(
    client,
    """const DEFAULT_SOCKET_PATH = '/run/wobble-ops.sock';
const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';
const MAX_RESPONSE_BYTES = 16 * 1024;
""",
    """const DEFAULT_SOCKET_PATH = '/run/wobble-ops.sock';
const DEFAULT_JOURNAL_PATH = '/var/lib/wobble-ops/operations.json';
const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';
const MAX_RESPONSE_BYTES = 16 * 1024;
const OPERATION_STATES = new Set(['queued', 'running', 'drain', 'verifying', 'succeeded', 'failed']);
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed']);
""",
)
replace_once(
    client,
    """    socketPath = process.env.ADMIN_OPS_SOCKET || DEFAULT_SOCKET_PATH,
    maintenanceFlag = MAINTENANCE_FLAG,
    timeoutMs = 135_000
  } = {}) {
    this.socketPath = socketPath;
    this.maintenanceFlag = maintenanceFlag;
    this.timeoutMs = timeoutMs;
  }
""",
    """    socketPath = process.env.ADMIN_OPS_SOCKET || DEFAULT_SOCKET_PATH,
    maintenanceFlag = MAINTENANCE_FLAG,
    journalPath = process.env.ADMIN_OPS_JOURNAL || DEFAULT_JOURNAL_PATH,
    timeoutMs = 135_000
  } = {}) {
    this.socketPath = socketPath;
    this.maintenanceFlag = maintenanceFlag;
    this.journalPath = journalPath;
    this.timeoutMs = timeoutMs;
  }
""",
)
replace_once(
    client,
    """  status() {
    const maintenance = this.maintenanceEnabled();
    return {
      available: this.available(),
      maintenance,
      operations: publicOperations().filter(item =>
        maintenance ? item.id !== 'maintenance.enable' : item.id !== 'maintenance.disable'
      )
    };
  }
""",
    """  history(limit = 20) {
    const boundedLimit = Math.max(1, Math.min(40, Number.parseInt(limit, 10) || 20));
    try {
      const parsed = JSON.parse(fs.readFileSync(this.journalPath, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.operations)) return [];
      return parsed.operations
        .filter(item => {
          const id = String(item?.id || '');
          return (
            /^[0-9a-f-]{36}$/i.test(id) &&
            Object.hasOwn(OPERATION_DEFINITIONS, String(item?.action || '')) &&
            OPERATION_STATES.has(String(item?.state || '')) &&
            Number.isSafeInteger(Number(item?.createdAt))
          );
        })
        .slice(-boundedLimit)
        .reverse()
        .map(item => ({
          id: String(item.id),
          action: String(item.action),
          state: String(item.state),
          createdAt: Number(item.createdAt),
          updatedAt: Number.isSafeInteger(Number(item.updatedAt)) ? Number(item.updatedAt) : Number(item.createdAt),
          completedAt: Number.isSafeInteger(Number(item.completedAt)) ? Number(item.completedAt) : null,
          durationMs: Number.isFinite(Number(item.durationMs)) ? Math.max(0, Number(item.durationMs)) : null,
          reason: /^[a-z0-9-]{1,80}$/.test(String(item.reason || '')) ? String(item.reason) : null,
          transitions: Array.isArray(item.transitions)
            ? item.transitions
                .filter(step => OPERATION_STATES.has(String(step?.state || '')) && Number.isSafeInteger(Number(step?.at)))
                .slice(-12)
                .map(step => ({ state: String(step.state), at: Number(step.at) }))
            : []
        }));
    } catch {
      return [];
    }
  }

  status() {
    const maintenance = this.maintenanceEnabled();
    const history = this.history();
    const activeOperation = history.find(item => !TERMINAL_OPERATION_STATES.has(item.state)) || null;
    return {
      available: this.available(),
      maintenance,
      busy: Boolean(activeOperation),
      activeOperation,
      history,
      operations: publicOperations().filter(item =>
        maintenance ? item.id !== 'maintenance.enable' : item.id !== 'maintenance.disable'
      )
    };
  }
""",
)
replace_once(
    client,
    """  AdminOperationsClient,
  DEFAULT_SOCKET_PATH,
  MAINTENANCE_FLAG,
""",
    """  AdminOperationsClient,
  DEFAULT_JOURNAL_PATH,
  DEFAULT_SOCKET_PATH,
  MAINTENANCE_FLAG,
""",
)

routes = Path('server/controlPlaneRoutes.js')
replace_once(
    routes,
    """        available: Boolean(status.available),
        maintenance: Boolean(status.maintenance),
        operations: status.operations || []
""",
    """        available: Boolean(status.available),
        maintenance: Boolean(status.maintenance),
        busy: Boolean(status.busy),
        activeOperation: status.activeOperation || null,
        history: status.history || [],
        operations: status.operations || []
""",
)
replace_once(
    routes,
    """      'operation-busy',
      'operation-timeout',
      'operation-failed',
      'restart-cooldown'
""",
    """      'operation-busy',
      'operation-state-failed',
      'operation-timeout',
      'operation-readiness-timeout',
      'operation-failed',
      'restart-cooldown'
""",
)
replace_once(
    routes,
    """          detail: {
            reason,
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
          }
""",
    """          detail: {
            reason,
            operationId: result?.operationId || result?.requestId || null,
            durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
          }
""",
)
replace_once(
    routes,
    """        detail: {
          durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
        }
""",
    """        detail: {
          operationId: result?.operationId || result?.requestId || null,
          durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
        }
""",
)
replace_once(
    routes,
    """      operation,
      accepted,
      durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
""",
    """      operation,
      operationId: result?.operationId || result?.requestId || null,
      accepted,
      durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
""",
)

index = Path('client/admin/index.html')
replace_once(
    index,
    """          <div id="operations-status" class="cards"></div>
          <div id="operations-list" class="grid-two"></div>
        </section>
""",
    """          <div id="operations-status" class="cards"></div>
          <div id="operations-list" class="grid-two"></div>
          <article class="card">
            <div class="card-head">
              <div>
                <p class="eyebrow">DURABLE OPERATIONS</p>
                <h2>История системных операций</h2>
                <p class="section-help">
                  Состояние хранится на VPS отдельно от браузера. Перезагрузка страницы, Control Plane или
                  безопасного helper не стирает текущую операцию и её этапы.
                </p>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Операция</th>
                    <th>Этап</th>
                    <th>Длительность</th>
                    <th>Результат</th>
                  </tr>
                </thead>
                <tbody id="operations-history-body"></tbody>
              </table>
            </div>
          </article>
        </section>
""",
)

admin = Path('client/admin/admin.js')
replace_once(
    admin,
    """  operations: null,
  operationConfirmation: null,
  operationConfirmationTimer: null
""",
    """  operations: null,
  operationConfirmation: null,
  operationConfirmationTimer: null,
  operationMonitorId: null
""",
)
replace_once(
    admin,
    """const ROLE_LABELS = Object.freeze({
""",
    """const OPERATION_STATE_LABELS = Object.freeze({
  queued: 'В очереди',
  running: 'Выполняется',
  drain: 'Завершение матчей',
  verifying: 'Проверка готовности',
  succeeded: 'Успешно',
  failed: 'Ошибка'
});
const OPERATION_TITLE_FALLBACKS = Object.freeze({
  'backup.create': 'Создать резервную копию',
  'backup.verify': 'Проверить последнюю копию',
  'smoke.run': 'Проверить работу Wobble',
  'maintenance.enable': 'Включить режим обслуживания',
  'maintenance.disable': 'Выключить режим обслуживания',
  'nginx.reload': 'Безопасно перечитать Nginx',
  'wobble.start': 'Запустить / восстановить сервер игры',
  'wobble.restart': 'Плавно перезапустить сервер игры'
});
const ROLE_LABELS = Object.freeze({
""",
)
replace_once(
    admin,
    """    'operation-busy': 'Сейчас уже выполняется другая системная операция. Подождите немного.',
    'operation-timeout': 'Системная операция превысила допустимое время.',
""",
    """    'operation-busy': 'Сейчас уже выполняется другая системная операция. Подождите немного.',
    'operation-state-failed': 'Не удалось надёжно сохранить состояние операции. Действие не запущено.',
    'operation-timeout': 'Системная операция превысила допустимое время.',
    'operation-readiness-timeout': 'Сервис запущен, но не подтвердил готовность вовремя.',
""",
)
replace_once(
    admin,
    """function renderOperations(payload) {
  state.operations = payload;
  const status = $('#operations-status');
  status.replaceChildren(
    statCard(
      'Безопасные операции',
      payload.available ? 'ДОСТУПНЫ' : 'НЕДОСТУПНЫ',
      payload.available
        ? 'root-helper подключён через закрытый Unix socket и принимает только список действий ниже'
        : 'после обновления VPS установщик должен включить wobble-ops.socket',
      payload.available ? 'good' : 'bad'
    )
  );

  const root = $('#operations-list');
""",
    """function renderOperations(payload) {
  state.operations = payload;
  const status = $('#operations-status');
  const statusCards = [
    statCard(
      'Безопасные операции',
      payload.available ? 'ДОСТУПНЫ' : 'НЕДОСТУПНЫ',
      payload.available
        ? 'root-helper подключён через закрытый Unix socket и принимает только список действий ниже'
        : 'после обновления VPS установщик должен включить wobble-ops.socket',
      payload.available ? 'good' : 'bad'
    )
  ];
  if (payload.activeOperation) {
    const active = payload.activeOperation;
    statusCards.push(
      statCard(
        'Текущая операция',
        OPERATION_STATE_LABELS[active.state] || active.state,
        OPERATION_TITLE_FALLBACKS[active.action] || active.action,
        active.state === 'failed' ? 'bad' : 'warn'
      )
    );
  }
  status.replaceChildren(...statusCards);

  const root = $('#operations-list');
""",
)
replace_once(
    admin,
    """    button.className = operation.tone === 'danger' ? 'primary confirm' : 'primary';
    button.disabled = !payload.available;
""",
    """    button.className = operation.tone === 'danger' ? 'primary confirm' : 'primary';
    button.disabled = !payload.available || Boolean(payload.busy);
""",
)
replace_once(
    admin,
    """    root.append(card);
  }
}

async function loadOperations() {
  const payload = await api('/api/admin/operations/status', {});
  renderOperations(payload);
}

async function monitorAcceptedRestart() {
  const deadline = Date.now() + 225_000;
  let sawTransition = false;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await api('/api/admin/control/status', {});
    } catch (error) {
      if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
      if (state.currentPanel === 'operations') {
        setStatus('Control Plane временно не смог обновить статус restart. Повторяю проверку…', 'warn');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    const game = status.game || {};
    if (status.maintenance || !game.reachable) sawTransition = true;
    if (state.currentPanel === 'operations') {
      if (!game.reachable) setStatus('Старый игровой процесс остановлен; жду новый Wobble…', 'warn');
      else if (status.maintenance)
        setStatus('Wobble перезапускается; новые подключения пока закрыты maintenance…', 'warn');
      else setStatus('Проверяю готовность нового игрового процесса…', 'warn');
    }
    if (
      game.reachable &&
      game.ok &&
      !status.maintenance &&
      (sawTransition || Number(game.uptimeSeconds || 0) <= 30)
    ) {
      await loadOperations();
      setStatus('Новый Wobble запущен и принимает подключения. Control Plane не прерывался.', 'good');
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (state.operations) renderOperations(state.operations);
  setStatus(
    'Control Plane работает, но restart не подтвердил готовность нового Wobble вовремя. Проверьте «Сервер» и «Надёжность».',
    'warn'
  );
  return false;
}
""",
    """    root.append(card);
  }

  const historyBody = $('#operations-history-body');
  historyBody.replaceChildren();
  for (const entry of payload.history || []) {
    const row = document.createElement('tr');
    appendText(row, 'td', new Date(entry.createdAt).toLocaleString('ru-RU'));
    appendText(row, 'td', OPERATION_TITLE_FALLBACKS[entry.action] || entry.action);
    appendText(row, 'td', OPERATION_STATE_LABELS[entry.state] || entry.state);
    appendText(
      row,
      'td',
      Number.isFinite(Number(entry.durationMs)) ? `${Math.max(0, Math.round(Number(entry.durationMs) / 1000))} с` : '—'
    );
    appendText(row, 'td', entry.reason ? operationErrorLabel(entry.reason) : entry.state === 'succeeded' ? 'Готово' : '—');
    historyBody.append(row);
  }
  if (!(payload.history || []).length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'muted';
    cell.textContent = 'Операции ещё не запускались.';
    row.append(cell);
    historyBody.append(row);
  }
}

async function loadOperations({ monitor = true } = {}) {
  const payload = await api('/api/admin/operations/status', {});
  renderOperations(payload);
  if (monitor && payload.activeOperation && state.operationMonitorId !== payload.activeOperation.id) {
    void monitorDurableOperation(
      payload.activeOperation.id,
      OPERATION_TITLE_FALLBACKS[payload.activeOperation.action] || payload.activeOperation.action
    );
  }
  return payload;
}

async function monitorDurableOperation(operationId, title) {
  if (!operationId || state.operationMonitorId === operationId) return false;
  state.operationMonitorId = operationId;
  const deadline = Date.now() + 240_000;
  try {
    while (Date.now() < deadline) {
      let payload;
      try {
        payload = await loadOperations({ monitor: false });
      } catch (error) {
        if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
        if (state.currentPanel === 'operations') {
          setStatus('Control Plane временно не смог прочитать durable state. Повторяю проверку…', 'warn');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
        continue;
      }
      const entry = (payload.history || []).find(item => item.id === operationId);
      if (!entry) {
        setStatus(`${title}: запись операции пока не найдена в durable history.`, 'warn');
        return false;
      }
      if (entry.state === 'succeeded') {
        setStatus(`${title}: успешно завершено.`, 'good');
        return true;
      }
      if (entry.state === 'failed') {
        setStatus(`${title}: ${operationErrorLabel(entry.reason || 'operation-failed')}`, 'bad');
        return false;
      }
      if (state.currentPanel === 'operations') {
        setStatus(`${title}: ${OPERATION_STATE_LABELS[entry.state] || entry.state}…`, 'warn');
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    setStatus(`${title}: операция всё ещё не получила финальный durable state. Обновите «Операции» позже.`, 'warn');
    return false;
  } finally {
    if (state.operationMonitorId === operationId) state.operationMonitorId = null;
  }
}
""",
)
replace_once(
    admin,
    """    if (operation === 'wobble.restart' && result.accepted) {
      setStatus('Перезапуск Wobble принят. Панель останется открытой и проследит за запуском.', 'warn');
      await monitorAcceptedRestart();
      return;
    }
    await loadOperations();
    setStatus(`${spec.title}: готово.`, 'good');
""",
    """    await loadOperations({ monitor: false });
    if (result.operationId) {
      setStatus(`${spec.title}: запрос принят, слежу за durable state…`, 'warn');
      await monitorDurableOperation(result.operationId, spec.title);
      return;
    }
    setStatus(`${spec.title}: готово.`, 'good');
""",
)

ops_test = Path('server/adminOperations.test.mjs')
replace_once(
    ops_test,
    """  const helper = createServer({
    requestTimeoutMs: 10,
    execute: async () => {
""",
    """  const helper = createServer({
    requestTimeoutMs: 10,
    journalPath: path.join(dir, 'operations.json'),
    execute: async () => {
""",
)

pkg = Path('package.json')
replace_once(
    pkg,
    "server/controlPlaneDeploy.test.mjs server/adminOperations.test.mjs server/adminInfrastructure.test.mjs",
    "server/controlPlaneDeploy.test.mjs server/adminOperations.test.mjs server/durableOperations.test.mjs server/adminInfrastructure.test.mjs",
)

Path('server/durableOperations.test.mjs').write_text(r'''import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  beginDurableOperation,
  readOperationJournal,
  recoverDurableOperations,
  transitionDurableOperation,
  writeRestartMarker
} from '../deploy/wobble-ops-helper.mjs';

const require = createRequire(import.meta.url);
const { AdminOperationsClient } = require('./adminOperationsClient');

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-durable-ops-'));
  return {
    dir,
    journalPath: path.join(dir, 'operations.json'),
    markerPath: path.join(dir, 'restart.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const request = (id, action) => ({ requestId: id, action });

test('durable journal persists the full bounded operation lifecycle atomically', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(
      request('11111111-1111-4111-8111-111111111111', 'backup.create'),
      { journalPath: ctx.journalPath, now: 1000 }
    );
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 1100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'succeeded', { now: 1600, durationMs: 600 }), true);
    const records = readOperationJournal(ctx.journalPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'succeeded');
    assert.equal(records[0].durationMs, 600);
    assert.deepEqual(records[0].transitions.map(step => step.state), ['queued', 'running', 'succeeded']);
    assert.equal(fs.statSync(ctx.journalPath).mode & 0o777, 0o644);
  } finally {
    ctx.cleanup();
  }
});

test('an active durable operation blocks overlap and interrupted non-restart work fails on helper recovery', () => {
  const ctx = tempState();
  try {
    const first = beginDurableOperation(
      request('22222222-2222-4222-8222-222222222222', 'backup.verify'),
      { journalPath: ctx.journalPath, now: 2000 }
    );
    assert.equal(first.ok, true);
    assert.equal(transitionDurableOperation(first.context, 'running', { now: 2100 }), true);
    const blocked = beginDurableOperation(
      request('33333333-3333-4333-8333-333333333333', 'smoke.run'),
      { journalPath: ctx.journalPath, now: 2200 }
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'operation-busy');
    assert.equal(blocked.activeId, first.context.id);

    const recovered = recoverDurableOperations({
      journalPath: ctx.journalPath,
      markerPath: ctx.markerPath,
      now: 3000
    });
    assert.equal(recovered[0].state, 'failed');
    assert.equal(recovered[0].reason, 'helper-restarted');

    const second = beginDurableOperation(
      request('33333333-3333-4333-8333-333333333333', 'smoke.run'),
      { journalPath: ctx.journalPath, now: 3100 }
    );
    assert.equal(second.ok, true);
  } finally {
    ctx.cleanup();
  }
});

test('restart marker keeps the matching durable restart alive across helper restart', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(
      request('44444444-4444-4444-8444-444444444444', 'wobble.restart'),
      { journalPath: ctx.journalPath, now: 4000 }
    );
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 4100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 4200 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 1234,
          startedAt: 4000,
          clearMaintenance: true,
          phase: 'signal-delivered',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );
    const recovered = recoverDurableOperations({
      journalPath: ctx.journalPath,
      markerPath: ctx.markerPath,
      now: 4300
    });
    assert.equal(recovered[0].state, 'drain');
    assert.equal(recovered[0].reason, null);
  } finally {
    ctx.cleanup();
  }
});

test('control-plane operations client exposes sanitized active state and newest-first history', () => {
  const ctx = tempState();
  try {
    fs.writeFileSync(
      ctx.journalPath,
      JSON.stringify({
        version: 1,
        operations: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            action: 'backup.create',
            state: 'succeeded',
            createdAt: 1000,
            updatedAt: 1500,
            completedAt: 1500,
            durationMs: 500,
            reason: null,
            secret: 'must-not-leak',
            transitions: [{ state: 'succeeded', at: 1500, raw: 'hidden' }]
          },
          {
            id: '66666666-6666-4666-8666-666666666666',
            action: 'wobble.restart',
            state: 'verifying',
            createdAt: 2000,
            updatedAt: 2500,
            completedAt: null,
            durationMs: null,
            reason: null,
            transitions: [{ state: 'verifying', at: 2500 }]
          }
        ]
      })
    );
    const client = new AdminOperationsClient({
      socketPath: path.join(ctx.dir, 'missing.sock'),
      maintenanceFlag: path.join(ctx.dir, 'maintenance'),
      journalPath: ctx.journalPath
    });
    const status = client.status();
    assert.equal(status.busy, true);
    assert.equal(status.activeOperation.id, '66666666-6666-4666-8666-666666666666');
    assert.equal(status.history[0].state, 'verifying');
    assert.equal(status.history[1].state, 'succeeded');
    assert.equal(Object.hasOwn(status.history[1], 'secret'), false);
    assert.deepEqual(status.history[1].transitions[0], { state: 'succeeded', at: 1500 });
  } finally {
    ctx.cleanup();
  }
});
''')

Path('docs/DURABLE-OPERATIONS.md').write_text(r'''# Durable Operations

Wobble Control treats privileged server operations as durable state machines rather than browser requests.

## Ownership and storage

`wobble-ops.service` is the authoritative lifecycle owner. It writes an atomic bounded journal to
`/var/lib/wobble-ops/operations.json`. The directory is writable only through the hardened root helper;
the resulting journal is world-readable because it contains only allowlisted action IDs, lifecycle states,
timestamps, durations and bounded reason codes. It never stores command lines chosen by a user, stdout,
stderr, tokens, cookies, access codes or filesystem paths supplied by HTTP clients.

The unprivileged Control Plane reads that sanitized journal and returns it from
`/api/admin/operations/status`. No gameplay SQLite migration or second gameplay database writer is needed.

## State machine

Operations start as `queued` and move through the smallest valid path for their type:

- ordinary oneshots: `queued -> running -> succeeded|failed`;
- service recovery: `queued -> running -> verifying -> succeeded|failed`;
- graceful Wobble restart: `queued -> running -> drain -> verifying -> succeeded|failed`.

Only one non-terminal privileged operation may exist at a time. This makes recovery deterministic and keeps
operator UI/audit history from claiming two conflicting server transitions are both authoritative.

## Recovery

On helper startup, unfinished ordinary operations are closed as `failed/helper-restarted`: their child
process lifetime cannot be proven after the helper itself died. A graceful restart is different: its existing
`/run/wobble-ops/restart.json` marker carries the durable operation ID, so the helper resumes that exact
operation and continues the readiness monitor. A restart marker that disappears while the durable operation
is still non-terminal is failed closed as `restart-state-lost`.

The journal survives browser reloads, Control Plane restarts, helper restarts and VPS reboot. The runtime
maintenance flag and restart marker remain under `/run` because they describe current boot/process ownership;
the persistent journal records the operator-visible history across those lifetimes.

## UI contract

The Operations panel shows the active lifecycle and bounded newest-first history. Buttons are disabled while
an operation is non-terminal. Reloading the page rehydrates the active operation from the server and resumes
polling it until `succeeded` or `failed`; success is never inferred merely from a browser timeout or page
reload.
''')
