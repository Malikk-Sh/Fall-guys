from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    file = ROOT / path
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:80]!r}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# Production bootstrap: the game process gets only an unprivileged Unix-socket client.
replace_once(
    'server/bootstrap.js',
    "const { AdminControlService } = require('./adminControl');\nconst { installAdminRoutes } = require('./adminRoutes');",
    "const { AdminControlService } = require('./adminControl');\nconst { AdminOperationsClient } = require('./adminOperationsClient');\nconst { installAdminRoutes } = require('./adminRoutes');"
)
replace_once(
    'server/bootstrap.js',
    "const adminControl = new AdminControlService({\n  db: core.accounts.db,\n  health: core.health,\n  gameplay: core.gameplay,\n  adminAuth\n});\nconst recoveryLogin",
    "const adminControl = new AdminControlService({\n  db: core.accounts.db,\n  health: core.health,\n  gameplay: core.gameplay,\n  adminAuth\n});\nconst adminOperations = new AdminOperationsClient();\nconst recoveryLogin"
)
replace_once(
    'server/bootstrap.js',
    "  control: adminControl,\n  enabled: adminPanelEnabled,",
    "  control: adminControl,\n  operations: adminOperations,\n  enabled: adminPanelEnabled,"
)
replace_once(
    'server/bootstrap.js',
    "module.exports = { ...core, auth, google, inventory, rewards, adminAuth, adminControl };",
    "module.exports = { ...core, auth, google, inventory, rewards, adminAuth, adminControl, adminOperations };"
)

# Admin routes: owner-only status/run endpoints, explicit confirmation and audit around external work.
replace_once(
    'server/adminRoutes.js',
    "  control,\n  enabled = false,",
    "  control,\n  operations = null,\n  enabled = false,"
)
operations_routes = r'''
  app.post('/api/admin/operations/status', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'ops.execute');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!operations || typeof operations.status !== 'function') {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
    try {
      const status = operations.status();
      return res.json({ ok: true, available: Boolean(status.available), operations: status.operations || [] });
    } catch {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
  });

  app.post('/api/admin/operations/run', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'ops.execute');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['operation', 'confirmation']))) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!operations || typeof operations.status !== 'function' || typeof operations.run !== 'function') {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }

    const operation = String(req.body?.operation || '').trim();
    let status;
    try {
      status = operations.status();
    } catch {
      return res.status(503).json({ ok: false, error: 'operations-unavailable' });
    }
    if (!status.operations?.some(item => item?.id === operation)) {
      return res.status(400).json({ ok: false, error: 'unknown-operation' });
    }
    if (req.body?.confirmation !== operation) {
      return res.status(400).json({ ok: false, error: 'operation-confirmation-required' });
    }

    const actor = resolved.session.user;
    adminAuth.audit({
      actor,
      action: 'ops.operation.requested',
      targetType: 'operation',
      targetId: operation
    });

    let result;
    try {
      result = await operations.run(operation);
    } catch {
      result = { ok: false, reason: 'helper-error' };
    }

    const safeReasons = new Set([
      'helper-unavailable',
      'helper-timeout',
      'helper-error',
      'helper-closed',
      'helper-invalid-response',
      'helper-response-too-large',
      'helper-response-mismatch',
      'operation-busy',
      'operation-timeout',
      'operation-failed',
      'restart-cooldown'
    ]);
    if (!result?.ok) {
      const reason = safeReasons.has(result?.reason) ? result.reason : 'helper-error';
      adminAuth.audit({
        actor,
        action: 'ops.operation.failed',
        targetType: 'operation',
        targetId: operation,
        detail: {
          reason,
          durationMs: Number.isFinite(Number(result?.durationMs)) ? Number(result.durationMs) : null
        }
      });
      const httpStatus = reason === 'operation-busy' || reason === 'restart-cooldown' ? 409 : 503;
      return res.status(httpStatus).json({
        ok: false,
        error: reason,
        ...(reason === 'restart-cooldown' && Number.isFinite(Number(result?.retryAfterMs))
          ? { retryAfterMs: Math.max(0, Number(result.retryAfterMs)) }
          : {})
      });
    }

    const accepted = Boolean(result.accepted);
    adminAuth.audit({
      actor,
      action: accepted ? 'ops.operation.accepted' : 'ops.operation.completed',
      targetType: 'operation',
      targetId: operation,
      detail: {
        durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
      }
    });
    return res.json({
      ok: true,
      operation,
      accepted,
      durationMs: Number.isFinite(Number(result.durationMs)) ? Number(result.durationMs) : null
    });
  });

'''
replace_once(
    'server/adminRoutes.js',
    "  app.post('/api/admin/audit', json, (req, res) => {",
    operations_routes + "  app.post('/api/admin/audit', json, (req, res) => {"
)

