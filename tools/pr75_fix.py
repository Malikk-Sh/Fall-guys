from pathlib import Path

path = Path('tools/pr75_patch.py')
text = path.read_text(encoding='utf-8')
old = '''    "    'player-support.read',\\n    'moderation.read',\\n",\n    "    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'moderation.read',\\n",\n    'owner support capabilities'\n'''
new = '''    "    'analytics.read',\\n    'player-support.read',\\n    'moderation.read',\\n    'moderation.write',\\n",\n    "    'analytics.read',\\n    'player-support.read',\\n    'player-support.sessions.write',\\n    'player-support.name.write',\\n    'moderation.read',\\n    'moderation.write',\\n",\n    'owner support capabilities'\n'''
if text.count(old) != 1:
    raise SystemExit(f'expected one selector block, got {text.count(old)}')
text = text.replace(old, new, 1)
old_session = "{ id: 'SECRET-ACTIVE-SESSION-H', createdAt: 10_000, lastSeenAt: 48_000, expiresAt: 80_000 }"
new_session = "{ id: 'SECRET-ACTIVE-SESSION-HA', createdAt: 10_000, lastSeenAt: 48_000, expiresAt: 80_000 }"
if text.count(old_session) != 1:
    raise SystemExit(f'expected one session assertion, got {text.count(old_session)}')
path.write_text(text.replace(old_session, new_session, 1), encoding='utf-8')
print('PR75 staging repairs applied')
