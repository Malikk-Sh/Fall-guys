import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService } = require('./adminAuth');
const { installControlPlaneRoutes } = require('./controlPlaneRoutes');

async function start({ gameClient, operations } = {}) {
  const db = openDatabase(':memory:');
  const adminAuth = new AdminAuthService({ db });
  const created = adminAuth.createUser({ name: 'Owner', role: 'owner' });
  const app = express();
  installControlPlaneRoutes({
    app,
    adminAuth,
    gameClient:
      gameClient ||
      ({
        health: async () => null,
        adminRequest: async () => ({
          statusCode: 503,
          payload: { ok: false, error: 'game-control-unavailable' }
        })
      }),
    infrastructure: { snapshot: async () => ({ services: {}, network: {}, resources: {} }) },
    reliability: { report: async () => ({ status: 'healthy', summary: {} }) },
    operations:
      operations ||
      ({
        status: () => ({ available: true, maintenance: false, operations: [] }),
        run: async () => ({ ok: false, reason: 'operation-failed' })
      }),
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

test('unknown admin route is never forwarded', async () => {
  let upstreamCalls = 0;
  const ctx = await start({
    gameClient: {
      health: async () => null,
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
