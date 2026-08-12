from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:100]!r}")
    path.write_text(text.replace(old, new, 1))


install = Path("deploy/install.sh")
replace_once(
    install,
    'cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service\n',
    'cp "$APP_DIR/deploy/wobble.service" /etc/systemd/system/wobble.service\n'
    'cp "$APP_DIR/deploy/wobble-control.service" /etc/systemd/system/wobble-control.service\n',
)
replace_once(
    install,
    "systemctl enable wobble >/dev/null\n",
    "systemctl enable wobble >/dev/null\n"
    "systemctl enable wobble-control >/dev/null\n",
)
replace_once(
    install,
    "systemctl restart wobble\n\nremove_shared_stream_include() {",
    """systemctl restart wobble

say "Независимый Wobble Control"
# Control Plane должен подняться даже если новый gameplay process сломан. Его единственная
# обязательная dependency здесь — существующая persistent DB (или намеренно :memory: в dev).
# Не ждём /health/live: иначе неудачный deploy снова лишил бы оператора панели диагностики.
if [ "$database_file" != ":memory:" ]; then
  database_ready=0
  for _ in $(seq 1 20); do
    if [ -f "$database_file" ]; then
      database_ready=1
      break
    fi
    sleep 1
  done
  [ "$database_ready" -eq 1 ] || fail "persistent DB не появилась перед стартом Wobble Control"
fi

systemctl restart wobble-control
control_ready=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:3001/health/control >/dev/null 2>&1; then
    control_ready=1
    break
  fi
  sleep 1
done
[ "$control_ready" -eq 1 ] ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"

remove_shared_stream_include() {""",
)
replace_once(
    install,
    "ufw delete allow 3000/tcp >/dev/null 2>&1 || true\n",
    "ufw delete allow 3000/tcp >/dev/null 2>&1 || true\n"
    "ufw delete allow 3001/tcp >/dev/null 2>&1 || true\n",
)
replace_once(
    install,
    """curl -fsS --max-time 5 http://127.0.0.1:3000/health/live >/dev/null ||
  fail "сервер не отвечает — смотрите journalctl -u wobble -n 50 --no-pager"
""",
    """curl -fsS --max-time 5 http://127.0.0.1:3000/health/live >/dev/null ||
  fail "сервер не отвечает — смотрите journalctl -u wobble -n 50 --no-pager"
curl -fsS --max-time 5 http://127.0.0.1:3001/health/control >/dev/null ||
  fail "Wobble Control не отвечает — смотрите journalctl -u wobble-control -n 50 --no-pager"
""",
)

