'use strict';

const crypto = require('crypto');
const { ALLOWED_EVENTS, ERROR_EVENTS } = require('./serviceReliability');

const MAX_STRUCTURED_LOG_BYTES = 64 * 1024;
const MAX_PENDING = 200;
const ERROR_EVENT_SET = new Set(ERROR_EVENTS);

function normalizeFingerprintSource(value) {
  return String(value || '')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{20,}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/:\d+:\d+/g, ':<line>:<col>')
    .replace(/\b\d{4,}\b/g, '<n>')
    .slice(0, 16 * 1024);
}

function stackFramesOnly(value) {
  return String(value || '')
    .split('\n')
    .filter(line => /^\s*at\s+/.test(line))
    .join('\n');
}

function fingerprintFor(payload) {
  if (!ERROR_EVENT_SET.has(payload.event)) return '';
  // Never hash the raw exception message. Besides being unnecessary for grouping, the first line
  // of an Error stack can contain dynamic application values. Frames identify the code location;
  // events without frames deliberately group by the closed event name only.
  const frames = normalizeFingerprintSource(stackFramesOnly(payload.stack));
  return crypto
    .createHash('sha256')
    .update(`${payload.event}\n${frames || '<no-stack>'}`)
    .digest('hex')
    .slice(0, 24);
}

function structuredReliabilityEvent(value, fallbackLevel = 'info', now = Date.now()) {
  if (typeof value !== 'string' || !value.startsWith('{')) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_STRUCTURED_LOG_BYTES) return null;
  let payload;
  try {
    payload = JSON.parse(value);
  } catch {
    return null;
  }
  const event = String(payload?.event || '').trim();
  if (!ALLOWED_EVENTS.has(event)) return null;
  const rawLevel = String(payload?.level || fallbackLevel).trim();
  const severity = rawLevel === 'error' ? 'error' : rawLevel === 'warn' ? 'warn' : 'info';
  const parsedTs = Date.parse(String(payload?.ts || ''));
  return {
    event,
    severity,
    fingerprint: fingerprintFor(payload),
    occurredAt: Number.isFinite(parsedTs) ? parsedTs : now
  };
}

function installReliabilityCapture({ now = () => Date.now() } = {}) {
  const originalLog = console.log;
  const originalError = console.error;
  let sink = null;
  const pending = [];
  let installed = true;

  const deliver = event => {
    if (!event) return;
    if (sink) {
      try {
        sink(event);
      } catch {
        // Reliability is observability only. It must never alter application logging or gameplay.
      }
      return;
    }
    if (pending.length >= MAX_PENDING) pending.shift();
    pending.push(event);
  };

  const wrap = (original, fallbackLevel) =>
    function reliabilityConsoleWrapper(...args) {
      original.apply(console, args);
      try {
        deliver(structuredReliabilityEvent(args[0], fallbackLevel, now()));
      } catch {
        // Preserve console behavior even if telemetry parsing fails.
      }
    };

  console.log = wrap(originalLog, 'info');
  console.error = wrap(originalError, 'error');

  return {
    setSink(nextSink) {
      sink = typeof nextSink === 'function' ? nextSink : null;
      if (!sink) return 0;
      let delivered = 0;
      while (pending.length) {
        const event = pending.shift();
        try {
          sink(event);
          delivered += 1;
        } catch {
          // Drop only the telemetry event; never replay it forever.
        }
      }
      return delivered;
    },
    pendingCount() {
      return pending.length;
    },
    uninstall() {
      if (!installed) return false;
      installed = false;
      console.log = originalLog;
      console.error = originalError;
      sink = null;
      pending.length = 0;
      return true;
    }
  };
}

module.exports = {
  installReliabilityCapture,
  structuredReliabilityEvent,
  fingerprintFor,
  normalizeFingerprintSource,
  stackFramesOnly,
  MAX_PENDING
};
