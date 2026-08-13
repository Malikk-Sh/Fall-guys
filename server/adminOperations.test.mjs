import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ACTIONS,
  MAINTENANCE_FLAG,
  RESTART_MARKER,
  clearRestartMarker,
  createServer,
  maintenanceEnabled,
  readRestartMarker,
  readWobbleOperationalHealth,
  setMaintenance,
  validateRequest,
  writeRestartMarker
} from '../deploy/wobble-ops-helper.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { installAdminRoutes } = require('./adminRoutes');
const operationalState = require('./operationalState');
const {
  AdminOperationsClient,
  OPERATION_DEFINITIONS,
  publicOperations,
  validOperation
} = require('./adminOperationsClient');

async function start(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, adminAuth, role) {
  const created = adminAuth.createUser({ name: `${role} ops test`, role, now: 1000 });
  assert.equal(created.ok, true);
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: created.accessCode })
  });
  assert.equal(response.status, 200);
  return {
    user: created.user,
    payload: await response.json(),
    cookie: response.headers.get('set-cookie').split(';', 1)[0]
  };
}

function post(base, route, loginState, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: {
      Cookie: loginState.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': loginState.payload.csrf
    },
    body: JSON.stringify(body)
  });
}

test('web client and root helper share the same closed operation allowlist', () => {
  assert.deepEqual(Object.keys(ACTIONS).sort(), Object.keys(OPERATION_DEFINITIONS).sort());
  assert.deepEqual(
    publicOperations()
      .map(item => item.id)
      .sort(),
    Object.keys(ACTIONS).sort()
  );
  assert.equal(validOperation('backup.create'), 'backup.create');
  assert.equal(validOperation('maintenance.enable'), 'maintenance.enable');
  assert.equal(validOperation('nginx.reload'), 'nginx.reload');
  assert.equal(validOperation('wobble.start'), 'wobble.start');
  assert.equal(validOperation('unknown.operation'), null);

  const allowedUnits = new Set([
    'wobble-backup.service',
    'wobble-backup-verify.service',
    'wobble-smoke.service'
  ]);
  const systemdActions = Object.entries(ACTIONS).filter(([, spec]) => spec.kind === 'systemd');
  assert.equal(systemdActions.length, allowedUnits.size);
  for (const [action, spec] of systemdActions) {
    assert.equal(allowedUnits.has(spec.unit), true, `${action} may use only an explicitly approved unit`);
    assert.equal(spec.verb, 'start');
  }

  assert.equal(ACTIONS['nginx.reload'].kind, 'nginx-reload');
  assert.equal(ACTIONS['wobble.start'].kind, 'wobble-start');
  assert.equal(ACTIONS['wobble.restart'].kind, 'graceful-restart');
  assert.equal(ACTIONS['wobble.restart'].deferred, true);
  assert.deepEqual(
    [ACTIONS['maintenance.enable'].enabled, ACTIONS['maintenance.disable'].enabled],
    [true, false]
  );
  for (const definition of Object.values(OPERATION_DEFINITIONS)) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 20);
  }
});

test('helper rejects extra fields and unknown actions before privileged work', () => {
  const requestId = '4d4a51e8-f32b-4f97-8d48-95640ad5084d';
  assert.deepEqual(validateRequest({ requestId, action: 'smoke.run' }), {
    requestId,
    action: 'smoke.run'
  });
  assert.deepEqual(validateRequest({ requestId, action: 'nginx.reload' }), {
    requestId,
    action: 'nginx.reload'
  });
  assert.equal(validateRequest({ requestId, action: 'shell.exec' }), null);
  assert.equal(validateRequest({ requestId, action: 'smoke.run', command: 'id' }), null);
  assert.equal(validateRequest({ requestId, action: 'maintenance.enable', path: '/tmp/example' }), null);
  assert.equal(validateRequest({ requestId: 'not-a-uuid', action: 'smoke.run' }), null);
});

