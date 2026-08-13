import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService } = require('./adminAuth');
const { installControlPlaneRoutes } = require('./controlPlaneRoutes');

async function start({ gameClient, operations, alerts, role = 'owner' } = {}) {
  const db = openDatabase(':memory:');
  const adminAuth = new AdminAuthService({ db });
  const created = adminAuth.createUser({ name: role === 'owner' ? 'Owner' : 'Admin', role });
  const app = express();
  installControlPlaneRoutes({
    app,
    adminAuth,
    gameClient: gameClient || {
      status: async () => null,
      adminRequest: async () => ({
        statusCode: 503,
        payload: { ok: false, error: 'game-control-unavailable' }
      })
    },
    infrastructure: { snapshot: async () => ({ services: {}, network: {}, resources: {} }) },
    reliability: { report: async () => ({ status: 'healthy', summary: {} }) },
    operations: operations || {
      status: () => ({ available: true, maintenance: false, operations: [] }),
      run: async () => ({ ok: false, reason: 'operation-failed' })
    },
    alerts: alerts || {
      status: () => ({
        generatedAt: Date.now(),
        lastEvaluatedAt: Date.now(),
        evaluationStale: false,
        storageHealthy: true,
        sources: { infrastructure: true, reliability: true, operations: true },
        counts: { active: 0, critical: 0, warning: 0, unacknowledged: 0 },
        active: [],
        history: []
      }),
      acknowledge: () => ({ ok: false, reason: 'alert-not-active' })
    },
    build: { version: 'test', commit: 'abc' },
    enabled: true,
    secureCookies: false
  });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    server,
    origin,
    accessCode: created.accessCode,
    async close() {
      await new Promise(resolve => server.close(resolve));
      db.close();
    }
  };
}

async function login(ctx) {
  const response = await fetch(`${ctx.origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: ctx.accessCode })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, csrf: body.csrf };
}

async function post(ctx, path, session, body = {}) {
  return fetch(`${ctx.origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-Wobble-Admin-CSRF': session.csrf
    },
    body: JSON.stringify(body)
  });
}

test('game-dependent admin route fails explicitly while local session stays usable', async () => {
  const ctx = await start();
  try {
    const session = await login(ctx);
    const game = await post(ctx, '/api/admin/dashboard', session);
    assert.equal(game.status, 503);
    assert.deepEqual(await game.json(), { ok: false, error: 'game-control-unavailable' });

    const control = await post(ctx, '/api/admin/control/status', session);
    assert.equal(control.status, 200);
    const status = await control.json();
    assert.equal(status.ok, true);
    assert.equal(status.control.ok, true);
    assert.equal(status.game.reachable, false);

    const sessionResponse = await post(ctx, '/api/admin/session', session);
    assert.equal(sessionResponse.status, 200);
  } finally {
    await ctx.close();
  }
});

test('game proxy synthesizes only the admin session cookie', async () => {
  let forwarded = null;
  const ctx = await start({
    gameClient: {
      status: async () => ({ reachable: true, ready: true, ok: true }),
      adminRequest: async (_path, options) => {
        forwarded = options;
        return { statusCode: 200, payload: { ok: true, overview: {} } };
      }
    }
  });
  try {
    const session = await login(ctx);
    const response = await fetch(`${ctx.origin}/api/admin/dashboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${session.cookie}; account_session=must-not-forward`,
        'X-Wobble-Admin-CSRF': session.csrf
      },
      body: '{}'
    });
    assert.equal(response.status, 200);
    assert.match(forwarded.cookie, /^wobble_admin_session=/);
    assert.equal(forwarded.cookie.includes('account_session'), false);
  } finally {
    await ctx.close();
  }
});

test('unknown admin route is never forwarded', async () => {
  let upstreamCalls = 0;
  const ctx = await start({
    gameClient: {
      status: async () => null,
      adminRequest: async () => {
        upstreamCalls += 1;
        return { statusCode: 200, payload: { ok: true } };
      }
    }
  });
  try {
    const session = await login(ctx);
    const response = await post(ctx, '/api/admin/arbitrary-command', session);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, 'admin-route-not-found');
    assert.equal(upstreamCalls, 0);
  } finally {
    await ctx.close();
  }
});

