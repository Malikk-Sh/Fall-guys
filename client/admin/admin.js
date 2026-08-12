'use strict';

const state = {
  csrf: '',
  admin: null,
  capabilities: new Set(),
  currentPanel: 'overview',
  sessionGeneration: 0,
  refreshRevision: 0,
  infrastructure: null,
  analytics: null,
  analyticsLoadRevision: 0,
  playerDetailRevision: 0,
  playerSearchQuery: '',
  playerDetail: null,
  playerActionConfirmation: null,
  playerActionTimer: null,
  moderationCase: null,
  moderationConfirmation: null,
  sanctionConfirmation: null,
  moderationLoadRevision: 0,
  operations: null,
  operationConfirmation: null,
  operationConfirmationTimer: null
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const METRIC_LABELS = Object.freeze({
  match_started: 'Начатые матчи',
  match_finished: 'Завершённые матчи',
  match_abandoned: 'Выходы до финиша',
  fall: 'Падения',
  finish_time: 'Время прохождения'
});
const STATUS_LABELS = Object.freeze({
  open: 'Новое',
  reviewing: 'В работе',
  resolved: 'Закрыто',
  dismissed: 'Отклонено'
});
const REASON_LABELS = Object.freeze({
  afk: 'Бездействие (AFK)',
  griefing: 'Мешает другим игрокам',
  'offensive-name': 'Оскорбительное имя',
  exploitCheat: 'Читы / эксплуатация ошибки',
  'exploit-cheat': 'Читы / эксплуатация ошибки',
  offensiveName: 'Оскорбительное имя',
  other: 'Нарушение правил'
});
const ROLE_LABELS = Object.freeze({
  owner: 'Владелец',
  operator: 'Оператор',
  moderator: 'Модератор',
  analyst: 'Аналитик',
  viewer: 'Наблюдатель'
});
const AUDIT_ACTION_LABELS = Object.freeze({
  'admin.login': 'Вход в панель',
  'admin.logout': 'Выход из панели',
  'admin.user.create': 'Создан администратор',
  'admin.user.rotate': 'Сменён код администратора',
  'admin.user.disable': 'Администратор отключён',
  'admin.user.enable': 'Администратор включён',
  'moderation.case.transition': 'Изменён статус жалобы',
  'player.sanction.apply': 'Применена санкция к игроку',
  'player.sanction.revoke': 'Снята санкция с игрока',
  'player.support.view': 'Открыта карточка игрока',
  'player.support.logout': 'Завершены сессии игрока',
  'player.support.rename': 'Изменено имя игрока',
  'ops.operation.requested': 'Запрошена системная операция',
  'ops.operation.completed': 'Системная операция завершена',
  'ops.operation.accepted': 'Принят запрос на перезапуск Wobble',
  'ops.operation.failed': 'Системная операция завершилась ошибкой'
});

function setStatus(text, tone = '') {
  const node = $('#status-line');
  node.textContent = text;
  node.className = `muted ${tone}`.trim();
}

async function api(path, body = {}, { csrf = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (csrf && state.csrf) headers['X-Wobble-Admin-CSRF'] = state.csrf;
  const response = await fetch(path, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = { ok: false, error: `http-${response.status}` };
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `http-${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function closeModerationCase() {
  state.moderationLoadRevision += 1;
  state.moderationCase = null;
  resetModerationConfirmation();
  resetSanctionConfirmation();
  const dialog = $('#moderation-dialog');
  if (dialog.open) dialog.close();
}

function clearPlayerSupportView() {
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
    '#player-partners',
    '#player-sanctions',
    '#player-sessions',
    '#player-support-history'
  ]) {
    const node = $(selector);
    if (node) node.replaceChildren();
  }
  state.playerDetail = null;
  resetPlayerActionConfirmation();
  const name = $('#player-detail-name');
  if (name) name.textContent = 'Игрок';
  const id = $('#player-detail-id');
  if (id) id.textContent = '';
}

function showLogin(message = '') {
  closeModerationCase();
  clearPlayerSupportView();
  state.csrf = '';
  state.admin = null;
  state.capabilities = new Set();
  state.infrastructure = null;
  state.analytics = null;
  state.operations = null;
  clearOperationConfirmation();
  state.sessionGeneration += 1;
  state.refreshRevision += 1;
  document.body.dataset.adminSession = 'login';
  const refresh = $('#refresh');
  refresh.disabled = false;
  refresh.removeAttribute('aria-busy');
  $('#app-view').removeAttribute('aria-busy');
  $('#app-view').hidden = true;
  $('#identity').hidden = true;
  $('#login-view').hidden = false;
  $('#login-error').textContent = message;
}

function activateSession(payload) {
  state.csrf = payload.csrf;
  state.admin = payload.admin;
  state.capabilities = new Set(payload.capabilities || []);
  state.sessionGeneration += 1;
  document.body.dataset.adminSession = 'active';
  $('#admin-name').textContent = payload.admin.name;
  $('#admin-role').textContent = ROLE_LABELS[payload.admin.role] || payload.admin.role;
  $('#admin-role').title = `Техническое название роли: ${payload.admin.role}`;
  $('#identity').hidden = false;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  for (const button of $$('#tabs [data-capability]')) {
    button.hidden = !state.capabilities.has(button.dataset.capability);
  }
  if (!state.capabilities.has('dashboard.read')) return showLogin('Для этой роли нет доступа к панели.');
  switchPanel('overview');
}

function switchPanel(name) {
  const button = $(`#tabs [data-panel="${name}"]`);
  if (!button || button.hidden) name = 'overview';
  if (name !== 'moderation') closeModerationCase();
  if (name !== 'analytics') state.analyticsLoadRevision += 1;
  if (name !== 'players') state.playerDetailRevision += 1;
  if (name !== 'operations') clearOperationConfirmation();
  state.currentPanel = name;
  for (const item of $$('.panel')) item.hidden = item.id !== `panel-${name}`;
  for (const item of $$('#tabs [data-panel]')) {
    const active = item.dataset.panel === name;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  const activeButton = $(`#tabs [data-panel="${name}"]`);
  activeButton?.scrollIntoView({
    block: 'nearest',
    inline: 'center',
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  });
  refreshCurrent();
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

function formatBytes(value) {
  if (value == null || value === '') return '—';
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = bytes;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toLocaleString('ru-RU', { maximumFractionDigits: index >= 3 ? 1 : 0 })} ${units[index]}`;
}

function percent(value) {
  if (value == null || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%` : '—';
}

function availability(value) {
  return value ? 'Доступен' : 'Недоступен';
}

function serviceState(service) {
  if (!service?.found) return 'Не найден';
  if (service.active) return 'Работает';
  return `Не активен (${service.activeState || 'unknown'})`;
}

function formatBoundedCount(value, truncated) {
  return `${formatNumber(value)}${truncated ? '+' : ''}`;
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value)
  );
}

function formatDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[3]}.${match[2]}` : '—';
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds || 0));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  if (days) return `${days}д ${hours}ч`;
  if (hours) return `${hours}ч ${minutes}м`;
  return `${minutes}м`;
}

function formatMilliseconds(value) {
  if (value == null) return '—';
  const ms = Math.max(0, Number(value || 0));
  if (ms < 1000) return `${formatNumber(ms)} мс`;
  return `${(ms / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} сек`;
}

function appendText(parent, tag, text, className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function statCard(label, value, hint = '', tone = '') {
  const card = document.createElement('article');
  card.className = `stat${tone ? ` stat-${tone}` : ''}`;
  appendText(card, 'span', label, 'label');
  appendText(card, 'strong', value, `value ${tone}`.trim());
  if (hint) appendText(card, 'span', hint, 'hint');
  return card;
}

function fillDetails(selector, entries) {
  const root = $(selector);
  root.replaceChildren();
  for (const [label, value] of entries) {
    appendText(root, 'dt', label);
    appendText(root, 'dd', String(value ?? '—'));
  }
}

function statusLabel(value) {
  return STATUS_LABELS[value] ? `${STATUS_LABELS[value]} (${value})` : value || '—';
}

function reasonLabel(value) {
  return REASON_LABELS[value] || value || '—';
}

function sanctionStatusLabel(item) {
  if (!item) return 'Нет активного ограничения';
  if (item.kind === 'warning') return 'Предупреждение';
  if (item.status === 'active') return item.permanent ? 'Активный бан без срока' : 'Активный временный бан';
  if (item.status === 'revoked') return 'Бан снят досрочно';
  if (item.status === 'expired') return 'Срок бана истёк';
  return item.status || '—';
}

function sanctionTimeLabel(item) {
  if (!item) return '—';
  if (item.kind === 'warning') return `выдано ${formatTime(item.createdAt)}`;
  if (item.permanent) return 'без срока';
  return item.expiresAt ? `до ${formatTime(item.expiresAt)}` : '—';
}

function renderPlayerSanctions(context = {}) {
  const root = $('#player-sanctions');
  root.replaceChildren();
  const active = context.active;
  if (active) {
    playerListItem(
      root,
      `${sanctionStatusLabel(active)} · ${reasonLabel(active.reason)}`,
      `${sanctionTimeLabel(active)} · выдал ${active.createdByName || active.createdByAdminId}`
    );
  }
  for (const item of context.history || []) {
    if (active && item.id === active.id) continue;
    const note = item.note ? ` · заметка: ${item.note}` : '';
    const revoked = item.revokedAt
      ? ` · снято ${formatTime(item.revokedAt)} (${item.revokedByName || item.revokedByAdminId || 'администратор'})`
      : '';
    playerListItem(
      root,
      `${sanctionStatusLabel(item)} · ${reasonLabel(item.reason)}`,
      `${sanctionTimeLabel(item)} · ${formatTime(item.createdAt)} · ${item.createdByName || item.createdByAdminId}${revoked}${note}`
    );
  }
  if (!active && !context.history?.length) appendText(root, 'p', 'Санкций и предупреждений нет.', 'muted');
}

function deviceLabel(value) {
  if (value === 'mobile') return 'Телефон / планшет';
  if (value === 'desktop') return 'Компьютер';
  if (value === '—') return 'Не указано';
  return value;
}

function modeLabel(value) {
  if (value === 'race') return 'Гонка';
  if (value === 'coop') return 'Кооператив';
  if (value === 'solo') return 'Одиночный';
  if (value === '—') return 'Не указано';
  return value;
}

function courseLabel(value) {
  const text = String(value || '—');
  const chapter = /^ch(\d+)$/i.exec(text);
  if (chapter) return `Глава ${chapter[1]} (${text})`;
  return text === '—' ? 'Не указано' : text;
}

async function loadOverview() {
  const payload = await api('/api/admin/dashboard');
  const data = payload.overview;
  const health = data.health || {};
  const backup = health.backup || {};
  const backupProblem = Boolean(backup.required && (!backup.available || backup.stale));
  const backupLabel = backup.required ? (backupProblem ? 'НУЖНО ПРОВЕРИТЬ' : 'В ПОРЯДКЕ') : 'НЕ ТРЕБУЕТСЯ';
  const backupHint =
    backup.ageSeconds != null
      ? `последняя подтверждённая копия: ${formatDuration(backup.ageSeconds)} назад`
      : backup.required
        ? 'нет свежей подтверждённой копии'
        : 'для этого запуска постоянный backup не обязателен';
  const cards = $('#overview-cards');
  cards.replaceChildren(
    statCard('Игроки сейчас', formatNumber(health.players), `${formatNumber(health.rooms)} активных комнат`),
    statCard(
      'Активные аккаунты за 24ч',
      formatNumber(data.accounts?.active24h),
      `всего зарегистрировано: ${formatNumber(data.accounts?.total)}`
    ),
    statCard(
      'Новые дела модерации',
      formatBoundedCount(data.moderation?.open, data.moderation?.openTruncated),
      `${formatBoundedCount(data.moderation?.reviewing, data.moderation?.reviewingTruncated)} уже в работе · ${formatNumber(data.moderation?.reports24h)} жалоб за 24ч`,
      data.moderation?.open ? 'warn' : 'good'
    ),
    statCard(
      'Резервные копии',
      backupLabel,
      backupHint,
      backupProblem ? 'bad' : backup.required ? 'good' : ''
    )
  );
  fillDetails('#production-details', [
    ['Версия игры', health.version],
    ['Сборка (commit)', health.commit],
    ['Релиз', health.release || 'запуск из ветки, не из release tag'],
    ['Версия сетевого протокола', health.protocolVersion],
    ['Сервер запущен', formatTime(health.startedAt)],
    ['Работает без перезапуска', formatDuration(health.uptime)],
    ['Проверенных рекордов', formatNumber(data.competitiveRecords)]
  ]);
  fillDetails('#load-details', [
    ['Задержка цикла сервера (p95)', `${health.load?.eventLoopP95Ms ?? 0} мс`],
    ['Память процесса (RSS)', `${health.load?.rssMb ?? 0} МБ`],
    ['Память JavaScript', `${health.load?.heapUsedMb ?? 0} / ${health.load?.heapTotalMb ?? 0} МБ`],
    ['Подключения', `${health.capacity?.socketCount ?? 0} / ${health.capacity?.maxSockets ?? 0}`],
    ['Активные матчи', `${health.capacity?.activeMatches ?? 0} / ${health.capacity?.maxMatches ?? 0}`],
    ['Игроков в поиске матча', `${health.matchmaking?.waiting ?? 0}`],
    ['Перегружен', health.load?.overloaded ? 'ДА — стоит проверить' : 'нет']
  ]);
}

function rowWithCells(values) {
  const row = document.createElement('tr');
  for (const value of values) appendText(row, 'td', String(value ?? '—'));
  return row;
}

function analyticsRequest() {
  return {
    days: Number($('#analytics-days').value || 7),
    limit: 1000,
    mode: $('#analytics-mode').value || 'all',
    course: $('#analytics-course').value || 'all',
    device: $('#analytics-device').value || 'all'
  };
}

function populateFilter(selector, allLabel, options, selected, labeler = value => value) {
  const select = $(selector);
  select.replaceChildren();
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = allLabel;
  select.append(all);
  for (const value of options || []) {
    if (!value || value === 'all') continue;
    const option = document.createElement('option');
    option.value = value;
    option.textContent = labeler(value);
    select.append(option);
  }
  select.value = [...select.options].some(option => option.value === selected) ? selected : 'all';
}

function comparisonHint(current, previous, formatter = formatNumber) {
  if (previous == null) return 'нет данных для прошлого периода';
  const currentNumber = Number(current || 0);
  const previousNumber = Number(previous || 0);
  if (!previousNumber) return `прошлый такой же период: ${formatter(previousNumber)}`;
  const percent = Math.round(((currentNumber - previousNumber) / previousNumber) * 100);
  const sign = percent > 0 ? '+' : '';
  return `прошлый период: ${formatter(previousNumber)} · изменение ${sign}${percent}%`;
}

function renderAnalyticsKpis(data) {
  const current = data.kpis?.current || {};
  const previous = data.kpis?.previous || null;
  const comparisonAvailable = data.comparisonAvailable !== false;
  const completion = current.completionPercent == null ? '—' : `${current.completionPercent}%`;
  const previousCompletion = previous?.completionPercent == null ? '—' : `${previous.completionPercent}%`;
  const comparisonUnavailableHint =
    data.comparisonReason === 'current-day-incomplete'
      ? 'сегодняшний день ещё идёт — не сравниваем его с полным вчерашним днём'
      : `полное сравнение недоступно: метрики хранятся ${formatNumber(data.retentionDays)} дней`;
  const compareHint = (currentValue, previousValue, formatter = formatNumber) =>
    comparisonAvailable ? comparisonHint(currentValue, previousValue, formatter) : comparisonUnavailableHint;
  const cards = $('#analytics-kpis');
  cards.replaceChildren(
    statCard('Начатые матчи', formatNumber(current.started), compareHint(current.started, previous?.started)),
    statCard(
      'Завершённые матчи',
      formatNumber(current.finished),
      compareHint(current.finished, previous?.finished)
    ),
    statCard(
      'Завершено / начато',
      completion,
      `${comparisonAvailable ? `прошлый такой же период: ${previousCompletion}` : comparisonUnavailableHint} · это отношение событий, не уникальных игроков`
    ),
    statCard(
      'Выходы до финиша',
      formatNumber(current.abandoned),
      compareHint(current.abandoned, previous?.abandoned),
      comparisonAvailable && current.abandoned > Number(previous?.abandoned || 0) ? 'warn' : ''
    ),
    statCard(
      'Падения',
      formatNumber(current.falls),
      compareHint(current.falls, previous?.falls),
      comparisonAvailable && current.falls > Number(previous?.falls || 0) ? 'warn' : ''
    ),
    statCard(
      'Среднее проверенное время',
      formatMilliseconds(current.verifiedAverageMs),
      `${comparisonAvailable ? `прошлый период: ${formatMilliseconds(previous?.verifiedAverageMs)}` : comparisonUnavailableHint} · проверенных финишей: ${formatNumber(current.verifiedFinishes)}`
    )
  );
}

function renderAnalyticsTrend() {
  const data = state.analytics;
  const root = $('#analytics-chart');
  root.replaceChildren();
  if (!data?.trend?.length) {
    appendText(root, 'p', 'За выбранный период данных пока нет.', 'empty');
    return;
  }
  const field = $('#analytics-trend-metric').value || 'matchStarted';
  const values = data.trend.map(point => Number(point[field] || 0));
  const max = Math.max(1, ...values);
  for (const [index, point] of data.trend.entries()) {
    const value = values[index];
    const item = document.createElement('div');
    item.className = 'bar-day';
    item.title = `${point.day}: ${formatNumber(value)}`;
    appendText(item, 'span', formatNumber(value), 'bar-value');
    const track = document.createElement('div');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    fill.style.height = `${Math.max(value ? 5 : 0, (value / max) * 100)}%`;
    track.append(fill);
    item.append(track);
    appendText(item, 'span', formatDay(point.day), 'bar-label');
    root.append(item);
  }
}

function renderHotspots(selector, items, emptyText) {
  const root = $(selector);
  root.replaceChildren();
  for (const [index, item] of (items || []).entries()) {
    const card = document.createElement('div');
    card.className = 'rank-item';
    appendText(card, 'span', `${index + 1}`, 'rank-number');
    const copy = document.createElement('div');
    appendText(copy, 'strong', item.detail === '—' ? courseLabel(item.course) : item.detail);
    appendText(
      copy,
      'span',
      `${courseLabel(item.course)} · ${deviceLabel(item.device)} · ${formatNumber(item.samples)} событий`,
      'rank-meta'
    );
    card.append(copy);
    root.append(card);
  }
  if (!items?.length) appendText(root, 'p', emptyText, 'muted');
}

function renderAnalyticsTable(data) {
  const body = $('#analytics-body');
  body.replaceChildren();
  for (const row of data.rows || []) {
    const average =
      row.metric === 'finish_time'
        ? formatMilliseconds(row.average)
        : row.average == null
          ? '—'
          : formatNumber(row.average);
    body.append(
      rowWithCells([
        `${METRIC_LABELS[row.metric] || row.metric} (${row.metric})`,
        modeLabel(row.mode),
        courseLabel(row.course),
        row.detail,
        deviceLabel(row.device),
        formatNumber(row.samples),
        average
      ])
    );
  }
  if (!data.rows?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Нет данных с такими фильтрами за выбранный период.', 'empty');
    cell.colSpan = 7;
    body.append(row);
  }
}

async function loadAnalytics() {
  const requestRevision = ++state.analyticsLoadRevision;
  const request = analyticsRequest();
  const payload = await api('/api/admin/analytics', request);
  if (requestRevision !== state.analyticsLoadRevision) return false;
  const data = payload.analytics;
  state.analytics = data;
  populateFilter('#analytics-mode', 'Все режимы', data.options?.modes, data.filters?.mode, modeLabel);
  populateFilter(
    '#analytics-course',
    'Все трассы и главы',
    data.options?.courses,
    data.filters?.course,
    courseLabel
  );
  populateFilter(
    '#analytics-device',
    'Все устройства',
    data.options?.devices,
    data.filters?.device,
    deviceLabel
  );
  const limitNote = data.truncated ? ' · таблица ограничена первыми 1000 строками' : '';
  const comparisonNote = data.comparisonAvailable
    ? ` · сравнение с ${data.previousFrom}–${data.previousTo}`
    : data.comparisonReason === 'current-day-incomplete'
      ? ' · сегодня показывается в реальном времени без сравнения со вчера'
      : ` · предыдущий полный период не сравнивается: история хранится ${formatNumber(data.retentionDays)} дней`;
  const droppedNote = data.dropped
    ? ` · ВНИМАНИЕ: сервер отбросил ${formatNumber(data.dropped)} необычных ключей метрик`
    : ' · потерь метрик не обнаружено';
  $('#analytics-meta').textContent = `Период с ${data.from}${comparisonNote}${limitNote}${droppedNote}`;
  renderAnalyticsKpis(data);
  renderAnalyticsTrend();
  renderHotspots('#fall-hotspots', data.hotspots?.falls, 'Падений по выбранным фильтрам нет.');
  renderHotspots(
    '#abandon-hotspots',
    data.hotspots?.abandons,
    'Выходов до финиша по выбранным фильтрам нет.'
  );
  renderAnalyticsTable(data);
  return true;
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value) {
  const text = String(value ?? '');
  // Spreadsheet applications may interpret leading =,+,-,@ as a formula. Exported
  // dimensions are data, never formulas, so neutralize them before CSV quoting.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function exportAnalytics(format) {
  const data = state.analytics;
  if (!data) return setStatus('Сначала загрузите статистику.', 'warn');
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    downloadText(
      `wobble-analytics-${stamp}.json`,
      `${JSON.stringify(data, null, 2)}\n`,
      'application/json;charset=utf-8'
    );
    setStatus('JSON со статистикой подготовлен.', 'good');
    return;
  }
  const header = ['metric', 'metric_label', 'mode', 'course', 'detail', 'device', 'samples', 'average'];
  const lines = [header.join(',')];
  for (const row of data.rows || []) {
    lines.push(
      [
        row.metric,
        METRIC_LABELS[row.metric] || row.metric,
        row.mode,
        row.course,
        row.detail,
        row.device,
        row.samples,
        row.average ?? ''
      ]
        .map(csvCell)
        .join(',')
    );
  }
  downloadText(`wobble-analytics-${stamp}.csv`, `\uFEFF${lines.join('\n')}\n`, 'text/csv;charset=utf-8');
  setStatus('CSV со статистикой подготовлен.', 'good');
}

function fillDetailsElement(root, entries) {
  root.replaceChildren();
  for (const [label, value] of entries) {
    appendText(root, 'dt', label);
    appendText(root, 'dd', String(value ?? '—'));
  }
}

function providerLabel(provider) {
  if (provider === 'google') return 'Google';
  return provider || '—';
}

function playerListItem(root, title, meta) {
  const item = document.createElement('div');
  item.className = 'rank-item support-list-item';
  const copy = document.createElement('div');
  appendText(copy, 'strong', title);
  appendText(copy, 'span', meta, 'rank-meta');
  item.append(copy);
  root.append(item);
}

function renderSimpleList(selector, rows, formatter, emptyText) {
  const root = $(selector);
  root.replaceChildren();
  for (const row of rows || []) {
    const [title, meta] = formatter(row);
    playerListItem(root, title, meta);
  }
  if (!rows?.length) appendText(root, 'p', emptyText, 'muted');
}

function clearPlayerActionTimer() {
  if (state.playerActionTimer) clearTimeout(state.playerActionTimer);
  state.playerActionTimer = null;
}

function resetPlayerActionConfirmation(message = '') {
  clearPlayerActionTimer();
  state.playerActionConfirmation = null;
  const labels = [
    ['#player-force-logout', 'Завершить все сессии'],
    ['#player-rename', 'Изменить имя'],
    ['#player-reset-name', 'Сбросить на Wobbler']
  ];
  for (const [selector, text] of labels) {
    const button = $(selector);
    if (!button) continue;
    button.disabled = false;
    button.textContent = text;
    button.classList.remove('confirm');
  }
  const hint = $('#player-support-action-hint');
  if (hint) hint.textContent = message;
}

function armPlayerAction(key, button, confirmationText) {
  if (state.playerActionConfirmation === key) return true;
  resetPlayerActionConfirmation();
  state.playerActionConfirmation = key;
  button.textContent = confirmationText;
  button.classList.add('confirm');
  $('#player-support-action-hint').textContent =
    'Проверьте данные и нажмите ту же кнопку ещё раз в течение 10 секунд.';
  state.playerActionTimer = setTimeout(() => resetPlayerActionConfirmation('Подтверждение истекло.'), 10_000);
  return false;
}

function supportActionNote() {
  const note = $('#player-support-note').value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (note.length < 3) {
    setStatus('Укажите внутреннюю причину действия минимум из 3 символов.', 'warn');
    return '';
  }
  return note;
}

function supportHistoryMeta(event) {
  const actor = event.actorName || 'Система';
  const role = ROLE_LABELS[event.actorRole] || event.actorRole || 'system';
  const note = event.detail?.note ? ` · причина: ${event.detail.note}` : '';
  const renamed =
    event.action === 'player.support.rename'
      ? ` · ${event.detail?.fromName || '—'} → ${event.detail?.toName || '—'}`
      : '';
  return `${formatTime(event.createdAt)} · ${actor} (${role})${renamed}${note}`;
}

async function copyPlayerSupportId() {
  const supportId = state.playerDetail?.account?.supportId;
  if (!supportId) return setStatus('У этого legacy-аккаунта нет короткого Support ID.', 'warn');
  try {
    await navigator.clipboard.writeText(supportId);
    setStatus(`Support ID ${supportId} скопирован`, 'good');
  } catch {
    setStatus(`Не удалось скопировать автоматически. Support ID: ${supportId}`, 'warn');
  }
}

async function forceLogoutPlayer() {
  const player = state.playerDetail;
  if (!player?.account?.id) return;
  const note = supportActionNote();
  if (!note) return;
  const button = $('#player-force-logout');
  const key = `logout:${player.account.id}:${note}`;
  if (!armPlayerAction(key, button, 'Подтвердить завершение всех сессий')) return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/players/logout', { accountId: player.account.id, note });
    resetPlayerActionConfirmation();
    setStatus(
      `Сессии завершены: HTTP ${formatNumber(result.revokedSessions)}, WST ${formatNumber(result.revokedSocketTickets)}, reconnect ${formatNumber(result.revokedReconnectSessions)}, WebSocket ${formatNumber(result.disconnectedSockets)}.`,
      'good'
    );
    await openPlayerDetail(player.account.id, { preserveStatus: true });
  } catch (error) {
    resetPlayerActionConfirmation();
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Не удалось завершить сессии: ${error.message}`, 'bad');
  }
}

