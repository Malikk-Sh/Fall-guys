from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:160]!r}")
    path.write_text(text.replace(old, new, 1))


notifier = Path('server/telegramAlertDelivery.js')
replace_once(
    notifier,
    "const EVENT_KINDS = new Set(['opened', 'escalated', 'recovered', 'recovered-summary']);",
    "const EVENT_KINDS = new Set([\n  'opened',\n  'escalated',\n  'recovered',\n  'recovered-summary',\n  'escalated-recovered'\n]);",
)
replace_once(
    notifier,
    """    const bounded = boundRecords(normalized);
    fd = fs.openSync(temporary, 'w', 0o600);
""",
    """    const bounded = boundRecords(normalized);
    if (!bounded) return false;
    fd = fs.openSync(temporary, 'w', 0o600);
""",
)
replace_once(
    notifier,
    """function boundRecords(records) {
  if (records.length <= MAX_RECORDS) return records;
  const protectedIds = new Set(records.filter(item => item.pending || !item.resolvedSent).map(item => item.id));
  const removable = records
    .filter(item => !protectedIds.has(item.id))
    .sort((a, b) => (a.resolvedAt || a.lastSeenAt) - (b.resolvedAt || b.lastSeenAt));
  const removeCount = Math.max(0, records.length - MAX_RECORDS);
  const removed = new Set(removable.slice(0, removeCount).map(item => item.id));
  return records.filter(item => !removed.has(item.id)).slice(-MAX_RECORDS);
}
""",
    """function boundRecords(records) {
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
""",
)
replace_once(
    notifier,
    """function schedule(record, kind, severity, now) {
  if (!EVENT_KINDS.has(kind) || !Object.hasOwn(SEVERITY_RANK, severity)) return false;
  if (
    record.pending &&
    record.pending.kind === kind &&
    record.pending.severity === severity &&
    record.pending.nextAttemptAt <= now
  ) {
    return false;
  }
  const attempts = record.pending?.kind === kind ? record.pending.attempts : 0;
  record.pending = { kind, severity, attempts, nextAttemptAt: Math.min(record.pending?.nextAttemptAt || now, now) };
  return true;
}
""",
    """function schedule(record, kind, severity, now) {
  if (!EVENT_KINDS.has(kind) || !Object.hasOwn(SEVERITY_RANK, severity)) return false;
  if (record.pending?.kind === kind && record.pending?.severity === severity) {
    // Preserve durable backoff. Re-observing the same incident must not pull retryAt back to now.
    return false;
  }
  record.pending = { kind, severity, attempts: 0, nextAttemptAt: now };
  return true;
}
""",
)
replace_once(
    notifier,
    """function reconcile(records, feed, minSeverity, now) {
  let changed = false;
  const activeIds = new Set();
  for (const alert of feed.active) {
""",
    """function reconcile(records, feed, minSeverity, now) {
  let changed = false;
  const activeIds = new Set();
  const resolvedIds = new Set(feed.resolved.map(item => item.id));
  for (const alert of feed.active) {
""",
)
replace_once(
    notifier,
    """  for (const alert of feed.resolved) {
    const record = ensureRecord(records, alert);
    if (record.pending?.kind === 'opened' || record.pending?.kind === 'escalated') {
      if (qualifies(record.pending.severity, minSeverity)) {
        record.pending = {
          kind: record.sentSeverity ? 'recovered' : 'recovered-summary',
          severity: record.pending.severity,
          attempts: 0,
          nextAttemptAt: now
        };
        changed = true;
      } else {
        record.pending = null;
        changed = true;
      }
    } else if (record.sentSeverity && !record.resolvedSent) {
      changed = schedule(record, 'recovered', record.sentSeverity, now) || changed;
    } else if (!record.sentSeverity && qualifies(alert.severity, minSeverity) && !record.resolvedSent) {
      changed = schedule(record, 'recovered-summary', alert.severity, now) || changed;
    }
  }

  // Records no longer present in the bounded feed are kept for deduplication but never inferred resolved.
  for (const record of records) {
    if (!activeIds.has(record.id) && record.resolvedAt == null && !feed.resolved.some(item => item.id === record.id)) {
      continue;
    }
  }
  return changed;
}
""",
    """  for (const alert of feed.resolved) {
    const record = ensureRecord(records, alert);
    const escalatedPastDelivery =
      record.sentSeverity && SEVERITY_RANK[alert.severity] > SEVERITY_RANK[record.sentSeverity];
    if (record.pending?.kind === 'opened' || record.pending?.kind === 'escalated') {
      if (qualifies(record.pending.severity, minSeverity)) {
        record.pending = {
          kind: record.sentSeverity && SEVERITY_RANK[record.pending.severity] > SEVERITY_RANK[record.sentSeverity]
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
""",
)
replace_once(
    notifier,
    """  if (pending.kind === 'recovered-summary') {
    return [
      '🟢 Wobble: инцидент произошёл и уже восстановлен',
      meta.title,
      `Инцидент: ${shortId}`,
      `Уровень: ${severity}`,
      `Открыт: ${iso(record.openedAt)}`,
      `Восстановлен: ${iso(record.resolvedAt)}`,
      `Раздел: ${panelLabel(meta.recommendedPanel)}`
    ].join('\\n');
  }
""",
    """  if (pending.kind === 'recovered-summary' || pending.kind === 'escalated-recovered') {
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
    ].join('\\n');
  }
""",
)
replace_once(
    notifier,
    """      if (event.kind === 'recovered-summary') {
        record.sentSeverity = event.severity;
        record.resolvedSent = true;
      }
      if (event.kind === 'recovered') record.resolvedSent = true;
""",
    """      if (event.kind === 'recovered-summary' || event.kind === 'escalated-recovered') {
        record.sentSeverity = event.severity;
        record.resolvedSent = true;
      }
      if (event.kind === 'recovered') record.resolvedSent = true;
""",
)
replace_once(
    notifier,
    """    process.exitCode = 1;
    return;
  }
  if (!config.enabled) {
""",
    """    process.exitCode = 78;
    return;
  }
  if (!config.enabled) {
""",
)
replace_once(
    notifier,
    """    safeLog('telegram_alert_state_corrupt', { reason: 'state-corrupt' });
    process.exitCode = 1;
    return;
""",
    """    safeLog('telegram_alert_state_corrupt', { reason: 'state-corrupt' });
    process.exitCode = 78;
    return;
""",
)

