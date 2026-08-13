from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    path.write_text(text.replace(old, new, 1))


notifier = Path('server/telegramAlertDelivery.js')
replace_once(
    notifier,
    """  if (feedResult.ok && feedResult.feed.storageHealthy && !feedResult.feed.evaluationStale) {
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
""",
    """  if (feedResult.ok && feedResult.feed.storageHealthy && !feedResult.feed.evaluationStale) {
    if (reconcile(records, feedResult.feed, config.minSeverity, now) && !writeState(stateFile, records)) {
      return { ok: false, reason: 'state-unavailable' };
    }
    // Reconcile against a fresh authoritative lifecycle before any external send/retry. A stale or
    // unavailable feed may hide a recovery, so delivering an old pending 'open' in that state could
    // create a false current alert in Telegram.
    return processDue(records, config, stateFile, { now, send });
  }
  if (!feedResult.ok) {
    safeLog('telegram_alert_feed_unavailable', { reason: feedResult.reason });
  } else {
    safeLog('telegram_alert_feed_degraded', {
      reason: feedResult.feed.storageHealthy ? 'evaluation-stale' : 'alert-state-unhealthy'
    });
  }
  return { ok: true, deferred: true };
""",
)

tests = Path('server/telegramAlertDelivery.test.mjs')
tests.write_text(
    tests.read_text()
    + r'''

test('pending Telegram retry waits for a fresh healthy Alert Center feed before sending', async () => {
  const ctx = tempState();
  let sends = 0;
  try {
    await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert()] }) }),
      send: async () => ({ ok: false, reason: 'telegram-network' })
    });
    const retryAt = loadState(ctx.file).records[0].pending.nextAttemptAt;

    let result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: retryAt + 1,
      getFeed: async () => ({ ok: false, reason: 'feed-unavailable' }),
      send: async () => {
        sends += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(result, { ok: true, deferred: true });
    assert.equal(sends, 0);

    result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: retryAt + 2,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert({ lastSeenAt: retryAt + 2 })], stale: true }) }),
      send: async () => {
        sends += 1;
        return { ok: true };
      }
    });
    assert.deepEqual(result, { ok: true, deferred: true });
    assert.equal(sends, 0);

    result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: retryAt + 3,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ state: 'resolved', lastSeenAt: retryAt, resolvedAt: retryAt + 1 })]
        })
      }),
      send: async text => {
        sends += 1;
        assert.match(text, /произошёл и уже восстановлен/);
        return { ok: true };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(sends, 1);
  } finally {
    ctx.cleanup();
  }
});
'''
)

docs = Path('docs/TELEGRAM-ALERT-DELIVERY.md')
text = docs.read_text()
needle = "Failed delivery uses bounded exponential backoff.\nTelegram `429` `retry_after` is honored within a safe bounded range."
replacement = "Failed delivery uses bounded exponential backoff. Telegram `429` `retry_after` is honored within a safe bounded range. Pending delivery/retry is attempted only after a fresh healthy Alert Center feed has first reconciled the incident lifecycle; stale/unavailable feed state therefore cannot trigger a stale external notification."
if text.count(needle) != 1:
    raise SystemExit(f'docs: expected one retry paragraph, found {text.count(needle)}')
docs.write_text(text.replace(needle, replacement, 1))
