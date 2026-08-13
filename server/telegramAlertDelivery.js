'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { ALERT_RULES } = require('./controlPlaneAlerts');

const STATE_VERSION = 1;
const DEFAULT_STATE_FILE = '/var/lib/wobble-telegram-alerts/state.json';
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const MAX_FEED_BYTES = 64 * 1024;
const MAX_TELEGRAM_BYTES = 32 * 1024;
const MAX_RECORDS = 200;
const MAX_DELIVERIES_PER_PASS = 3;
const CONTROL_HOST = '127.0.0.1';
const CONTROL_PORT = 3001;
const CONTROL_PATH = '/internal/alerts/delivery';
const TELEGRAM_HOST = 'api.telegram.org';
const TELEGRAM_PORT = 443;
const SEVERITY_RANK = Object.freeze({ warning: 1, critical: 2 });
const EVENT_KINDS = new Set(['opened', 'escalated', 'recovered', 'recovered-summary', 'escalated-recovered']);

function safeTime(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function validToken(value) {
  return /^\d{6,15}:[A-Za-z0-9_-]{20,100}$/.test(String(value || ''));
}

function validChatId(value) {
  return /^-?\d{1,20}$/.test(String(value || ''));
}

function validateConfig(env = process.env) {
  const enabled = env.TELEGRAM_ALERTS_ENABLED === '1';
  if (!enabled) return { ok: true, enabled: false };
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  const minSeverity = String(env.TELEGRAM_ALERT_MIN_SEVERITY || 'critical').trim();
  if (!validToken(token)) return { ok: false, reason: 'invalid-bot-token' };
  if (!validChatId(chatId)) return { ok: false, reason: 'invalid-chat-id' };
  if (!Object.hasOwn(SEVERITY_RANK, minSeverity)) return { ok: false, reason: 'invalid-min-severity' };
  return { ok: true, enabled: true, token, chatId, minSeverity };
}

function safeAlert(value, expectedState) {
  const id = String(value?.id || '');
  const rule = String(value?.rule || '');
  const severity = String(value?.severity || '');
  const state = String(value?.state || '');
  const openedAt = safeTime(value?.openedAt);
  const lastSeenAt = safeTime(value?.lastSeenAt);
  if (
    !validUuid(id) ||
    !Object.hasOwn(ALERT_RULES, rule) ||
    !Object.hasOwn(SEVERITY_RANK, severity) ||
    state !== expectedState ||
    openedAt == null ||
    lastSeenAt == null ||
    lastSeenAt < openedAt
  ) {
    return null;
  }
  const resolvedAt = safeTime(value?.resolvedAt);
  return {
    id,
    rule,
    severity,
    state,
    openedAt,
    lastSeenAt,
    resolvedAt: state === 'resolved' && resolvedAt != null && resolvedAt >= openedAt ? resolvedAt : null
  };
}

function normalizeFeed(value) {
  if (!value || value.version !== 1) return null;
  const generatedAt = safeTime(value.generatedAt);
  if (generatedAt == null) return null;
  const active = Array.isArray(value.active) ? value.active.map(item => safeAlert(item, 'active')) : [];
  const resolved = Array.isArray(value.resolved)
    ? value.resolved.map(item => safeAlert(item, 'resolved'))
    : [];
  if (active.some(item => !item) || resolved.some(item => !item)) return null;
  return {
    version: 1,
    generatedAt,
    lastEvaluatedAt: safeTime(value.lastEvaluatedAt),
    evaluationStale: Boolean(value.evaluationStale),
    storageHealthy: value.storageHealthy !== false,
    active,
    resolved
  };
}

function normalizePending(value) {
  if (!value) return null;
  const kind = String(value.kind || '');
  const severity = String(value.severity || '');
  const attempts = Number(value.attempts);
  const nextAttemptAt = safeTime(value.nextAttemptAt);
  if (
    !EVENT_KINDS.has(kind) ||
    !Object.hasOwn(SEVERITY_RANK, severity) ||
    !Number.isSafeInteger(attempts) ||
    attempts < 0 ||
    attempts > 1000 ||
    nextAttemptAt == null
  ) {
    return null;
  }
  return { kind, severity, attempts, nextAttemptAt };
}

function normalizeRecord(value) {
  const id = String(value?.id || '');
  const rule = String(value?.rule || '');
  const openedAt = safeTime(value?.openedAt);
  const lastSeenAt = safeTime(value?.lastSeenAt);
  const resolvedAt = value?.resolvedAt == null ? null : safeTime(value.resolvedAt);
  const latestSeverity = String(value?.latestSeverity || '');
  const sentSeverity = value?.sentSeverity == null ? null : String(value.sentSeverity);
  if (
    !validUuid(id) ||
    !Object.hasOwn(ALERT_RULES, rule) ||
    openedAt == null ||
    lastSeenAt == null ||
    lastSeenAt < openedAt ||
    (resolvedAt != null && resolvedAt < openedAt) ||
    !Object.hasOwn(SEVERITY_RANK, latestSeverity) ||
    (sentSeverity != null && !Object.hasOwn(SEVERITY_RANK, sentSeverity))
  ) {
    return null;
  }
  const pending = value?.pending == null ? null : normalizePending(value.pending);
  if (value?.pending != null && !pending) return null;
  return {
    id,
    rule,
    openedAt,
    lastSeenAt,
    resolvedAt,
    latestSeverity,
    sentSeverity,
    resolvedSent: Boolean(value?.resolvedSent),
    pending
  };
}

function loadState(file = DEFAULT_STATE_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.alerts)) {
      return { ok: false, records: [] };
    }
    const records = parsed.alerts.map(normalizeRecord);
    if (records.some(item => !item)) return { ok: false, records: [] };
    const ids = new Set(records.map(item => item.id));
    if (ids.size !== records.length) return { ok: false, records: [] };
    return { ok: true, records: records.slice(-MAX_RECORDS) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, records: [] };
    return { ok: false, records: [] };
  }
}