# Include operation tests in the normal regression suite.
replace_once(
    'package.json',
    'server/adminPlayerSupportRoutes.test.mjs server/googleIdentity.test.mjs',
    'server/adminPlayerSupportRoutes.test.mjs server/adminOperations.test.mjs server/googleIdentity.test.mjs'
)

# systemd: StartLimit* belongs to [Unit], not [Service].
replace_once(
    'deploy/wobble.service',
    "After=network-online.target\nWants=network-online.target\n\n[Service]",
    "After=network-online.target\nWants=network-online.target\n# Если падает чаще пяти раз за минуту — остановиться и дождаться диагностики.\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n[Service]"
)
replace_once(
    'deploy/wobble.service',
    "Restart=always\nRestartSec=3\n# Если падает чаще пяти раз за минуту — это не случайность, и бесконечный перезапуск только\n# мешает разбираться. Пусть остановится и ждёт.\nStartLimitIntervalSec=60\nStartLimitBurst=5\n",
    "Restart=always\nRestartSec=3\n"
)
replace_once(
    'deploy/wobble-backup.service',
    "ExecStart=/bin/bash /opt/wobble/deploy/backup.sh\nUMask=0077",
    "ExecStart=/bin/bash /opt/wobble/deploy/backup.sh\nTimeoutStartSec=120\nUMask=0077"
)

# Installer: root executes only a root-owned copied helper; application scripts remain User=wobble.
old_service_block = '''say "Служба и резервные копии"
cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service
cp "$APP_DIR/deploy/wobble-backup.service" /etc/systemd/system/wobble-backup.service
cp "$APP_DIR/deploy/wobble-backup.timer" /etc/systemd/system/wobble-backup.timer
cp "$APP_DIR/deploy/wobble-backup-watch.service" /etc/systemd/system/wobble-backup-watch.service
cp "$APP_DIR/deploy/wobble-backup-watch.timer" /etc/systemd/system/wobble-backup-watch.timer
systemctl daemon-reload
systemctl enable wobble >/dev/null
systemctl enable wobble-backup.timer wobble-backup-watch.timer >/dev/null
'''
new_service_block = '''say "Служба и резервные копии"
cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service
cp "$APP_DIR/deploy/wobble-backup.service" /etc/systemd/system/wobble-backup.service
cp "$APP_DIR/deploy/wobble-backup.timer" /etc/systemd/system/wobble-backup.timer
cp "$APP_DIR/deploy/wobble-backup-watch.service" /etc/systemd/system/wobble-backup-watch.service
cp "$APP_DIR/deploy/wobble-backup-watch.timer" /etc/systemd/system/wobble-backup-watch.timer
cp "$APP_DIR/deploy/wobble-backup-verify.service" /etc/systemd/system/wobble-backup-verify.service
cp "$APP_DIR/deploy/wobble-smoke.service" /etc/systemd/system/wobble-smoke.service
cp "$APP_DIR/deploy/wobble-ops.service" /etc/systemd/system/wobble-ops.service
cp "$APP_DIR/deploy/wobble-ops.socket" /etc/systemd/system/wobble-ops.socket
# Важно: privileged helper не запускается из /opt/wobble, которым владеет service-user.
# Иначе компрометация игрового процесса позволила бы заменить root-код перед запуском helper.
install -d -m 0755 -o root -g root /usr/local/lib/wobble-ops
install -m 0755 -o root -g root "$APP_DIR/deploy/wobble-ops-helper.mjs" /usr/local/lib/wobble-ops/helper.mjs
systemctl daemon-reload
systemctl stop wobble-ops.service >/dev/null 2>&1 || true
systemctl enable wobble >/dev/null
systemctl enable wobble-backup.timer wobble-backup-watch.timer wobble-ops.socket >/dev/null
systemctl restart wobble-ops.socket
'''
replace_once('deploy/install.sh', old_service_block, new_service_block)

