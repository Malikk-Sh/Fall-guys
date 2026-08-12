from pathlib import Path

path = Path('tools/pr76_codex_fixes.py')
text = path.read_text(encoding='utf-8')
old = '''    """            SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,\n""",'''
new = '''    """        SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,\n""",'''
if text.count(old) != 1:
    raise SystemExit(f'summary selector repair expected exactly one match, got {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
