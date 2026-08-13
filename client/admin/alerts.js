'use strict';

(() => {
  const readCapability = 'alerts.read';
  const acknowledgeCapability = 'alerts.ack';
  const POLL_MS = 30_000;
  const state = {
    data: null,
    revision: 0,
    canRead: false,
    canAcknowledge: false,
    pollTimer: null
  };
  const $ = selector => document.querySelector(selector);

  function text(parent, tag, value, className = '') {
    const node = document.createElement(tag);
    node.textContent = String(value ?? '—');
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function sharedApi(path, body = {}, options = {}) {
    if (typeof window.api !== 'function') throw new Error('admin-api-unavailable');
    return window.api(path, body, options);
  }

  function sharedSwitchPanel(name) {
    if (typeof window.switchPanel !== 'function') throw new Error('admin-navigation-unavailable');
    return window.switchPanel(name);
  }

  function sharedShowLogin(message) {
    state.revision += 1;
    stopPolling();
    clearView();
    if (typeof window.showLogin === 'function') return window.showLogin(message);
    window.location.reload();
  }

  function setStatus(message, tone = '') {
    const node = $('#status-line');
    if (!node) return;
    node.textContent = message;
    node.className = `muted ${tone}`.trim();
  }

  function formatTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(
      new Date(Number(value))
    );
  }

  function formatDurationSeconds(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds >= 86400) return `${Math.floor(seconds / 86400)}д ${Math.floor((seconds % 86400) / 3600)}ч`;
    if (seconds >= 3600) return `${Math.floor(seconds / 3600)}ч ${Math.floor((seconds % 3600) / 60)}м`;
    if (seconds >= 60) return `${Math.floor(seconds / 60)}м`;
    return `${Math.round(seconds)}с`;
  }

  function statCard(label, value, hint = '', tone = '') {
    const card = document.createElement('article');
    card.className = `stat${tone ? ` stat-${tone}` : ''}`;
    text(card, 'span', label, 'label');
    text(card, 'strong', value, `value ${tone}`.trim());
    if (hint) text(card, 'span', hint, 'hint');
    return card;
  }

  function row(values, cellTag = 'td') {
    const tr = document.createElement('tr');
    for (const value of values) text(tr, cellTag, value);
    return tr;
  }

  function severityLabel(value) {
    return value === 'critical' ? 'КРИТИЧНО' : 'ПРЕДУПРЕЖДЕНИЕ';
  }

  function severityTone(value) {
    return value === 'critical' ? 'bad' : 'warn';
  }

  function panelLabel(value) {
    const labels = {
      infrastructure: 'Сервер',
      reliability: 'Надёжность',
      operations: 'Операции'
    };
    return labels[value] || value || 'Обзор';
  }

  function contextLabel(alert) {
    const context = alert?.context || {};
    switch (alert?.rule) {
      case 'game-unavailable':
      case 'game-not-ready':
        return `systemd: ${context.serviceActive ? 'active' : 'не active'} · endpoint: ${context.reachable ? 'доступен' : 'недоступен'} · ready: ${context.ready ? 'да' : 'нет'}`;
      case 'nginx-unavailable':
        return context.serviceActive ? 'Nginx active' : 'Nginx не active';
      case 'public-edge-unavailable':
        return `TCP: ${context.tcpReachable ? 'да' : 'нет'} · TLS: ${context.tlsReachable ? 'да' : 'нет'}`;
      case 'tls-unhealthy':
      case 'tls-expiring':
        return `TLS: ${context.reachable ? 'доступен' : 'недоступен'} · доверие: ${context.trusted ? 'да' : 'нет'} · осталось: ${context.daysRemaining == null ? '—' : `${context.daysRemaining} дн.`}`;
      case 'backup-stale':
        return `local: ${context.available ? 'есть' : 'нет'} · возраст: ${formatDurationSeconds(context.ageSeconds)}${context.offsiteRequired ? ` · offsite: ${context.offsiteAvailable && !context.offsiteStale ? 'в норме' : 'проблема'}` : ''}`;
      case 'disk-pressure':
        return context.usedPercent == null
          ? 'Нет данных о заполнении диска'
          : `Диск занят на ${context.usedPercent}%`;
      case 'reliability-degraded':
        return context.reasons?.length
          ? context.reasons.join(' · ')
          : 'Reliability вернула ухудшенный статус';
      case 'operation-stuck':
        return `${context.action || 'operation'} · ${context.state || 'unknown'} · без изменения ${formatDurationSeconds(context.ageSeconds)}`;
      default:
        return '—';
    }
  }

  function acknowledgementLabel(alert) {
    if (!alert.acknowledgedAt) return 'Не просмотрено';
    return `Увидел: ${alert.acknowledgedBy?.name || 'администратор'} · ${formatTime(alert.acknowledgedAt)}`;
  }

  function clearView() {
    state.data = null;
    const cards = $('#alerts-cards');
    const active = $('#alerts-active-body');
    const history = $('#alerts-history-body');
    const meta = $('#alerts-meta');
    if (cards) cards.replaceChildren();
    if (active) active.replaceChildren();
    if (history) history.replaceChildren();
    if (meta) meta.textContent = '';
    updateTab(null);
  }

  function updateTab(data) {
    const tab = $('#tabs [data-panel="alerts"]');
    if (!tab) return;
    const unacknowledged = Number(data?.counts?.unacknowledged || 0);
    tab.textContent = unacknowledged > 0 ? `Оповещения · ${unacknowledged}` : 'Оповещения';
    tab.title = unacknowledged > 0 ? `Непросмотренных: ${unacknowledged}` : 'Нет непросмотренных оповещений';
  }

  function appendEmpty(body, message, columns) {
    const tr = document.createElement('tr');
    const cell = text(tr, 'td', message, 'empty');
    cell.colSpan = columns;
    body.append(tr);
  }

  function openRecommended(panel) {
    const tab = $(`#tabs [data-panel="${panel}"]`);
    if (tab && !tab.hidden) {
      tab.click();
      return;
    }
    sharedSwitchPanel(panel || 'overview');
  }

  function render(data) {
    state.data = data;
    updateTab(data);
    const counts = data.counts || {};
    const sourceValues = Object.values(data.sources || {});
    const healthySources = sourceValues.filter(Boolean).length;
    const sourceTone = healthySources === sourceValues.length && sourceValues.length ? 'good' : 'warn';
    const freshnessTone = data.evaluationStale || !data.storageHealthy ? 'bad' : 'good';
    $('#alerts-cards').replaceChildren(
      statCard(
        'Активные проблемы',
        String(Number(counts.active || 0)),
        `${Number(counts.critical || 0)} критичных · ${Number(counts.warning || 0)} предупреждений`,
        Number(counts.critical || 0) ? 'bad' : Number(counts.warning || 0) ? 'warn' : 'good'
      ),
      statCard(
        'Непросмотрено',
        String(Number(counts.unacknowledged || 0)),
        'Acknowledgement не закрывает проблему — только отмечает, что оператор её увидел.',
        Number(counts.unacknowledged || 0) ? 'warn' : 'good'
      ),
      statCard(
        'Источники',
        sourceValues.length ? `${healthySources}/${sourceValues.length}` : '0/0',
        'Infrastructure · Reliability · Durable Operations',
        sourceTone
      ),
      statCard(
        'Evaluator',
        data.evaluationStale ? 'УСТАРЕЛ' : data.storageHealthy ? 'РАБОТАЕТ' : 'STATE ERROR',
        data.lastEvaluatedAt
          ? `Последняя проверка: ${formatTime(data.lastEvaluatedAt)}`
          : 'Проверка ещё не завершалась',
        freshnessTone
      )
    );
    $('#alerts-meta').textContent =
      `Состояние сформировано: ${formatTime(data.generatedAt)}. Alert Center не запускает restart и не меняет источник health автоматически.`;

    const active = $('#alerts-active-body');
    active.replaceChildren();
    for (const alert of data.active || []) {
      const tr = row([
        severityLabel(alert.severity),
        alert.title,
        formatTime(alert.openedAt),
        acknowledgementLabel(alert),
        contextLabel(alert)
      ]);
      tr.firstElementChild.className = severityTone(alert.severity);
      const action = document.createElement('td');
      const buttons = document.createElement('div');
      buttons.className = 'support-action-buttons';
      const inspect = text(buttons, 'button', `Открыть «${panelLabel(alert.recommendedPanel)}»`, 'ghost');
      inspect.type = 'button';
      inspect.addEventListener('click', () => openRecommended(alert.recommendedPanel));
      if (state.canAcknowledge && !alert.acknowledgedAt) {
        const acknowledge = text(buttons, 'button', 'Отметить как увиденное', 'primary');
        acknowledge.type = 'button';
        acknowledge.dataset.alertId = alert.id;
      }
      action.append(buttons);
      tr.append(action);
      active.append(tr);
    }
    if (!(data.active || []).length) appendEmpty(active, 'Активных оповещений сейчас нет.', 6);

    const history = $('#alerts-history-body');
    history.replaceChildren();
    for (const alert of data.history || []) {
      history.append(
        row([
          severityLabel(alert.severity),
          alert.title,
          formatTime(alert.openedAt),
          formatTime(alert.resolvedAt),
          acknowledgementLabel(alert)
        ])
      );
    }
    if (!(data.history || []).length) appendEmpty(history, 'Resolved incidents пока не накопились.', 5);
  }

  async function loadAlerts({ silent = false } = {}) {
    if (!state.canRead || document.body.dataset.adminSession !== 'active') return false;
    const revision = ++state.revision;
    if (!silent && !$('#panel-alerts')?.hidden) setStatus('Обновляю Alert Center…');
    try {
      const payload = await sharedApi('/api/admin/alerts/status', {});
      if (revision !== state.revision || !state.canRead) return false;
      render(payload.alerts);
      if (!silent && !$('#panel-alerts')?.hidden) {
        const counts = payload.alerts?.counts || {};
        setStatus(
          Number(counts.critical || 0)
            ? 'Есть критичные production-оповещения. Сначала откройте связанный раздел диагностики.'
            : Number(counts.warning || 0)
              ? 'Есть production-предупреждения, которые стоит проверить.'
              : 'Активных production-оповещений нет.',
          Number(counts.critical || 0) ? 'bad' : Number(counts.warning || 0) ? 'warn' : 'good'
        );
      }
      return true;
    } catch (error) {
      if (revision !== state.revision) return false;
      if (error.status === 401) {
        sharedShowLogin('Сессия администратора завершена. Войдите снова.');
        return false;
      }
      if (!silent && !$('#panel-alerts')?.hidden) {
        setStatus(`Не удалось загрузить Alert Center: ${error.message}`, 'bad');
      }
      return false;
    }
  }

  async function acknowledge(alertId) {
    if (!state.canAcknowledge || !alertId) return;
    setStatus('Сохраняю отметку оператора…');
    try {
      await sharedApi('/api/admin/alerts/acknowledge', { alertId });
      await loadAlerts({ silent: true });
      setStatus(
        'Оповещение отмечено как увиденное. Оно останется активным до восстановления health.',
        'good'
      );
    } catch (error) {
      if (error.status === 401) {
        sharedShowLogin('Сессия администратора завершена. Войдите снова.');
        return;
      }
      setStatus(`Не удалось сохранить acknowledgement: ${error.message}`, 'bad');
    }
  }

  function startPolling() {
    if (state.pollTimer || !state.canRead) return;
    void loadAlerts({ silent: true });
    state.pollTimer = setInterval(() => void loadAlerts({ silent: true }), POLL_MS);
  }

  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function openPanel() {
    if (!state.canRead) return;
    sharedSwitchPanel('alerts');
    void loadAlerts();
  }

  async function syncAccess() {
    const tab = $('#tabs [data-panel="alerts"]');
    if (!tab) return;
    if (document.body.dataset.adminSession !== 'active') {
      state.canRead = false;
      state.canAcknowledge = false;
      tab.hidden = true;
      $('#panel-alerts').hidden = true;
      stopPolling();
      clearView();
      return;
    }
    try {
      const value = await sharedApi('/api/admin/session', {}, { csrf: false });
      const capabilities = new Set(value.capabilities || []);
      state.canRead = capabilities.has(readCapability);
      state.canAcknowledge = capabilities.has(acknowledgeCapability);
      tab.hidden = !state.canRead;
      if (!state.canRead) {
        $('#panel-alerts').hidden = true;
        stopPolling();
        clearView();
        return;
      }
      startPolling();
    } catch (error) {
      state.canRead = false;
      state.canAcknowledge = false;
      tab.hidden = true;
      $('#panel-alerts').hidden = true;
      stopPolling();
      clearView();
      if (error.status === 401 && document.body.dataset.adminSession === 'active') {
        sharedShowLogin('Сессия администратора завершена. Войдите снова.');
      }
    }
  }

  function createUi() {
    if ($('#panel-alerts')) return;
    const tabs = $('#tabs');
    if (!tabs) return;
    const overview = tabs.querySelector('[data-panel="overview"]');
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.panel = 'alerts';
    tab.dataset.capability = readCapability;
    tab.textContent = 'Оповещения';
    tab.hidden = true;
    overview?.after(tab);
    if (!overview) tabs.prepend(tab);

    const panel = document.createElement('section');
    panel.id = 'panel-alerts';
    panel.className = 'panel';
    panel.hidden = true;

    const help = document.createElement('details');
    help.className = 'help-card';
    help.open = true;
    text(help, 'summary', 'Что такое «Оповещения»?');
    text(
      help,
      'p',
      'Alert Center сам проверяет уже существующие безопасные сигналы сервера и собирает только устойчивые проблемы. Один случайный неудачный probe не создаёт incident.'
    );
    text(
      help,
      'p',
      '«Отметить как увиденное» не исправляет и не скрывает проблему. Alert станет resolved только после устойчивого восстановления исходного health-сигнала. Автоматических restart или внешних webhook здесь нет.'
    );
    panel.append(help);

    const summary = document.createElement('article');
    summary.className = 'card';
    text(summary, 'p', 'OPERATOR INBOX', 'eyebrow');
    text(summary, 'h2', 'Что требует внимания сейчас');
    const meta = text(summary, 'p', '', 'muted');
    meta.id = 'alerts-meta';
    const cards = document.createElement('div');
    cards.id = 'alerts-cards';
    cards.className = 'cards';
    summary.append(cards);
    panel.append(summary);

    const activeCard = document.createElement('article');
    activeCard.className = 'card';
    text(activeCard, 'h2', 'Активные оповещения');
    text(
      activeCard,
      'p',
      'Сначала откройте рекомендуемый раздел и подтвердите симптом. Операции запускаются отдельно и только вручную.',
      'section-help'
    );
    const activeWrap = document.createElement('div');
    activeWrap.className = 'table-wrap';
    const activeTable = document.createElement('table');
    const activeHead = document.createElement('thead');
    activeHead.append(row(['Приоритет', 'Проблема', 'С', 'Просмотрено', 'Контекст', 'Что делать'], 'th'));
    activeTable.append(activeHead);
    const activeBody = document.createElement('tbody');
    activeBody.id = 'alerts-active-body';
    activeTable.append(activeBody);
    activeWrap.append(activeTable);
    activeCard.append(activeWrap);
    panel.append(activeCard);

    const historyCard = document.createElement('article');
    historyCard.className = 'card';
    text(historyCard, 'h2', 'Недавно восстановилось');
    text(
      historyCard,
      'p',
      'Resolved означает только то, что исходный health-сигнал устойчиво вернулся в норму.',
      'section-help'
    );
    const historyWrap = document.createElement('div');
    historyWrap.className = 'table-wrap';
    const historyTable = document.createElement('table');
    const historyHead = document.createElement('thead');
    historyHead.append(row(['Приоритет', 'Проблема', 'Началось', 'Восстановилось', 'Просмотрено'], 'th'));
    historyTable.append(historyHead);
    const historyBody = document.createElement('tbody');
    historyBody.id = 'alerts-history-body';
    historyTable.append(historyBody);
    historyWrap.append(historyTable);
    historyCard.append(historyWrap);
    panel.append(historyCard);

    $('#app-view')?.append(panel);
    tab.addEventListener('click', openPanel);
    activeBody.addEventListener('click', event => {
      const button = event.target.closest('button[data-alert-id]');
      if (button) void acknowledge(button.dataset.alertId);
    });
    $('#refresh')?.addEventListener(
      'click',
      event => {
        if (!panel.hidden && tab.classList.contains('active')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          void loadAlerts();
        }
      },
      true
    );
  }

  createUi();
  const observer = new MutationObserver(syncAccess);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-admin-session'] });
  void syncAccess();
})();
