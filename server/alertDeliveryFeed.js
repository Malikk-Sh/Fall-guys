'use strict';

const { ALERT_RULES } = require('./controlPlaneAlerts');

const FEED_VERSION = 1;
const SEVERITIES = new Set(['warning', 'critical']);
const STATES = new Set(['active', 'resolved']);

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || '')
  );
}

function safeTime(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function isLoopbackAddress(value) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(value || ''));
}

function safeFeedAlert(value) {
  const id = String(value?.id || '');
  const rule = String(value?.rule || '');
  const severity = String(value?.severity || '');
  const state = String(value?.state || '');
  const openedAt = safeTime(value?.openedAt);
  const lastSeenAt = safeTime(value?.lastSeenAt);
  const meta = ALERT_RULES[rule];
  if (
    !validUuid(id) ||
    !meta ||
    !SEVERITIES.has(severity) ||
    !STATES.has(state) ||
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
    resolvedAt: state === 'resolved' && resolvedAt != null && resolvedAt >= openedAt ? resolvedAt : null,
    title: meta.title,
    recommendedPanel: meta.recommendedPanel
  };
}

function buildAlertDeliveryFeed(status, { now = Date.now() } = {}) {
  const generatedAt = safeTime(now) ?? Date.now();
  const active = Array.isArray(status?.active) ? status.active.map(safeFeedAlert).filter(Boolean) : [];
  const resolved = Array.isArray(status?.history) ? status.history.map(safeFeedAlert).filter(Boolean) : [];
  return {
    version: FEED_VERSION,
    generatedAt,
    lastEvaluatedAt: safeTime(status?.lastEvaluatedAt),
    evaluationStale: Boolean(status?.evaluationStale),
    storageHealthy: status?.storageHealthy !== false,
    active: active.filter(item => item.state === 'active').slice(0, 100),
    resolved: resolved.filter(item => item.state === 'resolved').slice(0, 50)
  };
}

module.exports = {
  FEED_VERSION,
  buildAlertDeliveryFeed,
  isLoopbackAddress,
  safeFeedAlert
};
