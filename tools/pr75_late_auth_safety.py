from pathlib import Path

path = Path('server/index.js')
text = path.read_text(encoding='utf-8')
old = """  room.updatedAt = Date.now();
  emitLobby(room);
  return true;
}

function createCoopRoom(chapterId, hostId) {
"""
new = """  room.updatedAt = Date.now();
  return true;
}

function createCoopRoom(chapterId, hostId) {
"""
if text.count(old) != 1:
    raise SystemExit(f'late-auth helper selector expected once, got {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