async function renamePlayer(name) {
  const player = state.playerDetail;
  if (!player?.account?.id) return;
  const requested = String(name || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!requested) return setStatus('Введите новое имя.', 'warn');
  const note = supportActionNote();
  if (!note) return;
  const reset = requested === 'Wobbler';
  const button = reset ? $('#player-reset-name') : $('#player-rename');
  const key = `rename:${player.account.id}:${requested}:${note}`;
  if (!armPlayerAction(key, button, reset ? 'Подтвердить сброс имени' : `Подтвердить имя «${requested}»`))
    return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/players/rename', {
      accountId: player.account.id,
      name: requested,
      note
    });
    resetPlayerActionConfirmation();
    setStatus(`Имя изменено: ${result.previousName} → ${result.name}`, 'good');
    await openPlayerDetail(player.account.id, { preserveStatus: true });
  } catch (error) {
    resetPlayerActionConfirmation();
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    const message =
      error.payload?.error === 'invalid-player-name'
        ? 'Имя содержит недопустимые символы или длиннее 16 знаков.'
        : error.payload?.error === 'no-change'
          ? 'Это имя уже установлено.'
          : error.message;
    setStatus(`Не удалось изменить имя: ${message}`, 'bad');
  }
}

function openPlayerModeration() {
  const player = state.playerDetail;
  if (!player?.account?.id || !player.moderation) return;
  openModerationCase(player.account.id);
}

