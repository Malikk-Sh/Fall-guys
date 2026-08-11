#!/usr/bin/env node

import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SYSTEMCTL = '/usr/bin/systemctl';
const MAX_REQUEST_BYTES = 4096;
const RESTART_DELAY_MS = 1000;
const RESTART_COOLDOWN_MS = 30_000;

export const ACTIONS = Object.freeze({
  'backup.create': Object.freeze({ verb: 'start', unit: 'wobble-backup.service', timeoutMs: 125_000 }),
  'backup.verify': Object.freeze({ verb: 'start', unit: 'wobble-backup-verify.service', timeoutMs: 45_000 }),
  'smoke.run': Object.freeze({ verb: 'start', unit: 'wobble-smoke.service', timeoutMs: 45_000 }),
  'wobble.restart': Object.freeze({ verb: 'restart', unit: 'wobble.service', deferred: true })
});

let busy = false;
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

function runSystemctl(spec) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(SYSTEMCTL, [spec.verb, spec.unit], {
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false
    });
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, spec.timeoutMs || 45_000);
    timer.unref?.();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length < 2048) stderr += chunk;
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'systemctl-error', durationMs: Date.now() - startedAt });
    });
    child.once('close', code => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        reason: timedOut ? 'operation-timeout' : code === 0 ? null : 'operation-failed',
        exitCode: Number.isInteger(code) ? code : null,
        durationMs: Date.now() - startedAt,
        systemdMessage: code === 0 ? null : stderr.trim().slice(0, 500) || null
      });
    });
  });
}

function scheduleRestart(spec) {
  setTimeout(() => {
    const child = spawn(SYSTEMCTL, [spec.verb, spec.unit], {
      detached: true,
      stdio: 'ignore',
      shell: false
    });
    child.unref();
  }, RESTART_DELAY_MS).unref?.();
}

function send(socket, payload) {
  try {
    socket.end(`${JSON.stringify(payload)}\n`);
  } catch {
    socket.destroy();
  }
}

export async function executeRequest(request, now = Date.now()) {
  const spec = ACTIONS[request.action];
  if (!spec) return { ok: false, reason: 'unknown-operation' };
  if (busy) return { ok: false, reason: 'operation-busy' };
  if (request.action === 'wobble.restart' && now < restartCooldownUntil) {
    return { ok: false, reason: 'restart-cooldown', retryAfterMs: restartCooldownUntil - now };
  }

  if (spec.deferred) {
    restartCooldownUntil = now + RESTART_COOLDOWN_MS;
    scheduleRestart(spec);
    return { ok: true, accepted: true, deferred: true };
  }

  busy = true;
  try {
    return await runSystemctl(spec);
  } finally {
    busy = false;
  }
}

export function createServer() {
  return net.createServer(socket => {
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
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
      const result = await executeRequest(request);
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
