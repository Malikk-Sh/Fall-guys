#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SYSTEMCTL = '/usr/bin/systemctl';
const NGINX = '/usr/sbin/nginx';
const MAX_REQUEST_BYTES = 4096;
const MAX_HEALTH_BYTES = 4096;
const REQUEST_READ_TIMEOUT_MS = 5000;
const RESTART_COOLDOWN_MS = 30_000;
const RESTART_MONITOR_MS = 1000;
const RESTART_MONITOR_TIMEOUT_MS = 210_000;
const RESTART_MARKER_VERSION = 1;
const RESTART_SIGNAL_PHASES = new Set(['signal-pending', 'signal-delivered', 'signal-uncertain']);
const READY_STREAK_REQUIRED = 3;
const WOBBLE_HEALTH_TIMEOUT_MS = 1500;
const WOBBLE_HEALTH_HOST = '127.0.0.1';
const WOBBLE_HEALTH_PORT = 3000;
const WOBBLE_HEALTH_PATH = '/health/ops';

export const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';
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

export const ACTIONS = Object.freeze({
  'backup.create': Object.freeze({
    kind: 'systemd',
    verb: 'start',
    unit: 'wobble-backup.service',
    timeoutMs: 125_000
  }),
  'backup.verify': Object.freeze({
    kind: 'systemd',
    verb: 'start',
    unit: 'wobble-backup-verify.service',
    timeoutMs: 45_000
  }),
  'smoke.run': Object.freeze({
    kind: 'systemd',
    verb: 'start',
    unit: 'wobble-smoke.service',
    timeoutMs: 45_000
  }),
  'maintenance.enable': Object.freeze({ kind: 'maintenance', enabled: true }),
  'maintenance.disable': Object.freeze({ kind: 'maintenance', enabled: false }),
  'nginx.reload': Object.freeze({ kind: 'nginx-reload', timeoutMs: 20_000 }),
  'wobble.start': Object.freeze({ kind: 'wobble-start' }),
  'wobble.restart': Object.freeze({ kind: 'graceful-restart', deferred: true })
});

let busy = false;
let restartInFlight = false;
let restartCooldownUntil = 0;

function validRequestId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

export function validateRequest(value) {
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
      `${JSON.stringify({ version: OPERATION_JOURNAL_VERSION, operations })}\n`,
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
  if (!context?.id || !context?.action || !context?.journalPath || !OPERATION_STATES.has(nextState))
    return false;
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

function runCommand(command, args, { timeoutMs = 45_000, captureStdout = false } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'pipe'],
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    if (captureStdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (stdout.length < 2048) stdout += chunk;
      });
    }
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 2048) stderr += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: 'systemctl-error',
        durationMs: Date.now() - startedAt
      });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        reason: timedOut ? 'operation-timeout' : code === 0 ? null : 'operation-failed',
        exitCode: Number.isInteger(code) ? code : null,
        durationMs: Date.now() - startedAt,
        stdout: captureStdout ? stdout.trim().slice(0, 500) : null,
        systemdMessage: code === 0 ? null : stderr.trim().slice(0, 500) || null
      });
    });
  });
}

function runSystemctl(spec) {
  return runCommand(SYSTEMCTL, [spec.verb, spec.unit], {
    timeoutMs: spec.timeoutMs || 45_000
  });
}

export function maintenanceEnabled(flagPath = MAINTENANCE_FLAG) {
  try {
    return fs.statSync(flagPath).isFile();
  } catch {
    return false;
  }
}