function hidePlayerDetail() {
  state.playerDetailRevision += 1;
  state.playerDetail = null;
  resetPlayerActionConfirmation();
  $('#player-detail').hidden = true;
}

function renderPlayerDetail(player) {
  const account = player.account || {};
  const login = player.login || {};
  const sessions = login.sessions || {};
  const progress = player.progress || {};
  const stats = progress.stats || {};
  const inventory = player.inventory || {};
  const social = player.social || {};
  const moderation = player.moderation;
  const sanctions = player.sanctions || { active: null, history: [] };
  const live = player.live || {};
  state.playerDetail = player;
  resetPlayerActionConfirmation();
  const providers =
    (login.providers || []).map(item => providerLabel(item.provider)).join(', ') || 'не привязан';

  $('#player-detail-name').textContent = account.name || 'Wobbler';
  $('#player-detail-id').textContent = `ID аккаунта: ${account.id}`;
  $('#player-support-id').textContent = account.supportId || 'legacy — недоступен';
  $('#player-copy-support-id').disabled = !account.supportId;
  $('#player-support-note').value = '';
  $('#player-rename-input').value = account.name || 'Wobbler';
  $('#player-name-actions').hidden = !state.capabilities.has('player-support.name.write');
  $('#player-session-actions').hidden = !state.capabilities.has('player-support.sessions.write');
  const moderationButton = $('#player-open-moderation');
  moderationButton.hidden = !(state.capabilities.has('moderation.read') && moderation);
  $('#player-summary-cards').replaceChildren(
    statCard(
      'Активных входов',
      formatNumber(sessions.active),
      `${formatNumber(live.sockets)} игровых WebSocket сейчас`
    ),
    statCard(
      'Пройдено глав',
      `${formatNumber(stats.coopChaptersCompleted)} / 10`,
      `${formatNumber(stats.coopMatchesCompleted)} завершённых co-op матчей`
    ),
    statCard(
      'Получено жалоб',
      formatNumber(social.reportsReceived?.total),
      `${formatNumber(social.reportsReceived?.reporters)} разных жалобщиков`,
      social.reportsReceived?.total ? 'warn' : ''
    ),
    statCard(
      'Модерация',
      moderation ? statusLabel(moderation.status) : 'Нет дела',
      moderation ? `${formatNumber(moderation.totalReports)} жалоб в деле` : 'активного moderation case нет'
    ),
    statCard(
      'Ограничение',
      sanctions.active ? sanctionStatusLabel(sanctions.active) : 'НЕТ',
      sanctions.active
        ? `${reasonLabel(sanctions.active.reason)} · ${sanctionTimeLabel(sanctions.active)}`
        : 'активного бана нет',
      sanctions.active ? 'bad' : 'good'
    )
  );

  fillDetailsElement($('#player-account-details'), [
    ['Support ID', account.supportId || 'legacy — недоступен'],
    ['Создан', formatTime(account.createdAt)],
    ['Последняя активность аккаунта', formatTime(account.lastSeenAt)],
    ['Способы входа', providers],
    ['Активных сессий', formatNumber(sessions.active)],
    ['Всего сохранённых session rows', formatNumber(sessions.totalStored)],
    ['Последняя активная сессия', formatTime(sessions.latestSeenAt)],
    ['Ближайшее истечение сессии', formatTime(sessions.soonestActiveExpiresAt)],
    [
      'Смена recovery-кода ожидает подтверждения',
      account.recoveryRotationPending ? `да, с ${formatTime(account.recoveryRotationStartedAt)}` : 'нет'
    ]
  ]);
  fillDetailsElement($('#player-progress-details'), [
    ['Завершено co-op матчей', formatNumber(stats.coopMatchesCompleted)],
    ['Уникально пройдено глав', `${formatNumber(stats.coopChaptersCompleted)} / 10`],
    ['Спасений напарника', formatNumber(stats.coopRevives)],
    ['Достижений', formatNumber(progress.achievements?.length)],
    ['Личных рекордов', formatNumber(progress.personalRecords?.length)]
  ]);
  fillDetailsElement($('#player-social-details'), [
    ['Недавних напарников в карточке', formatNumber(social.recentPartners?.length)],
    ['Сам исключил из подбора', formatNumber(social.avoidedByThisPlayer)],
    ['Жалоб получил', formatNumber(social.reportsReceived?.total)],
    ['Разных жалобщиков', formatNumber(social.reportsReceived?.reporters)],
    ['Жалоб отправил', formatNumber(social.reportsSubmitted)],
    ['Последняя жалоба на игрока', formatTime(social.reportsReceived?.lastReportedAt)]
  ]);
  const loadout = inventory.loadout || {};
  fillDetailsElement($('#player-loadout-details'), [
    ['Тело', loadout.body || 'classic'],
    ['Визор', loadout.visor || 'не выбран'],
    ['Антенна', loadout.antenna || 'не выбрана'],
    ['След', loadout.trail || 'не выбран'],
    ['Финишный эффект', loadout.finish || 'не выбран'],
    ['Открыто предметов', formatNumber(inventory.cosmetics?.length)]
  ]);

  renderSimpleList(
    '#player-chapters',
    progress.chapters,
    row => [
      courseLabel(row.chapterId),
      `${formatNumber(row.completions)} прохождений · лучшее время ${formatMilliseconds(row.bestTimeMs)} · ${row.flawless ? 'есть безошибочное прохождение' : 'безошибочного прохождения нет'} · последнее ${formatTime(row.lastCompletedAt)}`
    ],
    'Главы пока не пройдены.'
  );
  renderSimpleList(
    '#player-achievements',
    progress.achievements,
    row => [row.id, `получено ${formatTime(row.unlockedAt)}`],
    'Достижений пока нет.'
  );
  renderSimpleList(
    '#player-records',
    progress.personalRecords,
    row => [
      `${modeLabel(row.mode)} · ${courseLabel(row.courseKey)}`,
      `${formatMilliseconds(row.timeMs)} · поставлен ${formatTime(row.achievedAt)}`
    ],
    'Личных рекордов пока нет.'
  );
  renderSimpleList(
    '#player-inventory',
    inventory.cosmetics,
    row => [row.id, `открыто ${formatTime(row.unlockedAt)} · источник: ${row.source}`],
    'Дополнительная косметика пока не открыта.'
  );
  for (const reward of inventory.recentRewards || []) {
    playerListItem(
      $('#player-inventory'),
      `Награда: ${reward.reward}${reward.cosmeticId ? ` · ${reward.cosmeticId}` : ''}`,
      `${formatTime(reward.grantedAt)} · источник: ${reward.source}`
    );
  }
  renderSimpleList(
    '#player-partners',
    social.recentPartners,
    row => [
      `${row.name} · ${row.id}`,
      `${formatNumber(row.matchesTogether)} матчей вместе · ${courseLabel(row.lastChapterId)} · ${formatTime(row.lastPlayedAt)}${row.avoidedByThisPlayer ? ' · этот игрок исключён из повторного подбора' : ''}`
    ],
    'Недавних напарников нет.'
  );
  renderSimpleList(
    '#player-sessions',
    login.sessionList,
    row => [
      `Сессия ${row.id}`,
      `создана ${formatTime(row.createdAt)} · активность ${formatTime(row.lastSeenAt)} · истекает ${formatTime(row.expiresAt)}`
    ],
    'Активных HTTP-сессий нет.'
  );
  if (Number(live.sockets || 0) > 0) {
    playerListItem(
      $('#player-sessions'),
      `Игровые WebSocket: ${formatNumber(live.sockets)}`,
      'Показывается только количество; сетевые адреса панель не раскрывает.'
    );
  }
  renderSimpleList(
    '#player-support-history',
    player.supportHistory,
    event => [AUDIT_ACTION_LABELS[event.action] || event.action, supportHistoryMeta(event)],
    'Изменяющих действий поддержки по этому аккаунту ещё не было.'
  );
  renderPlayerSanctions(sanctions);
  $('#player-detail').hidden = false;
  $('#player-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function openPlayerDetail(accountId, { preserveStatus = false } = {}) {
  const revision = ++state.playerDetailRevision;
  if (!preserveStatus) setStatus('Загружаю карточку игрока…');
  try {
    const payload = await api('/api/admin/players/detail', { accountId });
    if (revision !== state.playerDetailRevision) return;
    renderPlayerDetail(payload.player);
    if (!preserveStatus) setStatus('Карточка игрока загружена', 'good');
  } catch (error) {
    if (revision !== state.playerDetailRevision) return;
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Не удалось открыть игрока: ${error.message}`, 'bad');
  }
}

async function searchPlayers() {
  const query = $('#player-search-query').value.trim();
  if (query.length < 2) {
    $('#player-search-meta').textContent = 'Введите хотя бы 2 символа.';
    return false;
  }
  state.playerSearchQuery = query;
  const payload = await api('/api/admin/players/search', { query, limit: 30 });
  const body = $('#player-results-body');
  body.replaceChildren();
  for (const player of payload.results || []) {
    const row = rowWithCells([
      `${player.name} · ${player.supportId ? `${player.supportId} · ` : ''}${player.id}`,
      formatTime(player.lastSeenAt),
      formatNumber(player.activeSessions),
      player.hasExternalLogin ? 'есть' : 'нет'
    ]);
    const action = document.createElement('td');
    const button = appendText(action, 'button', 'Открыть карточку', 'case-open');
    button.type = 'button';
    button.addEventListener('click', () => openPlayerDetail(player.id));
    row.append(action);
    body.append(row);
  }
  if (!payload.results?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Игроки по этому запросу не найдены.', 'empty');
    cell.colSpan = 5;
    body.append(row);
  }
  $('#player-search-meta').textContent =
    `Найдено: ${formatNumber(payload.results?.length)}. Поиск по имени может вернуть несколько совпадений.`;
  return true;
}

async function loadPlayers() {
  if (!state.playerSearchQuery) return true;
  $('#player-search-query').value = state.playerSearchQuery;
  return searchPlayers();
}

function reasonsText(reasons = {}) {
  return (
    Object.entries(reasons)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason, count]) => `${reasonLabel(reason)}: ${count}`)
      .join(' · ') || '—'
  );
}

async function loadModeration() {
  const status = $('#moderation-status').value || 'open';
  const payload = await api('/api/admin/moderation/queue', { status, limit: 100 });
  const body = $('#moderation-body');
  body.replaceChildren();
  for (const item of payload.cases || []) {
    const row = rowWithCells([
      `${item.currentName} · ${item.targetAccountId}`,
      statusLabel(item.status),
      item.uniqueReporters,
      item.totalReports,
      reasonsText(item.reasons),
      formatTime(item.lastReportedAt)
    ]);
    const action = document.createElement('td');
    const button = appendText(action, 'button', 'Открыть дело', 'case-open');
    button.type = 'button';
    button.addEventListener('click', () => openModerationCase(item.targetAccountId));
    row.append(action);
    body.append(row);
  }
  if (!payload.cases?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'В этой категории дел сейчас нет.', 'empty');
    cell.colSpan = 7;
    body.append(row);
  }
}

function itemCard(root, title, meta, note = '') {
  const card = document.createElement('article');
  card.className = root.id === 'case-history' ? 'history-item' : 'evidence-item';
  const head = document.createElement('div');
  head.className = 'item-head';
  appendText(head, 'strong', title);
  card.append(head);
  const details = document.createElement('div');
  details.className = 'item-meta';
  for (const value of meta.filter(Boolean)) appendText(details, 'span', value);
  card.append(details);
  if (note) appendText(card, 'p', note, 'item-note');
  root.append(card);
}

function defaultModerationStatus(current) {
  if (current === 'open') return 'reviewing';
  if (current === 'reviewing') return 'resolved';
  return 'reviewing';
}

function resetModerationConfirmation(message = '') {
  state.moderationConfirmation = null;
  const button = $('#case-apply');
  if (button) {
    button.disabled = false;
    button.textContent = 'Подготовить изменение';
    button.classList.remove('confirm');
  }
  const hint = $('#case-action-hint');
  if (hint && message) hint.textContent = message;
}

function resetSanctionConfirmation(message = '') {
  state.sanctionConfirmation = null;
  const apply = $('#sanction-apply');
  const revoke = $('#sanction-revoke');
  if (apply) {
    apply.disabled = false;
    apply.textContent = 'Подготовить санкцию';
    apply.classList.remove('confirm');
  }
  if (revoke) {
    revoke.disabled = false;
    revoke.textContent = 'Снять активный бан';
    revoke.classList.remove('confirm');
  }
  const hint = $('#sanction-action-hint');
  if (hint && message) hint.textContent = message;
}

function updateSanctionFields() {
  const kind = $('#sanction-kind').value;
  const duration = $('#sanction-duration');
  const durationLabel = $('#sanction-duration-label');
  const customLabel = $('#sanction-custom-label');
  const owner = state.capabilities.has('sanctions.permanent');
  durationLabel.hidden = kind !== 'ban';
  duration.disabled = kind !== 'ban';
  for (const option of duration.querySelectorAll('[data-owner-only], [data-permanent]')) {
    option.disabled = !owner;
  }
  if (!owner && (duration.value === 'permanent' || Number(duration.value) > 604800000)) {
    duration.value = '604800000';
  }
  customLabel.hidden = kind !== 'ban' || duration.value !== 'custom';
  $('#sanction-custom-hours').max = owner ? '8760' : '168';
  resetSanctionConfirmation();
}

function renderCaseSanctions(item) {
  const context = item.sanctions || { active: null, history: [] };
  const currentRoot = $('#case-sanction-current');
  const historyRoot = $('#case-sanction-history');
  currentRoot.replaceChildren();
  historyRoot.replaceChildren();
  const active = context.active;
  if (active) {
    itemCard(
      currentRoot,
      `${sanctionStatusLabel(active)} · ${reasonLabel(active.reason)}`,
      [
        sanctionTimeLabel(active),
        `выдал: ${active.createdByName || active.createdByAdminId}`,
        `ID санкции: ${active.id}`
      ],
      active.note || ''
    );
  } else {
    appendText(currentRoot, 'p', 'Активного бана нет.', 'muted');
  }
  for (const sanction of context.history || []) {
    itemCard(
      historyRoot,
      `${sanctionStatusLabel(sanction)} · ${reasonLabel(sanction.reason)}`,
      [
        formatTime(sanction.createdAt),
        sanctionTimeLabel(sanction),
        `выдал: ${sanction.createdByName || sanction.createdByAdminId}`,
        sanction.revokedAt
          ? `снял: ${sanction.revokedByName || sanction.revokedByAdminId || 'администратор'} · ${formatTime(sanction.revokedAt)}`
          : null
      ],
      [sanction.note, sanction.revokeNote ? `Снятие: ${sanction.revokeNote}` : ''].filter(Boolean).join('\n')
    );
  }
  if (!context.history?.length) appendText(historyRoot, 'p', 'История санкций пока пуста.', 'muted');

  const form = $('#sanction-action');
  form.hidden = !state.capabilities.has('sanctions.write');
  $('#sanction-revoke').hidden = !active || !state.capabilities.has('sanctions.write');
  if (active?.permanent && !state.capabilities.has('sanctions.permanent'))
    $('#sanction-revoke').hidden = true;
  $('#sanction-note').value = '';
  updateSanctionFields();
  resetSanctionConfirmation(
    active?.permanent && !state.capabilities.has('sanctions.permanent')
      ? 'Постоянный бан может снять только владелец.'
      : 'Первое нажатие только готовит действие; второе подтверждает его в течение 10 секунд.'
  );
}

function sanctionRequestFromForm() {
  const kind = $('#sanction-kind').value;
  const reason = $('#sanction-reason').value;
  const note = $('#sanction-note').value.trim();
  let durationMs = null;
  let permanent = false;
  if (kind === 'ban') {
    const selected = $('#sanction-duration').value;
    if (selected === 'permanent') permanent = true;
    else if (selected === 'custom') {
      const hours = Number($('#sanction-custom-hours').value);
      durationMs = Number.isSafeInteger(hours) && hours > 0 ? hours * 60 * 60 * 1000 : null;
    } else {
      durationMs = Number(selected);
    }
  }
  return { kind, reason, note, durationMs, permanent };
}

async function refreshModerationCaseAfterSanction(targetAccountId) {
  const payload = await api('/api/admin/moderation/case', { targetAccountId });
  renderModerationCase(payload.case);
  if (state.currentPanel === 'moderation') await loadModeration();
  return payload.case;
}

async function submitSanction(event) {
  event.preventDefault();
  const item = state.moderationCase;
  if (!item || !state.capabilities.has('sanctions.write')) return;
  const request = sanctionRequestFromForm();
  if (!request.note) {
    resetSanctionConfirmation('Внутренняя заметка обязательна для любой санкции.');
    return;
  }
  if (request.kind === 'ban' && !request.permanent && !Number.isSafeInteger(request.durationMs)) {
    resetSanctionConfirmation('Укажите корректный срок бана.');
    return;
  }
  if (request.permanent && !state.capabilities.has('sanctions.permanent')) {
    resetSanctionConfirmation('Постоянный бан может выдать только владелец.');
    return;
  }

  const signature = JSON.stringify(['apply', item.targetAccountId, request]);
  const now = Date.now();
  if (
    !state.sanctionConfirmation ||
    state.sanctionConfirmation.signature !== signature ||
    state.sanctionConfirmation.expiresAt < now
  ) {
    state.sanctionConfirmation = { signature, expiresAt: now + 10_000 };
    $('#sanction-apply').textContent =
      request.kind === 'warning' ? 'Подтвердить предупреждение' : 'Подтвердить бан';
    $('#sanction-apply').classList.add('confirm');
    $('#sanction-action-hint').textContent =
      'Действие ещё не применено. Нажмите подтверждение в течение 10 секунд.';
    return;
  }

  $('#sanction-apply').disabled = true;
  $('#sanction-action-hint').textContent = 'Применяю санкцию и завершаю активные игровые сессии…';
  try {
    const result = await api('/api/admin/sanctions/apply', {
      targetAccountId: item.targetAccountId,
      ...request
    });
    await refreshModerationCaseAfterSanction(item.targetAccountId);
    setStatus(
      result.sanction.kind === 'ban'
        ? `Бан применён · завершено входов: ${formatNumber(result.revokedSessions)} · отключено соединений: ${formatNumber(result.disconnectedSockets)}`
        : 'Предупреждение записано',
      result.sanction.kind === 'ban' ? 'warn' : 'good'
    );
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    const labels = {
      'active-ban-exists': 'У игрока уже есть активный бан. Сначала снимите его или дождитесь окончания.',
      'sanction-duration-forbidden': 'Для вашей роли такой срок недоступен.',
      'permanent-sanction-owner-only': 'Постоянный бан доступен только владельцу.'
    };
    resetSanctionConfirmation(labels[error.payload?.error] || `Ошибка: ${error.message}`);
    setStatus('Санкция не применена', 'bad');
  } finally {
    $('#sanction-apply').disabled = false;
  }
}

async function revokeCurrentSanction() {
  const item = state.moderationCase;
  const active = item?.sanctions?.active;
  if (!active || !state.capabilities.has('sanctions.write')) return;
  const note = $('#sanction-note').value.trim();
  if (!note) {
    resetSanctionConfirmation('Перед снятием бана напишите внутреннюю причину решения.');
    return;
  }
  const signature = JSON.stringify(['revoke', active.id, note]);
  const now = Date.now();
  if (
    !state.sanctionConfirmation ||
    state.sanctionConfirmation.signature !== signature ||
    state.sanctionConfirmation.expiresAt < now
  ) {
    state.sanctionConfirmation = { signature, expiresAt: now + 10_000 };
    $('#sanction-revoke').textContent = 'Подтвердить снятие бана';
    $('#sanction-revoke').classList.add('confirm');
    $('#sanction-action-hint').textContent = 'Бан ещё действует. Подтвердите снятие в течение 10 секунд.';
    return;
  }
  $('#sanction-revoke').disabled = true;
  try {
    await api('/api/admin/sanctions/revoke', { sanctionId: active.id, note });
    await refreshModerationCaseAfterSanction(item.targetAccountId);
    setStatus('Бан снят досрочно', 'good');
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    resetSanctionConfirmation(
      error.payload?.error === 'permanent-sanction-owner-only'
        ? 'Постоянный бан может снять только владелец.'
        : `Ошибка: ${error.message}`
    );
    setStatus('Не удалось снять бан', 'bad');
  } finally {
    $('#sanction-revoke').disabled = false;
  }
}

function renderModerationCase(item) {
  state.moderationCase = item;
  resetModerationConfirmation(
    'Изменение будет записано и в историю дела, и в журнал действий администраторов.'
  );
  $('#case-title').textContent = item.currentName || 'Wobbler';
  $('#case-id').textContent = `ID игрока: ${item.targetAccountId}`;
  const status = $('#case-status');
  status.textContent = statusLabel(item.status);
  status.dataset.status = item.status;
  $('#case-reports').textContent =
    `${formatNumber(item.uniqueReporters)} разных жалобщиков · ${formatNumber(item.totalReports)} жалоб · ${reasonsText(item.reasons)}`;
  $('#case-last').textContent = `Последняя жалоба: ${formatTime(item.lastReportedAt)}`;

  const evidenceRoot = $('#case-evidence');
  evidenceRoot.replaceChildren();
  for (const evidence of item.evidence || []) {
    itemCard(evidenceRoot, reasonLabel(evidence.reason), [
      formatTime(evidence.reportedAt),
      `ID жалобщика: ${evidence.reporterAccountId}`,
      evidence.chapterIdSnapshot ? `глава: ${courseLabel(evidence.chapterIdSnapshot)}` : null,
      evidence.targetNameSnapshot ? `имя тогда: «${evidence.targetNameSnapshot}»` : null,
      Number(evidence.occurrences) > 1 ? `${evidence.occurrences} объединённых старых жалоб` : null
    ]);
  }
  if (!item.evidence?.length) appendText(evidenceRoot, 'p', 'Материалы жалоб отсутствуют.', 'muted');

  const historyRoot = $('#case-history');
  historyRoot.replaceChildren();
  for (const event of item.history || []) {
    itemCard(
      historyRoot,
      `${statusLabel(event.fromStatus)} → ${statusLabel(event.toStatus)}`,
      [
        formatTime(event.createdAt),
        `модератор: ${event.moderatorName || event.moderatorId}`,
        event.reviewedThrough ? `проверены жалобы до ${formatTime(event.reviewedThrough)}` : null
      ],
      event.note || ''
    );
  }
  if (!item.history?.length) appendText(historyRoot, 'p', 'Решений по делу пока нет.', 'muted');

  renderCaseSanctions(item);
  const action = $('#case-action');
  action.hidden = !state.capabilities.has('moderation.write');
  $('#case-next-status').value = defaultModerationStatus(item.status);
  $('#case-note').value = '';
}

async function openModerationCase(targetAccountId) {
  const requestRevision = ++state.moderationLoadRevision;
  setStatus('Загружаю дело…');
  try {
    const payload = await api('/api/admin/moderation/case', { targetAccountId });
    if (requestRevision !== state.moderationLoadRevision) return;
    renderModerationCase(payload.case);
    const dialog = $('#moderation-dialog');
    if (!dialog.open) dialog.showModal();
    setStatus('Дело загружено', 'good');
  } catch (error) {
    if (requestRevision !== state.moderationLoadRevision) return;
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Не удалось открыть дело: ${error.message}`, 'bad');
  }
}

