from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:140]!r}")
    path.write_text(text.replace(old, new, 1))


# A separate process cannot share an in-memory SQLite database. Reject this configuration explicitly
# instead of crashing later while preparing admin statements on a different empty database.
control = Path('server/controlPlane.js')
replace_once(
    control,
    """if (databaseFile !== ':memory:' && !fs.existsSync(databaseFile)) {
  throw new Error(`Refusing to create the gameplay database from control plane: ${databaseFile}`);
}
""",
    """if (databaseFile === ':memory:') {
  throw new Error('Wobble Control requires a shared persistent LEADERBOARD_DB');
}
if (!fs.existsSync(databaseFile)) {
  throw new Error(`Refusing to create the gameplay database from control plane: ${databaseFile}`);
}
""",
)

install = Path('deploy/install.sh')
replace_once(
    install,
    """backup_root="$(
  # shellcheck source=/dev/null
  . /etc/wobble.env
  printf '%s' "${BACKUP_DIR:-/var/lib/wobble/backups}"
)"

if [ "$database_file" != ":memory:" ] && [ -f "$database_file" ] &&
""",
    """backup_root="$(
  # shellcheck source=/dev/null
  . /etc/wobble.env
  printf '%s' "${BACKUP_DIR:-/var/lib/wobble/backups}"
)"

[ "$database_file" != ":memory:" ] ||
  fail "Wobble Control требует общий persistent LEADERBOARD_DB; :memory: нельзя разделить между процессами"

if [ -f "$database_file" ] &&
""",
)
replace_once(
    install,
    "if [ \"$database_file\" != \":memory:\" ] && [ ! -f \"$database_file\" ]; then",
    "if [ ! -f \"$database_file\" ]; then",
)
replace_once(
    install,
    """# Control Plane должен подняться даже если новый gameplay process сломан. Его единственная
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
""",
    """# Control Plane должен подняться даже если новый gameplay process сломан. Его обязательная
# dependency — уже существующая shared persistent DB. Не ждём /health/live нового build: иначе
# неудачный deploy снова лишил бы оператора панели диагностики.
database_ready=0
for _ in $(seq 1 20); do
  if [ -f "$database_file" ]; then
    database_ready=1
    break
  fi
  sleep 1
done
[ "$database_ready" -eq 1 ] || fail "persistent DB не появилась перед стартом Wobble Control"
""",
)

# Add a fixed owner-only recovery operation. Unlike graceful restart, it also works when there is
# no MainPID and clears systemd's failed/start-limit state before attempting start.
client = Path('server/adminOperationsClient.js')
replace_once(
    client,
    """  'wobble.restart': Object.freeze({
    id: 'wobble.restart',
""",
    """  'wobble.start': Object.freeze({
    id: 'wobble.start',
    title: 'Запустить / восстановить сервер игры',
    description:
      'Сбрасывает failed/start-limit состояние systemd и запускает wobble.service, если игровой процесс полностью остановлен.',
    impact:
      'Не перезапускает Nginx, Control Plane или VPN/Xray. Если maintenance включён, новые подключения останутся закрыты до его отдельного отключения.',
    tone: 'safe'
  }),
  'wobble.restart': Object.freeze({
    id: 'wobble.restart',
""",
)

helper = Path('deploy/wobble-ops-helper.mjs')
replace_once(
    helper,
    """  'nginx.reload': Object.freeze({ kind: 'nginx-reload', timeoutMs: 20_000 }),
  'wobble.restart': Object.freeze({ kind: 'graceful-restart', deferred: true })
""",
    """  'nginx.reload': Object.freeze({ kind: 'nginx-reload', timeoutMs: 20_000 }),
  'wobble.start': Object.freeze({ kind: 'wobble-start' }),
  'wobble.restart': Object.freeze({ kind: 'graceful-restart', deferred: true })
""",
)
replace_once(
    helper,
    """async function startGracefulRestart(now) {
""",
    """async function startWobbleService() {
  if (restartInFlight) return { ok: false, reason: 'operation-busy' };
  const startedAt = Date.now();
  const reset = await runCommand(SYSTEMCTL, ['reset-failed', 'wobble.service'], { timeoutMs: 5000 });
  if (!reset.ok) {
    return {
      ok: false,
      reason: reset.reason || 'operation-failed',
      durationMs: Date.now() - startedAt
    };
  }
  const start = await runCommand(SYSTEMCTL, ['start', 'wobble.service'], { timeoutMs: 20_000 });
  return {
    ok: start.ok,
    reason: start.ok ? null : start.reason || 'operation-failed',
    durationMs: Date.now() - startedAt
  };
}

async function startGracefulRestart(now) {
""",
)
replace_once(
    helper,
    """  if (spec.kind === 'graceful-restart') return startGracefulRestart(now);
  if (spec.kind === 'maintenance') {
""",
    """  if (spec.kind === 'graceful-restart') return startGracefulRestart(now);
  if (spec.kind === 'wobble-start') {
    busy = true;
    try {
      return await startWobbleService();
    } finally {
      busy = false;
    }
  }
  if (spec.kind === 'maintenance') {
""",
)

# The helper owns a 210 second restart monitor; UI must wait beyond that authoritative window.
admin = Path('client/admin/admin.js')
replace_once(admin, 'const deadline = Date.now() + 195_000;', 'const deadline = Date.now() + 225_000;')

# Extend regressions for the new fixed recovery action and persistent DB contract.
ops_test = Path('server/adminOperations.test.mjs')
replace_once(
    ops_test,
    """  assert.equal(ACTIONS['nginx.reload'].kind, 'nginx-reload');
  assert.equal(ACTIONS['wobble.restart'].kind, 'graceful-restart');
""",
    """  assert.equal(ACTIONS['nginx.reload'].kind, 'nginx-reload');
  assert.equal(ACTIONS['wobble.start'].kind, 'wobble-start');
  assert.equal(ACTIONS['wobble.restart'].kind, 'graceful-restart');
""",
)
replace_once(
    ops_test,
    """  assert.equal(validOperation('nginx.reload'), 'nginx.reload');
  assert.equal(validOperation('unknown.operation'), null);
""",
    """  assert.equal(validOperation('nginx.reload'), 'nginx.reload');
  assert.equal(validOperation('wobble.start'), 'wobble.start');
  assert.equal(validOperation('unknown.operation'), null);
""",
)

deploy_test = Path('server/controlPlaneDeploy.test.mjs')
replace_once(
    deploy_test,
    """test('Control Plane systemd unit stays independent from gameplay lifecycle', () => {
""",
    """test('Control Plane requires the shared persistent production database', () => {
  const control = fs.readFileSync(new URL('./controlPlane.js', import.meta.url), 'utf8');
  assert.match(control, /databaseFile === ':memory:'[\\s\\S]*requires a shared persistent LEADERBOARD_DB/);
  assert.match(install, /Wobble Control требует общий persistent LEADERBOARD_DB/);
});

test('Control Plane systemd unit stays independent from gameplay lifecycle', () => {
""",
)
