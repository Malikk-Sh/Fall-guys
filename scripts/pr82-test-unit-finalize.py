from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, found {count}: {old[:180]!r}")
    path.write_text(text.replace(old, new, 1))


install = Path('deploy/install.sh')
replace_once(
    install,
    'cp "$APP_DIR/deploy/wobble-telegram-alerts.service" /etc/systemd/system/wobble-telegram-alerts.service\n',
    'cp "$APP_DIR/deploy/wobble-telegram-alerts.service" /etc/systemd/system/wobble-telegram-alerts.service\n'
    'cp "$APP_DIR/deploy/wobble-telegram-alert-test.service" /etc/systemd/system/wobble-telegram-alert-test.service\n',
)

docs = Path('docs/TELEGRAM-ALERT-DELIVERY.md')
replace_once(
    docs,
    """After configuring the bot, set `TELEGRAM_ALERTS_ENABLED=1` and rerun `deploy/install.sh` (or enable/start only the notifier service manually).

The normal Wobble deploy must remain successful when Telegram is unconfigured or unavailable. External delivery is never a gameplay/control-plane readiness dependency.
""",
    """After configuring the bot, set `TELEGRAM_ALERTS_ENABLED=1` and rerun `deploy/install.sh` (or enable/start only the notifier service manually).

A real delivery can be verified without manufacturing a production incident:

```bash
systemctl start wobble-telegram-alert-test.service
journalctl -u wobble-telegram-alert-test.service -n 20 --no-pager
```

The one-shot unit sends only the fixed text `Wobble Control: Telegram alerts настроены и доставка работает.` through the same validated secret/egress boundary. It cannot accept arbitrary message text, destination URL, player data or an Operations command and it does not touch notifier dedup state.

The normal Wobble deploy must remain successful when Telegram is unconfigured or unavailable. External delivery is never a gameplay/control-plane readiness dependency.
""",
)
replace_once(
    docs,
    """- installer leaves Telegram disabled by default and does not overwrite an existing secret file;
- standard `npm test` includes the notifier regressions.
""",
    """- installer leaves Telegram disabled by default and does not overwrite an existing secret file;
- one-shot fixed delivery verification uses an isolated DynamicUser unit and never mutates notifier state;
- standard `npm test` includes the notifier regressions.
""",
)
