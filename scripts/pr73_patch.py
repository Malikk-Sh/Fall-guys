from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:100]!r}')
    p.write_text(text.replace(old, new, 1))


def append_once(path, marker, addition):
    p = Path(path)
    text = p.read_text()
    if addition.strip() in text:
        return
    if marker not in text:
        raise SystemExit(f'missing append anchor in {path}')
    p.write_text(text.replace(marker, marker + addition, 1))


# Admin RBAC: moderators may issue bounded temporary sanctions; permanent sanctions remain owner-only.
replace_once(
    'server/adminAuth.js',
    "    'moderation.write',\n    'audit.read',\n    'admin.manage',",
    "    'moderation.write',\n    'sanctions.write',\n    'sanctions.permanent',\n    'audit.read',\n    'admin.manage',",
)
replace_once(
    'server/adminAuth.js',
    "  moderator: Object.freeze(['dashboard.read', 'moderation.read', 'moderation.write']),",
    "  moderator: Object.freeze([\n    'dashboard.read',\n    'moderation.read',\n    'moderation.write',\n    'sanctions.write'\n  ]),",
)

# Admin endpoints: server derives actor from the authenticated admin session and never accepts an actor id.
admin_routes_anchor = "  app.post('/api/admin/infrastructure', json, async (req, res) => {"
admin_routes_insert = r'''  app.post('/api/admin/sanctions/apply', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'sanctions.write');
    if (!resolved) return undefined;
    if (
      !keysOnly(
        req.body,
        new Set(['targetAccountId', 'kind', 'reason', 'note', 'durationMs', 'permanent'])
      ) ||
      !req.body?.targetAccountId
    ) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.sanctionApply !== 'function') {
      return res.status(503).json({ ok: false, error: 'sanctions-unavailable' });
    }
    const result = control.sanctionApply({
      targetAccountId: req.body.targetAccountId,
      kind: req.body.kind,
      reason: req.body.reason,
      note: req.body.note,
      durationMs: req.body.durationMs,
      permanent: req.body.permanent === true,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const forbidden = new Set([
        'sanctions-forbidden',
        'sanction-duration-forbidden',
        'permanent-sanction-owner-only'
      ]);
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'active-ban-exists'
            ? 409
            : result.reason === 'sanctions-unavailable'
              ? 503
              : forbidden.has(result.reason)
                ? 403
                : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxDurationMs ? { maxDurationMs: result.maxDurationMs } : {}),
        ...(result.allowedKinds ? { allowedKinds: result.allowedKinds } : {}),
        ...(result.allowedReasons ? { allowedReasons: result.allowedReasons } : {}),
        ...(result.active ? { active: result.active } : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/sanctions/revoke', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'sanctions.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['sanctionId', 'note'])) || !req.body?.sanctionId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.sanctionRevoke !== 'function') {
      return res.status(503).json({ ok: false, error: 'sanctions-unavailable' });
    }
    const result = control.sanctionRevoke({
      sanctionId: req.body.sanctionId,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-sanction'
          ? 404
          : result.reason === 'permanent-sanction-owner-only' || result.reason === 'sanctions-forbidden'
            ? 403
            : result.reason === 'sanctions-unavailable'
              ? 503
              : result.reason === 'sanction-not-active'
                ? 409
                : 400;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    return res.json(result);
  });

'''
replace_once('server/adminRoutes.js', admin_routes_anchor, admin_routes_insert + admin_routes_anchor)

# Test suite includes the new migration/service/auth/admin/network coverage.
replace_once(
    'package.json',
    'server/adminModeration.test.mjs server/adminAnalytics.test.mjs',
    'server/adminModeration.test.mjs server/playerSanctions.test.mjs server/adminSanctions.test.mjs server/authSanctions.test.mjs server/networkSanctions.test.mjs server/adminAnalytics.test.mjs',
)

