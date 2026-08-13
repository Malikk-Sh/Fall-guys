import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TEST_MESSAGE, runTelegramAlertTest } = require('./telegramAlertTest');

const VALID_ENV = Object.freeze({
  TELEGRAM_ALERTS_ENABLED: '1',
  TELEGRAM_BOT_TOKEN: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi_123',
  TELEGRAM_CHAT_ID: '-1001234567890',
  TELEGRAM_ALERT_MIN_SEVERITY: 'critical'
});

test('Telegram one-shot test refuses disabled or invalid configuration without sending', async () => {
  let sends = 0;
  const send = async () => {
    sends += 1;
    return { ok: true };
  };
  assert.deepEqual(await runTelegramAlertTest({ env: {}, send }), {
    ok: false,
    reason: 'telegram-alerts-disabled',
    configError: true
  });
  assert.equal(sends, 0);
  const invalid = await runTelegramAlertTest({
    env: { ...VALID_ENV, TELEGRAM_BOT_TOKEN: 'bad-token' },
    send
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-bot-token');
  assert.equal(invalid.configError, true);
  assert.equal(sends, 0);
});

test('Telegram one-shot test sends only the fixed verification text through validated config', async () => {
  let observed = null;
  const result = await runTelegramAlertTest({
    env: { ...VALID_ENV },
    send: async (text, config) => {
      observed = { text, chatId: config.chatId, minSeverity: config.minSeverity };
      return { ok: true };
    }
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(observed, {
    text: TEST_MESSAGE,
    chatId: VALID_ENV.TELEGRAM_CHAT_ID,
    minSeverity: 'critical'
  });
  assert.equal(TEST_MESSAGE.includes(VALID_ENV.TELEGRAM_BOT_TOKEN), false);
});

test('Telegram one-shot test exposes only a safe failure reason', async () => {
  const result = await runTelegramAlertTest({
    env: { ...VALID_ENV },
    send: async () => ({ ok: false, reason: 'telegram-auth' })
  });
  assert.deepEqual(result, { ok: false, reason: 'telegram-auth' });
  assert.equal(JSON.stringify(result).includes(VALID_ENV.TELEGRAM_BOT_TOKEN), false);
});
