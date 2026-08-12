import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { ServiceReliability } = require('./serviceReliability');
const { structuredReliabilityEvent } = require('./reliabilityCapture');
const { installAdminReliabilityRoutes } = require('./adminReliabilityRoutes');
const { hasCapability } = require('./adminAuth');

function healthState() {
  return {
    version: '2.6.0',
    commit: 'abcdef012345',
    release: 'v2.6.0-beta.2',
    load: { eventLoopP95Ms: 20, rssMb: 100, heapUsedMb: 40 },
    capacity: { socketCount: 2, activeMatches: 1 },
    matchmaking: { waiting: 0 },
    metrics: {
      resumeSucceeded: 0,
      resumeFailed: 0,
      handlerErrors: 0,
      socketSendFailures: 0,
      capacityRejected: 0,
      snapshotsSkippedForLoad: 0
    }
  };
}

async function start(app) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('reliability stores metric deltas, groups errors and keeps build identity', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const health = healthState();
  let now = 1_000_000;
  const reliability = new ServiceReliability({ db, health: () => health, now: () => now });

  assert.equal(reliability.sample(), true); // counter baseline only
  health.metrics.resumeSucceeded = 8;
  health.metrics.resumeFailed = 2;
  health.metrics.handlerErrors = 1;
  health.metrics.socketSendFailures = 3;
  health.metrics.capacityRejected = 1;
  health.metrics.snapshotsSkippedForLoad = 5;
  health.load.eventLoopP95Ms = 135;
  health.load.rssMb = 180;
  health.capacity.socketCount = 25;
  now += 60_000;
  assert.equal(reliability.sample(), true);

  assert.equal(
    reliability.recordEvent({
      event: 'message_handler_threw',
      severity: 'error',
      fingerprint: '0123456789abcdef01234567',
      occurredAt: now + 1
    }),
    true
  );
  assert.equal(
    reliability.recordEvent({
      event: 'message_handler_threw',
      severity: 'error',
      fingerprint: '0123456789abcdef01234567',
      occurredAt: now + 2
    }),
    true
  );
  reliability.recordEvent({ event: 'server_started', severity: 'info', occurredAt: now + 3 });

  const report = reliability.report({ period: '1h', now: now + 10 });
  assert.equal(report.build.release, 'v2.6.0-beta.2');
  assert.equal(report.summary.reconnectSucceeded, 8);
  assert.equal(report.summary.reconnectFailed, 2);
  assert.equal(report.summary.reconnectSuccessPercent, 80);
  assert.equal(report.summary.handlerErrors, 1);
  assert.equal(report.summary.socketSendFailures, 3);
  assert.equal(report.summary.capacityRejected, 1);
  assert.equal(report.summary.eventLoopP95MsMax, 135);
  assert.equal(report.summary.rssMbMax, 180);
  assert.equal(report.summary.socketsMax, 25);
  assert.equal(report.status, 'critical');
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].occurrences, 2);
  assert.equal(report.errors[0].fingerprint, '0123456789abcdef01234567');
  assert.equal(report.errors[0].build.commit, 'abcdef012345');
  assert.equal(report.lifecycle.length, 1);
  assert.equal(report.lifecycle[0].event, 'server_started');
  assert.ok(report.series.length >= 1);
  db.close();
});

test('structured log capture emits only an allowlisted sanitized fingerprint', () => {
  const raw = JSON.stringify({
    level: 'error',
    event: 'message_handler_threw',
    playerId: 'private-player-id',
    roomId: 'PRIVATE-ROOM',
    message: 'token=WAS.super-secret-value account=private-player-id',
    stack: 'Error: token=WAS.super-secret-value\n    at handler (/opt/wobble/server/index.js:1234:56)',
    ts: '2026-08-13T00:00:00.000Z'
  });
  const captured = structuredReliabilityEvent(raw, 'error', 1);
  assert.deepEqual(Object.keys(captured).sort(), ['event', 'fingerprint', 'occurredAt', 'severity']);
  assert.equal(captured.event, 'message_handler_threw');
  assert.equal(captured.severity, 'error');
  assert.match(captured.fingerprint, /^[0-9a-f]{24}$/);
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes('super-secret-value'), false);
  assert.equal(serialized.includes('private-player-id'), false);
  assert.equal(serialized.includes('/opt/wobble'), false);
  assert.equal(structuredReliabilityEvent(JSON.stringify({ event: 'arbitrary_user_log' })), null);
});

test('reliability retention removes samples and events older than the bounded window', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const health = healthState();
  let now = 40 * 24 * 60 * 60 * 1000;
  const reliability = new ServiceReliability({
    db,
    health: () => health,
    now: () => now,
    retentionDays: 30
  });
  reliability.sample({ now: 1_000 });
  reliability.recordEvent({ event: 'socket_send_failed', severity: 'warn', occurredAt: 2_000 });
  reliability.prune(now, { force: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM service_reliability_samples').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM service_reliability_events').get().count, 0);
  db.close();
});

test('reliability capability is restricted to owner and operator', () => {
  assert.equal(hasCapability('owner', 'reliability.read'), true);
  assert.equal(hasCapability('operator', 'reliability.read'), true);
  for (const role of ['moderator', 'analyst', 'viewer']) {
    assert.equal(hasCapability(role, 'reliability.read'), false, role);
  }
});

test('admin reliability route requires the dedicated capability and rejects extra payload fields', async t => {
  const app = express();
  let requiredCapability = null;
  installAdminReliabilityRoutes({
    app,
    requireAdmin(req, res, capability) {
      requiredCapability = capability;
      if (req.headers['x-test-role'] !== 'owner') {
        res.status(403).json({ ok: false, error: 'admin-forbidden' });
        return null;
      }
      return { session: { user: { id: 'admin', name: 'Owner', role: 'owner' } } };
    },
    reliability: {
      report({ period }) {
        return { period, status: 'healthy', errors: [], lifecycle: [], series: [], summary: {} };
      }
    }
  });
  const { server, base } = await start(app);
  t.after(() => new Promise(resolve => server.close(resolve)));

  let response = await fetch(`${base}/api/admin/reliability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'viewer' },
    body: JSON.stringify({ period: '24h' })
  });
  assert.equal(response.status, 403);
  assert.equal(requiredCapability, 'reliability.read');

  response = await fetch(`${base}/api/admin/reliability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'owner' },
    body: JSON.stringify({ period: '7d', rawLogs: true })
  });
  assert.equal(response.status, 400);

  response = await fetch(`${base}/api/admin/reliability`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Role': 'owner' },
    body: JSON.stringify({ period: '7d' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.reliability.period, '7d');
});
