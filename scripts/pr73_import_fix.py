from pathlib import Path

p = Path('client/net/NetworkManager.js')
text = p.read_text()
old = "import { C2S, S2C, PROTOCOL_VERSION } from '/shared/protocol.js';"
new = "import { C2S, S2C, ERROR_CODES, PROTOCOL_VERSION } from '/shared/protocol.js';"
if old not in text:
    raise SystemExit('NetworkManager protocol import anchor missing')
p.write_text(text.replace(old, new, 1))