export function setMaintenance(enabled, flagPath = MAINTENANCE_FLAG) {
  try {
    if (enabled) {
      fs.writeFileSync(flagPath, `${new Date().toISOString()}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
    } else {
      fs.rmSync(flagPath, { force: true });
    }
    return { ok: true, maintenance: Boolean(enabled) };
  } catch {
    return { ok: false, reason: 'operation-failed' };
  }
}

function normalizeRestartMarker(value) {
  const oldPid = Number(value?.oldPid);
  const startedAt = Number(value?.startedAt);
  // Version-1 markers written before phases existed are conservatively treated as pending.
  // Re-delivering SIGUSR2 is safe because Wobble drain is process-wide and idempotent.
  const phase = value?.phase == null ? 'signal-pending' : String(value.phase);
  if (
    value?.version !== RESTART_MARKER_VERSION ||
    !Number.isSafeInteger(oldPid) ||
    oldPid <= 0 ||
    !Number.isSafeInteger(startedAt) ||
    startedAt <= 0 ||
    typeof value?.clearMaintenance !== 'boolean' ||
    !RESTART_SIGNAL_PHASES.has(phase)
  ) {
    return null;
  }
  const operationId = validRequestId(value?.operationId) ? String(value.operationId) : null;
  return {
    version: RESTART_MARKER_VERSION,
    oldPid,
    startedAt,
    clearMaintenance: value.clearMaintenance,
    phase,
    ...(operationId ? { operationId } : {})
  };
}

export function readRestartMarker(markerPath = RESTART_MARKER) {
  try {
    return normalizeRestartMarker(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
  } catch {
    return null;
  }
}

export function writeRestartMarker(value, markerPath = RESTART_MARKER) {
  const marker = normalizeRestartMarker(value);
  if (!marker) return false;
  const temporaryPath = `${markerPath}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, markerPath);
    return true;
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {
      // Best effort only: the canonical marker was never replaced.
    }
    return false;
  }
}

export function clearRestartMarker(markerPath = RESTART_MARKER) {
  try {
    fs.rmSync(markerPath, { force: true });
    fs.rmSync(`${markerPath}.tmp`, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function runNginxReload(spec) {
  const startedAt = Date.now();
  const check = await runCommand(NGINX, ['-t'], {
    timeoutMs: spec.timeoutMs || 20_000
  });
  if (!check.ok) {
    return {
      ok: false,
      reason: check.reason || 'operation-failed',
      durationMs: Date.now() - startedAt
    };
  }
  const reload = await runCommand(SYSTEMCTL, ['reload', 'nginx.service'], {
    timeoutMs: spec.timeoutMs || 20_000
  });
  return {
    ok: reload.ok,
    reason: reload.ok ? null : reload.reason || 'operation-failed',
    durationMs: Date.now() - startedAt
  };
}

async function wobbleMainPid() {
  const result = await runCommand(SYSTEMCTL, ['show', '--property=MainPID', '--value', 'wobble.service'], {
    timeoutMs: 5000,
    captureStdout: true
  });
  if (!result.ok) return 0;
  const pid = Number.parseInt(result.stdout, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function sendGracefulRestartSignal() {
  return runCommand(SYSTEMCTL, ['kill', '--kill-whom=main', '--signal=SIGUSR2', 'wobble.service'], {
    timeoutMs: 5000
  });
}

export function readWobbleOperationalHealth({
  host = WOBBLE_HEALTH_HOST,
  port = WOBBLE_HEALTH_PORT,
  path = WOBBLE_HEALTH_PATH,
  timeoutMs = WOBBLE_HEALTH_TIMEOUT_MS
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const request = http.get(
      {
        hostname: host,
        port,
        path,
        headers: { Host: `${host}:${port}` },
        agent: false
      },
      response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > MAX_HEALTH_BYTES) {
            request.destroy();
            finish(null);
          }
        });
        response.on('end', () => {
          if (response.statusCode !== 200) return finish(null);
          try {
            const value = JSON.parse(body);
            const pid = Number(value?.pid);
            if (!value?.ok || !Number.isSafeInteger(pid) || pid <= 0 || typeof value.draining !== 'boolean') {
              return finish(null);
            }
            return finish({ pid, draining: value.draining });
          } catch {
            return finish(null);
          }
        });
      }
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error('health-timeout')));
    request.once('error', () => finish(null));
  });
}

async function confirmOldProcessNotDraining(oldPid) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const health = await readWobbleOperationalHealth();
    const pid = await wobbleMainPid();
    if (!health || health.pid !== oldPid || health.draining || pid !== oldPid) return false;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250));
  }
  return true;
}