function writeState(file, records) {
  const directory = path.dirname(file);
  const temporary = `${file}.tmp-${process.pid}`;
  let fd = null;
  let directoryFd = null;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const normalized = records.map(normalizeRecord);
    if (normalized.some(item => !item)) return false;
    const bounded = boundRecords(normalized);
    if (!bounded) return false;
    fd = fs.openSync(temporary, 'w', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify({ version: STATE_VERSION, alerts: bounded })}\n`, 'utf8');
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

function boundRecords(records) {
  if (records.length <= MAX_RECORDS) return records;
  const protectedRecords = records.filter(item => item.pending || !item.resolvedSent);
  if (protectedRecords.length > MAX_RECORDS) return null;
  const protectedIds = new Set(protectedRecords.map(item => item.id));
  const removable = records
    .filter(item => !protectedIds.has(item.id))
    .sort((a, b) => (a.resolvedAt || a.lastSeenAt) - (b.resolvedAt || b.lastSeenAt));
  const removeCount = Math.max(0, records.length - MAX_RECORDS);
  const removed = new Set(removable.slice(0, removeCount).map(item => item.id));
  const bounded = records.filter(item => !removed.has(item.id));
  return bounded.length <= MAX_RECORDS ? bounded : null;
}

function qualifies(severity, minSeverity) {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[minSeverity];
}

function ensureRecord(records, alert) {
  let record = records.find(item => item.id === alert.id);
  if (!record) {
    record = {
      id: alert.id,
      rule: alert.rule,
      openedAt: alert.openedAt,
      lastSeenAt: alert.lastSeenAt,
      resolvedAt: alert.resolvedAt,
      latestSeverity: alert.severity,
      sentSeverity: null,
      resolvedSent: false,
      pending: null
    };
    records.push(record);
  }
  record.rule = alert.rule;
  record.lastSeenAt = Math.max(record.lastSeenAt, alert.lastSeenAt);
  record.latestSeverity =
    SEVERITY_RANK[alert.severity] >= SEVERITY_RANK[record.latestSeverity]
      ? alert.severity
      : record.latestSeverity;
  if (alert.resolvedAt != null) record.resolvedAt = Math.max(record.resolvedAt || 0, alert.resolvedAt);
  return record;
}

function schedule(record, kind, severity, now) {
  if (!EVENT_KINDS.has(kind) || !Object.hasOwn(SEVERITY_RANK, severity)) return false;
  if (record.pending?.kind === kind && record.pending?.severity === severity) {
    // Preserve durable backoff. Re-observing the same incident must not pull retryAt back to now.
    return false;
  }
  record.pending = { kind, severity, attempts: 0, nextAttemptAt: now };
  return true;
}

function reconcile(records, feed, minSeverity, now) {
  let changed = false;
  const activeIds = new Set();
  const resolvedIds = new Set(feed.resolved.map(item => item.id));
  for (const alert of feed.active) {
    activeIds.add(alert.id);
    const record = ensureRecord(records, alert);
    if (!qualifies(alert.severity, minSeverity)) continue;
    const sentRank = record.sentSeverity ? SEVERITY_RANK[record.sentSeverity] : 0;
    const currentRank = SEVERITY_RANK[alert.severity];
    if (sentRank < currentRank) {
      const kind = sentRank === 0 ? 'opened' : 'escalated';
      changed = schedule(record, kind, alert.severity, now) || changed;
    }
  }

  for (const alert of feed.resolved) {
    const record = ensureRecord(records, alert);
    const escalatedPastDelivery =
      record.sentSeverity && SEVERITY_RANK[alert.severity] > SEVERITY_RANK[record.sentSeverity];
    if (record.pending?.kind === 'opened' || record.pending?.kind === 'escalated') {
      if (qualifies(record.pending.severity, minSeverity)) {
        record.pending = {
          kind:
            record.sentSeverity && SEVERITY_RANK[record.pending.severity] > SEVERITY_RANK[record.sentSeverity]
              ? 'escalated-recovered'
              : record.sentSeverity
                ? 'recovered'
                : 'recovered-summary',
          severity: record.pending.severity,
          attempts: 0,
          nextAttemptAt: now
        };
        changed = true;
      } else {
        record.pending = null;
        changed = true;
      }
    } else if (escalatedPastDelivery && qualifies(alert.severity, minSeverity) && !record.resolvedSent) {
      changed = schedule(record, 'escalated-recovered', alert.severity, now) || changed;
    } else if (record.sentSeverity && !record.resolvedSent) {
      changed = schedule(record, 'recovered', record.sentSeverity, now) || changed;
    } else if (!record.sentSeverity && qualifies(alert.severity, minSeverity) && !record.resolvedSent) {
      changed = schedule(record, 'recovered-summary', alert.severity, now) || changed;
    }
  }

  // A healthy feed's active list is complete for the fixed Alert Center rule set. If an incident we
  // previously saw active is no longer active and already fell out of the bounded resolved history,
  // treat this poll time as the latest safe recovery observation rather than sending a stale open.
  for (const record of records) {
    if (record.resolvedAt != null || activeIds.has(record.id) || resolvedIds.has(record.id)) continue;
    record.resolvedAt = Math.max(record.lastSeenAt, feed.generatedAt);
    if (record.pending?.kind === 'opened' || record.pending?.kind === 'escalated') {
      record.pending = {
        kind: record.sentSeverity ? 'recovered' : 'recovered-summary',
        severity: record.pending.severity,
        attempts: 0,
        nextAttemptAt: now
      };
      changed = true;
    } else if (record.sentSeverity && !record.resolvedSent) {
      changed = schedule(record, 'recovered', record.sentSeverity, now) || changed;
    }
  }
  return changed;
}

function retryDelayMs(attempts, retryAfterSeconds = null) {
  if (retryAfterSeconds != null && Number.isFinite(Number(retryAfterSeconds))) {
    return Math.max(5_000, Math.min(60 * 60 * 1000, Math.round(Number(retryAfterSeconds) * 1000)));
  }
  const schedule = [15_000, 30_000, 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
  return schedule[Math.min(schedule.length - 1, Math.max(0, Number(attempts) || 0))];
}

function panelLabel(value) {
  return (
    { infrastructure: 'Сервер', reliability: 'Надёжность', operations: 'Операции' }[value] || 'Оповещения'
  );
}

function iso(value) {
  const at = safeTime(value);
  return at == null ? 'неизвестно' : new Date(at).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatMessage(record) {
  const meta = ALERT_RULES[record.rule];
  const pending = record.pending;
  if (!meta || !pending) return null;
  const shortId = record.id.slice(0, 8);
  const severity = pending.severity === 'critical' ? 'CRITICAL' : 'WARNING';
  if (pending.kind === 'recovered') {
    return [
      '🟢 Wobble: восстановлено',
      meta.title,
      `Инцидент: ${shortId}`,
      `Был уровень: ${severity}`,
      `Открыт: ${iso(record.openedAt)}`,
      `Восстановлен: ${iso(record.resolvedAt)}`,
      `Раздел: ${panelLabel(meta.recommendedPanel)}`
    ].join('\n');
  }
  if (pending.kind === 'recovered-summary' || pending.kind === 'escalated-recovered') {
    return [
      pending.kind === 'escalated-recovered'
        ? '🟢 Wobble: критическое ухудшение уже восстановлено'
        : '🟢 Wobble: инцидент произошёл и уже восстановлен',
      meta.title,
      `Инцидент: ${shortId}`,
      `Уровень: ${severity}`,
      `Открыт: ${iso(record.openedAt)}`,
      `Восстановлен: ${iso(record.resolvedAt)}`,
      `Раздел: ${panelLabel(meta.recommendedPanel)}`
    ].join('\n');
  }
  return [
    pending.kind === 'escalated' ? '🔴 Wobble: инцидент повышен до CRITICAL' : `🔴 Wobble: ${severity}`,
    meta.title,
    `Инцидент: ${shortId}`,
    `Открыт: ${iso(record.openedAt)}`,
    `Последний сигнал: ${iso(record.lastSeenAt)}`,
    `Раздел: ${panelLabel(meta.recommendedPanel)}`
  ].join('\n');
}

function requestJson(module, options, body, { maxBytes, timeoutMs = 7000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = module.request(options, res => {
      let bytes = 0;
      const chunks = [];
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          req.destroy();
          finish({ ok: false, reason: 'response-too-large' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Caller decides whether malformed JSON is acceptable.
        }
        finish({ ok: true, statusCode: Number(res.statusCode || 0), json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => finish({ ok: false, reason: 'network-error' }));
    if (body) req.end(body);
    else req.end();
  });
}

async function fetchFeed({ request = http } = {}) {
  const response = await requestJson(
    request,
    {
      host: CONTROL_HOST,
      port: CONTROL_PORT,
      path: CONTROL_PATH,
      method: 'GET',
      headers: { Accept: 'application/json' },
      agent: false
    },
    null,
    { maxBytes: MAX_FEED_BYTES, timeoutMs: 5000 }
  );
  if (!response.ok || response.statusCode !== 200 || response.json?.ok !== true) {
    return { ok: false, reason: 'feed-unavailable' };
  }
  const feed = normalizeFeed(response.json.feed);
  return feed ? { ok: true, feed } : { ok: false, reason: 'feed-invalid' };
}

function telegramRequestOptions(token, body) {
  return {
    host: TELEGRAM_HOST,
    port: TELEGRAM_PORT,
    servername: TELEGRAM_HOST,
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Accept: 'application/json'
    },
    agent: false
  };
}

async function sendTelegram(text, config, { request = https } = {}) {
  const body = JSON.stringify({
    chat_id: config.chatId,
    text,
    disable_web_page_preview: true
  });
  const response = await requestJson(request, telegramRequestOptions(config.token, body), body, {
    maxBytes: MAX_TELEGRAM_BYTES,
    timeoutMs: 8000
  });
  if (!response.ok) return { ok: false, reason: 'telegram-network' };
  if (response.statusCode === 200 && response.json?.ok === true) return { ok: true };
  if (response.statusCode === 429) {
    const retryAfter = Number(response.json?.parameters?.retry_after);
    return {
      ok: false,
      reason: 'telegram-rate-limited',
      retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null
    };
  }
  if (response.statusCode === 401 || response.statusCode === 403) {
    return { ok: false, reason: 'telegram-auth' };
  }
  return { ok: false, reason: 'telegram-rejected' };
}

function safeLog(event, fields = {}) {
  const safe = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (['alertId', 'rule', 'kind', 'severity', 'reason', 'attempts', 'minSeverity'].includes(key)) {
      safe[key] = value;
    }
  }
  console.log(JSON.stringify(safe));
}

async function processDue(records, config, stateFile, { now = Date.now(), send = sendTelegram } = {}) {
  const due = records
    .filter(item => item.pending && item.pending.nextAttemptAt <= now)
    .sort((a, b) => a.pending.nextAttemptAt - b.pending.nextAttemptAt || a.openedAt - b.openedAt)
    .slice(0, MAX_DELIVERIES_PER_PASS);
  for (const record of due) {
    const text = formatMessage(record);
    if (!text) {
      record.pending = null;
      if (!writeState(stateFile, records)) return { ok: false, reason: 'state-unavailable' };
      continue;
    }
    const event = { ...record.pending };
    const result = await send(text, config);
    if (result.ok) {
      if (event.kind === 'opened' || event.kind === 'escalated') record.sentSeverity = event.severity;
      if (event.kind === 'recovered-summary' || event.kind === 'escalated-recovered') {
        record.sentSeverity = event.severity;
        record.resolvedSent = true;
      }
      if (event.kind === 'recovered') record.resolvedSent = true;
      record.pending = null;
      if (!writeState(stateFile, records)) {
        safeLog('telegram_alert_state_uncertain', {
          alertId: record.id,
          rule: record.rule,
          kind: event.kind
        });
        return { ok: false, reason: 'state-uncertain' };
      }
      safeLog('telegram_alert_delivered', {
        alertId: record.id,
        rule: record.rule,
        kind: event.kind,
        severity: event.severity
      });
      continue;
    }
    record.pending.attempts += 1;
    record.pending.nextAttemptAt = now + retryDelayMs(record.pending.attempts - 1, result.retryAfterSeconds);
    if (!writeState(stateFile, records)) return { ok: false, reason: 'state-unavailable' };
    safeLog('telegram_alert_retry_scheduled', {
      alertId: record.id,
      rule: record.rule,
      kind: event.kind,
      severity: event.severity,
      reason: result.reason,
      attempts: record.pending.attempts
    });
  }
  return { ok: true };
}

async function deliveryPass({
  config,
  stateFile = process.env.TELEGRAM_ALERT_STATE || DEFAULT_STATE_FILE,
  now = Date.now(),
  getFeed = fetchFeed,
  send = sendTelegram
} = {}) {
  const loaded = loadState(stateFile);
  if (!loaded.ok) return { ok: false, reason: 'state-corrupt' };
  const records = loaded.records;
  const feedResult = await getFeed();
  if (feedResult.ok && feedResult.feed.storageHealthy && !feedResult.feed.evaluationStale) {
    if (reconcile(records, feedResult.feed, config.minSeverity, now) && !writeState(stateFile, records)) {
      return { ok: false, reason: 'state-unavailable' };
    }
  } else if (!feedResult.ok) {
    safeLog('telegram_alert_feed_unavailable', { reason: feedResult.reason });
  } else {
    safeLog('telegram_alert_feed_degraded', {
      reason: feedResult.feed.storageHealthy ? 'evaluation-stale' : 'alert-state-unhealthy'
    });
  }
  return processDue(records, config, stateFile, { now, send });
}

async function main() {
  const config = validateConfig();
  if (!config.ok) {
    safeLog('telegram_alert_config_invalid', { reason: config.reason });
    process.exitCode = 78;
    return;
  }
  if (!config.enabled) {
    safeLog('telegram_alerts_disabled');
    return;
  }
  const stateFile = process.env.TELEGRAM_ALERT_STATE || DEFAULT_STATE_FILE;
  const loaded = loadState(stateFile);
  if (!loaded.ok) {
    safeLog('telegram_alert_state_corrupt', { reason: 'state-corrupt' });
    process.exitCode = 78;
    return;
  }
  safeLog('telegram_alert_service_started', { minSeverity: config.minSeverity });
  let stopping = false;
  const stop = signal => {
    if (stopping) return;
    stopping = true;
    safeLog('telegram_alert_service_stopping', { reason: signal });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  while (!stopping) {
    try {
      const result = await deliveryPass({ config, stateFile });
      if (!result.ok) safeLog('telegram_alert_pass_failed', { reason: result.reason });
    } catch {
      safeLog('telegram_alert_pass_failed', { reason: 'unexpected-error' });
    }
    if (stopping) break;
    await new Promise(resolve => setTimeout(resolve, DEFAULT_POLL_INTERVAL_MS));
  }
}

if (require.main === module) void main();

module.exports = {
  CONTROL_HOST,
  CONTROL_PATH,
  CONTROL_PORT,
  DEFAULT_STATE_FILE,
  EVENT_KINDS,
  MAX_RECORDS,
  TELEGRAM_HOST,
  TELEGRAM_PORT,
  boundRecords,
  deliveryPass,
  fetchFeed,
  formatMessage,
  loadState,
  normalizeFeed,
  processDue,
  reconcile,
  retryDelayMs,
  sendTelegram,
  telegramRequestOptions,
  validateConfig,
  validChatId,
  validToken,
  writeState
};