async function submitModerationTransition(event) {
  event.preventDefault();
  const item = state.moderationCase;
  if (!item || !state.capabilities.has('moderation.write')) return;
  const nextStatus = $('#case-next-status').value;
  const note = $('#case-note').value.trim();
  const hint = $('#case-action-hint');
  const button = $('#case-apply');
  if (nextStatus === item.status) {
    resetModerationConfirmation('Выберите другой статус: текущее состояние дела уже такое.');
    return;
  }
  if ((nextStatus === 'resolved' || nextStatus === 'dismissed') && !note) {
    resetModerationConfirmation('Для закрытия или отклонения дела обязательно напишите причину решения.');
    return;
  }

  const signature = JSON.stringify([item.targetAccountId, item.revision, nextStatus, note]);
  const now = Date.now();
  if (
    !state.moderationConfirmation ||
    state.moderationConfirmation.signature !== signature ||
    state.moderationConfirmation.expiresAt < now
  ) {
    state.moderationConfirmation = { signature, expiresAt: now + 10_000 };
    button.textContent = `Подтвердить: ${STATUS_LABELS[nextStatus] || nextStatus}`;
    button.classList.add('confirm');
    hint.textContent =
      'Это ещё не применено. Проверьте материалы и заметку ещё раз, затем подтвердите в течение 10 секунд.';
    return;
  }

  button.disabled = true;
  hint.textContent = 'Сохраняю решение…';
  try {
    const payload = await api('/api/admin/moderation/transition', {
      targetAccountId: item.targetAccountId,
      status: nextStatus,
      note,
      expectedRevision: item.revision
    });
    renderModerationCase(payload.case);
    await loadModeration();
    setStatus(`Статус дела изменён: ${STATUS_LABELS[payload.case.status] || payload.case.status}`, 'good');
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    if (error.status === 409 && error.payload?.case) {
      renderModerationCase(error.payload.case);
      hint.textContent =
        'Пока вы читали дело, появилась новая жалоба или другой модератор изменил его. Я загрузил свежие данные — проверьте их заново.';
      setStatus('Дело изменилось — старое решение не применено', 'warn');
      return;
    }
    resetModerationConfirmation(`Ошибка: ${error.message}`);
    setStatus(`Не удалось изменить дело: ${error.message}`, 'bad');
  } finally {
    button.disabled = false;
  }
}

