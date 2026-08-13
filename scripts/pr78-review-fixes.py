from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:140]!r}")
    path.write_text(text.replace(old, new, 1))


# P1: during an existing production upgrade, bring Control Plane up and switch Nginx before
# restarting the old gameplay process. A truly fresh persistent DB has no old admin to preserve,
# so bootstrap gameplay once only to create/migrate the DB first.
install = Path("deploy/install.sh")
replace_once(
    install,
    '''else
  systemctl start wobble-backup.service
fi
systemctl restart wobble

say "Независимый Wobble Control"
''',
    '''else
  systemctl start wobble-backup.service
fi

fresh_database=0
if [ "$database_file" != ":memory:" ] && [ ! -f "$database_file" ]; then
  fresh_database=1
  say "Первичная инициализация persistent DB"
  # На совершенно новой установке старой админ-панели ещё нет. Коротко запускаем gameplay,
  # чтобы единственный migration owner создал схему, затем уже поднимаем независимый Control Plane.
  systemctl restart wobble
  bootstrap_ready=0
  for _ in $(seq 1 30); do
    if [ -f "$database_file" ] &&
      curl -fsS --max-time 2 http://127.0.0.1:3000/health/live >/dev/null 2>&1; then
      bootstrap_ready=1
      break
    fi
    sleep 1
  done
  [ "$bootstrap_ready" -eq 1 ] ||
    fail "Wobble не смог создать/migrate persistent DB на первой установке"
fi

say "Независимый Wobble Control"
''',
)
replace_once(
    install,
    '''if [ "$SHARED_HTTPS_443" = "1" ]; then
  ss -lntpH '( sport = :443 )' 2>/dev/null | grep -q nginx || fail "после reload Nginx не слушает внешний 443"
fi

if [ -n "$DOMAIN" ] && [ -d /etc/letsencrypt ]; then
''',
    '''if [ "$SHARED_HTTPS_443" = "1" ]; then
  ss -lntpH '( sport = :443 )' 2>/dev/null | grep -q nginx || fail "после reload Nginx не слушает внешний 443"
fi

# Для обычного upgrade это первый restart gameplay в deploy: к этому моменту /admin уже
# обслуживает независимый :3001. Поэтому даже плохой новый build не забирает у оператора панель.
# На fresh install gameplay уже был запущен выше только ради первичной migration; перезапускаем его
# ещё раз после cutover, чтобы порядок и итоговое состояние были одинаковыми во всех режимах.
say "Перезапуск gameplay после переключения Wobble Control"
systemctl restart wobble

if [ -n "$DOMAIN" ] && [ -d /etc/letsencrypt ]; then
''',
)

# P2: case variants must never fall through to the gameplay Express app.
nginx = Path("deploy/nginx-locations.conf")
replace_once(
    nginx,
    '''location ^~ /api/admin/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Некоторые allowlisted operations могут ждать systemd/helper дольше обычного HTTP-запроса.
    proxy_read_timeout 150s;
    proxy_send_timeout 150s;
    proxy_buffering off;
}

# Игра и публичные HTTP API остаются в gameplay process на :3000.
''',
    '''location ^~ /api/admin/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Некоторые allowlisted operations могут ждать systemd/helper дольше обычного HTTP-запроса.
    proxy_read_timeout 150s;
    proxy_send_timeout 150s;
    proxy_buffering off;
}

# Express route matching is case-insensitive by default. Lower-case ^~ locations above are the only
# public spellings we accept; case variants must not fall through to gameplay on :3000.
location ~* ^/api/admin(?:/|$) {
    return 404;
}
location ~* ^/admin(?:/|$) {
    return 404;
}

# Игра и публичные HTTP API остаются в gameplay process на :3000.
''',
)

verify = Path("deploy/verify-shared443-config.sh")
replace_once(
    verify,
    "grep -Fq 'location ~* ^/health/control$' \"$locations\"\n",
    "grep -Fq 'location ~* ^/health/control$' \"$locations\"\n"
    "grep -Fq 'location ~* ^/api/admin(?:/|$)' \"$locations\"\n"
    "grep -Fq 'location ~* ^/admin(?:/|$)' \"$locations\"\n",
)

