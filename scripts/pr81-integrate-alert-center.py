from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:180]!r}")
    path.write_text(text.replace(old, new, 1))


alerts = Path('server/controlPlaneAlerts.js')
replace_once(
    alerts,
    "const DEFAULT_STATE_FILE = '/var/lib/wobble/control-alerts.json';",
    "const DEFAULT_STATE_FILE = '/var/lib/wobble-control/alerts.json';",
)
replace_once(
    alerts,
    """    alert.acknowledgedAt = Math.max(alert.openedAt, at);
    alert.acknowledgedBy = normalizeActor(actor);
    if (!this._persist()) return { ok: false, reason: 'alert-state-unavailable' };
    return { ok: true, alert: publicRecord(alert) };
""",
    """    const previousAt = alert.acknowledgedAt;
    const previousBy = alert.acknowledgedBy;
    alert.acknowledgedAt = Math.max(alert.openedAt, at);
    alert.acknowledgedBy = normalizeActor(actor);
    if (!this._persist()) {
      // A failed durable write must not leave an acknowledgement visible only in RAM.
      alert.acknowledgedAt = previousAt;
      alert.acknowledgedBy = previousBy;
      return { ok: false, reason: 'alert-state-unavailable' };
    }
    return { ok: true, alert: publicRecord(alert) };
""",
)

docs = Path('docs/ALERT-CENTER.md')
replace_once(
    docs,
    '/var/lib/wobble/control-alerts.json',
    '/var/lib/wobble-control/alerts.json',
)
replace_once(
    docs,
    'Файл пишет только `wobble-control.service`. Запись атомарная',
    'Каталог создаётся systemd через `StateDirectory=wobble-control`; файл пишет только `wobble-control.service`. Запись атомарная',
)

control = Path('server/controlPlane.js')
replace_once(
    control,
    "const { ControlPlaneInfrastructure } = require('./controlPlaneInfrastructure');\n",
    "const { ControlPlaneAlertCenter } = require('./controlPlaneAlerts');\nconst { ControlPlaneInfrastructure } = require('./controlPlaneInfrastructure');\n",
)
replace_once(
    control,
    """const reliability = createServiceReliabilityReader({
  db,
  liveHealth: () => gameClient.status()
});
const build = buildIdentity();
""",
    """const reliability = createServiceReliabilityReader({
  db,
  liveHealth: () => gameClient.status()
});
const alerts = new ControlPlaneAlertCenter({ infrastructure, reliability, operations });
const build = buildIdentity();
""",
)
replace_once(
    control,
    """  reliability,
  operations,
  build,
""",
    """  reliability,
  operations,
  alerts,
  build,
""",
)
replace_once(
    control,
    """const server = app.listen(port, host, () => {
  console.log(
""",
    """const server = app.listen(port, host, () => {
  alerts.start();
  console.log(
""",
)
replace_once(
    control,
    """function shutdown(signal) {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(1), 5000);
""",
    """function shutdown(signal) {
  if (closing) return;
  closing = true;
  alerts.stop();
  const timer = setTimeout(() => process.exit(1), 5000);
""",
)

auth = Path('server/adminAuth.js')
replace_once(
    auth,
    """    'reliability.read',
    'analytics.read',
""",
    """    'reliability.read',
    'alerts.read',
    'alerts.ack',
    'analytics.read',
""",
)
# Same sequence appears once more in operator capabilities.
replace_once(
    auth,
    """    'reliability.read',
    'analytics.read',
""",
    """    'reliability.read',
    'alerts.read',
    'alerts.ack',
    'analytics.read',
""",
)

routes = Path('server/controlPlaneRoutes.js')
replace_once(
    routes,
    """  reliability,
  operations,
  build,
""",
    """  reliability,
  operations,
  alerts,
  build,
""",
)
insert_anchor = """  app.post('/api/admin/operations/status', json, (req, res) => {
"""
alert_routes = """  app.post('/api/admin/alerts/status', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'alerts.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!alerts || typeof alerts.status !== 'function') {
      return res.status(503).json({ ok: false, error: 'alerts-unavailable' });
    }
    try {
      return res.json({ ok: true, alerts: alerts.status() });
    } catch {
      return res.status(503).json({ ok: false, error: 'alerts-unavailable' });
    }
  });

  app.post('/api/admin/alerts/acknowledge', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'alerts.ack');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['alertId']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!alerts || typeof alerts.acknowledge !== 'function') {
      return res.status(503).json({ ok: false, error: 'alerts-unavailable' });
    }
    let result;
    try {
      result = alerts.acknowledge(req.body?.alertId, resolved.session.user);
    } catch {
      result = { ok: false, reason: 'alert-state-unavailable' };
    }
    if (!result?.ok) {
      const reason = String(result?.reason || 'alert-state-unavailable');
      const status = reason === 'invalid-alert-id' ? 400 : reason === 'alert-not-active' ? 409 : 503;
      const error = ['invalid-alert-id', 'alert-not-active', 'alert-state-unavailable'].includes(reason)
        ? reason
        : 'alert-state-unavailable';
      return res.status(status).json({ ok: false, error });
    }
    try {
      adminAuth.audit({
        actor: resolved.session.user,
        action: 'alert.acknowledged',
        targetType: 'alert',
        targetId: result.alert.id,
        detail: { rule: result.alert.rule, severity: result.alert.severity }
      });
    } catch {
      // The durable acknowledgement already succeeded. Audit failure must not create a false retry.
    }
    return res.json({ ok: true, alert: result.alert });
  });

"""
replace_once(routes, insert_anchor, alert_routes + insert_anchor)