admin = Path("client/admin/admin.js")
replace_once(
    admin,
    """async function loadOverview() {
  const payload = await api('/api/admin/dashboard');
""",
    """async function renderUnavailableOverview() {
  const status = await api('/api/admin/control/status', {});
  const control = status.control || {};
  const game = status.game || {};
  $('#overview-cards').replaceChildren(
    statCard(
      'Wobble Control',
      control.ok ? 'РАБОТАЕТ' : 'НЕДОСТУПЕН',
      control.build
        ? `${control.build.version || 'unknown'} · ${control.build.commit || 'unknown'}`
        : 'независимый control plane',
      control.ok ? 'good' : 'bad'
    ),
    statCard(
      'Сервер игры',
      game.reachable ? 'ВОССТАНАВЛИВАЕТСЯ' : 'НЕДОСТУПЕН',
      'Админ-панель продолжает работать независимо от gameplay process.',
      'bad'
    ),
    statCard(
      'Maintenance',
      status.maintenance ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН',
      status.maintenance
        ? 'новые WebSocket временно закрыты'
        : 'Nginx не блокирует новые WebSocket',
      status.maintenance ? 'warn' : 'good'
    ),
    statCard(
      'Безопасные операции',
      status.operationsAvailable ? 'ДОСТУПНЫ' : 'НЕДОСТУПНЫ',
      'root-helper живёт отдельно от игрового процесса',
      status.operationsAvailable ? 'good' : 'bad'
    )
  );
  fillDetails('#production-details', [
    ['Control Plane', control.ok ? 'работает' : 'недоступен'],
    ['Версия Control Plane', control.build?.version || '—'],
    ['Сборка Control Plane', control.build?.commit || '—'],
    [
      'Сервер игры',
      game.reachable ? 'процесс доступен, но dashboard ещё не готов' : 'процесс недоступен'
    ],
    ['Игровой commit', game.commit || '—'],
    ['Игровой uptime', game.reachable ? formatDuration(game.uptimeSeconds) : '—']
  ]);
  fillDetails('#load-details', [
    ['Игровые live-метрики', 'временно недоступны'],
    ['Что делать', 'откройте «Сервер», «Надёжность» или «Операции» для диагностики']
  ]);
  return {
    statusText: 'Игровой процесс сейчас недоступен, но Wobble Control продолжает работать.',
    tone: 'bad'
  };
}

async function loadOverview() {
  let payload;
  try {
    payload = await api('/api/admin/dashboard');
  } catch (error) {
    if (error.payload?.error === 'game-control-unavailable') return renderUnavailableOverview();
    throw error;
  }
""",
)
replace_once(
    admin,
    """    !infra.services?.wobble?.active ||
    !infra.services?.nginx?.active ||
""",
    """    !infra.services?.wobble?.active ||
    !infra.services?.control?.active ||
    !infra.network?.controlLocal?.reachable ||
    !infra.services?.nginx?.active ||
""",
)
replace_once(
    admin,
    """  const wobbleOk = Boolean(infra.services?.wobble?.active && infra.network?.nodeLocal?.reachable);
  const nginxOk = Boolean(infra.services?.nginx?.active && infra.network?.https443?.reachable);
""",
    """  const wobbleOk = Boolean(infra.services?.wobble?.active && infra.network?.nodeLocal?.reachable);
  const controlOk = Boolean(
    infra.services?.control?.active && infra.network?.controlLocal?.reachable
  );
  const nginxOk = Boolean(infra.services?.nginx?.active && infra.network?.https443?.reachable);
""",
)
replace_once(
    admin,
    """    statCard(
      'Nginx / HTTPS',
""",
    """    statCard(
      'Control Plane',
      controlOk ? 'РАБОТАЕТ' : 'ТРЕБУЕТ ПРОВЕРКИ',
      'wobble-control.service + локальный порт',
      controlOk ? 'good' : 'bad'
    ),
    statCard(
      'Nginx / HTTPS',
""",
)
replace_once(
    admin,
    """    [
      `Node 127.0.0.1:${infra.network?.nodeLocal?.port || 3000}`,
      availability(infra.network?.nodeLocal?.reachable)
    ],
    ['TLS через SNI Wobble', availability(infra.https?.reachable)]
""",
    """    [
      `Game Node 127.0.0.1:${infra.network?.nodeLocal?.port || 3000}`,
      availability(infra.network?.nodeLocal?.reachable)
    ],
    [
      `Control 127.0.0.1:${infra.network?.controlLocal?.port || 3001}`,
      availability(infra.network?.controlLocal?.reachable)
    ],
    ['TLS через SNI Wobble', availability(infra.https?.reachable)]
""",
)
replace_once(
    admin,
    "async function runOperation(operation) {\n",
    """async function monitorAcceptedRestart() {
  const deadline = Date.now() + 195_000;
  let sawTransition = false;
  while (Date.now() < deadline) {
    let status;
    try {
      status = await api('/api/admin/control/status', {});
    } catch (error) {
      if (error.status === 401)
        return showLogin('Сессия администратора завершена. Войдите снова.');
      if (state.currentPanel === 'operations') {
        setStatus(
          'Control Plane временно не смог обновить статус restart. Повторяю проверку…',
          'warn'
        );
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      continue;
    }
    const game = status.game || {};
    if (status.maintenance || !game.reachable) sawTransition = true;
    if (state.currentPanel === 'operations') {
      if (!game.reachable)
        setStatus('Старый игровой процесс остановлен; жду новый Wobble…', 'warn');
      else if (status.maintenance)
        setStatus(
          'Wobble перезапускается; новые подключения пока закрыты maintenance…',
          'warn'
        );
      else setStatus('Проверяю готовность нового игрового процесса…', 'warn');
    }
    if (
      game.reachable &&
      game.ok &&
      !status.maintenance &&
      (sawTransition || Number(game.uptimeSeconds || 0) <= 30)
    ) {
      await loadOperations();
      setStatus(
        'Новый Wobble запущен и принимает подключения. Control Plane не прерывался.',
        'good'
      );
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (state.operations) renderOperations(state.operations);
  setStatus(
    'Control Plane работает, но restart не подтвердил готовность нового Wobble вовремя. Проверьте «Сервер» и «Надёжность».',
    'warn'
  );
  return false;
}

async function runOperation(operation) {
""",
)
replace_once(
    admin,
    """    if (operation === 'wobble.restart' && result.accepted) {
      setStatus('Перезапуск Wobble принят. Страница обновится после запуска сервера…', 'warn');
      setTimeout(() => window.location.reload(), 4500);
      return;
    }
""",
    """    if (operation === 'wobble.restart' && result.accepted) {
      setStatus(
        'Перезапуск Wobble принят. Панель останется открытой и проследит за запуском.',
        'warn'
      );
      await monitorAcceptedRestart();
      return;
    }
""",
)
replace_once(
    admin,
    """    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    setStatus(`Ошибка: ${error.message}`, 'bad');
""",
    """    if (revision !== state.refreshRevision || panel !== state.currentPanel) return;
    if (error.payload?.error === 'game-control-unavailable') {
      setStatus(
        'Игровой процесс сейчас недоступен. Wobble Control остаётся онлайн; используйте «Сервер», «Надёжность» или «Операции».',
        'bad'
      );
      return;
    }
    setStatus(`Ошибка: ${error.message}`, 'bad');
""",
)
