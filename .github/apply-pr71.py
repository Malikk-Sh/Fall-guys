from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path, old, new):
    file = ROOT / path
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old[:100]!r}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


# Role capability: host-level status is deliberately owner/operator only.
replace_once(
    'server/adminAuth.js',
    "    'dashboard.read',\n    'analytics.read',",
    "    'dashboard.read',\n    'infrastructure.read',\n    'analytics.read',"
)
# The same fragment occurs again in operator; replace second occurrence now.
replace_once(
    'server/adminAuth.js',
    "    'dashboard.read',\n    'analytics.read',",
    "    'dashboard.read',\n    'infrastructure.read',\n    'analytics.read',"
)

# Wire the read-only infrastructure model into production bootstrap.
replace_once(
    'server/bootstrap.js',
    "const { AdminControlService } = require('./adminControl');\nconst { AdminOperationsClient } = require('./adminOperationsClient');",
    "const { AdminControlService } = require('./adminControl');\nconst { AdminInfrastructure } = require('./adminInfrastructure');\nconst { AdminOperationsClient } = require('./adminOperationsClient');"
)
replace_once(
    'server/bootstrap.js',
    "const adminOperations = new AdminOperationsClient();\nconst recoveryLogin",
    "const adminInfrastructure = new AdminInfrastructure({ health: core.health });\nconst adminOperations = new AdminOperationsClient();\nconst recoveryLogin"
)
replace_once(
    'server/bootstrap.js',
    "  control: adminControl,\n  operations: adminOperations,",
    "  control: adminControl,\n  infrastructure: adminInfrastructure,\n  operations: adminOperations,"
)
replace_once(
    'server/bootstrap.js',
    "module.exports = { ...core, auth, google, inventory, rewards, adminAuth, adminControl, adminOperations };",
    "module.exports = {\n  ...core,\n  auth,\n  google,\n  inventory,\n  rewards,\n  adminAuth,\n  adminControl,\n  adminInfrastructure,\n  adminOperations\n};"
)

# API: empty-body read-only endpoint with capability check.
replace_once(
    'server/adminRoutes.js',
    "  control,\n  operations = null,",
    "  control,\n  infrastructure = null,\n  operations = null,"
)
infra_route = r'''
  app.post('/api/admin/infrastructure', json, async (req, res) => {
    const resolved = requireAdmin(req, res, 'infrastructure.read');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set())) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!infrastructure || typeof infrastructure.snapshot !== 'function') {
      return res.status(503).json({ ok: false, error: 'infrastructure-unavailable' });
    }
    try {
      return res.json({ ok: true, infrastructure: await infrastructure.snapshot() });
    } catch {
      return res.status(503).json({ ok: false, error: 'infrastructure-unavailable' });
    }
  });

'''
replace_once(
    'server/adminRoutes.js',
    "  app.post('/api/admin/operations/status', json, (req, res) => {",
    infra_route + "  app.post('/api/admin/operations/status', json, (req, res) => {"
)

# Normal regression suite.
replace_once(
    'package.json',
    'server/adminOperations.test.mjs server/googleIdentity.test.mjs',
    'server/adminOperations.test.mjs server/adminInfrastructure.test.mjs server/googleIdentity.test.mjs'
)

