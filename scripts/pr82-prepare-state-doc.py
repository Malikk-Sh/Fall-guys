from pathlib import Path

path = Path('docs/TELEGRAM-ALERT-DELIVERY.md')
text = path.read_text()
old = 'Failed delivery uses bounded exponential backoff. Telegram `429` `retry_after` is honored within a safe bounded range.'
new = 'Failed delivery uses bounded exponential backoff.\nTelegram `429` `retry_after` is honored within a safe bounded range.'
if text.count(old) != 1:
    raise SystemExit(f'expected one Telegram retry paragraph, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
