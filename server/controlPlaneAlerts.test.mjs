import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ControlPlaneAlertCenter,
  infrastructureConditions,
  monitoringCondition,
  operationConditions,
  reliabilityConditions
} = require('./controlPlaneAlerts');

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-alerts-'));
  return {
    dir,
    file: path.join(dir, 'alerts.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function healthyInfrastructure(overrides = {}) {
  return {
    publicTarget: { origin: 'https://wobbles.example', hostname: 'wobbles.example', port: 443 },
    services: {
      wobble: { active: true },
      nginx: { active: true }
    },
    resources: { disk: { available: true, usedPercent: 30 } },
    network: { https443: { reachable: true } },
    https: { reachable: true, trusted: true, expired: false, daysRemaining: 60 },
    backup: {
      required: true,
      available: true,
      stale: false,
      ageSeconds: 300,
      maxAgeSeconds: 7200,
      offsite: { required: false, available: false, stale: false }
    },
    game: { reachable: true, ready: true },
    ...overrides
  };
}

function healthyReliability(overrides = {}) {
  return { status: 'healthy', reasons: [], ...overrides };
}

function operationsStatus(overrides = {}) {
  return { activeOperation: null, maintenance: false, ...overrides };
}

function center({ stateFile, infrastructure, reliability, operations, now = () => 1000 } = {}) {
  return new ControlPlaneAlertCenter({
    stateFile,
    infrastructure: infrastructure || { snapshot: async () => healthyInfrastructure() },
    reliability: reliability || { report: async () => healthyReliability() },
    operations: operations || { status: () => operationsStatus() },
    triggerStreak: 2,
    resolveStreak: 2,
    intervalMs: 10_000,
    now
  });
}

test('transient infrastructure failure is debounced, then active alert resolves only after stable recovery', async () => {
  const ctx = tempState();
  let bad = true;
  let now = 10_000;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () =>
        bad
          ? healthyInfrastructure({
              services: { wobble: { active: false }, nginx: { active: true } },
              game: { reachable: false, ready: false }
            })
          : healthyInfrastructure()
    }
  });
  try {
    await alerts.evaluate({ now });
    assert.equal(alerts.status({ now }).counts.active, 0);
    now += 60_000;
    await alerts.evaluate({ now });
    let status = alerts.status({ now });
    assert.equal(status.counts.active, 1);
    assert.equal(status.active[0].rule, 'game-unavailable');
    assert.equal(status.active[0].severity, 'critical');

    bad = false;
    now += 60_000;
    await alerts.evaluate({ now });
    assert.equal(alerts.status({ now }).counts.active, 1);
    now += 60_000;
    await alerts.evaluate({ now });
    status = alerts.status({ now });
    assert.equal(status.counts.active, 0);
    assert.equal(status.history[0].rule, 'game-unavailable');
    assert.equal(status.history[0].state, 'resolved');
  } finally {
    ctx.cleanup();
  }
});

test('expected graceful restart suppresses game-unavailable alert while other infrastructure rules remain evaluated', () => {
  const infra = healthyInfrastructure({
    services: { wobble: { active: false }, nginx: { active: true } },
    game: { reachable: false, ready: false },
    resources: { disk: { available: true, usedPercent: 97 } }
  });
  const conditions = infrastructureConditions(infra, {
    activeOperation: { action: 'wobble.restart', state: 'drain' }
  });
  assert.equal(conditions.has('game-unavailable'), false);
  assert.equal(conditions.get('disk-pressure').active, true);
  assert.equal(conditions.get('disk-pressure').severity, 'critical');
});

test('fixed rules reuse safe backup, TLS, reliability and durable-operation signals', () => {
  const infra = healthyInfrastructure({
    https: { reachable: true, trusted: true, expired: false, daysRemaining: 10 },
    backup: {
      required: true,
      available: false,
      stale: true,
      ageSeconds: 9000,
      maxAgeSeconds: 7200,
      offsite: { required: true, available: false, stale: true }
    }
  });
  const infraRules = infrastructureConditions(infra, operationsStatus());
  assert.equal(infraRules.get('tls-expiring').active, true);
  assert.equal(infraRules.get('tls-expiring').severity, 'warning');
  assert.equal(infraRules.get('backup-stale').active, true);
  assert.equal(infraRules.get('backup-stale').severity, 'critical');

  const reliability = reliabilityConditions({
    status: 'critical',
    reasons: ['internal-errors', 'arbitrary-secret-looking-reason']
  });
  assert.equal(reliability.get('reliability-degraded').active, true);
  assert.deepEqual(reliability.get('reliability-degraded').context.reasons, [
    'internal-errors',
    'arbitrary-secret-looking-reason'
  ]);

  const operation = operationConditions(
    {
      activeOperation: {
        action: 'backup.verify',
        state: 'running',
        updatedAt: 1_000
      }
    },
    1_000 + 6 * 60_000
  );
  assert.equal(operation.get('operation-stuck').active, true);
  assert.equal(operation.get('operation-stuck').context.action, 'backup.verify');
});