# Navigation + read-only infrastructure panel.
replace_once(
    'client/admin/index.html',
    '          <button data-panel="overview" data-capability="dashboard.read" class="active">Обзор</button>\n          <button data-panel="analytics" data-capability="analytics.read">Статистика</button>',
    '          <button data-panel="overview" data-capability="dashboard.read" class="active">Обзор</button>\n          <button data-panel="infrastructure" data-capability="infrastructure.read">Сервер</button>\n          <button data-panel="analytics" data-capability="analytics.read">Статистика</button>'
)
infra_panel = '''        <section id="panel-infrastructure" class="panel" hidden>
          <details class="help-card" open>
            <summary>Что показывает раздел «Сервер»?</summary>
            <p>
              Это только диагностика. Здесь видно, запущены ли Wobble и Nginx, хватает ли памяти и места на
              диске, работает ли HTTPS и свежая ли резервная копия. «Обновить данные» ничего не
              перезапускает и не меняет.
            </p>
            <p>
              Проверка не редактирует Nginx, firewall, shared 443 или VPN/Xray. Если что-то отмечено красным,
              сначала прочитайте пояснение рядом с показателем, а затем используйте runbook или вкладку
              «Операции» только для разрешённых действий Wobble.
            </p>
          </details>

          <div id="infrastructure-summary" class="cards"></div>

          <div class="grid-two">
            <article class="card">
              <h2>Системные службы</h2>
              <p class="section-help">
                Служба — это процесс или таймер, которым управляет systemd. «Работает» означает, что systemd
                считает её активной; это не изменяет её состояние.
              </p>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Что проверяется</th>
                      <th>Состояние</th>
                      <th>Автозапуск</th>
                    </tr>
                  </thead>
                  <tbody id="infrastructure-services-body"></tbody>
                </table>
              </div>
            </article>

            <article class="card">
              <h2>HTTPS-сертификат</h2>
              <p class="section-help">
                Проверка делает настоящий TLS-вход через локальный порт 443 с доменом Wobble. Так мы видим
                сертификат, который реально отдаёт Nginx через shared-443 маршрут.
              </p>
              <dl id="infrastructure-https-details" class="details"></dl>
            </article>
          </div>

          <div class="grid-two">
            <article class="card">
              <h2>Ресурсы VPS</h2>
              <p class="section-help">
                Показывает общую память и свободное место на файловой системе базы данных. Панель не читает
                содержимое файлов и не показывает список файлов.
              </p>
              <dl id="infrastructure-resource-details" class="details"></dl>
            </article>

            <article class="card">
              <h2>Локальные точки подключения</h2>
              <p class="section-help">
                «Доступен» означает, что на нужном локальном порту кто-то принимает соединение. HTTPS ниже
                дополнительно проверяется TLS-рукопожатием.
              </p>
              <dl id="infrastructure-network-details" class="details"></dl>
            </article>
          </div>

          <article class="card">
            <h2>Резервное копирование</h2>
            <p class="section-help">
              Здесь тот же безопасный статус backup, который использует health-check. Offsite — копия вне VPS;
              если она ещё не настроена, панель так и напишет, не выдавая это за ошибку локального backup.
            </p>
            <dl id="infrastructure-backup-details" class="details"></dl>
          </article>
        </section>

'''
replace_once(
    'client/admin/index.html',
    '        <section id="panel-analytics" class="panel" hidden>',
    infra_panel + '        <section id="panel-analytics" class="panel" hidden>'
)

# Client state cleanup.
replace_once(
    'client/admin/admin.js',
    "  currentPanel: 'overview',\n  analytics: null,",
    "  currentPanel: 'overview',\n  infrastructure: null,\n  analytics: null,"
)
replace_once(
    'client/admin/admin.js',
    "  state.capabilities = new Set();\n  state.analytics = null;",
    "  state.capabilities = new Set();\n  state.infrastructure = null;\n  state.analytics = null;"
)

# Formatting helpers for infrastructure values.
format_helpers = r'''
function formatBytes(value) {
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

'''
replace_once(
    'client/admin/admin.js',
    'function formatBoundedCount(value, truncated) {',
    format_helpers + 'function formatBoundedCount(value, truncated) {'
)

