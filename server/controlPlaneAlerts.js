'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_VERSION = 1;
const DEFAULT_STATE_FILE = '/var/lib/wobble/control-alerts.json';
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_TRIGGER_STREAK = 2;
const DEFAULT_RESOLVE_STREAK = 2;
const HISTORY_LIMIT = 100;
const OPERATION_STUCK_MS = 5 * 60 * 1000;
const TERMINAL_OPERATION_STATES = new Set(['succeeded', 'failed']);
const SEVERITIES = new Set(['warning', 'critical']);
const ALERT_STATES = new Set(['active', 'resolved']);
const RELIABILITY_REASONS = new Set([
  'internal-errors',
  'operational-warnings',
  'event-loop-critical',
  'event-loop-high',
  'reconnect-failure-rate-critical',
  'reconnect-failure-rate-high',
  'socket-send-failures',
  'capacity-rejections',
  'lifecycle-warning'
]);

const ALERT_RULES = Object.freeze({
  'game-unavailable': Object.freeze({
    title: 'Игровой сервер недоступен',
    description: 'wobble.service или локальный игровой endpoint не отвечает вне штатного restart.',
    recommendedPanel: 'infrastructure'
  }),
  'game-not-ready': Object.freeze({
    title: 'Игровой сервер не готов принимать игроков',
    description: 'Процесс Wobble отвечает, но readiness пока не подтверждён.',
    recommendedPanel: 'infrastructure'
  }),
  'nginx-unavailable': Object.freeze({
    title: 'Nginx не работает',
    description: 'Системная служба Nginx не активна.',
    recommendedPanel: 'infrastructure'
  }),
  'public-edge-unavailable': Object.freeze({
    title: 'Публичный HTTPS Wobble недоступен',
    description: 'Локальная проверка production HTTPS/SNI не может пройти до публичного edge.',
    recommendedPanel: 'infrastructure'
  }),
  'tls-unhealthy': Object.freeze({
    title: 'Проблема HTTPS-сертификата',
    description: 'Production TLS недоступен, просрочен или не проходит проверку доверия.',
    recommendedPanel: 'infrastructure'
  }),
  'tls-expiring': Object.freeze({
    title: 'HTTPS-сертификат скоро истечёт',
    description: 'До окончания production-сертификата осталось не больше 14 дней.',
    recommendedPanel: 'infrastructure'
  }),
  'backup-stale': Object.freeze({
    title: 'Резервная копия устарела или недоступна',
    description: 'Обязательный local/offsite backup не соответствует configured freshness policy.',
    recommendedPanel: 'infrastructure'
  }),
  'disk-pressure': Object.freeze({
    title: 'Мало свободного места на диске',
    description: 'Файловая система production DB приближается к заполнению.',
    recommendedPanel: 'infrastructure'
  }),
  'reliability-degraded': Object.freeze({
    title: 'Надёжность сервера ухудшилась',
    description: 'Reliability Center видит устойчивые operational warning/critical сигналы.',
    recommendedPanel: 'reliability'
  }),
  'operation-stuck': Object.freeze({
    title: 'Системная операция выполняется слишком долго',
    description: 'Durable Operation не меняла состояние больше пяти минут.',
    recommendedPanel: 'operations'
  })
});

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function safeTime(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function safePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? Math.round(number * 10) / 10 : null;
}

