# Wobble Control — Telegram Alert Delivery

PR #82 adds **outbound Telegram delivery** for the privacy-safe Alert Center lifecycle introduced in #81.

## Security boundary

Telegram delivery is deliberately **not** implemented inside `wobble.service`, `wobble-control.service`, or the privileged `wobble-ops` helper.

A separate unprivileged service owns the Telegram token and outbound network access:

```text
Alert Center (wobble-control :3001)
        |
        | loopback-only sanitized feed
        v
wobble-telegram-alerts.service
        |
        | HTTPS only to fixed api.telegram.org
        v
Telegram Bot API
```

The delivery service:

- runs under `DynamicUser=yes`;
- has no access to the gameplay SQLite database;
- has no admin cookies/sessions or player/account data;
- has no access to `/run/wobble-ops.sock` and cannot execute Operations;
- receives no arbitrary destination URL from HTTP or environment;
- talks only to the fixed local feed `127.0.0.1:3001` and fixed Telegram host `api.telegram.org`;
- keeps its own bounded dedup/retry state under `/var/lib/wobble-telegram-alerts`;
- reads its bot token/chat ID only from root-owned `/etc/wobble-telegram.env`.

A compromise of gameplay or the browser-facing Control Plane therefore does not directly expose the Telegram token through their process environment.

## Local delivery feed

`wobble-control.service` exposes a loopback-only GET endpoint for the notifier.

The feed contains only fields already safe enough for an operator notification:

- alert UUID;
- allowlisted rule ID;
- `warning|critical`;
- `active|resolved`;
- opened/last-seen/resolved timestamps;
- fixed title;
- fixed recommended panel.

It does **not** contain acknowledgement admin names, context payloads, player/account IDs, IP/User-Agent, raw logs, raw exception text, cookies, credentials or arbitrary browser input.

The notifier does not run Infrastructure/Reliability probes itself; it only consumes the cached Alert Center lifecycle.

## Delivery policy

Default minimum severity is `critical`.

A Telegram message is generated when:

1. a qualifying incident is first observed by the notifier;
2. an already-delivered `warning` escalates to `critical`;
3. an incident previously delivered to Telegram becomes resolved.

If Telegram is unavailable while an incident opens and the incident resolves before successful delivery, the notifier sends one compact **occurred + recovered** summary instead of a stale open notification followed by a recovery notification.

Set `TELEGRAM_ALERT_MIN_SEVERITY=warning` to deliver warning incidents too.

Acknowledgement in Wobble Control is intentionally separate from Telegram delivery. Acknowledging an incident does not cancel recovery delivery and does not mutate the source health signal.

## Deduplication and retry

The notifier owns durable state in:

```text
/var/lib/wobble-telegram-alerts/state.json
```

State is written atomically (`temp -> fsync -> rename -> fsync directory`) and contains only alert IDs, safe severity/state timestamps and retry metadata.

For each alert UUID the notifier tracks the highest severity successfully delivered and whether recovery was delivered. A process restart therefore cannot resend the same successful notification. Existing resolved Alert Center history is baselined as complete on first sight rather than replayed when Telegram is enabled.

Any corruption/unavailability/uncertainty of the notifier's own durable state stops delivery fail-closed. This is intentional: continuing after Telegram accepted a message but its local dedup acknowledgement could not be persisted could otherwise create a resend loop.

Failed delivery uses bounded exponential backoff. Telegram `429` `retry_after` is honored within a safe bounded range. Pending delivery/retry is attempted only after a fresh healthy Alert Center feed has first reconciled the incident lifecycle; stale/unavailable feed state therefore cannot trigger a stale external notification. Configuration/auth failures also back off rather than generating a hot loop.

The queue is bounded and delivery work per polling pass is capped, preventing a remote outage from turning recovery into a request storm.

## Telegram request contract

The Bot API request is a POST to the fixed host/path:

```text
https://api.telegram.org/bot<TOKEN>/sendMessage
```

Only these values are configurable:

- bot token;
- numeric chat ID;
- minimum severity.

The service does not accept a custom Telegram API host, generic webhook URL, arbitrary HTTP headers, arbitrary path or arbitrary proxy destination.

Messages use plain text (no Telegram Markdown/HTML parsing) and no link preview.

The token is never logged, included in Alert Center state, returned through Wobble HTTP APIs or stored in the delivery state file.

## Configuration

The installer creates `/etc/wobble-telegram.env` once, mode `0600`, with Telegram disabled by default:

```text
TELEGRAM_ALERTS_ENABLED=0
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALERT_MIN_SEVERITY=critical
```

After configuring the bot, set `TELEGRAM_ALERTS_ENABLED=1` and rerun `deploy/install.sh` (or enable/start only the notifier service manually).

A real delivery can be verified without manufacturing a production incident:

```bash
systemctl start wobble-telegram-alert-test.service
journalctl -u wobble-telegram-alert-test.service -n 20 --no-pager
```

The one-shot unit sends only the fixed text `Wobble Control: Telegram alerts настроены и доставка работает.` through the same validated secret/egress boundary. It cannot accept arbitrary message text, destination URL, player data or an Operations command and it does not touch notifier dedup state.

The normal Wobble deploy must remain successful when Telegram is unconfigured or unavailable. External delivery is never a gameplay/control-plane readiness dependency.

## Failure isolation

- Telegram outage does not modify Alert Center lifecycle.
- Telegram outage does not affect gameplay, admin login, Reliability, Infrastructure or Operations.
- Invalid Telegram configuration prevents only the notifier from starting.
- A missing Control Plane feed causes retry/backoff only in the notifier.
- The notifier cannot trigger root actions.
- No inbound Telegram commands/webhooks are implemented in this PR.

## Acceptance checks

Focused tests cover:

- delivery feed drops context/acknowledgement/private fields;
- non-loopback feed access is rejected;
- token/chat-ID validation;
- default critical-only policy and optional warning policy;
- open, escalation and recovery deduplication across notifier restart;
- open-while-offline then resolved -> one recovered-summary notification;
- exponential retry and Telegram `429 retry_after`;
- atomic bounded state persistence;
- request host/path cannot be redirected by configuration;
- Telegram token never appears in delivery state/log event payloads;
- systemd DynamicUser/state/environment boundaries;
- installer leaves Telegram disabled by default and does not overwrite an existing secret file;
- one-shot fixed delivery verification uses an isolated DynamicUser unit and never mutates notifier state;
- standard `npm test` includes the notifier regressions.
