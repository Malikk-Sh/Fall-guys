'use strict';

const state = {
  csrf: '',
  admin: null,
  capabilities: new Set(),
  currentPanel: 'overview'
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

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

function showLogin(message = '') {
  state.csrf = '';
  state.admin = null;
  state.capabilities = new Set();
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
  $('#admin-role').textContent = payload.admin.role;
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
  state.currentPanel = name;
  for (const item of $$('.panel')) item.hidden = item.id !== `panel-${name}`;
  for (const item of $$('#tabs [data-panel]')) item.classList.toggle('active', item.dataset.panel === name);
  refreshCurrent();
}

function formatNumber(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
}

function formatTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value)
  );
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

async function loadOverview() {
  const payload = await api('/api/admin/dashboard');
  const data = payload.overview;
  const health = data.health || {};
  const backup = health.backup || {};
  const cards = $('#overview-cards');
  cards.replaceChildren(
    statCard('Игроки сейчас', formatNumber(health.players), `${formatNumber(health.rooms)} комнат`),
    statCard(
      'Активные 24ч',
      formatNumber(data.accounts?.active24h),
      `${formatNumber(data.accounts?.total)} аккаунтов`
    ),
    statCard(
      'Модерация',
      formatNumber(data.moderation?.open),
      `${formatNumber(data.moderation?.reviewing)} reviewing · ${formatNumber(data.moderation?.reports24h)} жалоб / 24ч`,
      data.moderation?.open ? 'warn' : 'good'
    ),
    statCard(
      'Backup',
      backup.ok === false ? 'ПРОБЛЕМА' : 'OK',
      backup.local?.ageSeconds != null
        ? `возраст ${formatDuration(backup.local.ageSeconds)}`
        : 'статус в /health',
      backup.ok === false ? 'bad' : 'good'
    )
  );
  fillDetails('#production-details', [
    ['Version', health.version],
    ['Commit', health.commit],
    ['Release', health.release || 'branch mode'],
    ['Protocol', health.protocolVersion],
    ['Started', formatTime(health.startedAt)],
    ['Uptime', formatDuration(health.uptime)],
    ['Competitive records', formatNumber(data.competitiveRecords)]
  ]);
  fillDetails('#load-details', [
    ['Event loop p95', `${health.load?.eventLoopP95Ms ?? 0} ms`],
    ['RSS', `${health.load?.rssMb ?? 0} MB`],
    ['Heap', `${health.load?.heapUsedMb ?? 0} / ${health.load?.heapTotalMb ?? 0} MB`],
    ['Sockets', `${health.capacity?.socketCount ?? 0} / ${health.capacity?.maxSockets ?? 0}`],
    ['Matches', `${health.capacity?.activeMatches ?? 0} / ${health.capacity?.maxMatches ?? 0}`],
    ['Matchmaking', `${health.matchmaking?.waiting ?? 0} waiting`],
    ['Overloaded', health.load?.overloaded ? 'YES' : 'no']
  ]);
}

function rowWithCells(values) {
  const row = document.createElement('tr');
  for (const value of values) appendText(row, 'td', String(value ?? '—'));
  return row;
}

async function loadAnalytics() {
  const days = Number($('#analytics-days').value || 7);
  const payload = await api('/api/admin/analytics', { days, limit: 300 });
  const data = payload.analytics;
  $('#analytics-meta').textContent = `С ${data.from} · dropped=${data.dropped} · ${data.rows.length} строк`;
  const body = $('#analytics-body');
  body.replaceChildren();
  for (const row of data.rows) {
    body.append(
      rowWithCells([
        row.metric,
        row.mode,
        row.course,
        row.detail,
        row.device,
        formatNumber(row.samples),
        row.average == null ? '—' : formatNumber(row.average)
      ])
    );
  }
  if (!data.rows.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Нет данных за выбранный период', 'empty');
    cell.colSpan = 7;
    body.append(row);
  }
}

function reasonsText(reasons = {}) {
  return (
    Object.entries(reasons)
      .filter(([, count]) => Number(count) > 0)
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(' · ') || '—'
  );
}

async function loadModeration() {
  const status = $('#moderation-status').value || 'open';
  const payload = await api('/api/admin/moderation/queue', { status, limit: 100 });
  const body = $('#moderation-body');
  body.replaceChildren();
  for (const item of payload.cases || []) {
    body.append(
      rowWithCells([
        `${item.currentName} · ${item.targetAccountId}`,
        item.status,
        item.uniqueReporters,
        item.totalReports,
        reasonsText(item.reasons),
        formatTime(item.lastReportedAt)
      ])
    );
  }
  if (!payload.cases?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Очередь пуста', 'empty');
    cell.colSpan = 6;
    body.append(row);
  }
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
        event.actorRole,
        event.action,
        [event.targetType, event.targetId].filter(Boolean).join(': ') || '—'
      ])
    );
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
  setStatus('Обновление…');
  try {
    await loader();
    setStatus(`Обновлено ${new Date().toLocaleTimeString('ru-RU')}`, 'good');
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
        ? 'Admin panel отключена на сервере.'
        : error.status === 429
          ? 'Слишком много попыток. Подождите и попробуйте снова.'
          : 'Неверный access code.';
  }
});

$('#logout').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout');
  } catch {}
  showLogin();
});

$('#refresh').addEventListener('click', refreshCurrent);
$('#analytics-days').addEventListener('change', loadAnalytics);
$('#moderation-status').addEventListener('change', loadModeration);
for (const button of $$('#tabs [data-panel]')) {
  button.addEventListener('click', () => switchPanel(button.dataset.panel));
}

(async () => {
  try {
    const payload = await api('/api/admin/session', {}, { csrf: false });
    activateSession(payload);
  } catch (error) {
    showLogin(error.status === 404 ? 'Admin panel пока отключена на сервере.' : '');
  }
})();
