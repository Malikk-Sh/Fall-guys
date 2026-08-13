import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAlertDeliveryFeed, isLoopbackAddress } = require('./alertDeliveryFeed');
const {
  CONTROL_HOST,
  CONTROL_PATH,
  CONTROL_PORT,
  TELEGRAM_HOST,
  TELEGRAM_PORT,
  deliveryPass,
  loadState,
  retryDelayMs,
  telegramRequestOptions,
  validateConfig,
  writeState
} = require('./telegramAlertDelivery');

const ALERT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ALERT_ID = '22222222-2222-4222-8222-222222222222';

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-telegram-'));
  return {
    dir,
    file: path.join(dir, 'state.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function alert({
  id = ALERT_ID,
  rule = 'game-unavailable',
  severity = 'critical',
  state = 'active',
  openedAt = 10_000,
  lastSeenAt = 20_000,
  resolvedAt = null
} = {}) {
  return {
    id,
    rule,
    severity,
    state,
    openedAt,
    lastSeenAt,
    resolvedAt,
    title: 'attacker-controlled title must not matter',
    recommendedPanel: 'attacker-controlled-panel',
    context: { raw: 'secret-context' },
    acknowledgedBy: { name: 'Admin Secret Name', role: 'owner' },
    acknowledgedAt: 15_000
  };
}

function feed({ active = [], resolved = [], stale = false, storageHealthy = true } = {}) {
  return {
    version: 1,
    generatedAt: 30_000,
    lastEvaluatedAt: 29_000,
    evaluationStale: stale,
    storageHealthy,
    active,
    resolved
  };
}

function config(minSeverity = 'critical') {
  return {
    enabled: true,
    token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123',
    chatId: '-1001234567890',
    minSeverity
  };
}

test('delivery feed is loopback-only and strips context, acknowledgement and caller-provided labels', () => {
  const status = {
    lastEvaluatedAt: 29_000,
    evaluationStale: false,
    storageHealthy: true,
    active: [alert()],
    history: [
      alert({
        id: SECOND_ALERT_ID,
        rule: 'disk-pressure',
        state: 'resolved',
        openedAt: 1_000,
        lastSeenAt: 2_000,
        resolvedAt: 3_000
      })
    ]
  };
  const result = buildAlertDeliveryFeed(status, { now: 30_000 });
  assert.equal(result.active.length, 1);
  assert.equal(result.active[0].title, 'Игровой сервер недоступен');
  assert.equal(result.active[0].recommendedPanel, 'infrastructure');
  assert.equal(Object.hasOwn(result.active[0], 'context'), false);
  assert.equal(Object.hasOwn(result.active[0], 'acknowledgedBy'), false);
  assert.equal(Object.hasOwn(result.active[0], 'acknowledgedAt'), false);
  assert.equal(result.resolved[0].title, 'Мало свободного места на диске');
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('203.0.113.10'), false);
});

test('Telegram config is disabled by default and validates secret/chat/minimum severity when enabled', () => {
  assert.deepEqual(validateConfig({}), { ok: true, enabled: false });
  assert.equal(
    validateConfig({
      TELEGRAM_ALERTS_ENABLED: '1',
      TELEGRAM_BOT_TOKEN: 'bad',
      TELEGRAM_CHAT_ID: '-100123',
      TELEGRAM_ALERT_MIN_SEVERITY: 'critical'
    }).reason,
    'invalid-bot-token'
  );
  assert.equal(
    validateConfig({
      TELEGRAM_ALERTS_ENABLED: '1',
      TELEGRAM_BOT_TOKEN: config().token,
      TELEGRAM_CHAT_ID: 'channel-name',
      TELEGRAM_ALERT_MIN_SEVERITY: 'critical'
    }).reason,
    'invalid-chat-id'
  );
  const valid = validateConfig({
    TELEGRAM_ALERTS_ENABLED: '1',
    TELEGRAM_BOT_TOKEN: config().token,
    TELEGRAM_CHAT_ID: config().chatId,
    TELEGRAM_ALERT_MIN_SEVERITY: 'warning'
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.enabled, true);
  assert.equal(valid.minSeverity, 'warning');
});

test('default policy delivers a critical incident once and deduplicates it across service restart', async () => {
  const ctx = tempState();
  const sent = [];
  const currentFeed = feed({ active: [alert()] });
  const send = async text => {
    sent.push(text);
    return { ok: true };
  };
  try {
    let result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: currentFeed }),
      send
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /CRITICAL/);
    assert.match(sent[0], /Игровой сервер недоступен/);

    const persisted = loadState(ctx.file);
    assert.equal(persisted.ok, true);
    assert.equal(persisted.records[0].sentSeverity, 'critical');

    result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 60_000,
      getFeed: async () => ({ ok: true, feed: currentFeed }),
      send
    });
    assert.equal(result.ok, true);
    assert.equal(sent.length, 1);
  } finally {
    ctx.cleanup();
  }
});