function infrastructureTone(infra) {
  if (!infra) return 'bad';
  if (
    !infra.services?.wobble?.active ||
    !infra.services?.nginx?.active ||
    !infra.network?.https443?.reachable ||
    !infra.https?.reachable ||
    infra.https?.expired ||
    infra.backup?.stale ||
    (infra.resources?.disk?.usedPercent ?? 0) >= 95
  ) {
    return 'bad';
  }
  if (
    !infra.https?.trusted ||
    (infra.https?.daysRemaining != null && infra.https.daysRemaining < 14) ||
    (infra.resources?.disk?.usedPercent ?? 0) >= 85
  ) {
    return 'warn';
  }
  return 'good';
}

function renderInfrastructure(payload) {
  const infra = payload.infrastructure;
  state.infrastructure = infra;
  const summary = $('#infrastructure-summary');
  summary.replaceChildren();

  const wobbleOk = Boolean(infra.services?.wobble?.active && infra.network?.nodeLocal?.reachable);
  const nginxOk = Boolean(infra.services?.nginx?.active && infra.network?.https443?.reachable);
  const certDays = infra.https?.daysRemaining;
  const certOk = Boolean(infra.https?.reachable && infra.https?.trusted && !infra.https?.expired);
  const diskUsed = infra.resources?.disk?.usedPercent;
  const backupOk = Boolean(
    infra.backup && !infra.backup.stale && (!infra.backup.required || infra.backup.available)
  );

  summary.append(
    statCard(
      'Сервер игры',
      wobbleOk ? 'РАБОТАЕТ' : 'ТРЕБУЕТ ПРОВЕРКИ',
      'wobble.service + локальный Node-порт',
      wobbleOk ? 'good' : 'bad'
    ),
    statCard(
      'Nginx / HTTPS',
      nginxOk ? 'РАБОТАЕТ' : 'ТРЕБУЕТ ПРОВЕРКИ',
      'systemd + локальный порт 443',
      nginxOk ? 'good' : 'bad'
    ),
    statCard(
      'Сертификат',
      certOk ? `${formatNumber(certDays)} дн.` : 'ТРЕБУЕТ ПРОВЕРКИ',
      certOk ? 'до окончания HTTPS-сертификата' : 'TLS недоступен, просрочен или не доверен',
      certOk && certDays >= 14 ? 'good' : certOk ? 'warn' : 'bad'
    ),
    statCard(
      'Диск',
      diskUsed == null ? 'НЕТ ДАННЫХ' : `${percent(diskUsed)} занято`,
      diskUsed == null
        ? 'измерение файловой системы недоступно'
        : `свободно ${formatBytes(infra.resources?.disk?.availableBytes)}`,
      diskUsed == null ? 'warn' : diskUsed >= 95 ? 'bad' : diskUsed >= 85 ? 'warn' : 'good'
    ),
    statCard(
      'Backup',
      backupOk ? 'СВЕЖИЙ' : 'ТРЕБУЕТ ПРОВЕРКИ',
      backupOk ? 'последняя копия в допустимом возрасте' : 'копия отсутствует или устарела',
      backupOk ? 'good' : 'bad'
    )
  );

  const servicesBody = $('#infrastructure-services-body');
  servicesBody.replaceChildren();
  for (const service of Object.values(infra.services || {})) {
    servicesBody.append(
      rowWithCells([
        `${service.label} (${service.unit})`,
        serviceState(service),
        service.unitFileState === 'enabled'
          ? 'Включён'
          : service.unitFileState === 'disabled'
            ? 'Выключен'
            : service.unitFileState || '—'
      ])
    );
  }

  fillDetails('#infrastructure-https-details', [
    ['Домен', infra.publicTarget?.hostname || 'Не определён'],
    ['TLS-подключение', availability(infra.https?.reachable)],
    ['Сертификат доверен', infra.https?.trusted ? 'Да' : 'Нет / не удалось проверить'],
    ['Действителен до', formatTime(infra.https?.validTo)],
    ['Осталось дней', certDays == null ? '—' : formatNumber(certDays)],
    ['Задержка TLS', formatMilliseconds(infra.https?.latencyMs)]
  ]);

  const memory = infra.resources?.memory || {};
  const disk = infra.resources?.disk || {};
  fillDetails('#infrastructure-resource-details', [
    ['VPS работает без перезагрузки', formatDuration(infra.resources?.hostUptimeSeconds)],
    [
      'Память занята',
      `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${percent(memory.usedPercent)})`
    ],
    ['Память свободна', formatBytes(memory.freeBytes)],
    [
      'Диск занят',
      `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${percent(disk.usedPercent)})`
    ],
    ['Диск свободен', formatBytes(disk.availableBytes)],
    ['Средняя нагрузка 1 / 5 / 15 мин', (infra.resources?.loadAverage || []).join(' / ') || '—']
  ]);

  fillDetails('#infrastructure-network-details', [
    ['HTTP :80', availability(infra.network?.http80?.reachable)],
    ['Shared HTTPS :443', availability(infra.network?.https443?.reachable)],
    [
      `Node 127.0.0.1:${infra.network?.nodeLocal?.port || 3000}`,
      availability(infra.network?.nodeLocal?.reachable)
    ],
    ['TLS через SNI Wobble', availability(infra.https?.reachable)]
  ]);

  const backup = infra.backup || {};
  const offsite = backup.offsite || {};
  fillDetails('#infrastructure-backup-details', [
    ['Локальная копия', backup.available ? 'Есть' : 'Нет'],
    ['Свежесть', backup.stale ? 'Устарела / проблема' : backup.available ? 'В норме' : 'Нет данных'],
    ['Последний успех', formatTime(backup.lastSuccessAt)],
    ['Возраст', backup.ageSeconds == null ? '—' : formatDuration(backup.ageSeconds)],
    ['Проверка целостности', backup.integrity || '—'],
    ['Offsite настроен', offsite.configured ? 'Да' : 'Нет'],
    ['Offsite обязателен', offsite.required ? 'Да' : 'Нет'],
    ['Offsite доступен', offsite.configured ? (offsite.available ? 'Да' : 'Нет') : 'Не настроен']
  ]);

  return infrastructureTone(infra);
}

