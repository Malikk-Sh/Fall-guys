from pathlib import Path

path = Path('server/telegramAlertDelivery.js')
text = path.read_text()
old = """function retryDelayMs(attempts, retryAfterSeconds = null) {
  if (Number.isFinite(Number(retryAfterSeconds))) {
"""
new = """function retryDelayMs(attempts, retryAfterSeconds = null) {
  if (retryAfterSeconds != null && Number.isFinite(Number(retryAfterSeconds))) {
"""
if text.count(old) != 1:
    raise SystemExit(f'expected one retryDelayMs guard, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