function safeContext(rule, value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (rule === 'game-unavailable' || rule === 'game-not-ready') {
    return {
      serviceActive: Boolean(source.serviceActive),
      reachable: Boolean(source.reachable),
      ready: Boolean(source.ready)
    };
  }
  if (rule === 'nginx-unavailable') return { serviceActive: Boolean(source.serviceActive) };
  if (rule === 'public-edge-unavailable') {
    return {
      tcpReachable: Boolean(source.tcpReachable),
      tlsReachable: Boolean(source.tlsReachable)
    };
  }
  if (rule === 'tls-unhealthy' || rule === 'tls-expiring') {
    const daysRemaining = Number(source.daysRemaining);
    return {
      reachable: Boolean(source.reachable),
      trusted: Boolean(source.trusted),
      expired: source.expired === true,
      daysRemaining: Number.isFinite(daysRemaining) ? Math.round(daysRemaining) : null
    };
  }
  if (rule === 'backup-stale') {
    return {
      available: Boolean(source.available),
      stale: Boolean(source.stale),
      ageSeconds:
        Number.isFinite(Number(source.ageSeconds)) && Number(source.ageSeconds) >= 0
          ? Math.round(Number(source.ageSeconds))
          : null,
      maxAgeSeconds:
        Number.isFinite(Number(source.maxAgeSeconds)) && Number(source.maxAgeSeconds) >= 0
          ? Math.round(Number(source.maxAgeSeconds))
          : null,
      offsiteRequired: Boolean(source.offsiteRequired),
      offsiteAvailable: Boolean(source.offsiteAvailable),
      offsiteStale: Boolean(source.offsiteStale)
    };
  }
  if (rule === 'disk-pressure') return { usedPercent: safePercent(source.usedPercent) };
  if (rule === 'reliability-degraded') {
    return {
      reasons: Array.isArray(source.reasons)
        ? [...new Set(source.reasons.map(String).filter(reason => RELIABILITY_REASONS.has(reason)))].slice(0, 12)
        : []
    };
  }
  if (rule === 'operation-stuck') {
    return {
      action: String(source.action || '').slice(0, 80),
      state: String(source.state || '').slice(0, 40),
      ageSeconds:
        Number.isFinite(Number(source.ageSeconds)) && Number(source.ageSeconds) >= 0
          ? Math.round(Number(source.ageSeconds))
          : null
    };
  }
  return {};
}

function normalizeActor(value) {
  const name = String(value?.name || '').trim().slice(0, 80);
  const role = String(value?.role || '').trim().slice(0, 40);
  return name ? { name, role: role || null } : null;
}

function normalizeRecord(value) {
  const id = String(value?.id || '');
  const rule = String(value?.rule || '');
  const severity = String(value?.severity || '');
  const state = String(value?.state || '');
  const openedAt = safeTime(value?.openedAt);
  const lastSeenAt = safeTime(value?.lastSeenAt);
  if (
    !validUuid(id) ||
    !Object.hasOwn(ALERT_RULES, rule) ||
    !SEVERITIES.has(severity) ||
    !ALERT_STATES.has(state) ||
    openedAt == null ||
    lastSeenAt == null ||
    lastSeenAt < openedAt
  ) {
    return null;
  }
  const resolvedAt = safeTime(value?.resolvedAt);
  const acknowledgedAt = safeTime(value?.acknowledgedAt);
  return {
    id,
    rule,
    severity,
    state,
    openedAt,
    lastSeenAt,
    resolvedAt: state === 'resolved' && resolvedAt != null && resolvedAt >= openedAt ? resolvedAt : null,
    acknowledgedAt:
      acknowledgedAt != null && acknowledgedAt >= openedAt ? acknowledgedAt : null,
    acknowledgedBy: normalizeActor(value?.acknowledgedBy),
    context: safeContext(rule, value?.context)
  };
}

function loadState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.alerts)) {
      return { ok: false, alerts: [] };
    }
    const alerts = parsed.alerts.map(normalizeRecord);
    if (alerts.some(item => !item)) return { ok: false, alerts: [] };
    const ids = new Set(alerts.map(item => item.id));
    if (ids.size !== alerts.length) return { ok: false, alerts: [] };
    return { ok: true, alerts: alerts.slice(-HISTORY_LIMIT) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, alerts: [] };
    return { ok: false, alerts: [] };
  }
}

