#!/usr/bin/env node

import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SYSTEMCTL = '/usr/bin/systemctl';
const NGINX = '/usr/sbin/nginx';
const MAX_REQUEST_BYTES = 4096;
const REQUEST_READ_TIMEOUT_MS = 5000;
const RESTART_COOLDOWN_MS = 30_000;
const RESTART_MONITOR_MS = 1000;
const RESTART_MONITOR_TIMEOUT_MS = 210_000;

export const MAINTENANCE_FLAG = '/run/wobble-ops/maintenance';

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
  const result = await runCommand(
    SYSTEMCTL,
    ['show', '--property=MainPID', '--value', 'wobble.service'],
    { timeoutMs: 5000, captureStdout: true }
  );
  if (!result.ok) return 0;
  const pid = Number.parseInt(result.stdout, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

function scheduleRestartCompletion(oldPid, { clearMaintenance }) {
  const startedAt = Date.now();
  let checking = false;
  const timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const pid = await wobbleMainPid();
      if (pid && pid !== oldPid) {
        clearInterval(timer);
        restartInFlight = false;
        if (clearMaintenance) setMaintenance(false);
        return;
      }
      if (Date.now() - startedAt >= RESTART_MONITOR_TIMEOUT_MS) {
        clearInterval(timer);
        restartInFlight = false;
        // Безопасный отказ: если Wobble так и не поднялся новым процессом, maintenance остаётся.
        // Это не даёт клиентам устроить reconnect-storm на неисправный сервис.
        console.error('wobble graceful restart timed out; maintenance remains enabled');
      }
    } finally {
      checking = false;
    }
  }, RESTART_MONITOR_MS);
  timer.unref?.();
}

async function startGracefulRestart(now) {
  if (restartInFlight) return { ok: false, reason: 'operation-busy' };
  if (now < restartCooldownUntil) {
    return { ok: false, reason: 'restart-cooldown', retryAfterMs: restartCooldownUntil - now };
  }

  const oldPid = await wobbleMainPid();
  if (!oldPid) return { ok: false, reason: 'operation-failed' };

  const alreadyInMaintenance = maintenanceEnabled();
  const maintenance = setMaintenance(true);
  if (!maintenance.ok) return maintenance;

  const signal = await runCommand(
    SYSTEMCTL,
    ['kill', '--kill-whom=main', '--signal=SIGUSR2', 'wobble.service'],
    { timeoutMs: 5000 }
  );
  if (!signal.ok) {
    if (!alreadyInMaintenance) setMaintenance(false);
    return {
      ok: false,
      reason: signal.reason || 'operation-failed',
      durationMs: signal.durationMs
    };
  }

  restartInFlight = true;
  restartCooldownUntil = now + RESTART_COOLDOWN_MS;
  scheduleRestartCompletion(oldPid, { clearMaintenance: !alreadyInMaintenance });
  return { ok: true, accepted: true, deferred: true, maintenance: true };
}

export async function executeRequest(request, now = Date.now()) {
  const spec = ACTIONS[request.action];
  if (!spec) return { ok: false, reason: 'unknown-operation' };
  if (busy) return { ok: false, reason: 'operation-busy' };

  if (spec.kind === 'graceful-restart') return startGracefulRestart(now);
  if (spec.kind === 'maintenance') {
    if (restartInFlight && spec.enabled === false) {
      return { ok: false, reason: 'operation-busy' };
    }
    return setMaintenance(spec.enabled);
  }

  busy = true;
  try {
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
  requestTimeoutMs = REQUEST_READ_TIMEOUT_MS
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

      // A backup can legitimately take far longer than the 5-second request-read guard. Keeping
      // that guard active here would report a false failure while systemd continues the job.
      socket.setTimeout(0);
      const result = await execute(request);
      send(socket, { ...result, requestId: request.requestId, action: request.action });
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
  const server = createServer();
  server.listen({ fd });
}