route_tests = Path('server/controlPlaneRoutes.test.mjs')
replace_once(
    route_tests,
    "async function start({ gameClient, operations } = {}) {",
    "async function start({ gameClient, operations, alerts, role = 'owner' } = {}) {",
)
replace_once(
    route_tests,
    "const created = adminAuth.createUser({ name: 'Owner', role: 'owner' });",
    "const created = adminAuth.createUser({ name: role === 'owner' ? 'Owner' : 'Admin', role });",
)
replace_once(
    route_tests,
    """    operations: operations || {
      status: () => ({ available: true, maintenance: false, operations: [] }),
      run: async () => ({ ok: false, reason: 'operation-failed' })
    },
    build: { version: 'test', commit: 'abc' },
""",
    """    operations: operations || {
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
""",
)
route_tests.write_text(
    route_tests.read_text()
    + r'''

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
    const audit = ctx.db.prepare(
      "SELECT action, target_id FROM admin_audit_events WHERE action = 'alert.acknowledged' ORDER BY created_at DESC LIMIT 1"
    ).get();
    assert.deepEqual(audit, { action: 'alert.acknowledged', target_id: alertId });
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
'''
)

control_tests = Path('server/adminControlPlane.test.mjs')
replace_once(
    control_tests,
    """  assert.equal(hasCapability(login.user.role, 'ops.execute'), true);
  assert.equal(auth.verifyCsrf(login, login.csrf), true);
""",
    """  assert.equal(hasCapability(login.user.role, 'ops.execute'), true);
  assert.equal(hasCapability('owner', 'alerts.read'), true);
  assert.equal(hasCapability('owner', 'alerts.ack'), true);
  assert.equal(hasCapability('operator', 'alerts.read'), true);
  assert.equal(hasCapability('operator', 'alerts.ack'), true);
  assert.equal(hasCapability('moderator', 'alerts.read'), false);
  assert.equal(hasCapability('viewer', 'alerts.ack'), false);
  assert.equal(auth.verifyCsrf(login, login.csrf), true);
""",
)

alert_tests = Path('server/controlPlaneAlerts.test.mjs')
alert_tests.write_text(
    alert_tests.read_text()
    + r'''

test('failed acknowledgement persistence rolls back the in-memory acknowledgement', async () => {
  const ctx = tempState();
  let now = 40_000;
  const alerts = center({
    stateFile: ctx.file,
    now: () => now,
    infrastructure: {
      snapshot: async () => healthyInfrastructure({ resources: { disk: { available: true, usedPercent: 90 } } })
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
'''
)

package = Path('package.json')
replace_once(
    package,
    'server/serviceReliabilityReader.test.mjs server/controlPlaneDeploy.test.mjs',
    'server/serviceReliabilityReader.test.mjs server/controlPlaneAlerts.test.mjs server/controlPlaneDeploy.test.mjs',
)

deploy_test = Path('server/controlPlaneDeploy.test.mjs')
replace_once(
    deploy_test,
    """    'server/serviceReliabilityReader.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
""",
    """    'server/serviceReliabilityReader.test.mjs',
    'server/controlPlaneAlerts.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
""",
)
deploy_test.write_text(
    deploy_test.read_text()
    + r'''

test('Control Plane owns a separate persistent Alert Center state directory and lifecycle', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(unit, /^StateDirectory=wobble-control$/m);
  assert.match(unit, /^StateDirectoryMode=0750$/m);
  assert.match(unit, /^Environment=CONTROL_ALERT_STATE=\/var\/lib\/wobble-control\/alerts\.json$/m);
  assert.match(control, /new ControlPlaneAlertCenter\(\{ infrastructure, reliability, operations \}\)/);
  assert.match(control, /alerts\.start\(\);/);
  assert.match(control, /alerts\.stop\(\);/);
});
'''
)

service = Path('deploy/wobble-control.service')
replace_once(
    service,
    """EnvironmentFile=/etc/wobble.env
Environment=CONTROL_PORT=3001

Restart=always
""",
    """EnvironmentFile=/etc/wobble.env
Environment=CONTROL_PORT=3001
Environment=CONTROL_ALERT_STATE=/var/lib/wobble-control/alerts.json
StateDirectory=wobble-control
StateDirectoryMode=0750

Restart=always
""",
)
replace_once(
    service,
    """# The process reads the gameplay SQLite database and creates low-frequency admin session/audit writes.
# It must never write application code or arbitrary system paths.
ReadWritePaths=/var/lib/wobble
""",
    """# The process reads the gameplay SQLite database and creates low-frequency admin session/audit writes.
# Alert state lives in the systemd-owned StateDirectory above; no second gameplay DB writer is added.
# It must never write application code or arbitrary system paths.
ReadWritePaths=/var/lib/wobble
""",
)

index = Path('client/admin/index.html')
replace_once(
    index,
    """    <script src="/admin/admin.js" defer></script>
    <script src="/admin/reliability.js" defer></script>
""",
    """    <script src="/admin/admin.js" defer></script>
    <script src="/admin/reliability.js" defer></script>
    <script src="/admin/alerts.js" defer></script>
""",
)

admin = Path('client/admin/admin.js')
replace_once(
    admin,
    """  'ops.operation.accepted': 'Принят запрос на перезапуск Wobble',
  'ops.operation.failed': 'Системная операция завершилась ошибкой'
""",
    """  'ops.operation.accepted': 'Принят запрос на перезапуск Wobble',
  'ops.operation.failed': 'Системная операция завершилась ошибкой',
  'alert.acknowledged': 'Оператор увидел production-оповещение'
""",
)