test('warning is ignored by default but optional warning policy delivers it and later critical escalation', async () => {
  const ctx = tempState();
  const sent = [];
  let currentFeed = feed({ active: [alert({ severity: 'warning' })] });
  const send = async text => {
    sent.push(text);
    return { ok: true };
  };
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: currentFeed }),
      send
    });
    assert.equal(sent.length, 0);

    await deliveryPass({
      config: config('warning'),
      stateFile: ctx.file,
      now: 40_000,
      getFeed: async () => ({ ok: true, feed: currentFeed }),
      send
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /WARNING/);

    currentFeed = feed({ active: [alert({ severity: 'critical', lastSeenAt: 50_000 })] });
    await deliveryPass({
      config: config('warning'),
      stateFile: ctx.file,
      now: 50_000,
      getFeed: async () => ({ ok: true, feed: currentFeed }),
      send
    });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /повышен до CRITICAL/);
  } finally {
    ctx.cleanup();
  }
});

test('delivered incident sends one recovery and does not repeat recovery after restart', async () => {
  const ctx = tempState();
  const sent = [];
  const send = async text => {
    sent.push(text);
    return { ok: true };
  };
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()] }) }),
      send
    });
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 70_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ state: 'resolved', lastSeenAt: 60_000, resolvedAt: 65_000 })]
        })
      }),
      send
    });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /восстановлено/);

    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 90_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ state: 'resolved', lastSeenAt: 60_000, resolvedAt: 65_000 })]
        })
      }),
      send
    });
    assert.equal(sent.length, 2);
  } finally {
    ctx.cleanup();
  }
});

test('incident that resolves during Telegram outage becomes one recovered-summary notification', async () => {
  const ctx = tempState();
  const sent = [];
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()] }) }),
      send: async () => ({ ok: false, reason: 'telegram-network' })
    });
    let state = loadState(ctx.file);
    assert.equal(state.records[0].pending.kind, 'opened');

    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 40_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ state: 'resolved', lastSeenAt: 35_000, resolvedAt: 36_000 })]
        })
      }),
      send: async text => {
        sent.push(text);
        return { ok: true };
      }
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /произошёл и уже восстановлен/);
    state = loadState(ctx.file);
    assert.equal(state.records[0].resolvedSent, true);
  } finally {
    ctx.cleanup();
  }
});

test('stale or unhealthy Alert Center feed never invents new delivery or recovery', async () => {
  const ctx = tempState();
  const sent = [];
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()], stale: true }) }),
      send: async text => {
        sent.push(text);
        return { ok: true };
      }
    });
    assert.equal(sent.length, 0);
    assert.equal(fs.existsSync(ctx.file), false);

    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 40_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()], storageHealthy: false }) }),
      send: async text => {
        sent.push(text);
        return { ok: true };
      }
    });
    assert.equal(sent.length, 0);
  } finally {
    ctx.cleanup();
  }
});