async function loadInfrastructure() {
  const payload = await api('/api/admin/infrastructure', {});
  const tone = renderInfrastructure(payload);
  if (tone === 'bad') {
    return {
      statusText: 'Часть серверных проверок требует внимания. Посмотрите красные карточки ниже.',
      tone
    };
  }
  if (tone === 'warn') {
    return { statusText: 'Сервер работает, но есть предупреждения, которые стоит проверить.', tone };
  }
  return { statusText: 'Серверные проверки не показывают явных проблем.', tone: 'good' };
}

function clearOperationConfirmation() {
  state.operationConfirmation = null;
  if (state.operationConfirmationTimer) clearTimeout(state.operationConfirmationTimer);
  state.operationConfirmationTimer = null;
}

function operationErrorLabel(reason) {
  const labels = {
    'operations-unavailable': 'Безопасный helper пока не установлен или недоступен.',
    'helper-unavailable': 'Безопасный helper сейчас недоступен.',
    'helper-timeout': 'Операция выполнялась слишком долго и панель перестала её ждать.',
    'helper-error': 'Не удалось связаться с безопасным helper.',
    'operation-busy': 'Сейчас уже выполняется другая системная операция. Подождите немного.',
    'operation-timeout': 'Системная операция превысила допустимое время.',
    'operation-failed': 'Системная проверка завершилась ошибкой.',
    'restart-cooldown': 'Wobble недавно уже перезапускался. Подождите перед повтором.'
  };
  return labels[reason] || reason || 'Неизвестная ошибка';
}

