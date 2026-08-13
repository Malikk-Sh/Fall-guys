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
    """const EVENT_KINDS = new Set(['opened', 'escalated', 'recovered', 'recovered-summary', 'escalated-recovered']);
""",
    """const EVENT_KINDS = new Set(['opened', 'escalated', 'recovered', 'recovered-summary', 'escalated-recovered']);
const FATAL_STATE_REASONS = new Set(['state-corrupt', 'state-unavailable', 'state-uncertain']);
""",
)
replace_once(
    notifier,
    """    if (parsed?.version !== STATE_VERSION || !Array.isArray(parsed.alerts)) {
      return { ok: false, records: [] };
    }
""",
    """    if (
      parsed?.version !== STATE_VERSION ||
      !Array.isArray(parsed.alerts) ||
      parsed.alerts.length > MAX_RECORDS
    ) {
      return { ok: false, records: [] };
    }
""",
)
replace_once(
    notifier,
    """    return { ok: true, records: records.slice(-MAX_RECORDS) };
""",
    """    return { ok: true, records };
""",
)
replace_once(
    notifier,
    """  for (const alert of feed.resolved) {
    const record = ensureRecord(records, alert);
    const escalatedPastDelivery =
""",
    """  for (const alert of feed.resolved) {
    const existing = records.find(item => item.id === alert.id);
    const record = ensureRecord(records, alert);
    if (!existing) {
      // A bounded resolved history is context, not a replay queue. Baseline old incidents as complete
      // so enabling Telegram cannot flood the operator with recoveries from before the notifier ran.
      record.resolvedSent = true;
      record.pending = null;
      changed = true;
      continue;
    }
    const escalatedPastDelivery =
""",
)
replace_once(
    notifier,
    """    } else if (!record.sentSeverity && qualifies(alert.severity, minSeverity) && !record.resolvedSent) {
      changed = schedule(record, 'recovered-summary', alert.severity, now) || changed;
    }
  }
""",
    """    } else if (!record.sentSeverity && qualifies(alert.severity, minSeverity) && !record.resolvedSent) {
      changed = schedule(record, 'recovered-summary', alert.severity, now) || changed;
    } else if (!record.sentSeverity && !record.resolvedSent) {
      // The incident never met this notifier's severity policy. Mark it complete once resolved so it
      // remains safely evictable instead of consuming the protected retry/dedup budget forever.
      record.resolvedSent = true;
      changed = true;
    }
  }
""",
)
replace_once(
    notifier,
    """    } else if (record.sentSeverity && !record.resolvedSent) {
      changed = schedule(record, 'recovered', record.sentSeverity, now) || changed;
    }
  }
  return changed;
}
""",
    """    } else if (record.sentSeverity && !record.resolvedSent) {
      changed = schedule(record, 'recovered', record.sentSeverity, now) || changed;
    } else if (!record.sentSeverity && !record.resolvedSent) {
      record.resolvedSent = true;
      changed = true;
    }
  }
  return changed;
}
""",
)
replace_once(
    notifier,
    """function safeLog(event, fields = {}) {
""",
    """function isFatalStateFailure(reason) {
  return FATAL_STATE_REASONS.has(String(reason || ''));
}

function safeLog(event, fields = {}) {
""",
)
replace_once(
    notifier,
    """      const result = await deliveryPass({ config, stateFile });
      if (!result.ok) safeLog('telegram_alert_pass_failed', { reason: result.reason });
""",
    """      const result = await deliveryPass({ config, stateFile });
      if (!result.ok) {
        safeLog('telegram_alert_pass_failed', { reason: result.reason });
        if (isFatalStateFailure(result.reason)) {
          // Dedup/backoff state is authoritative for external delivery. Continuing without it risks
          // Telegram spam, especially after a send succeeded but its acknowledgement could not persist.
          process.exitCode = 78;
          return;
        }
      }
""",
)
replace_once(
    notifier,
    """  loadState,
  normalizeFeed,
""",
    """  isFatalStateFailure,
  loadState,
  normalizeFeed,
""",
)

tests = Path('server/telegramAlertDelivery.test.mjs')
replace_once(
    tests,
    """  deliveryPass,
  loadState,
""",
    """  deliveryPass,
  isFatalStateFailure,
  loadState,
""",
)
tests.write_text(
    tests.read_text()
    + r'''

test('first startup baselines old resolved history instead of replaying historical Telegram recoveries', async () => {
  const ctx = tempState();
  let sends = 0;
  try {
    const result = await deliveryPass({
      config: config(),
      stateFile: ctx.file,
      now: 80_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ state: 'resolved', lastSeenAt: 60_000, resolvedAt: 65_000 })]
        })
      }),
      send: async () => {
        sends += 1;
        return { ok: true };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(sends, 0);
    const record = loadState(ctx.file).records[0];
    assert.equal(record.resolvedSent, true);
    assert.equal(record.pending, null);
  } finally {
    ctx.cleanup();
  }
});

test('below-threshold warning becomes completed and evictable after resolution', async () => {
  const ctx = tempState();
  let sends = 0;
  try {
    await deliveryPass({
      config: config('critical'),
      stateFile: ctx.file,
      now: 30_000,
      getFeed: async () => ({ ok: true, feed: feed({ active: [alert({ severity: 'warning' })] }) }),
      send: async () => {
        sends += 1;
        return { ok: true };
      }
    });
    let record = loadState(ctx.file).records[0];
    assert.equal(record.sentSeverity, null);
    assert.equal(record.resolvedSent, false);

    await deliveryPass({
      config: config('critical'),
      stateFile: ctx.file,
      now: 70_000,
      getFeed: async () => ({
        ok: true,
        feed: feed({
          resolved: [alert({ severity: 'warning', state: 'resolved', lastSeenAt: 60_000, resolvedAt: 65_000 })]
        })
      }),
      send: async () => {
        sends += 1;
        return { ok: true };
      }
    });
    record = loadState(ctx.file).records[0];
    assert.equal(record.resolvedSent, true);
    assert.equal(record.pending, null);
    assert.equal(sends, 0);
  } finally {
    ctx.cleanup();
  }
});

test('all durable-state failures are fatal to the notifier delivery loop', () => {
  assert.equal(isFatalStateFailure('state-corrupt'), true);
  assert.equal(isFatalStateFailure('state-unavailable'), true);
  assert.equal(isFatalStateFailure('state-uncertain'), true);
  assert.equal(isFatalStateFailure('feed-unavailable'), false);
  assert.equal(isFatalStateFailure('telegram-network'), false);
});
'''
)

docs = Path('docs/TELEGRAM-ALERT-DELIVERY.md')
replace_once(
    docs,
    """For each alert UUID the notifier tracks the highest severity successfully delivered and whether recovery was delivered. A process restart therefore cannot resend the same successful notification.

Failed delivery uses bounded exponential backoff.
""",
    """For each alert UUID the notifier tracks the highest severity successfully delivered and whether recovery was delivered. A process restart therefore cannot resend the same successful notification. Existing resolved Alert Center history is baselined as complete on first sight rather than replayed when Telegram is enabled.

Any corruption/unavailability/uncertainty of the notifier's own durable state stops delivery fail-closed. This is intentional: continuing after Telegram accepted a message but its local dedup acknowledgement could not be persisted could otherwise create a resend loop.

Failed delivery uses bounded exponential backoff.
""",
)