test('maintenance flag uses one fixed runtime path and enable/disable is idempotent', () => {
  assert.equal(MAINTENANCE_FLAG, '/run/wobble-ops/maintenance');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-maintenance-test-'));
  const flag = path.join(dir, 'maintenance');
  try {
    assert.equal(maintenanceEnabled(flag), false);
    assert.equal(setMaintenance(true, flag).ok, true);
    assert.equal(maintenanceEnabled(flag), true);
    assert.equal(setMaintenance(true, flag).ok, true);
    assert.equal(setMaintenance(false, flag).ok, true);
    assert.equal(setMaintenance(false, flag).ok, true);
    assert.equal(maintenanceEnabled(flag), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('restart monitor state survives helper restart through one fixed durable marker', () => {
  assert.equal(RESTART_MARKER, '/run/wobble-ops/restart.json');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-restart-marker-test-'));
  const markerPath = path.join(dir, 'restart.json');
  const legacy = { version: 1, oldPid: 4321, startedAt: 123456, clearMaintenance: true };
  const pending = { ...legacy, phase: 'signal-pending' };
  try {
    assert.equal(readRestartMarker(markerPath), null);
    assert.equal(writeRestartMarker(legacy, markerPath), true);
    assert.deepEqual(readRestartMarker(markerPath), pending);
    for (const phase of ['signal-delivered', 'signal-uncertain']) {
      const marker = { ...legacy, phase };
      assert.equal(writeRestartMarker(marker, markerPath), true);
      assert.deepEqual(readRestartMarker(markerPath), marker);
    }
    assert.equal(writeRestartMarker({ ...legacy, phase: 'invalid-phase' }, markerPath), false);
    fs.writeFileSync(markerPath, '{broken json');
    assert.equal(readRestartMarker(markerPath), null);
    assert.equal(writeRestartMarker(legacy, markerPath), true);
    assert.equal(clearRestartMarker(markerPath), true);
    assert.equal(readRestartMarker(markerPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('operational drain state is process-wide and one-way for the retiring process', () => {
  assert.equal(operationalState.isDraining(), false);
  assert.equal(operationalState.beginDrain(), true);
  assert.equal(operationalState.isDraining(), true);
  assert.equal(operationalState.beginDrain(), false);
});

test('operational health parser accepts only a valid PID and drain state', async t => {
  let payload = { ok: true, pid: 4321, draining: false };
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/health/ops');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;

  assert.deepEqual(await readWobbleOperationalHealth({ port }), {
    pid: 4321,
    draining: false
  });

  payload = { ok: true, pid: 4321, draining: true };
  assert.deepEqual(await readWobbleOperationalHealth({ port }), {
    pid: 4321,
    draining: true
  });

  payload = { ok: true, pid: 'not-a-pid', draining: false };
  assert.equal(await readWobbleOperationalHealth({ port }), null);
});

test('operation status exposes only the maintenance transition that currently makes sense', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-maintenance-status-'));
  const flag = path.join(dir, 'maintenance');
  try {
    const client = new AdminOperationsClient({
      socketPath: path.join(dir, 'missing.sock'),
      maintenanceFlag: flag
    });
    let ids = client.status().operations.map(item => item.id);
    assert.ok(ids.includes('maintenance.enable'));
    assert.equal(ids.includes('maintenance.disable'), false);

    fs.writeFileSync(flag, 'on\n');
    ids = client.status().operations.map(item => item.id);
    assert.equal(ids.includes('maintenance.enable'), false);
    assert.ok(ids.includes('maintenance.disable'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('client keeps the IPC connection alive until a slow allowlisted operation replies', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-ops-test-'));
  const socketPath = path.join(dir, 'ops.sock');
  const helper = createServer({
    requestTimeoutMs: 10,
    journalPath: path.join(dir, 'operations.json'),
    execute: async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { ok: true, durationMs: 50 };
    }
  });
  await new Promise((resolve, reject) => {
    helper.once('error', reject);
    helper.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise(resolve => helper.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const client = new AdminOperationsClient({ socketPath, timeoutMs: 500 });
  assert.equal(client.available(), true);
  const result = await client.run('backup.verify');
  assert.equal(result.ok, true);
  assert.equal(result.action, 'backup.verify');
  assert.equal(result.durationMs, 50);
});

test('privileged helper limits its readiness network access to localhost', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const helperUnit = fs.readFileSync(path.join(root, 'deploy/wobble-ops.service'), 'utf8');
  const smokeUnit = fs.readFileSync(path.join(root, 'deploy/wobble-smoke.service'), 'utf8');
  const verifyUnit = fs.readFileSync(path.join(root, 'deploy/wobble-backup-verify.service'), 'utf8');
  const socketUnit = fs.readFileSync(path.join(root, 'deploy/wobble-ops.socket'), 'utf8');

  assert.match(helperUnit, /^User=root$/m);
  assert.match(helperUnit, /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/wobble-ops\/helper\.mjs/);
  assert.doesNotMatch(helperUnit, /ExecStart=.*\/opt\/wobble/);
  assert.match(helperUnit, /^RuntimeDirectory=wobble-ops$/m);
  assert.match(helperUnit, /^RuntimeDirectoryMode=0755$/m);
  assert.match(helperUnit, /^RuntimeDirectoryPreserve=yes$/m);
  assert.match(helperUnit, /^Restart=on-failure$/m);
  assert.match(helperUnit, /^RestartSec=1s$/m);
  assert.match(helperUnit, /^RestrictAddressFamilies=AF_UNIX AF_INET$/m);
  assert.match(helperUnit, /^IPAddressDeny=any$/m);
  assert.match(helperUnit, /^IPAddressAllow=127\.0\.0\.1\/32$/m);
  assert.doesNotMatch(helperUnit, /AF_INET6/);
  assert.match(smokeUnit, /^User=wobble$/m);
  assert.match(verifyUnit, /^User=wobble$/m);
  assert.match(socketUnit, /^SocketGroup=wobble$/m);
  assert.match(socketUnit, /^SocketMode=0660$/m);
});

test('maintenance gates only new WebSocket upgrades and nginx reload is validate-first', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const nginxLocations = fs.readFileSync(path.join(root, 'deploy/nginx-locations.conf'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'deploy/wobble-ops-helper.mjs'), 'utf8');

  assert.equal((nginxLocations.match(/\/run\/wobble-ops\/maintenance/g) || []).length, 1);
  assert.match(nginxLocations, /location ~\* \^\/health\/ops\$/);
  assert.doesNotMatch(nginxLocations, /location = \/health\/ops/);
  assert.match(
    nginxLocations,
    /location \/ws \{[\s\S]*if \(-f \/run\/wobble-ops\/maintenance\) \{[\s\S]*return 503;/
  );
  assert.doesNotMatch(nginxLocations.split('location /ws {', 1)[0], /wobble-ops\/maintenance/);

  const nginxTestAt = helper.indexOf("runCommand(NGINX, ['-t']");
  const nginxReloadAt = helper.indexOf("runCommand(SYSTEMCTL, ['reload', 'nginx.service']");
  assert.ok(nginxTestAt >= 0);
  assert.ok(nginxReloadAt > nginxTestAt);
  assert.doesNotMatch(helper, /exec\(|shell:\s*true/);
});

test('operational restart is serialized and clears maintenance only after stable new-PID health', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const bootstrap = fs.readFileSync(path.join(root, 'server/bootstrap.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const helper = fs.readFileSync(path.join(root, 'deploy/wobble-ops-helper.mjs'), 'utf8');
  const install = fs.readFileSync(path.join(root, 'deploy/install.sh'), 'utf8');

  assert.match(bootstrap, /const ACTIVE_MATCH_STATES = new Set\(\['COUNTDOWN', 'PLAYING'\]\)/);
  assert.match(bootstrap, /const DRAIN_TIMEOUT_MS = 180_000/);
  assert.match(bootstrap, /core\.beginOperationalDrain\(\)/);
  assert.match(index, /app\.get\('\/health\/ops'/);
  assert.match(index, /req\.path !== '\/health\/ops'/);
  assert.match(index, /pid: process\.pid/);
  assert.match(index, /draining: operationalState\.isDraining\(\)/);
  assert.match(index, /const ready =[\s\S]*!operationalState\.isDraining\(\)/);
  assert.match(index, /verifyClient:[\s\S]*!operationalState\.isDraining\(\)/);
  assert.match(
    index,
    /function beginCountdown\(room\) \{[\s\S]*operationalState\.isDraining\(\)[\s\S]*S2C\.SERVER_SHUTDOWN/
  );
  assert.match(bootstrap, /process\.on\('SIGUSR2', \(\) => beginGracefulDrain\('SIGUSR2'\)\)/);
  assert.match(bootstrap, /core\.shutdown\(`\$\{signal\}:\$\{reason\}`\)/);

  const reserveAt = helper.indexOf('restartInFlight = true;');
  const firstAwaitAt = helper.indexOf('const oldPid = await wobbleMainPid();');
  assert.ok(reserveAt >= 0 && firstAwaitAt > reserveAt);
  assert.match(helper, /const READY_STREAK_REQUIRED = 3/);
  assert.match(helper, /export const RESTART_MARKER = '\/run\/wobble-ops\/restart\.json'/);
  assert.match(helper, /recoverRestartMonitor\(\);/);
  const markerWriteAt = helper.indexOf('if (!writeRestartMarker(marker))');
  const startRestartAt = helper.indexOf('async function startGracefulRestart');
  const signalAt = helper.indexOf('const signal = await sendGracefulRestartSignal();', startRestartAt);
  assert.ok(markerWriteAt >= 0 && signalAt > markerWriteAt);
  const socketRestartAt = install.indexOf('systemctl restart wobble-ops.socket');
  const helperStartAt = install.indexOf('systemctl start wobble-ops.service');
  assert.ok(socketRestartAt >= 0 && helperStartAt > socketRestartAt);
  assert.match(
    helper,
    /health\?\.pid === candidatePid && health\.draining === false && confirmedPid === candidatePid/
  );
  assert.match(helper, /signal\.reason !== 'operation-timeout'/);
  assert.match(
    helper,
    /if \(spec\.kind === 'maintenance'\) \{[\s\S]*if \(restartInFlight\) return \{ ok: false, reason: 'operation-busy' \}/
  );
  assert.match(helper, /await confirmOldProcessNotDraining\(oldPid\)/);
  assert.match(helper, /--kill-whom=main', '--signal=SIGUSR2', 'wobble\.service'/);
  assert.match(helper, /restart timed out; maintenance remains enabled/);

  // Якорь — по ключу таблицы обработчиков, а не по тексту `if`: цепочка `if` разобрана в таблицу,
  // а проверяемое здесь важно само по себе — внутри запуска матча слив идёт раньше проверки
  // мощности, а счётчик отказа — после неё. Порядок этих трёх вещей и есть предмет теста.
  const startHandlerAt = index.indexOf('[C2S.START_MATCH]:');
  const startDrainAt = index.indexOf('if (operationalState.isDraining())', startHandlerAt);
  const capacityAt = index.indexOf('if (capacityStatus().matchesFull)', startHandlerAt);
  const capacityMetricAt = index.indexOf('metrics.capacityRejected++', startHandlerAt);
  assert.ok(startHandlerAt >= 0 && startDrainAt > startHandlerAt && startDrainAt < capacityAt);
  assert.ok(capacityAt < capacityMetricAt);

  const findHandlerAt = index.indexOf('[C2S.FIND_COOP]:');
  const findDrainAt = index.indexOf('if (operationalState.isDraining())', findHandlerAt);
  const findCapacityAt = index.indexOf(
    'if (loadStatus().overloaded || rooms.size >= MAX_ROOMS)',
    findHandlerAt
  );
  const findCapacityMetricAt = index.indexOf('metrics.capacityRejected++', findHandlerAt);
  assert.ok(findHandlerAt >= 0 && findDrainAt > findHandlerAt && findDrainAt < findCapacityAt);
  assert.ok(findCapacityAt < findCapacityMetricAt);

  const rematchHandlerAt = index.indexOf('[C2S.REMATCH_VOTE]:');
  const rematchHandlerDrainAt = index.indexOf('if (operationalState.isDraining())', rematchHandlerAt);
  const rematchMutationAt = index.indexOf("player.resultChoice = 'rematch';", rematchHandlerAt);
  assert.ok(
    rematchHandlerAt >= 0 &&
      rematchHandlerDrainAt > rematchHandlerAt &&
      rematchHandlerDrainAt < rematchMutationAt
  );

  const nextHandlerAt = index.indexOf('[C2S.NEXT_CHAPTER_VOTE]:');
  const nextHandlerDrainAt = index.indexOf('if (operationalState.isDraining())', nextHandlerAt);
  const nextChoiceMutationAt = index.indexOf("player.resultChoice = 'next';", nextHandlerAt);
  const nextVoteMetricAt = index.indexOf("gameplay.count('next_chapter_vote'", nextHandlerAt);
  assert.ok(
    nextHandlerAt >= 0 && nextHandlerDrainAt > nextHandlerAt && nextHandlerDrainAt < nextChoiceMutationAt
  );
  assert.ok(nextChoiceMutationAt < nextVoteMetricAt);

  assert.match(helper, /phase: 'signal-pending'/);
  assert.match(helper, /phase: 'signal-delivered'/);
  assert.match(helper, /phase: 'signal-uncertain'/);
  const advanceAt = helper.indexOf('async function advancePendingRestartSignal');
  const recoveryAt = helper.indexOf('export async function recoverRestartMonitor');
  const recoveryAdvanceAt = helper.indexOf('await advanceSignal(marker, markerPath)', recoveryAt);
  const recoveryMonitorAt = helper.indexOf('scheduleRestartCompletion(marker.oldPid', recoveryAt);
  const completionAt = helper.indexOf('function scheduleRestartCompletion');
  const persistedPendingAt = helper.indexOf("persisted?.phase === 'signal-pending'", completionAt);
  const monitorAdvanceAt = helper.indexOf(
    'await advancePendingRestartSignal(persisted, markerPath)',
    persistedPendingAt
  );
  assert.ok(advanceAt >= 0 && recoveryAdvanceAt > recoveryAt && recoveryAdvanceAt < recoveryMonitorAt);
  assert.ok(completionAt >= 0 && persistedPendingAt > completionAt && monitorAdvanceAt > persistedPendingAt);
  assert.match(helper, /await recoverRestartMonitor\(\);/);

  const drainFnAt = index.indexOf('function beginOperationalDrain()');
  const queueClearAt = index.indexOf('coopMatchmaking.splice(0)', drainFnAt);
  const roomlessClientsAt = index.indexOf('for (const client of wss.clients)', drainFnAt);
  const roomlessShutdownAt = index.indexOf('S2C.SERVER_SHUTDOWN', roomlessClientsAt);
  assert.ok(drainFnAt >= 0 && queueClearAt > drainFnAt && roomlessClientsAt > queueClearAt);
  assert.ok(roomlessShutdownAt > roomlessClientsAt);

  const enqueueAt = index.indexOf('function enqueueCoop(ws, message)');
  const enqueueDrainAt = index.indexOf('if (operationalState.isDraining())', enqueueAt);
  const enqueueLeaveAt = index.indexOf('leave(ws);', enqueueAt);
  assert.ok(enqueueAt >= 0 && enqueueDrainAt > enqueueAt && enqueueDrainAt < enqueueLeaveAt);

  const resultsAt = index.indexOf('function resolveResultsDecision(room');
  const nextChoiceAt = index.indexOf("player.resultChoice === 'next'", resultsAt);
  const nextDrainAt = index.indexOf('if (operationalState.isDraining())', nextChoiceAt);
  const nextMutationAt = index.indexOf('room.chapterId = nextChapterId;', nextChoiceAt);
  assert.ok(nextChoiceAt >= 0 && nextDrainAt > nextChoiceAt && nextDrainAt < nextMutationAt);

  const rematchChoiceAt = index.indexOf("player.resultChoice === 'rematch'", resultsAt);
  const rematchDrainAt = index.indexOf('if (operationalState.isDraining())', rematchChoiceAt);
  const rematchMetricAt = index.indexOf("gameplay.count('pair_continued'", rematchChoiceAt);
  assert.ok(rematchChoiceAt >= 0 && rematchDrainAt > rematchChoiceAt && rematchDrainAt < rematchMetricAt);
});

test('only owner can execute operations and every accepted request is audited', async t => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const adminAuth = new AdminAuthService({ db });
  const calls = [];
  const operations = {
    status: () => ({ available: true, operations: publicOperations() }),
    run: async operation => {
      calls.push(operation);
      return {
        ok: true,
        requestId: 'fake-request-id',
        action: operation,
        accepted: operation === 'wobble.restart',
        durationMs: 12
      };
    }
  };
  const app = express();
  installAdminRoutes({ app, adminAuth, control: {}, operations, enabled: true, secureCookies: false });
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  assert.equal(hasCapability('owner', 'ops.execute'), true);
  assert.equal(hasCapability('operator', 'ops.execute'), false);

  const owner = await login(base, adminAuth, 'owner');
  const status = await post(base, '/api/admin/operations/status', owner, {});
  assert.equal(status.status, 200);
  assert.equal((await status.json()).available, true);

  const missingConfirmation = await post(base, '/api/admin/operations/run', owner, {
    operation: 'backup.create',
    confirmation: 'wrong'
  });
  assert.equal(missingConfirmation.status, 400);
  assert.equal(calls.length, 0);

  const run = await post(base, '/api/admin/operations/run', owner, {
    operation: 'backup.create',
    confirmation: 'backup.create'
  });
  assert.equal(run.status, 200);
  assert.deepEqual(calls, ['backup.create']);

  const audit = adminAuth.recentAudit(20);
  assert.ok(
    audit.some(event => event.action === 'ops.operation.requested' && event.targetId === 'backup.create')
  );
  assert.ok(
    audit.some(event => event.action === 'ops.operation.completed' && event.targetId === 'backup.create')
  );

  const operator = await login(base, adminAuth, 'operator');
  const forbidden = await post(base, '/api/admin/operations/run', operator, {
    operation: 'nginx.reload',
    confirmation: 'nginx.reload'
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(calls, ['backup.create']);
});

test('failed helper calls are returned safely and recorded without raw command output', async t => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const adminAuth = new AdminAuthService({ db });
  const operations = {
    status: () => ({ available: true, operations: publicOperations() }),
    run: async operation => ({
      ok: false,
      action: operation,
      reason: 'operation-failed',
      systemdMessage: 'sensitive implementation detail'
    })
  };
  const app = express();
  installAdminRoutes({ app, adminAuth, control: {}, operations, enabled: true, secureCookies: false });
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const owner = await login(base, adminAuth, 'owner');
  const response = await post(base, '/api/admin/operations/run', owner, {
    operation: 'nginx.reload',
    confirmation: 'nginx.reload'
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'operation-failed');
  assert.equal(JSON.stringify(body).includes('sensitive implementation detail'), false);

  const failed = adminAuth.recentAudit(20).find(event => event.action === 'ops.operation.failed');
  assert.ok(failed);
  assert.equal(JSON.stringify(failed.detail).includes('sensitive implementation detail'), false);
});