# Player-side API keeps the public sanction payload instead of degrading a deliberate ban to "offline".
replace_once(
    'client/core/account.js',
    "async function post(path, body = {}, { fetchImpl = globalThis.fetch } = {}) {\n  const response = await fetchImpl(path, {\n    method: 'POST',\n    credentials: 'same-origin',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify(body)\n  });\n  const data = await response.json().catch(() => ({}));\n  return { ok: response.ok, status: response.status, data };\n}\n",
    "async function post(path, body = {}, { fetchImpl = globalThis.fetch } = {}) {\n  const response = await fetchImpl(path, {\n    method: 'POST',\n    credentials: 'same-origin',\n    headers: { 'content-type': 'application/json' },\n    body: JSON.stringify(body)\n  });\n  const data = await response.json().catch(() => ({}));\n  return { ok: response.ok, status: response.status, data };\n}\n\nfunction sanctionResult(status, data) {\n  return status === 403 && data?.error === 'account-sanctioned'\n    ? { sanctioned: true, sanction: data.sanction || null }\n    : null;\n}\n",
)
replace_once(
    'client/core/account.js',
    "export async function sessionAccount(options) {\n  const { ok, status, data } = await post('/api/auth/session', {}, options);\n  if (status === 401) return { missing: true };\n  return ok ? serverAccount(data) : null;\n}",
    "export async function sessionAccount(options) {\n  const { ok, status, data } = await post('/api/auth/session', {}, options);\n  if (status === 401) return { missing: true };\n  const blocked = sanctionResult(status, data);\n  if (blocked) return blocked;\n  return ok ? serverAccount(data) : null;\n}",
)
replace_once(
    'client/core/account.js',
    "export async function loginAccount(secret, options) {\n  const { ok, status, data } = await post('/api/auth/recovery', { secret }, options);\n  if (status === 404) return { unknown: true };\n  if (!ok) return null;\n  return serverAccount(data, secret);\n}",
    "export async function loginAccount(secret, options) {\n  const { ok, status, data } = await post('/api/auth/recovery', { secret }, options);\n  if (status === 404) return { unknown: true };\n  const blocked = sanctionResult(status, data);\n  if (blocked) return blocked;\n  if (!ok) return null;\n  return serverAccount(data, secret);\n}",
)
replace_once(
    'client/core/account.js',
    "export async function loginGoogle(credential, options) {\n  const { ok, status, data } = await post('/api/auth/google', { credential }, options);\n  if (status === 409) return { conflict: true };\n  if (!ok) return null;\n  return serverAccount(data);\n}",
    "export async function loginGoogle(credential, options) {\n  const { ok, status, data } = await post('/api/auth/google', { credential }, options);\n  if (status === 409) return { conflict: true };\n  const blocked = sanctionResult(status, data);\n  if (blocked) return blocked;\n  if (!ok) return null;\n  return serverAccount(data);\n}",
)
replace_once(
    'client/core/account.js',
    "  const session = await quiet(() => sessionAccount(options));\n  const sessionMatchesSelection =",
    "  const session = await quiet(() => sessionAccount(options));\n  if (session?.sanctioned) {\n    return { account: stored, records: [], progress: null, online: false, sanction: session.sanction };\n  }\n  const sessionMatchesSelection =",
)
replace_once(
    'client/core/account.js',
    "    const entered = await quiet(() => loginAccount(stagedSecret, options));\n    if (entered && !entered.unknown) {",
    "    const entered = await quiet(() => loginAccount(stagedSecret, options));\n    if (entered?.sanctioned) {\n      return { account: stored, records: [], progress: null, online: false, sanction: entered.sanction };\n    }\n    if (entered && !entered.unknown) {",
)
replace_once(
    'client/core/account.js',
    "    const entered = await quiet(() => loginAccount(stored.secret, options));\n    if (entered?.unknown) {",
    "    const entered = await quiet(() => loginAccount(stored.secret, options));\n    if (entered?.sanctioned) {\n      return { account: stored, records: [], progress: null, online: false, sanction: entered.sanction };\n    }\n    if (entered?.unknown) {",
)