unit = Path('deploy/wobble-telegram-alerts.service')
replace_once(
    unit,
    """Restart=on-failure
RestartSec=5s
""",
    """Restart=on-failure
RestartPreventExitStatus=78
RestartSec=5s
""",
)

install = Path('deploy/install.sh')
replace_once(
    install,
    'cp "$APP_DIR/deploy/wobble-control.service" /etc/systemd/system/wobble-control.service\n',
    'cp "$APP_DIR/deploy/wobble-control.service" /etc/systemd/system/wobble-control.service\n'
    'cp "$APP_DIR/deploy/wobble-telegram-alerts.service" /etc/systemd/system/wobble-telegram-alerts.service\n',
)
replace_once(
    install,
    """cp "$APP_DIR/deploy/wobble-ops.service" /etc/systemd/system/wobble-ops.service
cp "$APP_DIR/deploy/wobble-ops.socket" /etc/systemd/system/wobble-ops.socket
# Важно: privileged helper не запускается из /opt/wobble, которым владеет service-user.
""",
    """cp "$APP_DIR/deploy/wobble-ops.service" /etc/systemd/system/wobble-ops.service
cp "$APP_DIR/deploy/wobble-ops.socket" /etc/systemd/system/wobble-ops.socket
telegram_env=/etc/wobble-telegram.env
if [ ! -f "$telegram_env" ]; then
  install -m 0600 -o root -g root "$APP_DIR/deploy/wobble-telegram.env.example" "$telegram_env"
  echo "создан $telegram_env — Telegram alerts выключены до явной настройки"
else
  chown root:root "$telegram_env"
  chmod 600 "$telegram_env"
fi
telegram_alerts_enabled=0
if grep -qE '^TELEGRAM_ALERTS_ENABLED=1[[:space:]]*$' "$telegram_env"; then
  telegram_alerts_enabled=1
fi
# Важно: privileged helper не запускается из /opt/wobble, которым владеет service-user.
""",
)
replace_once(
    install,
    """systemctl enable wobble >/dev/null
systemctl enable wobble-control >/dev/null
systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket wobble-ops.service >/dev/null
systemctl restart wobble-ops.socket
""",
    """systemctl enable wobble >/dev/null
systemctl enable wobble-control >/dev/null
systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket wobble-ops.service >/dev/null
if [ "$telegram_alerts_enabled" = "1" ]; then
  systemctl enable wobble-telegram-alerts >/dev/null
else
  systemctl disable wobble-telegram-alerts >/dev/null 2>&1 || true
  systemctl stop wobble-telegram-alerts >/dev/null 2>&1 || true
fi
systemctl restart wobble-ops.socket
""",
)
replace_once(
    install,
    """[ "$control_ready" -eq 1 ] ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"

remove_shared_stream_include() {
""",
    """[ "$control_ready" -eq 1 ] ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"

if [ "$telegram_alerts_enabled" = "1" ]; then
  say "Telegram Alert Delivery"
  systemctl restart wobble-telegram-alerts >/dev/null 2>&1 || true
  sleep 1
  if systemctl is-active --quiet wobble-telegram-alerts; then
    echo "Telegram notifier запущен"
  else
    warn "Telegram notifier не запущен; основной deploy продолжается независимо"
    warn "проверьте /etc/wobble-telegram.env и journalctl -u wobble-telegram-alerts -n 50 --no-pager"
  fi
fi

remove_shared_stream_include() {
""",
)
replace_once(
    install,
    """echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"
""",
    """echo "Обновление:  bash ${APP_DIR}/deploy/install.sh"
if [ "$telegram_alerts_enabled" = "1" ]; then
  echo "Telegram:     systemctl status wobble-telegram-alerts --no-pager"
else
  echo "Telegram:     выключен (/etc/wobble-telegram.env)"
fi
""",
)

