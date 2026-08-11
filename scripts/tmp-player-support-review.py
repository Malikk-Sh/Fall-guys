from pathlib import Path

# Clear account-level data from the DOM whenever the admin session ends.
p = Path('client/admin/admin.js')
s = p.read_text()
anchor = '''function showLogin(message = '') {
  closeModerationCase();'''
replacement = '''function clearPlayerSupportView() {
  state.playerDetailRevision += 1;
  state.playerSearchQuery = '';
  const detail = $('#player-detail');
  if (detail) detail.hidden = true;
  const query = $('#player-search-query');
  if (query) query.value = '';
  const meta = $('#player-search-meta');
  if (meta) meta.textContent = '';
  const results = $('#player-results-body');
  if (results) results.replaceChildren();
  for (const selector of [
    '#player-summary-cards',
    '#player-account-details',
    '#player-progress-details',
    '#player-social-details',
    '#player-loadout-details',
    '#player-chapters',
    '#player-achievements',
    '#player-records',
    '#player-inventory',
    '#player-partners'
  ]) {
    const node = $(selector);
    if (node) node.replaceChildren();
  }
  const name = $('#player-detail-name');
  if (name) name.textContent = 'Игрок';
  const id = $('#player-detail-id');
  if (id) id.textContent = '';
}

function showLogin(message = '') {
  closeModerationCase();
  clearPlayerSupportView();'''
if anchor not in s:
    raise SystemExit('showLogin anchor missing')
p.write_text(s.replace(anchor, replacement, 1))

# Explain the indexed search behavior precisely in the UI.
p = Path('client/admin/index.html')
s = p.read_text()
s = s.replace(
    'Введите хотя бы 2 символа имени или часть ID. Поиск ничего не меняет в аккаунте.',
    'Введите хотя бы 2 символа: начало слова в имени или начало/полный ID аккаунта. Регистр русских и латинских букв не важен. Поиск ничего не меняет в аккаунте.'
)
p.write_text(s)

# Keep operator documentation and search semantics honest.
p = Path('docs/ADMIN-PANEL.md')
s = p.read_text()
s = s.replace(
    'Поиск принимает минимум два символа имени или часть account ID.',
    'Поиск принимает минимум два символа: начало слова в имени или начало/полный account ID. Имя ищется через отдельный FTS5 `unicode61` индекс, поэтому русский и латинский регистр не влияет на результат и поиск не сканирует всю таблицу аккаунтов.'
)
s = s.replace(
    'факт незавершённой recovery rotation, co-op прогресс, achievements, records, loadout, cosmetics,',
    'факт ещё действующей незавершённой recovery rotation (15-минутный TTL), co-op прогресс, achievements, records, loadout, cosmetics,'
)
s = s.replace(
    'последние награды, недавних напарников, собственные avoid-решения игрока и агрегат жалоб.',
    'последние награды, недавних напарников, собственные avoid-решения игрока и агрегат жалоб. Последняя активность берётся из свежей игровой session activity с `accounts.last_seen_at` только как fallback.'
)
p.write_text(s)