test('operations remain local and do not need gameplay upstream', async () => {
  let runs = 0;
  const operations = {
    status: () => ({
      available: true,
      maintenance: false,
      operations: [{ id: 'backup.create', title: 'Backup' }]
    }),
    run: async operation => {
      runs += 1;
      return { ok: true, accepted: false, operation, durationMs: 12 };
    }
  };
  const ctx = await start({ operations });
  try {
    const session = await login(ctx);
    const status = await post(ctx, '/api/admin/operations/status', session);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).available, true);

    const run = await post(ctx, '/api/admin/operations/run', session, {
      operation: 'backup.create',
      confirmation: 'backup.create'
    });
    assert.equal(run.status, 200);
    assert.equal((await run.json()).ok, true);
    assert.equal(runs, 1);
  } finally {
    await ctx.close();
  }
});

test('missing admin session is 401 rather than gameplay availability error', async () => {
  const ctx = await start();
  try {
    const response = await fetch(`${ctx.origin}/api/admin/dashboard`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'admin-session-required');
  } finally {
    await ctx.close();
  }
});

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

test('Alert Center stays local, owner/operator can acknowledge, and acknowledgement is audited', async () => {
  const alertId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  let acknowledgedBy = null;
  const alert = {
    id: alertId,
    rule: 'disk-pressure',
    severity: 'warning',
    state: 'active',
    openedAt: 1000,
    lastSeenAt: 2000,
    resolvedAt: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    context: { usedPercent: 90 },
    title: 'Мало свободного места на диске',
    description: 'Disk pressure',
    recommendedPanel: 'infrastructure'
  };
  const ctx = await start({
    role: 'operator',
    alerts: {
      status: () => ({
        generatedAt: 2000,
        lastEvaluatedAt: 2000,
        evaluationStale: false,
        storageHealthy: true,
        sources: { infrastructure: true, reliability: true, operations: true },
        counts: { active: 1, critical: 0, warning: 1, unacknowledged: 1 },
        active: [alert],
        history: []
      }),
      acknowledge: (id, actor) => {
        assert.equal(id, alertId);
        acknowledgedBy = actor;
        return {
          ok: true,
          alert: { ...alert, acknowledgedAt: 3000, acknowledgedBy: { name: actor.name, role: actor.role } }
        };
      }
    }
  });
  try {
    const session = await login(ctx);
    const status = await post(ctx, '/api/admin/alerts/status', session);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).alerts.counts.active, 1);

    const ack = await post(ctx, '/api/admin/alerts/acknowledge', session, { alertId });
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).alert.id, alertId);
    assert.equal(acknowledgedBy.role, 'operator');
    const audit = ctx.db
      .prepare(
        "SELECT action, target_id FROM admin_audit_events WHERE action = 'alert.acknowledged' ORDER BY created_at DESC LIMIT 1"
      )
      .get();
    assert.equal(audit.action, 'alert.acknowledged');
    assert.equal(audit.target_id, alertId);
  } finally {
    await ctx.close();
  }
});

test('roles without alerts.read cannot use Alert Center routes', async () => {
  const ctx = await start({ role: 'viewer' });
  try {
    const session = await login(ctx);
    const status = await post(ctx, '/api/admin/alerts/status', session);
    assert.equal(status.status, 403);
    assert.equal((await status.json()).error, 'admin-forbidden');
  } finally {
    await ctx.close();
  }
});

test('Alert Center acknowledgement validates payload and active-state conflicts', async () => {
  const ctx = await start({
    alerts: {
      status: () => ({ counts: {}, active: [], history: [] }),
      acknowledge: id =>
        id === 'ffffffff-ffff-4fff-8fff-ffffffffffff'
          ? { ok: false, reason: 'alert-not-active' }
          : { ok: false, reason: 'invalid-alert-id' }
    }
  });
  try {
    const session = await login(ctx);
    const invalid = await post(ctx, '/api/admin/alerts/acknowledge', session, { alertId: 'bad' });
    assert.equal(invalid.status, 400);
    const inactive = await post(ctx, '/api/admin/alerts/acknowledge', session, {
      alertId: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    });
    assert.equal(inactive.status, 409);
  } finally {
    await ctx.close();
  }
});
