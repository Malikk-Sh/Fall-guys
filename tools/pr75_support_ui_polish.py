from pathlib import Path

path = Path('client/admin/admin.js')
text = path.read_text(encoding='utf-8')

replacements = [
    (
        """  const hint = $('#player-support-action-hint');
  if (hint && message) hint.textContent = message;
}
""",
        """  const hint = $('#player-support-action-hint');
  if (hint) hint.textContent = message;
}
""",
        'support confirmation hint reset',
    ),
    (
        """async function openPlayerDetail(accountId, { preserveStatus = false } = {}) {
  const revision = ++state.playerDetailRevision;
  setStatus('Загружаю карточку игрока…');
""",
        """async function openPlayerDetail(accountId, { preserveStatus = false } = {}) {
  const revision = ++state.playerDetailRevision;
  if (!preserveStatus) setStatus('Загружаю карточку игрока…');
""",
        'preserve support action status while refreshing detail',
    ),
]

for old, new, label in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    text = text.replace(old, new, 1)

path.write_text(text, encoding='utf-8')
