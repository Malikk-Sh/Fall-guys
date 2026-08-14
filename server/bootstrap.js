// Production entrypoint for account sessions, external identities, inventory and rewards.
//
// `index.js` remains directly importable by the existing unit/integration tests. This thin layer
// extends CSP for Google Identity Services, installs Auth V2 + inventory + rewards on the exported
// Express app, then starts the same HTTP/WebSocket server.

const http = require('http');
const { installReliabilityCapture } = require('./reliabilityCapture');

// Capture only a closed allowlist of already-structured operational log events. The capture is
// installed before index.js is loaded so an early startup error can still be grouped. Until the DB
// backed reliability service is ready, at most a small bounded queue is kept in memory.
const reliabilityCapture = installReliabilityCapture();

// Security headers are created inside index.js. Patch the response setter BEFORE loading it so the
// existing strict CSP remains the source of truth and Auth V2 adds only the two Google origins it
// actually needs. No `unsafe-inline`/`unsafe-eval` is introduced.
const setHeader = http.ServerResponse.prototype.setHeader;
http.ServerResponse.prototype.setHeader = function authV2SetHeader(name, value) {
  if (String(name).toLowerCase() === 'content-security-policy' && typeof value === 'string') {
    let policy = value
      .replace("script-src 'self'", "script-src 'self' https://accounts.google.com")
      .replace("connect-src 'self' ws: wss:", "connect-src 'self' ws: wss: https://accounts.google.com");
    if (!policy.includes('frame-src ')) policy += '; frame-src https://accounts.google.com';
    return setHeader.call(this, name, policy);
  }
  return setHeader.call(this, name, value);
};

const core = require('./index');
const { preloadBots } = require('./roomBots');

// Модель бота тянет клиентские модули, а те импортируют зависимости по браузерным путям — их
// разрешает client-loader, который до этого момента не зарегистрирован. Загружаем заранее и один
// раз: если не выйдет, сервер работает как прежде, просто без ботов.
preloadBots().catch(error => {
  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'server_started',
      ts: new Date().toISOString(),
      message: `боты недоступны: ${String(error?.message || error).slice(0, 200)}`
    })
  );
});
const { AuthService } = require('./auth');
const { GoogleIdentityVerifier } = require('./googleIdentity');
const { installAuthRoutes } = require('./authRoutes');
const { InventoryService } = require('./inventory');
const { RewardService } = require('./rewards');
const { installRewardRoutes } = require('./rewardRoutes');
const { installSocialRoutes } = require('./socialRoutes');
const { AdminAuthService } = require('./adminAuth');
const { AdminControlService } = require('./adminControl');
const { AdminInfrastructure } = require('./adminInfrastructure');
const { AdminOperationsClient } = require('./adminOperationsClient');
const { installAdminRoutes } = require('./adminRoutes');
const { installAdminReliabilityRoutes } = require('./adminReliabilityRoutes');
const { ServiceReliability } = require('./serviceReliability');
const { PlayerSanctions } = require('./playerSanctions');
const { accountAccessPolicy } = require('./accountAccessPolicy');
const { networkIdentity } = require('./networkIdentity');
const { socialCosmetics } = require('./socialCosmetics');

const auth = new AuthService({ db: core.accounts.db });
const google = new GoogleIdentityVerifier({ clientId: process.env.GOOGLE_CLIENT_ID });
const inventory = new InventoryService({ db: core.accounts.db, accounts: core.accounts });
const rewards = new RewardService({ db: core.accounts.db, inventory });
const adminAuth = new AdminAuthService({ db: core.accounts.db });
const sanctions = new PlayerSanctions({ db: core.accounts.db });
const adminControl = new AdminControlService({
  db: core.accounts.db,
  health: core.health,
  gameplay: core.gameplay,
  incidents: core.incidentDiagnostics,
  adminAuth,
  sanctions,
  auth,
  accounts: core.accounts,
  disconnectAccount: (accountId, options) => networkIdentity.disconnectAccount(accountId, options),
  connectionCount: accountId => networkIdentity.connectionCount(accountId),
  revokeReconnectSessions: accountId => core.revokeAccountReconnectSessions(accountId)
});
const adminInfrastructure = new AdminInfrastructure({ health: core.health });
const adminOperations = new AdminOperationsClient();
const reliability = new ServiceReliability({ db: core.accounts.db, health: core.health });
// Establish a counter baseline immediately. Later samples store only deltas, so process lifetime
// counters do not get counted again after every minute.
try {
  reliability.sample();
} catch {
  // Observability must never block game startup.
}
reliabilityCapture.setSink(event => reliability.recordEvent(event));
const reliabilityTimer = setInterval(() => {
  try {
    reliability.sample();
  } catch {
    // A telemetry write failure must not change gameplay availability.
  }
}, 60_000);
reliabilityTimer.unref?.();

