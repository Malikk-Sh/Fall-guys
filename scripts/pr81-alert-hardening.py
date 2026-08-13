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
    """  'operation-stuck': Object.freeze({
    title: 'Системная операция выполняется слишком долго',
    description: 'Durable Operation не меняла состояние больше пяти минут.',
    recommendedPanel: 'operations'
  })
""",
    """  'operation-stuck': Object.freeze({
    title: 'Системная операция выполняется слишком долго',
    description: 'Durable Operation не меняла состояние больше пяти минут.',
    recommendedPanel: 'operations'
  }),
  'operations-unavailable': Object.freeze({
    title: 'Безопасные системные операции недоступны',
    description: 'Control Plane не видит allowlisted root-helper socket и не сможет выполнить recovery action.',
    recommendedPanel: 'operations'
  }),
  'monitoring-degraded': Object.freeze({
    title: 'Один из источников мониторинга недоступен',
    description: 'Alert Center временно не может подтвердить состояние всех своих локальных источников.',
    recommendedPanel: 'infrastructure'
  })
""",
)
replace_once(
    alerts,
    """  if (rule === 'operation-stuck') {
    return {
      action: String(source.action || '').slice(0, 80),
      state: String(source.state || '').slice(0, 40),
      ageSeconds:
        Number.isFinite(Number(source.ageSeconds)) && Number(source.ageSeconds) >= 0
          ? Math.round(Number(source.ageSeconds))
          : null
    };
  }
""",
    """  if (rule === 'operation-stuck') {
    return {
      action: String(source.action || '').slice(0, 80),
      state: String(source.state || '').slice(0, 40),
      ageSeconds:
        Number.isFinite(Number(source.ageSeconds)) && Number(source.ageSeconds) >= 0
          ? Math.round(Number(source.ageSeconds))
          : null
    };
  }
  if (rule === 'operations-unavailable') return { available: Boolean(source.available) };
  if (rule === 'monitoring-degraded') {
    const allowed = new Set(['infrastructure', 'reliability', 'operations']);
    return {
      unavailable: Array.isArray(source.unavailable)
        ? [...new Set(source.unavailable.map(String).filter(item => allowed.has(item)))].slice(0, 3)
        : []
    };
  }
""",
)
replace_once(
    alerts,
    """function operationConditions(operations, now) {
  const result = new Map();
  const current = operations?.activeOperation;
""",
    """function operationConditions(operations, now) {
  const result = new Map();
  result.set(
    'operations-unavailable',
    condition(operations?.available === false, 'warning', { available: operations?.available })
  );
  const current = operations?.activeOperation;
""",
)
replace_once(
    alerts,
    """function publicRecord(record) {
""",
    """function monitoringCondition(sources) {
  const unavailable = Object.entries(sources || {})
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .filter(name => ['infrastructure', 'reliability', 'operations'].includes(name));
  return condition(
    unavailable.length > 0,
    unavailable.includes('infrastructure') ? 'critical' : 'warning',
    { unavailable }
  );
}

function publicRecord(record) {
""",
)
replace_once(
    alerts,
    """  _persist() {
    const active = this.alerts.filter(item => item.state === 'active');
    const resolved = this.alerts
      .filter(item => item.state === 'resolved')
      .sort((a, b) => (b.resolvedAt || b.lastSeenAt) - (a.resolvedAt || a.lastSeenAt));
    this.alerts = [...active, ...resolved.slice(0, Math.max(0, HISTORY_LIMIT - active.length))].sort(
      (a, b) => a.openedAt - b.openedAt
    );
    const ok = writeState(this.stateFile, this.alerts);
    this.storageHealthy = ok;
    return ok;
  }

  _apply(conditions, now) {
    let changed = false;
""",
    """  _persist() {
    const active = this.alerts.filter(item => item.state === 'active');
    const resolved = this.alerts
      .filter(item => item.state === 'resolved')
      .sort((a, b) => (b.resolvedAt || b.lastSeenAt) - (a.resolvedAt || a.lastSeenAt));
    const candidate = [...active, ...resolved.slice(0, Math.max(0, HISTORY_LIMIT - active.length))].sort(
      (a, b) => a.openedAt - b.openedAt
    );
    const ok = writeState(this.stateFile, candidate);
    this.storageHealthy = ok;
    if (ok) this.alerts = candidate;
    return ok;
  }

  _apply(conditions, now) {
    const before = this.alerts.map(item => ({
      ...item,
      acknowledgedBy: item.acknowledgedBy ? { ...item.acknowledgedBy } : null,
      context: item.context ? JSON.parse(JSON.stringify(item.context)) : {}
    }));
    let changed = false;
""",
)
replace_once(
    alerts,
    """        if (current) {
          const context = safeContext(rule, observed.context);
          if (
            current.severity !== observed.severity ||
            JSON.stringify(current.context) !== JSON.stringify(context) ||
            current.lastSeenAt !== now
          ) {
            current.severity = SEVERITIES.has(observed.severity) ? observed.severity : current.severity;
            current.context = context;
            current.lastSeenAt = Math.max(current.lastSeenAt, now);
            changed = true;
          }
""",
    """        if (current) {
          const context = safeContext(rule, observed.context);
          const nextSeverity = SEVERITIES.has(observed.severity) ? observed.severity : current.severity;
          const escalated = current.severity === 'warning' && nextSeverity === 'critical';
          if (
            current.severity !== nextSeverity ||
            JSON.stringify(current.context) !== JSON.stringify(context) ||
            current.lastSeenAt !== now
          ) {
            current.severity = nextSeverity;
            current.context = context;
            current.lastSeenAt = Math.max(current.lastSeenAt, now);
            if (escalated) {
              // Acknowledging a warning must not silently acknowledge a later critical escalation.
              current.acknowledgedAt = null;
              current.acknowledgedBy = null;
            }
            changed = true;
          }
""",
)
replace_once(
    alerts,
    """    if (changed) this._persist();
    return changed;
  }
""",
    """    if (changed && !this._persist()) {
      // Never expose an active/resolved/ack lifecycle transition that exists only in RAM.
      this.alerts = before;
      return false;
    }
    return changed;
  }
""",
)
replace_once(
    alerts,
    """      if (operationsOk) {
        for (const [rule, value] of operationConditions(operations, at)) conditions.set(rule, value);
      }
      this._apply(conditions, at);
""",
    """      if (operationsOk) {
        for (const [rule, value] of operationConditions(operations, at)) conditions.set(rule, value);
      }
      conditions.set('monitoring-degraded', monitoringCondition(this.sources));
      this._apply(conditions, at);
""",
)
replace_once(
    alerts,
    """  operationConditions,
  reliabilityConditions
};
""",
    """  monitoringCondition,
  operationConditions,
  reliabilityConditions
};
""",
)