# P1: distinguish process response from actual readiness.
game_client = Path("server/controlPlaneGameClient.js")
replace_once(
    game_client,
    '''  health() {
    return this.#request({
      path: '/health',
      method: 'GET',
      body: null,
      headers: { 'X-Wobble-Control-Request': crypto.randomUUID() },
      maxResponseBytes: 256 * 1024
    }).then(result => {
      if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.ok !== true) {
        return null;
      }
      return result.payload;
    });
  }
''',
    '''  health() {
    return this.#request({
      path: '/health',
      method: 'GET',
      body: null,
      headers: { 'X-Wobble-Control-Request': crypto.randomUUID() },
      maxResponseBytes: 256 * 1024
    }).then(result => {
      if (result.statusCode < 200 || result.statusCode >= 300 || result.payload?.ok !== true) {
        return null;
      }
      return result.payload;
    });
  }

  status() {
    return this.#request({
      path: '/health/ready',
      method: 'GET',
      body: null,
      headers: { 'X-Wobble-Control-Request': crypto.randomUUID() },
      maxResponseBytes: 256 * 1024
    }).then(result => {
      const payload = result.payload;
      if (
        !result.contactedUpstream ||
        !payload ||
        payload.service !== 'wobble-rush-3d' ||
        !Number.isFinite(Number(result.statusCode))
      ) {
        return null;
      }
      return {
        ...payload,
        reachable: true,
        ready: result.statusCode >= 200 && result.statusCode < 300 && payload.ok === true
      };
    });
  }
''',
)

routes = Path("server/controlPlaneRoutes.js")
replace_once(
    routes,
    "const game = await gameClient.health().catch(() => null);",
    "const game = await gameClient.status().catch(() => null);",
)
replace_once(
    routes,
    '''      game: game
        ? {
            reachable: true,
            ok: Boolean(game.ok),
            version: game.version || null,
            commit: game.commit || null,
            release: game.release || null,
            uptimeSeconds: Number(game.uptime || 0),
            draining: Boolean(game.draining)
          }
        : { reachable: false, ok: false },
''',
    '''      game: game
        ? {
            reachable: true,
            ok: Boolean(game.ready),
            ready: Boolean(game.ready),
            version: game.version || null,
            commit: game.commit || null,
            release: game.release || null,
            uptimeSeconds: Number(game.uptime || 0),
            load: game.load || null,
            capacity: game.capacity || null
          }
        : { reachable: false, ok: false, ready: false },
''',
)

infra = Path("server/controlPlaneInfrastructure.js")
replace_once(
    infra,
    "if (!gameClient || typeof gameClient.health !== 'function') {\n      throw new Error('ControlPlaneInfrastructure requires gameClient.health()');\n    }",
    "if (!gameClient || typeof gameClient.status !== 'function') {\n      throw new Error('ControlPlaneInfrastructure requires gameClient.status()');\n    }",
)
replace_once(
    infra,
    "this.gameClient.health().catch(() => null)",
    "this.gameClient.status().catch(() => null)",
)
replace_once(
    infra,
    '''      game: {
        reachable: Boolean(gameHealth?.ok),
        ok: Boolean(gameHealth?.ok),
''',
    '''      game: {
        reachable: Boolean(gameHealth?.reachable),
        ok: Boolean(gameHealth?.ready),
        ready: Boolean(gameHealth?.ready),
''',
)

# P2: reliability schema problems must degrade only the Reliability panel.
reader = Path("server/serviceReliabilityReader.js")
replace_once(
    reader,
    "module.exports = { ServiceReliabilityReader, PERIODS, periodSpec };\n",
    '''function createServiceReliabilityReader(options) {
  try {
    return new ServiceReliabilityReader(options);
  } catch {
    return null;
  }
}

module.exports = {
  ServiceReliabilityReader,
  createServiceReliabilityReader,
  PERIODS,
  periodSpec
};
''',
)

control = Path("server/controlPlane.js")
replace_once(
    control,
    "const { ServiceReliabilityReader } = require('./serviceReliabilityReader');",
    "const { createServiceReliabilityReader } = require('./serviceReliabilityReader');",
)
replace_once(
    control,
    "const reliability = new ServiceReliabilityReader({ db, liveHealth: () => gameClient.health() });",
    "const reliability = createServiceReliabilityReader({\n  db,\n  liveHealth: () => gameClient.status()\n});",
)

# P2: standard npm test/release gate must include the new boundary tests.
package = Path("package.json")
replace_once(
    package,
    "server/reliability.test.mjs server/adminOperations.test.mjs",
    "server/reliability.test.mjs server/controlPlaneGameClient.test.mjs server/controlPlaneRoutes.test.mjs server/serviceReliabilityReader.test.mjs server/controlPlaneDeploy.test.mjs server/adminOperations.test.mjs",
)