const recoveryLogin = core.accounts.login.bind(core.accounts);
const adminPanelEnabled = process.env.ADMIN_PANEL_ENABLED === '1';

// WST принадлежит только рукопожатию WebSocket. NetworkIdentity поглощает его один раз и дальше
// игровой протокол использует уже ws.accountId; CREATE/JOIN/FIND не видят credential вообще.
// Второй callback — server-side access policy. Он проверяется и для свежего WST, и для RESUME,
// поэтому старый reconnect token не позволяет обойти выданный после отключения бан.
accountAccessPolicy.configure(accountId => {
  const active = sanctions.active(accountId);
  return active ? sanctions.publicView(active) : null;
});
networkIdentity.configure(
  ticket => auth.consumeSocketTicket(ticket),
  accountId => !sanctions.active(accountId)
);
// В публичный профиль комнаты loadout попадает только из server inventory. index.js знает лишь
// этот узкий resolver и не получает доступ ни к HttpOnly session, ни к ownership-операциям.
socialCosmetics.configure(accountId => inventory.publicLoadout(accountId));

const accountPayload = account => ({
  ok: true,
  account: { id: account.id, name: account.name },
  records: core.accounts.records(account.id),
  progress: core.accounts.progress(account.id),
  profile: core.accounts.profile(account.id),
  inventory: inventory.syncEntitlements(account.id)
});

const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const clientIp = req => {
  if (TRUST_PROXY) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
};

const authRoutes = installAuthRoutes({
  app: core.app,
  accounts: core.accounts,
  recoveryLogin,
  auth,
  google,
  inventory,
  sanctions,
  clientIp,
  accountPayload,
  secureCookies: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE !== '0'
    : process.env.NODE_ENV === 'production'
});

installSocialRoutes({
  app: core.app,
  socialSafety: core.socialSafety,
  requireSession: authRoutes.requireSession
});
installRewardRoutes({ app: core.app, auth, rewards });
const adminRoutes = installAdminRoutes({
  app: core.app,
  adminAuth,
  control: adminControl,
  infrastructure: adminInfrastructure,
  operations: adminOperations,
  enabled: adminPanelEnabled,
  // The shared-443 stream topology does not preserve the public client address to the HTTP
  // backend. Admin login throttling therefore uses the trusted TCP peer and never X-Forwarded-For,
  // which a public caller could forge before Nginx appends its own hop.
  secureCookies: process.env.ADMIN_COOKIE_SECURE
    ? process.env.ADMIN_COOKIE_SECURE !== '0'
    : process.env.NODE_ENV === 'production'
});
installAdminReliabilityRoutes({
  app: core.app,
  requireAdmin: adminRoutes.requireAdmin,
  reliability
});

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

// Operational restart uses SIGUSR2 instead of `systemctl restart`. The privileged helper first
// enables the Nginx maintenance gate, so no new WebSocket clients enter while we drain. Existing
// matches continue; as soon as no COUNTDOWN/PLAYING room remains, the normal core.shutdown path
// sends SERVER_SHUTDOWN to the remaining sockets, flushes metrics/SQLite and exits. Restart=always
// in wobble.service then starts the fresh process. A bounded timeout prevents a stuck match from
// blocking an urgent restart forever.
const ACTIVE_MATCH_STATES = new Set(['COUNTDOWN', 'PLAYING']);
const DRAIN_POLL_MS = 1000;
const DRAIN_TIMEOUT_MS = 180_000;
let drainInterval = null;
let drainTimeout = null;
let shutdownCompletionArmed = false;

function activeMatchesForDrain() {
  return [...core.rooms.values()].filter(room => ACTIVE_MATCH_STATES.has(room?.state)).length;
}

function clearDrainTimers() {
  if (drainInterval) clearInterval(drainInterval);
  if (drainTimeout) clearTimeout(drainTimeout);
  drainInterval = null;
  drainTimeout = null;
}

function finalReliabilitySample() {
  clearInterval(reliabilityTimer);
  try {
    reliability.sample();
  } catch {
    // Shutdown must continue even when observability storage is unavailable.
  }
}

