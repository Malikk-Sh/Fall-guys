// Production entrypoint for account sessions, external identities, inventory and rewards.
//
// `index.js` remains directly importable by the existing unit/integration tests. This thin layer
// extends CSP for Google Identity Services, installs Auth V2 + inventory + rewards on the exported
// Express app, then starts the same HTTP/WebSocket server.

const http = require('http');

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
const { PlayerSanctions } = require('./playerSanctions');
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
  adminAuth,
  sanctions,
  auth,
  disconnectAccount: accountId => networkIdentity.disconnectAccount(accountId)
});
const adminInfrastructure = new AdminInfrastructure({ health: core.health });
const adminOperations = new AdminOperationsClient();
const recoveryLogin = core.accounts.login.bind(core.accounts);
const adminPanelEnabled = process.env.ADMIN_PANEL_ENABLED === '1';

// WST принадлежит только рукопожатию WebSocket. NetworkIdentity поглощает его один раз и дальше
// игровой протокол использует уже ws.accountId; CREATE/JOIN/FIND не видят credential вообще.
// Второй callback — server-side access policy. Он проверяется и для свежего WST, и для RESUME,
// поэтому старый reconnect token не позволяет обойти выданный после отключения бан.
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
installAdminRoutes({
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

const port = process.env.PORT || 3000;
const host = process.env.HOST || '0.0.0.0';

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
        devRewards: process.env.ENABLE_DEV_REWARDS === '1',
        google: google.enabled
      })
    );
  });
  process.on('SIGTERM', () => core.shutdown('SIGTERM'));
  process.on('SIGINT', () => core.shutdown('SIGINT'));
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
  adminOperations
};
