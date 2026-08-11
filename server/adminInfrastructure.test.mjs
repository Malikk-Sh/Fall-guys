import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { AdminInfrastructure, parseSystemdShow, publicTarget } = require('./adminInfrastructure');
const { installAdminRoutes } = require('./adminRoutes');

async function start(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function login(base, adminAuth, role) {
  const created = adminAuth.createUser({ name: `${role} infra test`, role, now: 1000 });
  assert.equal(created.ok, true);
  const response = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode: created.accessCode })
  });
  assert.equal(response.status, 200);
  return {
    payload: await response.json(),
    cookie: response.headers.get('set-cookie').split(';', 1)[0]
  };
}

function post(base, route, loginState, body = {}) {
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

test('systemd parser and public target expose only structured operational fields', () => {
  assert.deepEqual(
    parseSystemdShow('ActiveState=active\nSubState=running\nUnitFileState=enabled\n'),
    {
      found: true,
      active: true,
      activeState: 'active',
      subState: 'running',
      unitFileState: 'enabled'
    }
  );
  assert.deepEqual(publicTarget({ ALLOWED_ORIGINS: 'https://wobbles.ru' }), {
    origin: 'https://wobbles.ru',
    hostname: 'wobbles.ru',
    port: 443
  });
  assert.deepEqual(publicTarget({ ALLOWED_ORIGINS: 'not-a-url,http://localhost:3000' }), {
    origin: null,
    hostname: null,
    port: 443
  });
});

test('infrastructure snapshot combines service, TLS, resource and backup health without secrets', async () => {
  const calls = [];
  const infrastructure = new AdminInfrastructure({
    env: {
      ALLOWED_ORIGINS: 'https://wobbles.ru',
      PORT: '3000',
      LEADERBOARD_DB: '/var/lib/wobble/leaderboard.db'
    },
    health: () => ({
      ok: true,
      version: '2.6.0',
      commit: 'abcdef1',
      release: null,
      uptime: 900,
      load: { eventLoopP95Ms: 2.5, rssMb: 70, overloaded: false },
      capacity: { socketCount: 3, activeMatches: 1, maxSockets: 2000, maxMatches: 300 },
      backup: {
        required: true,
        available: true,
        stale: false,
        ageSeconds: 300,
        lastSuccessAt: '2026-08-11T20:00:00.000Z',
        offsite: { configured: false, required: false, available: false, stale: false }
      }
    }),
    systemdUnit: async unit => {
      calls.push(unit);
      return {
        found: true,
        active: unit !== 'certbot.timer',
        activeState: unit === 'certbot.timer' ? 'inactive' : 'active',
        subState: unit.endsWith('.timer') ? 'waiting' : 'running',
        unitFileState: 'enabled'
      };
    },
    probeTcp: async ({ port }) => ({ reachable: port !== 80, latencyMs: port !== 80 ? 3 : null }),
    probeTls: async ({ servername }) => ({
      reachable: true,
      trusted: true,
      authorizationError: null,
      latencyMs: 4,
      validFrom: '2026-07-01T00:00:00.000Z',
      validTo: '2026-09-29T00:00:00.000Z',
      daysRemaining: 48,
      expired: false,
      testedServername: servername
    }),
    statfs: () => ({ bsize: 4096, blocks: 1_000_000, bavail: 400_000 }),
    system: {
      totalmem: () => 8 * 1024 ** 3,
      freemem: () => 3 * 1024 ** 3,
      uptime: () => 123_456,
      loadavg: () => [0.2, 0.3, 0.4]
    }
  });

  const snapshot = await infrastructure.snapshot({ now: Date.parse('2026-08-11T20:30:00Z') });
  assert.deepEqual(calls.sort(), [
    'certbot.timer',
    'nginx.service',
    'wobble-backup-watch.timer',
    'wobble-backup.timer',
    'wobble-ops.socket',
    'wobble.service'
  ]);
  assert.equal(snapshot.publicTarget.hostname, 'wobbles.ru');
  assert.equal(snapshot.services.wobble.active, true);
  assert.equal(snapshot.services.certbotTimer.active, false);
  assert.equal(snapshot.network.http80.reachable, false);
  assert.equal(snapshot.network.https443.reachable, true);
  assert.equal(snapshot.network.nodeLocal.port, 3000);
  assert.equal(snapshot.https.trusted, true);
  assert.equal(snapshot.resources.memory.usedPercent, 62.5);
  assert.equal(snapshot.resources.disk.usedPercent, 60);
  assert.equal(snapshot.backup.stale, false);
  assert.equal(JSON.stringify(snapshot).includes('WADMIN.'), false);
  assert.equal(JSON.stringify(snapshot).includes('token_hash'), false);
  assert.equal(JSON.stringify(snapshot).includes('secret_hash'), false);
});

test('infrastructure endpoint is read-only and limited to owner/operator', async t => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const adminAuth = new AdminAuthService({ db });
  const calls = [];
  const infrastructure = {
    snapshot: async () => {
      calls.push('snapshot');
      return { generatedAt: 'now', services: {}, resources: {}, network: {}, https: {}, backup: null, game: {} };
    }
  };
  const app = express();
  installAdminRoutes({
    app,
    adminAuth,
    control: {},
    infrastructure,
    enabled: true,
    secureCookies: false
  });
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  assert.equal(hasCapability('owner', 'infrastructure.read'), true);
  assert.equal(hasCapability('operator', 'infrastructure.read'), true);
  assert.equal(hasCapability('moderator', 'infrastructure.read'), false);
  assert.equal(hasCapability('analyst', 'infrastructure.read'), false);

  const owner = await login(base, adminAuth, 'owner');
  const ownerResponse = await post(base, '/api/admin/infrastructure', owner);
  assert.equal(ownerResponse.status, 200);
  assert.equal((await ownerResponse.json()).ok, true);

  const operator = await login(base, adminAuth, 'operator');
  assert.equal((await post(base, '/api/admin/infrastructure', operator)).status, 200);

  const moderator = await login(base, adminAuth, 'moderator');
  assert.equal((await post(base, '/api/admin/infrastructure', moderator)).status, 403);
  assert.deepEqual(calls, ['snapshot', 'snapshot']);
});
