import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { ACTIONS, validateRequest } from '../deploy/wobble-ops-helper.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { installAdminRoutes } = require('./adminRoutes');
const { OPERATION_DEFINITIONS, publicOperations, validOperation } = require('./adminOperationsClient');

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
  assert.equal(validOperation('anything; rm -rf /'), null);

  const allowedUnits = new Set([
    'wobble-backup.service',
    'wobble-backup-verify.service',
    'wobble-smoke.service',
    'wobble.service'
  ]);
  for (const [action, spec] of Object.entries(ACTIONS)) {
    assert.equal(allowedUnits.has(spec.unit), true, `${action} may use only an explicitly approved unit`);
    assert.ok(['start', 'restart'].includes(spec.verb));
    assert.equal(typeof OPERATION_DEFINITIONS[action].description, 'string');
    assert.ok(OPERATION_DEFINITIONS[action].description.length > 20);
  }
  assert.equal(allowedUnits.size, Object.keys(ACTIONS).length);
});

test('helper rejects extra fields and unknown actions before systemctl', () => {
  const requestId = '4d4a51e8-f32b-4f97-8d48-95640ad5084d';
  assert.deepEqual(validateRequest({ requestId, action: 'smoke.run' }), { requestId, action: 'smoke.run' });
  assert.equal(validateRequest({ requestId, action: 'shell.exec' }), null);
  assert.equal(validateRequest({ requestId, action: 'smoke.run', command: 'id' }), null);
  assert.equal(validateRequest({ requestId: 'not-a-uuid', action: 'smoke.run' }), null);
});

test('privileged helper is installed from a root-owned path while app scripts run unprivileged', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const helperUnit = fs.readFileSync(path.join(root, 'deploy/wobble-ops.service'), 'utf8');
  const smokeUnit = fs.readFileSync(path.join(root, 'deploy/wobble-smoke.service'), 'utf8');
  const verifyUnit = fs.readFileSync(path.join(root, 'deploy/wobble-backup-verify.service'), 'utf8');
  const socketUnit = fs.readFileSync(path.join(root, 'deploy/wobble-ops.socket'), 'utf8');

  assert.match(helperUnit, /^User=root$/m);
  assert.match(helperUnit, /ExecStart=\/usr\/bin\/node \/usr\/local\/lib\/wobble-ops\/helper\.mjs/);
  assert.doesNotMatch(helperUnit, /ExecStart=.*\/opt\/wobble/);
  assert.match(smokeUnit, /^User=wobble$/m);
  assert.match(verifyUnit, /^User=wobble$/m);
  assert.match(socketUnit, /^SocketGroup=wobble$/m);
  assert.match(socketUnit, /^SocketMode=0660$/m);
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
    operation: 'smoke.run',
    confirmation: 'smoke.run'
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
    operation: 'smoke.run',
    confirmation: 'smoke.run'
  });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, 'operation-failed');
  assert.equal(JSON.stringify(body).includes('sensitive implementation detail'), false);

  const failed = adminAuth.recentAudit(20).find(event => event.action === 'ops.operation.failed');
  assert.ok(failed);
  assert.equal(JSON.stringify(failed.detail).includes('sensitive implementation detail'), false);
});
