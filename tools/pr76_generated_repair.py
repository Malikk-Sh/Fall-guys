from pathlib import Path

path = Path('server/incidentDiagnostics.js')
text = path.read_text(encoding='utf-8')
old = """function cleanAccountId(value) {
  const id = String(value || '').trim();
  return id && id.length <= 160 && !/[\\u0000-\\u001f\\u007f]/.test(id) ? id : '';
}
"""
new = """function cleanAccountId(value) {
  const id = String(value || '').trim();
  if (!id || id.length > 160) return '';
  for (const character of id) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return '';
  }
  return id;
}
"""
if text.count(old) != 1:
    raise SystemExit(f'cleanAccountId lint repair expected 1 match, got {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