deploy_test = Path('server/controlPlaneDeploy.test.mjs')
replace_once(
    deploy_test,
    """const unit = fs.readFileSync(new URL('../deploy/wobble-control.service', import.meta.url), 'utf8');
""",
    """const unit = fs.readFileSync(new URL('../deploy/wobble-control.service', import.meta.url), 'utf8');
const telegramUnit = fs.readFileSync(
  new URL('../deploy/wobble-telegram-alerts.service', import.meta.url),
  'utf8'
);
const telegramEnvExample = fs.readFileSync(
  new URL('../deploy/wobble-telegram.env.example', import.meta.url),
  'utf8'
);
""",
)
replace_once(
    deploy_test,
    """    'server/controlPlaneAlerts.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
""",
    """    'server/controlPlaneAlerts.test.mjs',
    'server/telegramAlertDelivery.test.mjs',
    'server/controlPlaneDeploy.test.mjs'
""",
)
deploy_test.write_text(
    deploy_test.read_text()
    + r'''

test('Telegram delivery is a separate DynamicUser service with an independent secret and state boundary', () => {
  assert.match(telegramUnit, /^DynamicUser=yes$/m);
  assert.match(telegramUnit, /^EnvironmentFile=\/etc\/wobble-telegram\.env$/m);
  assert.match(telegramUnit, /^StateDirectory=wobble-telegram-alerts$/m);
  assert.match(telegramUnit, /^StateDirectoryMode=0700$/m);
  assert.match(telegramUnit, /^RestartPreventExitStatus=78$/m);
  assert.doesNotMatch(telegramUnit, /^User=(root|wobble)$/m);
  assert.doesNotMatch(telegramUnit, /wobble-ops\.sock/);
  assert.doesNotMatch(telegramUnit, /LEADERBOARD_DB/);
  assert.match(telegramEnvExample, /^TELEGRAM_ALERTS_ENABLED=0$/m);
  assert.match(telegramEnvExample, /^TELEGRAM_BOT_TOKEN=$/m);
  assert.match(telegramEnvExample, /^TELEGRAM_CHAT_ID=$/m);
});

test('installer never overwrites Telegram secrets and does not make notifier health a deploy dependency', () => {
  assert.match(install, /if \[ ! -f "\$telegram_env" \]; then[\s\S]*wobble-telegram\.env\.example/);
  assert.match(install, /chmod 600 "\$telegram_env"/);
  assert.match(install, /TELEGRAM_ALERTS_ENABLED=1/);
  assert.match(install, /systemctl enable wobble-telegram-alerts/);
  assert.match(install, /systemctl disable wobble-telegram-alerts/);
  assert.match(install, /Telegram notifier не запущен; основной deploy продолжается независимо/);
  assert.doesNotMatch(install, /TELEGRAM_BOT_TOKEN=.*\/etc\/wobble\.env/);
});

test('Control Plane exposes only the sanitized Telegram feed on its fixed loopback service', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(control, /app\.get\('\/internal\/alerts\/delivery'/);
  assert.match(control, /isLoopbackAddress\(req\.socket\.remoteAddress\)/);
  assert.match(control, /buildAlertDeliveryFeed\(alerts\.status\(\)\)/);
});
'''
)

telegram_test = Path('server/telegramAlertDelivery.test.mjs')
telegram_test.write_text(
    telegram_test.read_text()
    + r'''

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
          resolved: [alert({ severity: 'critical', state: 'resolved', lastSeenAt: 50_000, resolvedAt: 55_000 })]
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
'''
)