test('retry backoff is bounded and Telegram retry_after is honored', () => {
  assert.equal(retryDelayMs(0), 15_000);
  assert.equal(retryDelayMs(1), 30_000);
  assert.equal(retryDelayMs(999), 30 * 60_000);
  assert.equal(retryDelayMs(0, 7), 7_000);
  assert.equal(retryDelayMs(0, 0), 5_000);
  assert.equal(retryDelayMs(0, 99999), 60 * 60_000);
});

test('Telegram destination is fixed and only the validated token changes the bot path', () => {
  const body = JSON.stringify({ chat_id: config().chatId, text: 'test' });
  const options = telegramRequestOptions(config().token, body);
  assert.equal(options.host, TELEGRAM_HOST);
  assert.equal(options.port, TELEGRAM_PORT);
  assert.equal(options.servername, TELEGRAM_HOST);
  assert.equal(options.path, `/bot${config().token}/sendMessage`);
  assert.equal(CONTROL_HOST, '127.0.0.1');
  assert.equal(CONTROL_PORT, 3001);
  assert.equal(CONTROL_PATH, '/internal/alerts/delivery');
});

test('corrupt notifier state fails closed and state never contains Telegram credentials', () => {
  const ctx = tempState();
  try {
    fs.writeFileSync(ctx.file, '{broken');
    assert.equal(loadState(ctx.file).ok, false);
    fs.rmSync(ctx.file);
    const record = {
      id: ALERT_ID,
      rule: 'game-unavailable',
      openedAt: 10_000,
      lastSeenAt: 20_000,
      resolvedAt: null,
      latestSeverity: 'critical',
      sentSeverity: null,
      resolvedSent: false,
      pending: { kind: 'opened', severity: 'critical', attempts: 0, nextAttemptAt: 30_000 }
    };
    assert.equal(writeState(ctx.file, [record]), true);
    const raw = fs.readFileSync(ctx.file, 'utf8');
    assert.equal(raw.includes(config().token), false);
    assert.equal(raw.includes(config().chatId), false);
    assert.equal(raw.includes('secret-context'), false);
  } finally {
    ctx.cleanup();
  }
});

test('corrupt durable notifier state blocks feed reads and Telegram sends', async () => {
  const ctx = tempState();
  let feedCalls = 0;
  let sendCalls = 0;
  try {
    fs.writeFileSync(ctx.file, '{broken');
    const result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => {
        feedCalls += 1;
        return { ok: true, feed: feed({ active: [alert()] }) };
      },
      send: async () => {
        sendCalls += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(result, { ok: false, reason: 'state-corrupt' });
    assert.equal(feedCalls, 0);
    assert.equal(sendCalls, 0);
  } finally {
    ctx.cleanup();
  }
});

test('durable retry timestamp is not reset by observing the same still-active incident', async () => {
  const ctx = tempState();
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()] }) }),
      send: async () => ({ ok: false, reason: 'telegram-network' })
    });
    const first = loadState(ctx.file).records[0].pending.nextAttemptAt;
    assert.ok(first > 30_000);
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 31_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert({ lastSeenAt: 31_000 })] }) }),
      send: async () => {
        throw new Error('backoff should prevent an early retry');
      }
    });
    assert.equal(loadState(ctx.file).records[0].pending.nextAttemptAt, first);
  } finally {
    ctx.cleanup();
  }
});

test('critical escalation that resolves before notifier observes it is still reported as recovered escalation', async () => {
  const ctx = tempState();
  const sent = [];
  try {
    await deliveryPass({
      config: config('warning'),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert({ severity: 'warning' })] }) }),
      send: async text => {
        sent.push(text);
        return { ok: true };
      }
    });
    await deliveryPass({
      config: config('warning'),
      stateFile: ctx.file,
      now: 60_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [
            alert({ severity: 'critical', state: 'resolved', lastSeenAt: 50_000, resolvedAt: 55_000 })
          ]
        })
      }),
      send: async text => {
        sent.push(text);
        return { ok: true };
      }
    });
    assert.equal(sent.length, 2);
    assert.match(sent[1], /критическое ухудшение уже восстановлено/);
  } finally {
    ctx.cleanup();
  }
});