function renderOperations(payload) {
  state.operations = payload;
  const status = $('#operations-status');
  status.replaceChildren(
    statCard(
      'Безопасные операции',
      payload.available ? 'ДОСТУПНЫ' : 'НЕДОСТУПНЫ',
      payload.available
        ? 'root-helper подключён через закрытый Unix socket и принимает только список действий ниже'
        : 'после обновления VPS установщик должен включить wobble-ops.socket',
      payload.available ? 'good' : 'bad'
    )
  );

  const root = $('#operations-list');
  root.replaceChildren();
  for (const operation of payload.operations || []) {
    const card = document.createElement('article');
    card.className = 'card';
    appendText(
      card,
      'p',
      operation.tone === 'danger' ? 'ТРЕБУЕТ ОСТОРОЖНОСТИ' : 'БЕЗОПАСНАЯ ОПЕРАЦИЯ',
      'eyebrow'
    );
    appendText(card, 'h2', operation.title);
    appendText(card, 'p', operation.description, 'section-help');
    const impact = document.createElement('div');
    impact.className = 'explain-box';
    appendText(impact, 'strong', 'Что произойдёт');
    appendText(impact, 'span', operation.impact);
    card.append(impact);

    const confirming =
      state.operationConfirmation?.operation === operation.id &&
      state.operationConfirmation.expiresAt > Date.now();
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.operation = operation.id;
    button.className = operation.tone === 'danger' ? 'primary confirm' : 'primary';
    button.disabled = !payload.available;
    button.textContent = confirming ? 'Подтвердить действие' : operation.title;
    card.append(button);
    if (confirming) {
      appendText(
        card,
        'p',
        'Первое нажатие ничего не выполнило. Проверьте описание выше и нажмите ещё раз в течение 10 секунд.',
        'muted warn'
      );
    }
    root.append(card);
  }
}