# Player-facing explanation and network-ticket suppression while sanctioned.
replace_once(
    'client/core/AccountFlow.js',
    "  async signIn() {\n    const { account, records, progress, online } = await ensureAccount({});\n    this.apply(account, { online, records, progress });\n    if (!online)\n      this.game.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');\n    this.setupGoogle().catch(() => {});\n  }\n",
    "  sanctionMessage(sanction) {\n    const reasons = {\n      afk: 'бездействие (AFK)',\n      griefing: 'намеренное создание помех другим игрокам',\n      'offensive-name': 'недопустимое имя',\n      'exploit-cheat': 'использование читов или эксплуатация ошибки',\n      other: 'нарушение правил'\n    };\n    const reason = reasons[sanction?.reason] || reasons.other;\n    if (sanction?.permanent) return `Онлайн-доступ заблокирован без срока. Причина: ${reason}.`;\n    const expires = Number(sanction?.expiresAt);\n    const until = Number.isFinite(expires)\n      ? new Date(expires).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })\n      : 'указанного модерацией срока';\n    return `Онлайн-доступ временно ограничен до ${until}. Причина: ${reason}.`;\n  }\n\n  showSanction(sanction) {\n    this.game.accountSanction = sanction || null;\n    this.networkTicket = null;\n    const message = this.sanctionMessage(sanction);\n    this.game.ui.accountStatus(message);\n    this.game.ui.toast?.(message);\n    return message;\n  }\n\n  async signIn() {\n    const { account, records, progress, online, sanction = null } = await ensureAccount({});\n    this.apply(account, { online, records, progress });\n    if (sanction) this.showSanction(sanction);\n    else if (!online)\n      this.game.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');\n    this.setupGoogle().catch(() => {});\n  }\n",
)
replace_once(
    'client/core/AccountFlow.js',
    "    this.online = Boolean(online && account);\n",
    "    this.online = Boolean(online && account);\n    if (this.online) this.game.accountSanction = null;\n",
)
replace_once(
    'client/core/AccountFlow.js',
    "      const session = await sessionAccount();\n      if (!session || session.missing) return null;\n      return session.networkTicket || null;",
    "      const session = await sessionAccount();\n      if (!session || session.missing) return null;\n      if (session.sanctioned) {\n        this.showSanction(session.sanction);\n        return null;\n      }\n      return session.networkTicket || null;",
)
replace_once(
    'client/core/AccountFlow.js',
    "      const entered = await loginGoogle(credential);\n      if (!entered || entered.conflict)\n",
    "      const entered = await loginGoogle(credential);\n      if (entered?.sanctioned) return this.showSanction(entered.sanction);\n      if (!entered || entered.conflict)\n",
)
replace_once(
    'client/core/AccountFlow.js',
    "        const entered = await loginAccount(value);\n        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');",
    "        const entered = await loginAccount(value);\n        if (entered?.sanctioned) return this.showSanction(entered.sanction);\n        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');",
)

# Admin HTML: sanctions are visible in support cards and actionable from the moderation case.
replace_once(
    'client/admin/index.html',
    "              Панель принципиально не показывает recovery-коды, хеши кодов, session tokens, Google ID или\n              другие данные, с которыми можно войти в аккаунт. Здесь пока нет кнопок изменения аккаунта —\n              только чтение.",
    "              Панель принципиально не показывает recovery-коды, хеши кодов, session tokens, Google ID или\n              другие данные, с которыми можно войти в аккаунт. История санкций доступна здесь для поддержки,\n              а применять ограничения можно только ролям с отдельным правом модерации.",
)
replace_once(
    'client/admin/index.html',
    "            <div class=\"support-lists\">\n              <details class=\"support-details\" open>\n                <summary>Главы кампании</summary>",
    "            <div class=\"support-lists\">\n              <details class=\"support-details\" open>\n                <summary>Санкции и предупреждения</summary>\n                <div id=\"player-sanctions\" class=\"rank-list\"></div>\n              </details>\n              <details class=\"support-details\" open>\n                <summary>Главы кампании</summary>",
)
case_history_anchor = '''        <section class="case-section">
          <h3>История решений</h3>
          <p class="section-help">
            Здесь видно, кто и когда переводил дело между статусами и какую заметку оставил.
          </p>
          <div id="case-history" class="history-list"></div>
        </section>
'''
case_sanctions = '''
        <section class="case-section sanction-section">
          <h3>Санкции игрока</h3>
          <p class="section-help">
            Бан применяется сервером к аккаунту: активные входы завершаются, текущие WebSocket-соединения
            закрываются, а новый вход и RESUME блокируются до окончания срока или ручного снятия.
          </p>
          <div id="case-sanction-current" class="history-list"></div>
          <details class="support-details">
            <summary>История санкций</summary>
            <div id="case-sanction-history" class="history-list"></div>
          </details>
          <form id="sanction-action" class="case-action sanction-action" hidden>
            <div class="explain-box">
              <strong>Сначала проверьте материалы дела</strong>
              <span>Причина видна игроку. Внутренняя заметка остаётся только в админ-панели и журнале санкций.</span>
            </div>
            <div class="sanction-grid">
              <label>
                Действие
                <select id="sanction-kind">
                  <option value="warning">Предупреждение</option>
                  <option value="ban" selected>Временный бан</option>
                </select>
              </label>
              <label id="sanction-duration-label">
                Срок
                <select id="sanction-duration">
                  <option value="900000">15 минут</option>
                  <option value="3600000">1 час</option>
                  <option value="21600000">6 часов</option>
                  <option value="86400000" selected>24 часа</option>
                  <option value="259200000">3 дня</option>
                  <option value="604800000">7 дней</option>
                  <option value="2592000000" data-owner-only>30 дней</option>
                  <option value="custom">Другой срок</option>
                  <option value="permanent" data-permanent>Без срока</option>
                </select>
              </label>
              <label id="sanction-custom-label" hidden>
                Срок в часах
                <input id="sanction-custom-hours" type="number" min="1" step="1" value="24" />
              </label>
              <label>
                Причина для игрока
                <select id="sanction-reason">
                  <option value="griefing">Мешает другим игрокам</option>
                  <option value="exploit-cheat">Читы / эксплуатация ошибки</option>
                  <option value="offensive-name">Недопустимое имя</option>
                  <option value="afk">Бездействие (AFK)</option>
                  <option value="other">Другое нарушение правил</option>
                </select>
              </label>
              <label class="case-note-label sanction-note-label">
                Внутренняя заметка модератора
                <textarea id="sanction-note" maxlength="1000" rows="4" required placeholder="Что проверено и почему выбрана эта санкция. Игрок этот текст не увидит."></textarea>
              </label>
            </div>
            <p id="sanction-action-hint" class="muted">Первое нажатие только готовит действие; второе подтверждает его в течение 10 секунд.</p>
            <div class="sanction-buttons">
              <button id="sanction-apply" class="primary action-button" type="submit">Подготовить санкцию</button>
              <button id="sanction-revoke" class="ghost danger-action" type="button" hidden>Снять активный бан</button>
            </div>
          </form>
        </section>
'''
replace_once('client/admin/index.html', case_history_anchor, case_history_anchor + case_sanctions)

