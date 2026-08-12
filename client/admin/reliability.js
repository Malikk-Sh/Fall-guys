'use strict';

(() => {
  const capability = 'reliability.read';
  const state = { data: null, revision: 0 };
  const $ = selector => document.querySelector(selector);

  function text(parent, tag, value, className = '') {
    const node = document.createElement(tag);
    node.textContent = String(value ?? '—');
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('ru-RU').format(Number(value || 0));
  }

  function formatTime(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(
      new Date(Number(value))
    );
  }

  function percent(value) {
    return value == null ? '—' : `${Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
  }

  function setStatus(message, tone = '') {
    const node = $('#status-line');
    if (!node) return;
    node.textContent = message;
    node.className = `muted ${tone}`.trim();
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

  function buildLabel(build = {}) {
    return `${build.version || 'unknown'} · ${build.commit || 'unknown'}${build.release ? ` · ${build.release}` : ''}`;
  }

  const eventLabels = Object.freeze({
    message_handler_threw: 'Ошибка обработчика сетевого сообщения',
    socket_send_failed: 'Не удалось отправить WebSocket-пакет',
    socket_send_threw: 'WebSocket send выбросил исключение',
    invalid_room_transition: 'Недопустимый переход состояния комнаты',
    shutdown_forced: 'Принудительное завершение процесса',
    database_close_failed: 'Ошибка закрытия SQLite',
    server_started: 'Сервер запущен',
    server_drain_started: 'Начато плавное завершение',
    server_drain_finished: 'Плавное завершение закончено',
    shutdown_started: 'Начато выключение',
    shutdown_complete: 'Выключение завершено'
  });

  function eventLabel(value) {
    return eventLabels[value] || value || '—';
  }

  function toneForStatus(status) {
    return status === 'critical' ? 'bad' : status === 'warning' ? 'warn' : 'good';
  }

  function statusLabel(status) {
    if (status === 'critical') return 'ТРЕБУЕТ ВНИМАНИЯ';
    if (status === 'warning') return 'ЕСТЬ ПРЕДУПРЕЖДЕНИЯ';
    return 'СТАБИЛЬНО';
  }

  function reasonLabel(reason) {
    const labels = {
      'internal-errors': 'зафиксированы внутренние ошибки сервера',
      'operational-warnings': 'зафиксированы предупреждения внутренних операций',
      'event-loop-critical': 'event loop сильно задерживается',
      'event-loop-high': 'event loop работает медленнее нормы',
      'reconnect-failure-rate-critical': 'очень высокая доля неудачных reconnect',
      'reconnect-failure-rate-high': 'повышенная доля неудачных reconnect',
      'socket-send-failures': 'повторяются ошибки отправки WebSocket',
      'capacity-rejections': 'сервер отклонял подключения из-за лимитов ёмкости',
      'lifecycle-warning': 'одно из событий запуска/остановки завершилось с предупреждением'
    };
    return labels[reason] || reason;
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
    clearView();
    if (typeof window.showLogin === 'function') return window.showLogin(message);
    window.location.reload();
  }

  function clearView() {
    state.data = null;
    const meta = $('#reliability-meta');
    if (meta) meta.textContent = '';
    for (const selector of [
      '#reliability-cards',
      '#reliability-errors',
      '#reliability-lifecycle',
      '#reliability-series'
    ]) {
      const node = $(selector);
      if (node) node.replaceChildren();
    }
  }

  function createUi() {
    if ($('#panel-reliability')) return;
    const tabs = $('#tabs');
    const infrastructure = tabs?.querySelector('[data-panel="infrastructure"]');
    if (!tabs) return;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.dataset.panel = 'reliability';
    tab.dataset.capability = capability;
    tab.textContent = 'Надёжность';
    tab.hidden = true;
    infrastructure?.after(tab);
    if (!infrastructure) tabs.append(tab);

    const panel = document.createElement('section');
    panel.id = 'panel-reliability';
    panel.className = 'panel';
    panel.hidden = true;

    const help = document.createElement('details');
    help.className = 'help-card';
    help.open = true;
    text(help, 'summary', 'Что показывает «Надёжность»?');
    text(
      help,
      'p',
      'Это история состояния всего сервера, а не конкретного игрока: reconnect, внутренние ошибки, WebSocket, нагрузка, лимиты и жизненный цикл процесса. Данные сохраняются между перезапусками.'
    );
    text(
      help,
      'p',
      'Здесь нет IP, Account ID, room/match ID, User-Agent, токенов, request payload, raw текста исключений или stack trace. Одинаковые ошибки объединяются по необратимому fingerprint.'
    );
    panel.append(help);

    const controls = document.createElement('article');
    controls.className = 'card';
    const head = document.createElement('div');
    head.className = 'card-head';
    const copy = document.createElement('div');
    text(copy, 'p', 'SERVER RELIABILITY', 'eyebrow');
    text(copy, 'h2', 'Состояние production во времени');
    head.append(copy);
    const actions = document.createElement('div');
    actions.className = 'export-actions';
    const bundle = document.createElement('button');
    bundle.id = 'reliability-copy';
    bundle.type = 'button';
    bundle.className = 'ghost';
    bundle.textContent = 'Скопировать диагностику';
    actions.append(bundle);
    head.append(actions);
    controls.append(head);

    const filter = document.createElement('div');
    filter.className = 'filter-grid';
    const label = document.createElement('label');
    text(label, 'span', 'Период');
    const select = document.createElement('select');
    select.id = 'reliability-period';
    for (const [value, title] of [
      ['1h', 'Последний час'],
      ['6h', 'Последние 6 часов'],
      ['24h', 'Последние 24 часа'],
      ['7d', 'Последние 7 дней'],
      ['30d', 'Последние 30 дней']
    ]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = title;
      if (value === '24h') option.selected = true;
      select.append(option);
    }
    label.append(select);
    filter.append(label);
    controls.append(filter);
    const meta = document.createElement('p');
    meta.id = 'reliability-meta';
    meta.className = 'muted';
    controls.append(meta);
    const cards = document.createElement('div');
    cards.id = 'reliability-cards';
    cards.className = 'cards';
    controls.append(cards);
    panel.append(controls);

    const grid = document.createElement('div');
    grid.className = 'grid-two';
    const errors = document.createElement('article');
    errors.className = 'card';
    text(errors, 'h2', 'Группы ошибок');
    text(errors, 'p', 'Одинаковые события объединяются по типу, fingerprint и build.', 'section-help');
    const errorWrap = document.createElement('div');
    errorWrap.className = 'table-wrap';
    const errorTable = document.createElement('table');
    const errorHead = document.createElement('thead');
    errorHead.append(
      row(['Ошибка', 'Уровень', 'Сколько', 'Первое / последнее', 'Build', 'Fingerprint'], 'th')
    );
    errorTable.append(errorHead);
    const errorBody = document.createElement('tbody');
    errorBody.id = 'reliability-errors';
    errorTable.append(errorBody);
    errorWrap.append(errorTable);
    errors.append(errorWrap);
    grid.append(errors);

    const lifecycle = document.createElement('article');
    lifecycle.className = 'card';
    text(lifecycle, 'h2', 'Жизненный цикл сервера');
    text(
      lifecycle,
      'p',
      'Запуски, drain и штатные завершения помогают связать сбой с перезапуском.',
      'section-help'
    );
    const lifeWrap = document.createElement('div');
    lifeWrap.className = 'table-wrap';
    const lifeTable = document.createElement('table');
    const lifeHead = document.createElement('thead');
    lifeHead.append(row(['Время', 'Событие', 'Build'], 'th'));
    lifeTable.append(lifeHead);
    const lifeBody = document.createElement('tbody');
    lifeBody.id = 'reliability-lifecycle';
    lifeTable.append(lifeBody);
    lifeWrap.append(lifeTable);
    lifecycle.append(lifeWrap);
    grid.append(lifecycle);
    panel.append(grid);

    const timeline = document.createElement('article');
    timeline.className = 'card';
    text(timeline, 'h2', 'История нагрузки и сети');
    text(
      timeline,
      'p',
      'Показатели агрегируются в более крупные интервалы для длинных периодов, чтобы ответ API оставался небольшим.',
      'section-help'
    );
    const seriesWrap = document.createElement('div');
    seriesWrap.className = 'table-wrap';
    const seriesTable = document.createElement('table');
    const seriesHead = document.createElement('thead');
    seriesHead.append(
      row(
        ['Время', 'Event loop p95', 'RSS', 'Sockets', 'Матчи', 'Reconnect ok/fail', 'Ошибки', 'Capacity'],
        'th'
      )
    );
    seriesTable.append(seriesHead);
    const seriesBody = document.createElement('tbody');
    seriesBody.id = 'reliability-series';
    seriesTable.append(seriesBody);
    seriesWrap.append(seriesTable);
    timeline.append(seriesWrap);
    panel.append(timeline);

    $('#app-view')?.append(panel);

    tab.addEventListener('click', openPanel);
    select.addEventListener('change', loadReliability);
    bundle.addEventListener('click', copyBundle);

    $('#refresh')?.addEventListener(
      'click',
      event => {
        if (!panel.hidden && tab.classList.contains('active')) {
          event.preventDefault();
          event.stopImmediatePropagation();
          loadReliability();
        }
      },
      true
    );
  }

  async function syncAccess() {
    const tab = $('#tabs [data-panel="reliability"]');
    if (!tab) return;
    if (document.body.dataset.adminSession !== 'active') {
      tab.hidden = true;
      $('#panel-reliability').hidden = true;
      clearView();
      return;
    }
    try {
      const value = await sharedApi('/api/admin/session', {}, { csrf: false });
      tab.hidden = !(value.capabilities || []).includes(capability);
      if (tab.hidden) {
        $('#panel-reliability').hidden = true;
        clearView();
      }
    } catch (error) {
      tab.hidden = true;
      $('#panel-reliability').hidden = true;
      clearView();
      if (error.status === 401 && document.body.dataset.adminSession === 'active') {
        sharedShowLogin('Сессия администратора завершена. Войдите снова.');
      }
    }
  }

  async function reliabilityApi(period) {
    const payload = await sharedApi('/api/admin/reliability', { period });
    return payload.reliability;
  }

  function openPanel() {
    const tab = $('#tabs [data-panel="reliability"]');
    if (!tab || tab.hidden) return;
    // Use the existing panel router instead of toggling DOM manually. Besides keeping the shared
    // currentPanel state correct, switchPanel() invalidates outstanding views and clears any armed
    // privileged operation confirmation when leaving Operations.
    sharedSwitchPanel('reliability');
    loadReliability();
  }

  function render(data) {
    state.data = data;
    const summary = data.summary || {};
    const tone = toneForStatus(data.status);
    const attempts = Number(summary.reconnectSucceeded || 0) + Number(summary.reconnectFailed || 0);
    $('#reliability-meta').textContent =
      `Период: ${formatTime(data.from)} — ${formatTime(data.to)} · хранение ${formatNumber(data.retentionDays)} дней · build ${buildLabel(data.build)}.`;
    const reasonText = data.reasons?.length
      ? data.reasons.map(reasonLabel).join('; ')
      : 'за выбранный период явных сигналов проблемы не найдено';
    $('#reliability-cards').replaceChildren(
      statCard('Состояние', statusLabel(data.status), reasonText, tone),
      statCard(
        'Reconnect',
        attempts ? percent(summary.reconnectSuccessPercent) : 'НЕТ ПОПЫТОК',
        `${formatNumber(summary.reconnectSucceeded)} успешно · ${formatNumber(summary.reconnectFailed)} неудачно`,
        summary.reconnectFailed ? 'warn' : 'good'
      ),
      statCard(
        'Внутренние ошибки',
        formatNumber(summary.handlerErrors),
        `${formatNumber(data.errors?.length)} сгруппированных типов/build`,
        summary.handlerErrors ? 'bad' : 'good'
      ),
      statCard(
        'WebSocket send',
        formatNumber(summary.socketSendFailures),
        'ошибок отправки пакетов',
        summary.socketSendFailures ? 'warn' : 'good'
      ),
      statCard(
        'Event loop p95 max',
        `${Number(summary.eventLoopP95MsMax || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мс`,
        `среднее ${Number(summary.eventLoopP95MsAverage || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мс`,
        summary.eventLoopP95MsMax >= 250 ? 'bad' : summary.eventLoopP95MsMax >= 120 ? 'warn' : 'good'
      ),
      statCard(
        'Capacity rejects',
        formatNumber(summary.capacityRejected),
        `максимум sockets ${formatNumber(summary.socketsMax)} · матчей ${formatNumber(summary.activeMatchesMax)}`,
        summary.capacityRejected ? 'warn' : 'good'
      )
    );

    const errors = $('#reliability-errors');
    errors.replaceChildren();
    for (const item of data.errors || []) {
      errors.append(
        row([
          eventLabel(item.event),
          item.severity,
          formatNumber(item.occurrences),
          `${formatTime(item.firstOccurredAt)} / ${formatTime(item.lastOccurredAt)}`,
          buildLabel(item.build),
          item.fingerprint || '—'
        ])
      );
    }
    if (!data.errors?.length) {
      const empty = row(['За период сгруппированных ошибок нет.']);
      empty.firstElementChild.colSpan = 6;
      errors.append(empty);
    }

    const lifecycle = $('#reliability-lifecycle');
    lifecycle.replaceChildren();
    for (const item of data.lifecycle || []) {
      lifecycle.append(
        row([
          formatTime(item.lastOccurredAt),
          `${eventLabel(item.event)}${item.occurrences > 1 ? ` ×${formatNumber(item.occurrences)}` : ''}`,
          buildLabel(item.build)
        ])
      );
    }
    if (!data.lifecycle?.length) {
      const empty = row(['За период lifecycle-событий нет.']);
      empty.firstElementChild.colSpan = 3;
      lifecycle.append(empty);
    }

    const series = $('#reliability-series');
    series.replaceChildren();
    for (const item of data.series || []) {
      series.append(
        row([
          formatTime(item.at),
          `${Number(item.eventLoopP95Ms || 0).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} мс`,
          `${formatNumber(item.rssMb)} МБ`,
          formatNumber(item.sockets),
          formatNumber(item.activeMatches),
          `${formatNumber(item.reconnectSucceeded)} / ${formatNumber(item.reconnectFailed)}`,
          `${formatNumber(item.handlerErrors)} handler · ${formatNumber(item.socketSendFailures)} send`,
          formatNumber(item.capacityRejected)
        ])
      );
    }
    if (!data.series?.length) {
      const empty = row(['Исторические samples появятся после запуска обновлённого сервера.']);
      empty.firstElementChild.colSpan = 8;
      series.append(empty);
    }
    setStatus(
      data.status === 'critical'
        ? 'Reliability обнаружила серьёзные сигналы — проверьте группы ошибок и временную линию.'
        : data.status === 'warning'
          ? 'Reliability обнаружила предупреждения за выбранный период.'
          : 'Reliability не показывает явных проблем за выбранный период.',
      tone
    );
  }

  async function loadReliability() {
    const revision = ++state.revision;
    const select = $('#reliability-period');
    if (!select) return;
    setStatus('Загружаю историю надёжности…');
    try {
      const data = await reliabilityApi(select.value || '24h');
      if (revision !== state.revision || $('#panel-reliability')?.hidden) return;
      render(data);
    } catch (error) {
      if (revision !== state.revision) return;
      if (error.status === 401) {
        sharedShowLogin('Сессия администратора завершена. Войдите снова.');
        return;
      }
      setStatus(`Не удалось загрузить Reliability Center: ${error.message}`, 'bad');
    }
  }

  async function copyBundle() {
    const data = state.data;
    if (!data) return setStatus('Сначала загрузите Reliability Center.', 'warn');
    const bundle = {
      version: 1,
      generatedAt: data.generatedAt,
      period: data.period,
      from: data.from,
      to: data.to,
      build: data.build,
      status: data.status,
      reasons: data.reasons,
      summary: data.summary,
      errors: data.errors,
      lifecycle: data.lifecycle,
      series: data.series
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
      setStatus('Безопасный серверный диагностический пакет скопирован.', 'good');
    } catch {
      setStatus('Не удалось скопировать пакет автоматически.', 'warn');
    }
  }

  createUi();
  const observer = new MutationObserver(syncAccess);
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-admin-session'] });
  syncAccess();
})();