function armReliabilityShutdownCompletion() {
  if (shutdownCompletionArmed) return false;
  shutdownCompletionArmed = true;
  // core.shutdown() closes WebSocket/HTTP first and closes SQLite inside server.close()'s callback.
  // Registering this listener before core.shutdown() means the actual HTTP server close event is
  // persisted while the shared DB is still open. The later structured shutdown_complete log is
  // still written to journald; its duplicate telemetry write happens after DB close and is ignored.
  core.server.once('close', () => {
    try {
      reliability.recordEvent({ event: 'shutdown_complete', severity: 'info' });
    } catch {
      // A completion marker is useful observability, never a reason to block process exit.
    }
  });
  return true;
}

function beginGracefulDrain(signal = 'SIGUSR2') {
  // Core owns the process-wide drain transition: in the same tick it closes new admission,
  // clears impossible matchmaking waits and notifies roomless sockets. Active room sockets stay
  // connected while bootstrap waits for COUNTDOWN/PLAYING matches to finish.
  if (!core.beginOperationalDrain()) return false;
  const startedAt = Date.now();
  const initialMatches = activeMatchesForDrain();
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'server_drain_started',
      signal,
      activeMatches: initialMatches,
      timeoutMs: DRAIN_TIMEOUT_MS
    })
  );

  let finishing = false;
  const finish = reason => {
    if (finishing) return;
    finishing = true;
    clearDrainTimers();
    console.log(
      JSON.stringify({
        level: reason === 'timeout' ? 'warn' : 'info',
        event: 'server_drain_finished',
        reason,
        waitedMs: Date.now() - startedAt,
        activeMatches: activeMatchesForDrain()
      })
    );
    armReliabilityShutdownCompletion();
    finalReliabilitySample();
    core.shutdown(`${signal}:${reason}`);
  };

  // Даём HTTP-ответу на команду restart успеть вернуться в Wobble Control до возможного выхода.
  // После этого пустой сервер выключится сразу, а занятый — будет ждать завершения матча.
  drainInterval = setInterval(() => {
    if (activeMatchesForDrain() === 0) finish('drained');
  }, DRAIN_POLL_MS);
  drainInterval.unref?.();
  drainTimeout = setTimeout(() => finish('timeout'), DRAIN_TIMEOUT_MS);
  drainTimeout.unref?.();
  return true;
}

if (require.main === module) {
  core.server.listen(port, host, () => {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'server_started',
        port: Number(port),
        host,
        authV2: true,
        socketAuth: true,
        serverInventory: true,
        socialCosmetics: true,
        socialSafety: true,
        playerSanctions: true,
        rewardPlatform: true,
        adminPanel: adminPanelEnabled,
        reliability: true,
        devRewards: process.env.ENABLE_DEV_REWARDS === '1',
        google: google.enabled
      })
    );
  });
  // Последняя линия обороны: исключение, до которого не дотянулся ни один обработчик.
  //
  // Обычный совет для Node — записать и выйти: состояние процесса после такой ошибки неизвестно.
  // Здесь выбрано иначе, и вот почему. В этом процессе живут все идущие забеги, и выход означает
  // гарантированную потерю их всех до единого. Неизвестное состояние — риск; выход — уже
  // случившийся ущерб, причём для каждого, кто сейчас играет. Между «возможно, что-то сломано» и
  // «точно выбило всех» игра выбирает первое и продолжает обслуживать комнаты.
  //
  // Чтобы это не превратилось в тихое проглатывание ошибок, событие идёт в тот же структурный лог,
  // что и остальные: console.error перехвачен reliability capture, а 'uncaught_exception' внесён в
  // список отслеживаемых. Ошибка не исчезает — она становится видимой в Reliability Center.
  const logUnhandled = (event, error) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event,
        ts: new Date().toISOString(),
        message: String(error?.message || error || '').slice(0, 500),
        stack: String(error?.stack || '').slice(0, 2000)
      })
    );
  };
  process.on('uncaughtException', error => logUnhandled('uncaught_exception', error));
  process.on('unhandledRejection', reason => logUnhandled('uncaught_exception', reason));

  process.on('SIGUSR2', () => beginGracefulDrain('SIGUSR2'));
  process.on('SIGTERM', () => {
    clearDrainTimers();
    armReliabilityShutdownCompletion();
    finalReliabilitySample();
    core.shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    clearDrainTimers();
    armReliabilityShutdownCompletion();
    finalReliabilitySample();
    core.shutdown('SIGINT');
  });
}

module.exports = {
  ...core,
  auth,
  google,
  inventory,
  rewards,
  sanctions,
  adminAuth,
  adminControl,
  adminInfrastructure,
  adminOperations,
  reliability,
  activeMatchesForDrain,
  beginGracefulDrain,
  armReliabilityShutdownCompletion
};
