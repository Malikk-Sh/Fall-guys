from pathlib import Path

path = Path('tools/pr76_incident_center.py')
text = path.read_text(encoding='utf-8')
old = '''replace_once(\n    'server/adminAuth.js',\n    "    'player-support.name.write',\\n    'moderation.read',",\n    "    'player-support.name.write',\\n    'incidents.read',\\n    'moderation.read',",\n    'owner incidents capability',\n)'''
new = '''replace_once(\n    'server/adminAuth.js',\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'moderation.read',",\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'incidents.read',\\n    'moderation.read',",\n    'owner incidents capability',\n)'''
if text.count(old) != 1:
    raise SystemExit(f'owner selector repair expected 1 match, got {text.count(old)}')
text = text.replace(old, new, 1)
old = '''replace_once(\n    'server/adminAuth.js',\n    "    'player-support.sessions.write',\\n    'moderation.read',",\n    "    'player-support.sessions.write',\\n    'incidents.read',\\n    'moderation.read',",\n    'operator incidents capability',\n)'''
new = '''replace_once(\n    'server/adminAuth.js',\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'moderation.read',",\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'incidents.read',\\n    'moderation.read',",\n    'operator incidents capability',\n)'''
if text.count(old) != 1:
    raise SystemExit(f'operator selector repair expected 1 match, got {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