async function loadOperations() {
  const payload = await api('/api/admin/operations/status', {});
  renderOperations(payload);
}

async function runOperation(operation) {
  const spec = state.operations?.operations?.find(item => item.id === operation);
  if (!spec || !state.operations?.available) return;
  const now = Date.now();
  if (
    !state.operationConfirmation ||
    state.operationConfirmation.operation !== operation ||
    state.operationConfirmation.expiresAt <= now
  ) {
    clearOperationConfirmation();
    state.operationConfirmation = { operation, expiresAt: now + 10_000 };
    state.operationConfirmationTimer = setTimeout(() => {
      clearOperationConfirmation();
      if (state.currentPanel === 'operations' && state.operations) renderOperations(state.operations);
    }, 10_100);
    renderOperations(state.operations);
    setStatus(`Проверьте описание «${spec.title}» и нажмите ещё раз для подтверждения.`, 'warn');
    return;
  }

  clearOperationConfirmation();
  for (const button of $$('#operations-list button[data-operation]')) button.disabled = true;
  setStatus(`Выполняю: ${spec.title}…`);
  try {
    const result = await api('/api/admin/operations/run', {
      operation,
      confirmation: operation
    });
    if (operation === 'wobble.restart' && result.accepted) {
      setStatus('Перезапуск Wobble принят. Страница обновится после запуска сервера…', 'warn');
      setTimeout(() => window.location.reload(), 4500);
      return;
    }
    await loadOperations();
    setStatus(`${spec.title}: готово.`, 'good');
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    if (state.operations) renderOperations(state.operations);
    setStatus(`${spec.title}: ${operationErrorLabel(error.payload?.error || error.message)}`, 'bad');
  }
}

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action;
}

async function loadAudit() {
  const payload = await api('/api/admin/audit', { limit: 150 });
  const body = $('#audit-body');
  body.replaceChildren();
  for (const event of payload.events || []) {
    body.append(
      rowWithCells([
        formatTime(event.createdAt),
        event.actorName,
        ROLE_LABELS[event.actorRole] || event.actorRole,
        auditActionLabel(event.action),
        [event.targetType, event.targetId].filter(Boolean).join(': ') || '—'
      ])
    );
  }
  if (!payload.events?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Журнал пока пуст.', 'empty');
    cell.colSpan = 5;
    body.append(row);
  }
}

async function refreshCurrent() {
  const loaders = {
    overview: loadOverview,
    infrastructure: loadInfrastructure,
    analytics: loadAnalytics,
    players: loadPlayers,
    moderation: loadModeration,
    operations: loadOperations,
    audit: loadAudit
  };
  const panel = state.currentPanel;
  const loader = loaders[panel];
  if (!loader) return;

  const revision = ++state.refreshRevision;
  const sessionGeneration = state.sessionGeneration;
  const refresh = $('#refresh');
  refresh.disabled = true;
  refresh.setAttribute('aria-busy', 'true');
  $('#app-view').setAttribute('aria-busy', 'true');
  setStatus('Обновляю данные…');

  try {
    const result = await loader();
    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    if (result?.statusText) setStatus(result.statusText, result.tone || '');
    else setStatus(`Данные обновлены в ${new Date().toLocaleTimeString('ru-RU')}`, 'good');
  } catch (error) {
    if (error.status === 401 && sessionGeneration === state.sessionGeneration)
      return showLogin('Сессия администратора завершена. Войдите снова.');
    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    setStatus(`Ошибка: ${error.message}`, 'bad');
  } finally {
    if (revision === state.refreshRevision) {
      refresh.disabled = false;
      refresh.removeAttribute('aria-busy');
      $('#app-view').removeAttribute('aria-busy');
    }
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  const accessCode = $('#access-code').value.trim();
  try {
    const payload = await api('/api/admin/login', { accessCode }, { csrf: false });
    $('#access-code').value = '';
    activateSession(payload);
  } catch (error) {
    $('#login-error').textContent =
      error.status === 404
        ? 'Панель отключена на сервере. Сначала включите ADMIN_PANEL_ENABLED=1.'
        : error.status === 429
          ? 'Слишком много попыток входа. Подождите и попробуйте снова.'
          : 'Код администратора не подошёл.';
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout');
  } catch {
    state.csrf = '';
  }
  showLogin();
});

$('#refresh').addEventListener('click', refreshCurrent);
$('#operations-list').addEventListener('click', event => {
  const button = event.target.closest('button[data-operation]');
  if (button) runOperation(button.dataset.operation);
});
$('#analytics-days').addEventListener('change', () => {
  $('#analytics-mode').value = 'all';
  $('#analytics-course').value = 'all';
  $('#analytics-device').value = 'all';
  refreshCurrent();
});
$('#analytics-mode').addEventListener('change', refreshCurrent);
$('#analytics-course').addEventListener('change', refreshCurrent);
$('#analytics-device').addEventListener('change', refreshCurrent);
$('#analytics-trend-metric').addEventListener('change', renderAnalyticsTrend);
$('#analytics-export-csv').addEventListener('click', () => exportAnalytics('csv'));
$('#analytics-export-json').addEventListener('click', () => exportAnalytics('json'));
$('#player-search-form').addEventListener('submit', async event => {
  event.preventDefault();
  setStatus('Ищу игрока…');
  try {
    await searchPlayers();
    setStatus('Поиск завершён', 'good');
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Ошибка поиска: ${error.message}`, 'bad');
  }
});
$('#player-detail-close').addEventListener('click', hidePlayerDetail);
$('#player-copy-support-id').addEventListener('click', copyPlayerSupportId);
$('#player-force-logout').addEventListener('click', forceLogoutPlayer);
$('#player-rename').addEventListener('click', () => renamePlayer($('#player-rename-input').value));
$('#player-reset-name').addEventListener('click', () => renamePlayer('Wobbler'));
$('#player-open-moderation').addEventListener('click', openPlayerModeration);
$('#player-support-note').addEventListener('input', () => resetPlayerActionConfirmation());
$('#player-rename-input').addEventListener('input', () => resetPlayerActionConfirmation());
$('#moderation-status').addEventListener('change', refreshCurrent);
$('#case-close').addEventListener('click', closeModerationCase);
$('#case-action').addEventListener('submit', submitModerationTransition);
$('#case-next-status').addEventListener('change', () => resetModerationConfirmation());
$('#case-note').addEventListener('input', () => resetModerationConfirmation());
$('#sanction-action').addEventListener('submit', submitSanction);
$('#sanction-revoke').addEventListener('click', revokeCurrentSanction);
$('#sanction-kind').addEventListener('change', updateSanctionFields);
$('#sanction-duration').addEventListener('change', updateSanctionFields);
$('#sanction-custom-hours').addEventListener('input', () => resetSanctionConfirmation());
$('#sanction-reason').addEventListener('change', () => resetSanctionConfirmation());
$('#sanction-note').addEventListener('input', () => resetSanctionConfirmation());
$('#moderation-dialog').addEventListener('cancel', () => {
  state.moderationLoadRevision += 1;
  state.moderationCase = null;
  resetModerationConfirmation();
  resetSanctionConfirmation();
});
for (const button of $$('#tabs [data-panel]')) {
  button.addEventListener('click', () => switchPanel(button.dataset.panel));
}

(async () => {
  try {
    const payload = await api('/api/admin/session', {}, { csrf: false });
    activateSession(payload);
  } catch (error) {
    showLogin(error.status === 404 ? 'Панель пока отключена на сервере.' : '');
  }
})();