# Admin JS state, labels and player support rendering.
replace_once(
    'client/admin/admin.js',
    "  moderationConfirmation: null,\n  moderationLoadRevision: 0,",
    "  moderationConfirmation: null,\n  sanctionConfirmation: null,\n  moderationLoadRevision: 0,",
)
replace_once(
    'client/admin/admin.js',
    "  offensiveName: 'Оскорбительное имя'\n});",
    "  offensiveName: 'Оскорбительное имя',\n  other: 'Нарушение правил'\n});",
)
replace_once(
    'client/admin/admin.js',
    "  'moderation.case.transition': 'Изменён статус жалобы',\n  'player.support.view': 'Открыта карточка игрока',",
    "  'moderation.case.transition': 'Изменён статус жалобы',\n  'player.sanction.apply': 'Применена санкция к игроку',\n  'player.sanction.revoke': 'Снята санкция с игрока',\n  'player.support.view': 'Открыта карточка игрока',",
)
replace_once(
    'client/admin/admin.js',
    "    '#player-partners'\n  ]) {",
    "    '#player-partners',\n    '#player-sanctions'\n  ]) {",
)

sanction_helpers_anchor = "function deviceLabel(value) {"
sanction_helpers = r'''function sanctionStatusLabel(item) {
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

'''
replace_once('client/admin/admin.js', sanction_helpers_anchor, sanction_helpers + sanction_helpers_anchor)
replace_once(
    'client/admin/admin.js',
    "  const moderation = player.moderation;\n  const providers =",
    "  const moderation = player.moderation;\n  const sanctions = player.sanctions || { active: null, history: [] };\n  const providers =",
)
replace_once(
    'client/admin/admin.js',
    "    statCard(\n      'Модерация',\n      moderation ? statusLabel(moderation.status) : 'Нет дела',\n      moderation ? `${formatNumber(moderation.totalReports)} жалоб в деле` : 'активного moderation case нет'\n    )\n  );",
    "    statCard(\n      'Модерация',\n      moderation ? statusLabel(moderation.status) : 'Нет дела',\n      moderation ? `${formatNumber(moderation.totalReports)} жалоб в деле` : 'активного moderation case нет'\n    ),\n    statCard(\n      'Ограничение',\n      sanctions.active ? sanctionStatusLabel(sanctions.active) : 'НЕТ',\n      sanctions.active ? `${reasonLabel(sanctions.active.reason)} · ${sanctionTimeLabel(sanctions.active)}` : 'активного бана нет',\n      sanctions.active ? 'bad' : 'good'\n    )\n  );",
)
replace_once(
    'client/admin/admin.js',
    "  $('#player-detail').hidden = false;\n  $('#player-detail').scrollIntoView",
    "  renderPlayerSanctions(sanctions);\n  $('#player-detail').hidden = false;\n  $('#player-detail').scrollIntoView",
)

