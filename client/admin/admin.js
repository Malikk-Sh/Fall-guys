'use strict';

const state = {
  csrf: '',
  admin: null,
  capabilities: new Set(),
  currentPanel: 'overview',
  analytics: null,
  moderationCase: null,
  moderationConfirmation: null,
  moderationLoadRevision: 0
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
  offensiveName: 'Оскорбительное имя'
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
  'moderation.case.transition': 'Изменён статус жалобы'
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
  const dialog = $('#moderation-dialog');
  if (dialog.open) dialog.close();
}

function showLogin(message = '') {
  closeModerationCase();
  state.csrf = '';
  state.admin = null;
  state.capabilities = new Set();
  state.analytics = null;
  $('#app-view').hidden = true;
  $('#identity').hidden = true;
  $('#login-view').hidden = false;
  $('#login-error').textContent = message;
}

function activateSession(payload) {
  state.csrf = payload.csrf;
  state.admin = payload.admin;
  state.capabilities = new Set(payload.capabilities || []);
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
  state.currentPanel = name;
  for (const item of $$('.panel')) item.hidden = item.id !== `panel-${name}`;
  for (const item of $$('#tabs [data-panel]')) item.classList.toggle('active', item.dataset.panel === name);
  refreshCurrent();
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
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
  card.className = 'stat';
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
  const comparisonUnavailableHint = `полное сравнение недоступно: метрики хранятся ${formatNumber(data.retentionDays)} дней`;
  const cards = $('#analytics-kpis');
  cards.replaceChildren(
    statCard(
      'Начатые матчи',
      formatNumber(current.started),
      comparisonHint(current.started, previous.started)
    ),
    statCard(
      'Завершённые матчи',
      formatNumber(current.finished),
      comparisonHint(current.finished, previous.finished)
    ),
    statCard(
      'Завершено / начато',
      completion,
      `${comparisonAvailable ? `прошлый такой же период: ${previousCompletion}` : comparisonUnavailableHint} · это отношение событий, не уникальных игроков`
    ),
    statCard(
      'Выходы до финиша',
      formatNumber(current.abandoned),
      comparisonHint(current.abandoned, previous.abandoned),
      current.abandoned > previous.abandoned ? 'warn' : ''
    ),
    statCard(
      'Падения',
      formatNumber(current.falls),
      comparisonHint(current.falls, previous.falls),
      current.falls > previous.falls ? 'warn' : ''
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
  const request = analyticsRequest();
  const payload = await api('/api/admin/analytics', request);
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
    analytics: loadAnalytics,
    moderation: loadModeration,
    audit: loadAudit
  };
  const loader = loaders[state.currentPanel];
  if (!loader) return;
  setStatus('Обновляю данные…');
  try {
    await loader();
    setStatus(`Данные обновлены в ${new Date().toLocaleTimeString('ru-RU')}`, 'good');
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Ошибка: ${error.message}`, 'bad');
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
$('#moderation-status').addEventListener('change', refreshCurrent);
$('#case-close').addEventListener('click', closeModerationCase);
$('#case-action').addEventListener('submit', submitModerationTransition);
$('#case-next-status').addEventListener('change', () => resetModerationConfirmation());
$('#case-note').addEventListener('input', () => resetModerationConfirmation());
$('#moderation-dialog').addEventListener('cancel', () => {
  state.moderationLoadRevision += 1;
  state.moderationCase = null;
  resetModerationConfirmation();
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
