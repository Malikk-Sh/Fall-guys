'use strict';

const { sendTelegram, validateConfig } = require('./telegramAlertDelivery');

const TEST_MESSAGE = '✅ Wobble Control: Telegram alerts настроены и доставка работает.';

async function runTelegramAlertTest({ env = process.env, send = sendTelegram } = {}) {
  const config = validateConfig(env);
  if (!config.ok) return { ok: false, reason: config.reason, configError: true };
  if (!config.enabled) return { ok: false, reason: 'telegram-alerts-disabled', configError: true };
  const result = await send(TEST_MESSAGE, config);
  return result?.ok ? { ok: true } : { ok: false, reason: String(result?.reason || 'telegram-test-failed') };
}

async function main() {
  let result;
  try {
    result = await runTelegramAlertTest();
  } catch {
    result = { ok: false, reason: 'unexpected-error' };
  }
  if (result.ok) {
    console.log(JSON.stringify({ event: 'telegram_alert_test_delivered' }));
    return;
  }
  console.error(
    JSON.stringify({
      event: 'telegram_alert_test_failed',
      reason: result.reason
    })
  );
  process.exitCode = result.configError ? 78 : 1;
}

if (require.main === module) void main();

module.exports = { TEST_MESSAGE, runTelegramAlertTest };
