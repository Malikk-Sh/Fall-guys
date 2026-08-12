from pathlib import Path

path = Path('tools/pr75_patch.py')
text = path.read_text(encoding='utf-8')
old = '''    "    'player-support.read',\\n    'moderation.read',\\n",\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'moderation.read',\\n",\n    'owner support capabilities'\n'''
new = '''    "    'analytics.read',\\n    'player-support.read',\\n    'moderation.read',\\n    'moderation.write',\\n",\n    "    'analytics.read',\\n    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'moderation.read',\\n    'moderation.write',\\n",\n    'owner support capabilities'\n'''
if text.count(old) != 1:
    raise SystemExit(f'expected one selector block, got {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('PR75 selector repaired')