# Admin UI: add the owner-only Operations tab with plain-language impact descriptions.
replace_once(
    'client/admin/index.html',
    '          <button data-panel="moderation" data-capability="moderation.read">Модерация</button>\n          <button data-panel="audit" data-capability="audit.read">Журнал действий</button>',
    '          <button data-panel="moderation" data-capability="moderation.read">Модерация</button>\n          <button data-panel="operations" data-capability="ops.execute">Операции</button>\n          <button data-panel="audit" data-capability="audit.read">Журнал действий</button>'
)
operations_panel = '''        <section id="panel-operations" class="panel" hidden>
          <details class="help-card" open>
            <summary>Что можно делать в разделе «Операции»?</summary>
            <p>
              Здесь собраны только заранее разрешённые действия для Wobble. Панель не умеет выполнять
              произвольные команды сервера. Перед каждой операцией показано, что именно она делает и повлияет
              ли она на игроков.
            </p>
            <p>
              Эти кнопки не меняют Nginx, shared 443, firewall или VPN/Xray. Для каждого запуска требуется
              повторное подтверждение, а результат записывается в «Журнал действий».
            </p>
          </details>
          <div id="operations-status" class="cards"></div>
          <div id="operations-list" class="grid-two"></div>
        </section>

'''
replace_once(
    'client/admin/index.html',
    '        <section id="panel-audit" class="panel" hidden>',
    operations_panel + '        <section id="panel-audit" class="panel" hidden>'
)

# Client state + labels.
replace_once(
    'client/admin/admin.js',
    "  moderationConfirmation: null,\n  moderationLoadRevision: 0\n};",
    "  moderationConfirmation: null,\n  moderationLoadRevision: 0,\n  operations: null,\n  operationConfirmation: null,\n  operationConfirmationTimer: null\n};"
)
replace_once(
    'client/admin/admin.js',
    "  'moderation.case.transition': 'Изменён статус жалобы',\n  'player.support.view': 'Открыта карточка игрока'",
    "  'moderation.case.transition': 'Изменён статус жалобы',\n  'player.support.view': 'Открыта карточка игрока',\n  'ops.operation.requested': 'Запрошена системная операция',\n  'ops.operation.completed': 'Системная операция завершена',\n  'ops.operation.accepted': 'Принят запрос на перезапуск Wobble',\n  'ops.operation.failed': 'Системная операция завершилась ошибкой'"
)
replace_once(
    'client/admin/admin.js',
    "  state.analytics = null;\n  $('#app-view').hidden = true;",
    "  state.analytics = null;\n  state.operations = null;\n  clearOperationConfirmation();\n  $('#app-view').hidden = true;"
)
replace_once(
    'client/admin/admin.js',
    "  if (name !== 'players') state.playerDetailRevision += 1;\n  state.currentPanel = name;",
    "  if (name !== 'players') state.playerDetailRevision += 1;\n  if (name !== 'operations') clearOperationConfirmation();\n  state.currentPanel = name;"
)