ui = Path('client/admin/alerts.js')
replace_once(
    ui,
    """      case 'operation-stuck':
        return `${context.action || 'operation'} · ${context.state || 'unknown'} · без изменения ${formatDurationSeconds(context.ageSeconds)}`;
      default:
""",
    """      case 'operation-stuck':
        return `${context.action || 'operation'} · ${context.state || 'unknown'} · без изменения ${formatDurationSeconds(context.ageSeconds)}`;
      case 'operations-unavailable':
        return context.available ? 'Helper доступен' : 'Allowlisted root-helper socket недоступен';
      case 'monitoring-degraded':
        return context.unavailable?.length
          ? `Недоступны: ${context.unavailable.join(' · ')}`
          : 'Источник мониторинга недоступен';
      default:
""",
)
replace_once(
    ui,
    """    const unacknowledged = Number(data?.counts?.unacknowledged || 0);
    tab.textContent = unacknowledged > 0 ? `Оповещения · ${unacknowledged}` : 'Оповещения';
    tab.title = unacknowledged > 0 ? `Непросмотренных: ${unacknowledged}` : 'Нет непросмотренных оповещений';
""",
    """    const unacknowledged = Number(data?.counts?.unacknowledged || 0);
    const storageError = data && data.storageHealthy === false;
    tab.textContent = storageError
      ? `Оповещения · ${unacknowledged > 0 ? `${unacknowledged} ` : ''}!`
      : unacknowledged > 0
        ? `Оповещения · ${unacknowledged}`
        : 'Оповещения';
    tab.title = storageError
      ? 'Alert Center не может надёжно сохранить своё состояние'
      : unacknowledged > 0
        ? `Непросмотренных: ${unacknowledged}`
        : 'Нет непросмотренных оповещений';
""",
)

docs = Path('docs/ALERT-CENTER.md')
replace_once(
    docs,
    """- Durable Operation не меняла состояние больше пяти минут.
""",
    """- Durable Operation не меняла состояние больше пяти минут;
- allowlisted Operations helper недоступен;
- один из источников Alert Center (Infrastructure / Reliability / Operations) недоступен устойчиво.
""",
)
replace_once(
    docs,
    """Acknowledgement:

- не скрывает проблему;
""",
    """Acknowledgement:

- сбрасывается при escalation `warning → critical`, чтобы ухудшение снова стало непросмотренным;
- не скрывает проблему;
""",
)
replace_once(
    docs,
    """- Ошибка evaluator не меняет gameplay/API semantics.
""",
    """- Ошибка evaluator не меняет gameplay/API semantics.
- Failed write не может оставить lifecycle transition только в RAM: Alert Center откатывает изменение и показывает state error.
""",
)

tests = Path('server/controlPlaneAlerts.test.mjs')
replace_once(
    tests,
    """  ControlPlaneAlertCenter,
  infrastructureConditions,
  operationConditions,
  reliabilityConditions
""",
    """  ControlPlaneAlertCenter,
  infrastructureConditions,
  monitoringCondition,
  operationConditions,
  reliabilityConditions
""",
)
tests.write_text(
    tests.read_text()
    + r'''

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
    assert.equal(alerts.acknowledge(alert.id, { name: 'Operator', role: 'operator' }, { now: now + 1 }).ok, true);
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
      snapshot: async () => healthyInfrastructure({ services: { wobble: { active: true }, nginx: { active: nginxActive } } })
    }
  });
  try {
    await alerts.evaluate({ now });
    now += 60_000;
    await alerts.evaluate({ now });
    assert.equal(alerts.status({ now }).active.some(item => item.rule === 'nginx-unavailable'), true);

    nginxActive = true;
    now += 60_000;
    await alerts.evaluate({ now });
    fs.rmSync(ctx.dir, { recursive: true, force: true });
    fs.writeFileSync(ctx.dir, 'block-parent-directory');
    now += 60_000;
    await alerts.evaluate({ now });
    const status = alerts.status({ now });
    assert.equal(status.storageHealthy, false);
    assert.equal(status.active.some(item => item.rule === 'nginx-unavailable'), true);
    assert.equal(status.history.some(item => item.rule === 'nginx-unavailable'), false);
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
'''
)