function writeState(file, alerts) {
  const directory = path.dirname(file);
  const temporary = `${file}.tmp-${process.pid}`;
  let fd = null;
  let directoryFd = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
    const normalized = alerts.map(normalizeRecord);
    if (normalized.some(item => !item)) return false;
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: STATE_VERSION, alerts: normalized.slice(-HISTORY_LIMIT) })}\n`, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, file);
    directoryFd = fs.openSync(directory, 'r');
    fs.fsyncSync(directoryFd);
    fs.closeSync(directoryFd);
    directoryFd = null;
    return true;
  } catch {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort only.
      }
    }
    if (directoryFd != null) {
      try {
        fs.closeSync(directoryFd);
      } catch {
        // Best effort only.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Best effort only.
    }
    return false;
  }
}

function condition(active, severity, context = {}) {
  return { active: Boolean(active), severity, context };
}

function activeRestart(operations) {
  const current = operations?.activeOperation;
  return Boolean(
    current && current.action === 'wobble.restart' && !TERMINAL_OPERATION_STATES.has(String(current.state || ''))
  );
}

function infrastructureConditions(infrastructure, operations) {
  const result = new Map();
  const gameService = infrastructure?.services?.wobble || null;
  const game = infrastructure?.game || null;
  const restart = activeRestart(operations);
  if (operations && !restart) {
    const serviceActive = Boolean(gameService?.active);
    const reachable = Boolean(game?.reachable);
    const ready = Boolean(game?.ready);
    result.set(
      'game-unavailable',
      condition(!serviceActive || !reachable, 'critical', { serviceActive, reachable, ready })
    );
    result.set(
      'game-not-ready',
      condition(serviceActive && reachable && !ready, 'critical', { serviceActive, reachable, ready })
    );
  }

  const nginxActive = Boolean(infrastructure?.services?.nginx?.active);
  result.set('nginx-unavailable', condition(!nginxActive, 'critical', { serviceActive: nginxActive }));

  const targetKnown = Boolean(infrastructure?.publicTarget?.origin);
  if (targetKnown) {
    const tcpReachable = Boolean(infrastructure?.network?.https443?.reachable);
    const tlsReachable = Boolean(infrastructure?.https?.reachable);
    result.set(
      'public-edge-unavailable',
      condition(!tcpReachable || !tlsReachable, 'critical', { tcpReachable, tlsReachable })
    );
    const tls = infrastructure?.https || {};
    const unhealthy = !tls.reachable || !tls.trusted || tls.expired === true;
    result.set(
      'tls-unhealthy',
      condition(unhealthy, 'critical', {
        reachable: tls.reachable,
        trusted: tls.trusted,
        expired: tls.expired,
        daysRemaining: tls.daysRemaining
      })
    );
    const days = Number(tls.daysRemaining);
    result.set(
      'tls-expiring',
      condition(!unhealthy && Number.isFinite(days) && days <= 14, 'warning', {
        reachable: tls.reachable,
        trusted: tls.trusted,
        expired: tls.expired,
        daysRemaining: days
      })
    );
  }

  const backup = infrastructure?.backup;
  if (backup?.required) {
    result.set(
      'backup-stale',
      condition(!backup.available || backup.stale, 'critical', {
        available: backup.available,
        stale: backup.stale,
        ageSeconds: backup.ageSeconds,
        maxAgeSeconds: backup.maxAgeSeconds,
        offsiteRequired: backup.offsite?.required,
        offsiteAvailable: backup.offsite?.available,
        offsiteStale: backup.offsite?.stale
      })
    );
  }

  const usedPercent = Number(infrastructure?.resources?.disk?.usedPercent);
  if (Number.isFinite(usedPercent)) {
    result.set(
      'disk-pressure',
      condition(usedPercent >= 85, usedPercent >= 95 ? 'critical' : 'warning', { usedPercent })
    );
  }
  return result;
}

function reliabilityConditions(report) {
  const result = new Map();
  if (!report) return result;
  const severity = report.status === 'critical' ? 'critical' : 'warning';
  result.set(
    'reliability-degraded',
    condition(report.status === 'critical' || report.status === 'warning', severity, {
      reasons: report.reasons
    })
  );
  return result;
}

function operationConditions(operations, now) {
  const result = new Map();
  const current = operations?.activeOperation;
  if (!current) {
    result.set('operation-stuck', condition(false, 'critical'));
    return result;
  }
  const updatedAt = safeTime(current.updatedAt);
  const ageMs = updatedAt == null ? 0 : Math.max(0, now - updatedAt);
  result.set(
    'operation-stuck',
    condition(ageMs >= OPERATION_STUCK_MS, 'critical', {
      action: current.action,
      state: current.state,
      ageSeconds: Math.round(ageMs / 1000)
    })
  );
  return result;
}

function publicRecord(record) {
  const meta = ALERT_RULES[record.rule];
  return {
    ...record,
    title: meta.title,
    description: meta.description,
    recommendedPanel: meta.recommendedPanel
  };
}

class ControlPlaneAlertCenter {
  constructor({
    infrastructure,
    reliability,
    operations,
    stateFile = process.env.CONTROL_ALERT_STATE || DEFAULT_STATE_FILE,
    now = () => Date.now(),
    intervalMs = DEFAULT_INTERVAL_MS,
    triggerStreak = DEFAULT_TRIGGER_STREAK,
    resolveStreak = DEFAULT_RESOLVE_STREAK
  } = {}) {
    if (!infrastructure || typeof infrastructure.snapshot !== 'function') {
      throw new Error('ControlPlaneAlertCenter requires infrastructure.snapshot()');
    }
    this.infrastructure = infrastructure;
    this.reliability = reliability;
    this.operations = operations;
    this.stateFile = stateFile;
    this.now = now;
    this.intervalMs = Math.max(10_000, Number(intervalMs) || DEFAULT_INTERVAL_MS);
    this.triggerStreak = Math.max(1, Math.min(10, Number(triggerStreak) || DEFAULT_TRIGGER_STREAK));
    this.resolveStreak = Math.max(1, Math.min(10, Number(resolveStreak) || DEFAULT_RESOLVE_STREAK));
    const loaded = loadState(stateFile);
    this.alerts = loaded.alerts;
    this.storageHealthy = loaded.ok;
    this.lastEvaluatedAt = null;
    this.sources = { infrastructure: false, reliability: false, operations: false };
    this.streaks = new Map();
    this.timer = null;
    this.evaluating = false;
  }

  _active(rule) {
    return [...this.alerts].reverse().find(item => item.rule === rule && item.state === 'active') || null;
  }

  _persist() {
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
    for (const [rule, observed] of conditions) {
      if (!Object.hasOwn(ALERT_RULES, rule)) continue;
      const streak = this.streaks.get(rule) || { bad: 0, good: 0 };
      const current = this._active(rule);
      if (observed.active) {
        streak.bad += 1;
        streak.good = 0;
        if (current) {
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
        } else if (streak.bad >= this.triggerStreak) {
          this.alerts.push({
            id: crypto.randomUUID(),
            rule,
            severity: SEVERITIES.has(observed.severity) ? observed.severity : 'warning',
            state: 'active',
            openedAt: now,
            lastSeenAt: now,
            resolvedAt: null,
            acknowledgedAt: null,
            acknowledgedBy: null,
            context: safeContext(rule, observed.context)
          });
          changed = true;
        }
      } else {
        streak.bad = 0;
        if (current) {
          streak.good += 1;
          if (streak.good >= this.resolveStreak) {
            current.state = 'resolved';
            current.resolvedAt = Math.max(current.lastSeenAt, now);
            changed = true;
            streak.good = 0;
          }
        } else {
          streak.good = 0;
        }
      }
      this.streaks.set(rule, streak);
    }
    if (changed) this._persist();
    return changed;
  }

  async evaluate({ now = this.now() } = {}) {
    const at = safeTime(now);
    if (at == null || this.evaluating) return false;
    this.evaluating = true;
    try {
      let operations = null;
      let operationsOk = false;
      try {
        operations = this.operations?.status?.() || null;
        operationsOk = Boolean(operations);
      } catch {
        operations = null;
      }

      const [infrastructureResult, reliabilityResult] = await Promise.allSettled([
        this.infrastructure.snapshot({ now: at }),
        this.reliability?.report ? this.reliability.report({ period: '1h', now: at }) : Promise.resolve(null)
      ]);
      const infrastructure =
        infrastructureResult.status === 'fulfilled' ? infrastructureResult.value : null;
      const reliability = reliabilityResult.status === 'fulfilled' ? reliabilityResult.value : null;
      this.sources = {
        infrastructure: Boolean(infrastructure),
        reliability: Boolean(reliability),
        operations: operationsOk
      };

      const conditions = new Map();
      if (infrastructure) {
        for (const [rule, value] of infrastructureConditions(infrastructure, operationsOk ? operations : null)) {
          conditions.set(rule, value);
        }
      }
      if (reliability) {
        for (const [rule, value] of reliabilityConditions(reliability)) conditions.set(rule, value);
      }
      if (operationsOk) {
        for (const [rule, value] of operationConditions(operations, at)) conditions.set(rule, value);
      }
      this._apply(conditions, at);
      this.lastEvaluatedAt = at;
      return conditions.size > 0;
    } finally {
      this.evaluating = false;
    }
  }

  status({ now = this.now() } = {}) {
    const at = safeTime(now) ?? Date.now();
    const active = this.alerts
      .filter(item => item.state === 'active')
      .sort((a, b) => {
        const severity = (b.severity === 'critical' ? 2 : 1) - (a.severity === 'critical' ? 2 : 1);
        return severity || b.openedAt - a.openedAt;
      });
    const history = this.alerts
      .filter(item => item.state === 'resolved')
      .sort((a, b) => (b.resolvedAt || b.lastSeenAt) - (a.resolvedAt || a.lastSeenAt))
      .slice(0, 50);
    return {
      generatedAt: at,
      lastEvaluatedAt: this.lastEvaluatedAt,
      evaluationStale:
        this.lastEvaluatedAt == null || at - this.lastEvaluatedAt > Math.max(this.intervalMs * 3, 180_000),
      storageHealthy: this.storageHealthy,
      sources: { ...this.sources },
      counts: {
        active: active.length,
        critical: active.filter(item => item.severity === 'critical').length,
        warning: active.filter(item => item.severity === 'warning').length,
        unacknowledged: active.filter(item => item.acknowledgedAt == null).length
      },
      active: active.map(publicRecord),
      history: history.map(publicRecord)
    };
  }

  acknowledge(alertId, actor, { now = this.now() } = {}) {
    if (!validUuid(alertId)) return { ok: false, reason: 'invalid-alert-id' };
    const at = safeTime(now);
    if (at == null) return { ok: false, reason: 'invalid-time' };
    const alert = this.alerts.find(item => item.id === alertId && item.state === 'active');
    if (!alert) return { ok: false, reason: 'alert-not-active' };
    alert.acknowledgedAt = Math.max(alert.openedAt, at);
    alert.acknowledgedBy = normalizeActor(actor);
    if (!this._persist()) return { ok: false, reason: 'alert-state-unavailable' };
    return { ok: true, alert: publicRecord(alert) };
  }

  start() {
    if (this.timer) return false;
    const run = () => void this.evaluate().catch(() => false);
    run();
    this.timer = setInterval(run, this.intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    clearInterval(this.timer);
    this.timer = null;
    return true;
  }
}

module.exports = {
  ALERT_RULES,
  ControlPlaneAlertCenter,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STATE_FILE,
  HISTORY_LIMIT,
  activeRestart,
  infrastructureConditions,
  operationConditions,
  reliabilityConditions
};
