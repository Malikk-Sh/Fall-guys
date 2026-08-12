from pathlib import Path

path = Path('tools/pr76_codex_fixes.py')
text = path.read_text(encoding='utf-8')

old = '''    """            SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,\n""",'''
new = '''    """        SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,\n""",'''
if text.count(old) != 1:
    raise SystemExit(f'summary selector repair expected exactly one match, got {text.count(old)}')
text = text.replace(old, new, 1)

old = '''    """  verifyLegacyBackup,\n  createSnapshot,\n""",'''
new = '''    """  verifyLegacyBackup,\n  verifyBackup,\n  createLegacySnapshot,\n  createSnapshot,\n""",'''
if text.count(old) != 1:
    raise SystemExit(f'backup export selector repair expected exactly one match, got {text.count(old)}')
text = text.replace(old, new, 1)

old = '''    """  verifyLegacyBackup,\n  scrubEphemeralBackupData,\n  createSnapshot,\n""",'''
new = '''    """  verifyLegacyBackup,\n  verifyBackup,\n  createLegacySnapshot,\n  scrubEphemeralBackupData,\n  createSnapshot,\n""",'''
if text.count(old) != 1:
    raise SystemExit(f'backup export replacement repair expected exactly one match, got {text.count(old)}')
text = text.replace(old, new, 1)

old = "type: 'find_coop'"
new = "type: 'findCoop'"
if text.count(old) != 1:
    raise SystemExit(f'drain regression message repair expected exactly one match, got {text.count(old)}')
text = text.replace(old, new, 1)

old = "waitFor(client, 'matchmaking_waiting')"
new = "waitFor(client, 'matchmakingWaiting')"
if text.count(old) != 1:
    raise SystemExit(f'matchmaking response repair expected exactly one match, got {text.count(old)}')
text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