# Infrastructure renderer/loader before operations code.
infra_js = r'''
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
  const backupOk = Boolean(infra.backup && !infra.backup.stale && (!infra.backup.required || infra.backup.available));

  summary.append(
    statCard('Сервер игры', wobbleOk ? 'РАБОТАЕТ' : 'ТРЕБУЕТ ПРОВЕРКИ', 'wobble.service + локальный Node-порт', wobbleOk ? 'good' : 'bad'),
    statCard('Nginx / HTTPS', nginxOk ? 'РАБОТАЕТ' : 'ТРЕБУЕТ ПРОВЕРКИ', 'systemd + локальный порт 443', nginxOk ? 'good' : 'bad'),
    statCard(
      'Сертификат',
      certOk ? `${formatNumber(certDays)} дн.` : 'ТРЕБУЕТ ПРОВЕРКИ',
      certOk ? 'до окончания HTTPS-сертификата' : 'TLS недоступен, просрочен или не доверен',
      certOk && certDays >= 14 ? 'good' : certOk ? 'warn' : 'bad'
    ),
    statCard(
      'Диск',
      diskUsed == null ? 'НЕТ ДАННЫХ' : `${percent(diskUsed)} занято`,
      `свободно ${formatBytes(infra.resources?.disk?.availableBytes)}`,
      diskUsed == null ? 'warn' : diskUsed >= 95 ? 'bad' : diskUsed >= 85 ? 'warn' : 'good'
    ),
    statCard('Backup', backupOk ? 'СВЕЖИЙ' : 'ТРЕБУЕТ ПРОВЕРКИ', backupOk ? 'последняя копия в допустимом возрасте' : 'копия отсутствует или устарела', backupOk ? 'good' : 'bad')
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
    ['Память занята', `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)} (${percent(memory.usedPercent)})`],
    ['Память свободна', formatBytes(memory.freeBytes)],
    ['Диск занят', `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)} (${percent(disk.usedPercent)})`],
    ['Диск свободен', formatBytes(disk.availableBytes)],
    ['Средняя нагрузка 1 / 5 / 15 мин', (infra.resources?.loadAverage || []).join(' / ') || '—']
  ]);

  fillDetails('#infrastructure-network-details', [
    ['HTTP :80', availability(infra.network?.http80?.reachable)],
    ['Shared HTTPS :443', availability(infra.network?.https443?.reachable)],
    [`Node 127.0.0.1:${infra.network?.nodeLocal?.port || 3000}`, availability(infra.network?.nodeLocal?.reachable)],
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

  const tone = infrastructureTone(infra);
  if (tone === 'good') setStatus('Серверные проверки не показывают явных проблем.', 'good');
}

async function loadInfrastructure() {
  const payload = await api('/api/admin/infrastructure', {});
  renderInfrastructure(payload);
}

'''
replace_once(
    'client/admin/admin.js',
    'function clearOperationConfirmation() {',
    infra_js + 'function clearOperationConfirmation() {'
)
replace_once(
    'client/admin/admin.js',
    "    overview: loadOverview,\n    analytics: loadAnalytics,",
    "    overview: loadOverview,\n    infrastructure: loadInfrastructure,\n    analytics: loadAnalytics,"
)

# Documentation index links the two new operational sub-guides.
replace_once(
    'docs/README.md',
    '- [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md) — immutable tags, GitHub Release и exact-release deploy.\n',
    '- [`RELEASE-PROCESS.md`](RELEASE-PROCESS.md) — immutable tags, GitHub Release и exact-release deploy.\n- [`OPERATIONS-CONTROL.md`](OPERATIONS-CONTROL.md) — безопасная privileged-граница owner-only операций.\n- [`INFRASTRUCTURE-STATUS.md`](INFRASTRUCTURE-STATUS.md) — read-only диагностика VPS во вкладке «Сервер».\n'
)

# Short explanation in the main admin-panel guide.
replace_once(
    'docs/ADMIN-PANEL.md',
    '### Операции\n',
    '''### Сервер\n\nВкладка **Сервер** доступна `owner` и `operator` и только читает состояние production: фиксированные\nsystemd units, локальные порты 80/443/Node, TLS-сертификат через настоящий SNI handshake, память, диск и\nbackup/offsite. Она не меняет Nginx, firewall, shared 443 или VPN/Xray. Подробности: [INFRASTRUCTURE-STATUS.md](INFRASTRUCTURE-STATUS.md).\n\n### Операции\n'''
)

print('PR71 integration patch applied')