# Sanction form behavior in moderation dialog.
sanction_functions_anchor = "function renderModerationCase(item) {"
sanction_functions = r'''function resetSanctionConfirmation(message = '') {
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
        sanction.revokedAt ? `снял: ${sanction.revokedByName || sanction.revokedByAdminId || 'администратор'} · ${formatTime(sanction.revokedAt)}` : null
      ],
      [sanction.note, sanction.revokeNote ? `Снятие: ${sanction.revokeNote}` : ''].filter(Boolean).join('\n')
    );
  }
  if (!context.history?.length) appendText(historyRoot, 'p', 'История санкций пока пуста.', 'muted');

  const form = $('#sanction-action');
  form.hidden = !state.capabilities.has('sanctions.write');
  $('#sanction-revoke').hidden = !active || !state.capabilities.has('sanctions.write');
  if (active?.permanent && !state.capabilities.has('sanctions.permanent')) $('#sanction-revoke').hidden = true;
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
    $('#sanction-apply').textContent = request.kind === 'warning' ? 'Подтвердить предупреждение' : 'Подтвердить бан';
    $('#sanction-apply').classList.add('confirm');
    $('#sanction-action-hint').textContent = 'Действие ещё не применено. Нажмите подтверждение в течение 10 секунд.';
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

'''
replace_once('client/admin/admin.js', sanction_functions_anchor, sanction_functions + sanction_functions_anchor)
replace_once(
    'client/admin/admin.js',
    "  if (!item.history?.length) appendText(historyRoot, 'p', 'Решений по делу пока нет.', 'muted');\n\n  const action = $('#case-action');",
    "  if (!item.history?.length) appendText(historyRoot, 'p', 'Решений по делу пока нет.', 'muted');\n\n  renderCaseSanctions(item);\n  const action = $('#case-action');",
)
replace_once(
    'client/admin/admin.js',
    "  resetModerationConfirmation();\n  const dialog = $('#moderation-dialog');",
    "  resetModerationConfirmation();\n  resetSanctionConfirmation();\n  const dialog = $('#moderation-dialog');",
)
replace_once(
    'client/admin/admin.js',
    "$('#case-note').addEventListener('input', () => resetModerationConfirmation());\n$('#moderation-dialog').addEventListener('cancel', () => {",
    "$('#case-note').addEventListener('input', () => resetModerationConfirmation());\n$('#sanction-action').addEventListener('submit', submitSanction);\n$('#sanction-revoke').addEventListener('click', revokeCurrentSanction);\n$('#sanction-kind').addEventListener('change', updateSanctionFields);\n$('#sanction-duration').addEventListener('change', updateSanctionFields);\n$('#sanction-custom-hours').addEventListener('input', () => resetSanctionConfirmation());\n$('#sanction-reason').addEventListener('change', () => resetSanctionConfirmation());\n$('#sanction-note').addEventListener('input', () => resetSanctionConfirmation());\n$('#moderation-dialog').addEventListener('cancel', () => {",
)
replace_once(
    'client/admin/admin.js',
    "  resetModerationConfirmation();\n});\nfor (const button of $$('#tabs [data-panel]')) {",
    "  resetModerationConfirmation();\n  resetSanctionConfirmation();\n});\nfor (const button of $$('#tabs [data-panel]')) {",
)

# Small UI additions use existing visual language rather than a separate redesign.
css_addition = r'''

/* Player sanctions --------------------------------------------------------- */
.sanction-section {
  display: grid;
  gap: 12px;
}
.sanction-action {
  border-color: rgba(255, 135, 154, 0.24);
}
.sanction-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.sanction-note-label {
  grid-column: 1 / -1;
}
.sanction-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
}
.sanction-buttons button {
  flex: 1 1 210px;
}
.danger-action {
  border-color: rgba(255, 135, 154, 0.45);
  color: #ffb0bd;
}
@media (max-width: 700px) {
  .sanction-grid {
    grid-template-columns: 1fr;
  }
  .sanction-note-label {
    grid-column: auto;
  }
}
'''
Path('client/admin/admin.css').write_text(Path('client/admin/admin.css').read_text() + css_addition)

# Fix the auth-sanction test to send only the actual Cookie pair and use real wall-clock time.
replace_once(
    'server/authSanctions.test.mjs',
    "    now: 300\n  });",
    "    now: Date.now()\n  });",
)
replace_once(
    'server/authSanctions.test.mjs',
    "      Cookie: cookieForSession(session.token, { secure: false })",
    "      Cookie: cookieForSession(session.token, { secure: false }).split(';', 1)[0]",
)

print('PR73 patch applied')