test('public reliability alert drops unknown reason codes and acknowledgement survives Control Plane restart', async () => {
  const ctx = tempState();
  let now = 20_000;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    reliability: {
      report: async () => ({
        status: 'warning',
        reasons: ['event-loop-high', 'raw-user-controlled-text']
      })
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    let status = alerts.status({ now });
    assert.equal(status.counts.active, 1);
    assert.deepEqual(status.active[0].context.reasons, ['event-loop-high']);

    const id = status.active[0].id;
    const acknowledged = alerts.acknowledge(id, { name: 'Operator', role: 'operator' }, { now: now + 1 });
    assert.equal(acknowledged.ok, true);
    assert.equal(acknowledged.alert.acknowledgedBy.name, 'Operator');

    const restarted = center({ stateFile: ctx.file, now: () => now + 2 });
    status = restarted.status({ now: now + 2 });
    assert.equal(status.active[0].id, id);
    assert.equal(status.active[0].acknowledgedAt, now + 1);
    assert.deepEqual(status.active[0].acknowledgedBy, { name: 'Operator', role: 'operator' });
  } finally {
    ctx.cleanup();
  }
});

test('source failure never invents a recovery for an already active alert', async () => {
  const ctx = tempState();
  let fail = false;
  let now = 30_000;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () => {
        if (fail) throw new Error('synthetic infrastructure outage');
        return healthyInfrastructure({
          services: { wobble: { active: true }, nginx: { active: false } }
        });
      }
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    assert.equal(
      alerts.status({ now }).active.some(item => item.rule === 'nginx-unavailable'),
      true
    );

    fail = true;
    now += 60_000;
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    const status = alerts.status({ now });
    assert.equal(
      status.active.some(item => item.rule === 'nginx-unavailable'),
      true
    );
    assert.equal(
      status.active.some(item => item.rule === 'monitoring-degraded'),
      true
    );
    assert.equal(status.sources.infrastructure, false);
  } finally {
    ctx.cleanup();
  }
});

test('failed acknowledgement persistence rolls back the in-memory acknowledgement', async () => {
  const ctx = tempState();
  let now = 40_000;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () =>
        healthyInfrastructure({ resources: { disk: { available: true, usedPercent: 90 } } })
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    const before = alerts.status({ now }).active[0];
    assert.equal(before.acknowledgedAt, null);

    fs.rmSync(ctx.dir, { recursive: true, force: true });
    fs.writeFileSync(ctx.dir, 'block-parent-directory');
    const result = alerts.acknowledge(before.id, { name: 'Owner', role: 'owner' }, { now: now + 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'alert-state-unavailable');
    const after = alerts.status({ now: now + 2 }).active[0];
    assert.equal(after.acknowledgedAt, null);
    assert.equal(after.acknowledgedBy, null);
  } finally {
    ctx.cleanup();
  }
});

test('warning acknowledgement is cleared when the same incident escalates to critical', async () => {
  const ctx = tempState();
  let now = 50_000;
  let usedPercent = 90;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () => healthyInfrastructure({ resources: { disk: { available: true, usedPercent } } })
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    let alert = alerts.status({ now }).active.find(item => item.rule === 'disk-pressure');
    assert.equal(alert.severity, 'warning');
    assert.equal(
      alerts.acknowledge(alert.id, { name: 'Operator', role: 'operator' }, { now: now + 1 }).ok,
      true
    );
    assert.equal(alerts.status({ now: now + 2 }).counts.unacknowledged, 0);

    usedPercent = 96;
    now += 60_000;
    await alerts.evaluate({ now });
    alert = alerts.status({ now }).active.find(item => item.rule === 'disk-pressure');
    assert.equal(alert.severity, 'critical');
    assert.equal(alert.acknowledgedAt, null);
    assert.equal(alert.acknowledgedBy, null);
    assert.equal(alerts.status({ now }).counts.unacknowledged, 1);
  } finally {
    ctx.cleanup();
  }
});

test('failed lifecycle persistence rolls back a resolution instead of hiding an active alert in RAM', async () => {
  const ctx = tempState();
  let now = 60_000;
  let nginxActive = false;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () =>
        healthyInfrastructure({ services: { wobble: { active: true }, nginx: { active: nginxActive } } })
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    assert.equal(
      alerts.status({ now }).active.some(item => item.rule === 'nginx-unavailable'),
      true
    );

    nginxActive = true;
    now += 60_000;
    await alerts.evaluate({ now });
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    fs.writeFileSync(ctx.dir, 'block-parent-directory');
    now += 60_000;
    await alerts.evaluate({ now });
    const status = alerts.status({ now });
    assert.equal(status.storageHealthy, false);
    assert.equal(
      status.active.some(item => item.rule === 'nginx-unavailable'),
      true
    );
    assert.equal(
      status.history.some(item => item.rule === 'nginx-unavailable'),
      false
    );
  } finally {
    ctx.cleanup();
  }
});

test('monitoring and recovery tooling blind spots become debounced operator alerts', () => {
  const monitoring = monitoringCondition({ infrastructure: true, reliability: false, operations: false });
  assert.equal(monitoring.active, true);
  assert.equal(monitoring.severity, 'warning');
  assert.deepEqual(monitoring.context.unavailable, ['reliability', 'operations']);
  const critical = monitoringCondition({ infrastructure: false, reliability: true, operations: true });
  assert.equal(critical.severity, 'critical');

  const operations = operationConditions({ available: false, activeOperation: null }, 1000);
  assert.equal(operations.get('operations-unavailable').active, true);
  assert.equal(operations.get('operations-unavailable').severity, 'warning');
});