async function advancePendingRestartSignal(marker, markerPath = RESTART_MARKER) {
  if (!marker || marker.phase !== 'signal-pending') return { marker, rolledBack: false };

  const pid = await wobbleMainPid();
  const health = await readWobbleOperationalHealth();
  const confirmedPid = await wobbleMainPid();

  if (pid === marker.oldPid && confirmedPid === marker.oldPid && health?.pid === marker.oldPid) {
    if (health.draining === true) {
      marker = { ...marker, phase: 'signal-delivered' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }

    const signal = await sendGracefulRestartSignal();
    if (signal.ok) {
      marker = { ...marker, phase: 'signal-delivered' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }
    if (signal.reason === 'operation-timeout') {
      marker = { ...marker, phase: 'signal-uncertain' };
      writeRestartMarker(marker, markerPath);
      return { marker, rolledBack: false };
    }

    const safeToRollback = await confirmOldProcessNotDraining(marker.oldPid);
    if (safeToRollback) {
      clearRestartMarker(markerPath);
      if (marker.clearMaintenance) setMaintenance(false);
      restartInFlight = false;
      return { marker: null, rolledBack: true };
    }

    marker = { ...marker, phase: 'signal-uncertain' };
    writeRestartMarker(marker, markerPath);
    return { marker, rolledBack: false };
  }

  if (pid && pid !== marker.oldPid && confirmedPid === pid) {
    // The replacement is already the MainPID. Never send SIGUSR2 to the fresh process.
    marker = { ...marker, phase: 'signal-delivered' };
    writeRestartMarker(marker, markerPath);
  }

  // Missing/discordant PID or health is transient/ambiguous: keep signal-pending. The bounded
  // monitor will retry this exact state on a later tick while maintenance stays fail-closed.
  return { marker, rolledBack: false };
}

function scheduleRestartCompletion(
  oldPid,
  {
    clearMaintenance,
    startedAt = Date.now(),
    markerPath = RESTART_MARKER,
    operationId = null,
    journalPath = OPERATION_JOURNAL
  }
) {
  let checking = false;
  let candidatePid = 0;
  let readyStreak = 0;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      // The marker owns the maintenance gate. If another process or a helper restart removed the
      // flag while the marker still exists, recreate it before doing any readiness work.
      if (!maintenanceEnabled()) setMaintenance(true);

      const persisted = readRestartMarker(markerPath);
      if (persisted?.phase === 'signal-pending') {
        const advanced = await advancePendingRestartSignal(persisted, markerPath);
        if (advanced.rolledBack) {
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
      }

      const pid = await wobbleMainPid();
      if (pid && pid !== oldPid) {
        if (candidatePid !== pid) {
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
        const confirmedPid = await wobbleMainPid();
        if (health?.pid === candidatePid && health.draining === false && confirmedPid === candidatePid) {
          readyStreak += 1;
        } else {
          readyStreak = 0;
        }
        if (readyStreak >= READY_STREAK_REQUIRED) {
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
      } else {
        candidatePid = 0;
        readyStreak = 0;
      }

      if (Date.now() - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
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
    } finally {
      checking = false;
    }
  }, RESTART_MONITOR_MS);
  timer.unref?.();
}

export async function recoverRestartMonitor({
  markerPath = RESTART_MARKER,
  journalPath = OPERATION_JOURNAL,
  now = Date.now()
} = {}) {
  if (restartInFlight) return true;
  let marker = readRestartMarker(markerPath);
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
  if (!maintenanceEnabled()) setMaintenance(true);

  if (marker.phase === 'signal-pending') {
    const advanced = await advancePendingRestartSignal(marker, markerPath);
    if (advanced.rolledBack) return false;
    marker = advanced.marker || marker;
  }

  scheduleRestartCompletion(marker.oldPid, {
    clearMaintenance: marker.clearMaintenance,
    startedAt,
    markerPath,
    operationId: marker.operationId || null,
    journalPath
  });
  return true;
}

async function waitForWobbleReady({ timeoutMs = 20_000 } = {}) {
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
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });
  if (!reset.ok) {
    return {
      ok: false,
      reason: reset.reason || 'operation-failed',
      durationMs: Date.now() - startedAt
    };
  }
  const start = await runCommand(SYSTEMCTL, ['start', 'wobble.service'], { timeoutMs: 20_000 });
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

async function startGracefulRestart(now, operationContext) {
  if (restartInFlight) return { ok: false, reason: 'operation-busy' };
  if (now < restartCooldownUntil) {
    return { ok: false, reason: 'restart-cooldown', retryAfterMs: restartCooldownUntil - now };
  }

  // Резервируем переход ДО первого await. Иначе параллельная maintenance-команда или второй
  // restart может пройти между проверкой выше и фактической отправкой SIGUSR2.
  restartInFlight = true;

  const oldPid = await wobbleMainPid();
  if (!oldPid) {
    restartInFlight = false;
    return { ok: false, reason: 'operation-failed' };
  }

  const alreadyInMaintenance = maintenanceEnabled();
  const maintenance = setMaintenance(true);
  if (!maintenance.ok) {
    restartInFlight = false;
    return maintenance;
  }
  transitionDurableOperation(operationContext, 'running');

  // Durable ownership is written synchronously before SIGUSR2. If wobble-ops.service is restarted
  // by systemd or deploy/install.sh after this point, the next helper process reconstructs the
  // monitor and keeps the same maintenance ownership instead of stranding the server offline.
  let marker = {
    version: RESTART_MARKER_VERSION,
    oldPid,
    startedAt: now,
    clearMaintenance: !alreadyInMaintenance,
    phase: 'signal-pending',
    operationId: operationContext?.id || null
  };
  if (!writeRestartMarker(marker)) {
    restartInFlight = false;
    if (!alreadyInMaintenance) setMaintenance(false);
    return { ok: false, reason: 'operation-state-failed', maintenance: maintenanceEnabled() };
  }
  transitionDurableOperation(operationContext, 'drain');

  const signal = await sendGracefulRestartSignal();
  if (signal.ok) {
    marker = { ...marker, phase: 'signal-delivered' };
    writeRestartMarker(marker);
  } else if (signal.reason === 'operation-timeout') {
    marker = { ...marker, phase: 'signal-uncertain' };
    writeRestartMarker(marker);
  }
  if (!signal.ok) {
    // timeout неоднозначен: SIGUSR2 мог уже попасть в Node до убийства зависшего systemctl.
    // Любая другая ошибка тоже откатывает флаг только после тройного подтверждения тем же PID,
    // что старый процесс жив, отвечает локальному health и НЕ вошёл в drain.
    const safeToRollback =
      signal.reason !== 'operation-timeout' && (await confirmOldProcessNotDraining(oldPid));
    if (safeToRollback) {
      clearRestartMarker();
      if (!alreadyInMaintenance) setMaintenance(false);
      restartInFlight = false;
    } else {
      if (signal.reason !== 'operation-timeout') {
        marker = { ...marker, phase: 'signal-uncertain' };
        writeRestartMarker(marker);
      }
      restartCooldownUntil = now + RESTART_COOLDOWN_MS;
      scheduleRestartCompletion(oldPid, {
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
  });
  return { ok: true, accepted: true, deferred: true, maintenance: true };
}

export async function executeRequest(request, now = Date.now(), operationContext = null) {
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
    // Restart owns the maintenance flag until the new PID has passed readiness. Blocking both
    // transitions prevents a manual enable during restart from being mistaken for the helper's
    // temporary flag and removed by the completion monitor.
    if (restartInFlight) return { ok: false, reason: 'operation-busy' };
    transitionDurableOperation(operationContext, 'running');
    return setMaintenance(spec.enabled);
  }

  busy = true;
  try {
    transitionDurableOperation(operationContext, 'running');
    if (spec.kind === 'nginx-reload') return await runNginxReload(spec);
    return await runSystemctl(spec);
  } finally {
    busy = false;
  }
}

function send(socket, payload) {
  try {
    socket.end(`${JSON.stringify(payload)}\n`);
  } catch {
    socket.destroy();
  }
}

export function createServer({
  execute = executeRequest,
  requestTimeoutMs = REQUEST_READ_TIMEOUT_MS,
  journalPath = OPERATION_JOURNAL
} = {}) {
  return net.createServer(socket => {
    socket.setEncoding('utf8');
    // The short timeout protects only the tiny unauthenticated local request frame. Once a valid
    // allowlisted action has been parsed, operation-specific systemd/client timeouts take over.
    socket.setTimeout(requestTimeoutMs, () => socket.destroy());
    let input = '';
    let handled = false;

    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) {
        handled = true;
        send(socket, { ok: false, reason: 'request-too-large', requestId: null, action: null });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      let parsed;
      try {
        parsed = JSON.parse(input.slice(0, newline));
      } catch {
        send(socket, { ok: false, reason: 'invalid-json', requestId: null, action: null });
        return;
      }
      const request = validateRequest(parsed);
      if (!request) {
        send(socket, {
          ok: false,
          reason: 'invalid-request',
          requestId: parsed?.requestId || null,
          action: parsed?.action || null
        });
        return;
      }

      const begun = beginDurableOperation(request, { journalPath });
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
    });
    socket.once('error', () => socket.destroy());
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fd = Number(process.env.LISTEN_FDS || 0) > 0 ? 3 : null;
  if (fd == null) {
    console.error('wobble-ops helper must be started by systemd socket activation');
    process.exit(1);
  }
  recoverDurableOperations();
  await recoverRestartMonitor();
  const server = createServer();
  server.listen({ fd });
}