operations_js = r'''
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
    appendText(card, 'p', operation.tone === 'danger' ? 'ТРЕБУЕТ ОСТОРОЖНОСТИ' : 'БЕЗОПАСНАЯ ОПЕРАЦИЯ', 'eyebrow');
    appendText(card, 'h2', operation.title);
    appendText(card, 'p', operation.description, 'section-help');
    const impact = document.createElement('div');
    impact.className = 'explain-box';
    appendText(impact, 'strong', 'Что произойдёт');
    appendText(impact, 'span', operation.impact);
    card.append(impact);

    const confirming =
      state.operationConfirmation?.operation === operation.id && state.operationConfirmation.expiresAt > Date.now();
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

'''
replace_once(
    'client/admin/admin.js',
    'function auditActionLabel(action) {',
    operations_js + 'function auditActionLabel(action) {'
)
replace_once(
    'client/admin/admin.js',
    "    moderation: loadModeration,\n    audit: loadAudit",
    "    moderation: loadModeration,\n    operations: loadOperations,\n    audit: loadAudit"
)
replace_once(
    'client/admin/admin.js',
    "$('#refresh').addEventListener('click', refreshCurrent);",
    "$('#refresh').addEventListener('click', refreshCurrent);\n$('#operations-list').addEventListener('click', event => {\n  const button = event.target.closest('button[data-operation]');\n  if (button) runOperation(button.dataset.operation);\n});"
)

# Documentation: remove future-tense promise and describe the installed safety boundary.
replace_once(
    'docs/ADMIN-PANEL.md',
    'metrics, moderation workflow и admin audit history. Системные действия уровня backup/restart/deploy\nбудут подключаться отдельными PR поверх этой границы безопасности.',
    'metrics, moderation workflow и admin audit history. Для владельца также доступны четыре строго\nразрешённые operations: создать backup, перепроверить backup, запустить smoke и перезапустить только Wobble.'
)
replace_once(
    'docs/ADMIN-PANEL.md',
    'Не добавляйте shell execution в Node process. Системные операции должны идти через будущий узкий\nprivileged helper с allowlist команд, а не через произвольную строку shell из HTTP request.',
    'Node process не выполняет shell-команды. Системные операции идут через `/run/wobble-ops.sock` к\nroot-owned helper в `/usr/local/lib/wobble-ops/helper.mjs`. Helper принимает только четыре фиксированных\naction ID и запускает только заранее заданные systemd units; пользовательские строки никогда не становятся\nименем команды, unit или аргументом shell. Скрипты из `/opt/wobble` для backup/smoke выполняются самими\nsystemd units от `User=wobble`, а не от root.'
)
ops_docs = '''### Операции

Раздел **Операции** видит только `owner`. Каждая карточка заранее объясняет действие и влияние на игроков.
Первое нажатие только включает 10-секундное подтверждение; второе запускает действие. Все запросы и их
результат записываются в admin audit.

Доступны только:

- **Создать резервную копию** — запускает `wobble-backup.service`; игроков не отключает;
- **Проверить последнюю копию** — повторно делает SQLite `integrity_check` последнего tracked backup;
- **Проверить работу Wobble** — запускает существующий production smoke (health + страница + WebSocket + fresh backup);
- **Перезапустить сервер игры** — перезапускает только `wobble.service`; Nginx, shared 443, firewall и Xray не затрагиваются, но игровые соединения кратко оборвутся.

Архитектурная граница специально узкая:

```text
/admin -> Node (User=wobble)
       -> /run/wobble-ops.sock (root:wobble, 0660)
       -> root-owned allowlist helper
       -> только фиксированные systemd units
```

Helper не принимает command line, путь к файлу, unit name или shell fragment из HTTP. Даже при компрометации
игрового процесса эта граница не превращается в произвольное выполнение команд от root.

'''
replace_once(
    'docs/ADMIN-PANEL.md',
    '### Журнал действий\n',
    ops_docs + '### Журнал действий\n'
)

print('PR70 integration patch applied')
