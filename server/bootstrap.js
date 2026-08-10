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

const auth = new AuthService({ db: core.accounts.db });
const google = new GoogleIdentityVerifier({ clientId: process.env.GOOGLE_CLIENT_ID });
const inventory = new InventoryService({ db: core.accounts.db, accounts: core.accounts });
const rewards = new RewardService({ db: core.accounts.db, inventory });
const recoveryLogin = core.accounts.login.bind(core.accounts);

// Recovery code — только HTTP credential. Игровой WebSocket получает короткий WST ticket,
// выпущенный из HttpOnly session; старый recovery code нельзя использовать как сетевой bearer.
core.accounts.login = credential => {
  const ticket = auth.resolveSocketTicket(credential);
  return ticket ? core.accounts.get(ticket.accountId) : null;
};

const accountPayload = account => ({
  ok: true,
  account: { id: account.id, name: account.name },
  records: core.accounts.records(account.id),
  progress: core.accounts.progress(account.id),
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

installAuthRoutes({
  app: core.app,
  accounts: core.accounts,
  recoveryLogin,
  auth,
  google,
  inventory,
  clientIp,
  accountPayload,
  secureCookies: process.env.COOKIE_SECURE
    ? process.env.COOKIE_SECURE !== '0'
    : process.env.NODE_ENV === 'production'
});

installRewardRoutes({ app: core.app, auth, rewards });

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
        serverInventory: true,
        rewardPlatform: true,
        devRewards: process.env.ENABLE_DEV_REWARDS === '1',
        google: google.enabled
      })
    );
  });
  process.on('SIGTERM', () => core.shutdown('SIGTERM'));
  process.on('SIGINT', () => core.shutdown('SIGINT'));
}

module.exports = { ...core, auth, google, inventory, rewards };
