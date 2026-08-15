const express = require('express');
const { SESSION_COOKIE, parseCookies, cookieForSession, clearSessionCookie } = require('./auth');
const { BoundedIpRateLimiter } = require('./ipRateLimiter');
const { AccountSelfService } = require('./accountSelfService');

const AUTH_WINDOW_MS = 10 * 60 * 1000;

function installAuthRoutes({
  app,
  accounts,
  recoveryLogin = secret => accounts.login(secret),
  auth,
  google,
  inventory = null,
  sanctions = null,
  clientIp = req => req.socket.remoteAddress || 'unknown',
  accountPayload,
  secureCookies = process.env.NODE_ENV === 'production'
}) {
  const json = express.json({ limit: '20kb' });
  const attempts = {
    recovery: [40, new BoundedIpRateLimiter({ windowMs: AUTH_WINDOW_MS })],
    google: [80, new BoundedIpRateLimiter({ windowMs: AUTH_WINDOW_MS })]
  };
  const selfService = new AccountSelfService({ db: accounts.db, auth });

  const rateLimited = (kind, ip) => {
    if (!ip) return false;
    const [max, limiter] = attempts[kind];
    return limiter.limited(ip, max);
  };

  const tokenFrom = req => parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  const sessionFrom = req => auth.resolveSession(tokenFrom(req));
  const sanctionFor = accountId => {
    if (!accountId || !sanctions || typeof sanctions.active !== 'function') return null;
    return sanctions.active(accountId);
  };
  const denySanction = (res, accountId, sanction, { clearCookie = false } = {}) => {
    // Revoking all account sessions makes the restriction immediate on every device. The sanction
    // table is still checked on every login, so deleting the cookie is cleanup rather than the
    // source of truth.
    try {
      auth.revokeAccountSessions(accountId);
    } catch {
      // A failed cleanup must not turn an active ban into an allowed request.
    }
    if (clearCookie) res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
    res.setHeader('Cache-Control', 'no-store');
    const publicSanction = sanctions?.publicView?.(sanction) || {
      reason: sanction?.reason || 'other',
      expiresAt: sanction?.expiresAt ?? null,
      permanent: Boolean(sanction?.permanent)
    };
    return res.status(403).json({ ok: false, error: 'account-sanctioned', sanction: publicSanction });
  };

  const issue = (res, accountId) => {
    if (sanctionFor(accountId)) return null;
    const session = auth.createSession(accountId);
    if (!session) return null;
    res.setHeader(
      'Set-Cookie',
      cookieForSession(session.token, {
        secure: secureCookies,
        maxAgeMs: Math.max(0, session.expiresAt - Date.now())
      })
    );
    res.setHeader('Cache-Control', 'no-store');
    return session;
  };

  const withNetworkTicket = (payload, accountId) => ({
    ...payload,
    networkTicket: sanctionFor(accountId) ? null : auth.createSocketTicket(accountId)?.token || null
  });

  const requireSession = (req, res) => {
    const session = sessionFrom(req);
    if (!session) {
      res.status(401).json({ ok: false, error: 'session-required' });
      return null;
    }
    const sanction = sanctionFor(session.accountId);
    if (sanction) {
      denySanction(res, session.accountId, sanction, { clearCookie: true });
      return null;
    }
    return session;
  };

  app.post('/api/auth/config', json, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, googleClientId: google.enabled ? google.clientId : null });
  });

  app.post('/api/auth/session', json, (req, res) => {
    const session = sessionFrom(req);
    if (!session) return res.status(401).json({ ok: false, error: 'no-session' });
    const sanction = sanctionFor(session.accountId);
    if (sanction) return denySanction(res, session.accountId, sanction, { clearCookie: true });
    return res.json(
      withNetworkTicket(
        {
          ...accountPayload(session.account),
          identities: auth.identities(session.accountId)
        },
        session.accountId
      )
    );
  });

  app.post('/api/auth/profile', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    return res.json({ ok: true, profile: accounts.profile(session.accountId) });
  });

  app.post('/api/auth/sessions', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      ok: true,
      sessions: auth.listSessions(session.accountId, tokenFrom(req))
    });
  });

  app.post('/api/auth/sessions/revoke', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const result = auth.revokeAccountSession({
      accountId: session.accountId,
      sessionId: req.body?.sessionId,
      currentToken: tokenFrom(req)
    });
    if (!result.ok) {
      const status = result.reason === 'current-session' ? 409 : 400;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, removed: result.removed });
  });

  app.post('/api/auth/sessions/revoke-others', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const revoked = auth.revokeOtherSessions(session.accountId, tokenFrom(req));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, revoked });
  });

  app.post('/api/auth/recovery/rotate/prepare', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const prepared = selfService.prepareRecoveryCode({ accountId: session.accountId });
    if (!prepared) return res.status(404).json({ ok: false, error: 'unknown-account' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...prepared });
  });

  app.post('/api/auth/recovery/rotate/confirm', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const result = selfService.confirmRecoveryCode({
      accountId: session.accountId,
      currentToken: tokenFrom(req),
      secret: req.body?.secret
    });
    res.setHeader('Cache-Control', 'no-store');
    if (!result.ok) {
      const status = result.reason === 'unknown-account' ? 404 : result.reason === 'invalid-code' ? 400 : 409;
      return res.status(status).json({ ok: false, error: result.reason });
    }
    return res.json({ ok: true, ...result });
  });

  app.post('/api/auth/recovery', json, (req, res) => {
    if (rateLimited('recovery', clientIp(req)))
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    const account = recoveryLogin(req.body?.secret);
    if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
    const sanction = sanctionFor(account.id);
    if (sanction) return denySanction(res, account.id, sanction, { clearCookie: true });
    if (!issue(res, account.id)) return res.status(500).json({ ok: false, error: 'session-failed' });

    return res.json(
      withNetworkTicket({ ...accountPayload(account), identities: auth.identities(account.id) }, account.id)
    );
  });

  app.post('/api/auth/google', json, async (req, res) => {
    if (!google.enabled) return res.status(503).json({ ok: false, error: 'google-disabled' });
    if (rateLimited('google', clientIp(req)))
      return res.status(429).json({ ok: false, error: 'rate-limited' });

    let verified;
    try {
      verified = await google.verify(req.body?.credential);
    } catch {
      return res.status(503).json({ ok: false, error: 'google-unavailable' });
    }
    if (!verified.ok) return res.status(401).json({ ok: false, error: verified.reason });

    const existing = auth.identity('google', verified.subject);
    const current = sessionFrom(req);
    if (current) {
      const currentSanction = sanctionFor(current.accountId);
      if (currentSanction)
        return denySanction(res, current.accountId, currentSanction, { clearCookie: true });
    }
    let account;
    let secret = null;
    let linked = false;

    if (existing) {
      account = accounts.get(existing.accountId);
    } else if (current) {
      account = accounts.get(current.accountId);
      linked = Boolean(
        account && auth.linkIdentity({ provider: 'google', subject: verified.subject, accountId: account.id })
      );
      if (!linked) return res.status(409).json({ ok: false, error: 'identity-conflict' });
    } else {
      const created = accounts.create(verified.name || 'Wobbler');
      account = created;
      secret = created.secret;
      linked = Boolean(
        auth.linkIdentity({ provider: 'google', subject: verified.subject, accountId: account.id })
      );
      if (!linked) return res.status(409).json({ ok: false, error: 'identity-conflict' });
    }

    if (!account) return res.status(404).json({ ok: false, error: 'unknown-account' });
    const sanction = sanctionFor(account.id);
    if (sanction) return denySanction(res, account.id, sanction, { clearCookie: true });
    if (!issue(res, account.id)) return res.status(500).json({ ok: false, error: 'session-failed' });

    return res.json(
      withNetworkTicket(
        {
          ...accountPayload(account),
          identities: auth.identities(account.id),
          linked,
          ...(secret ? { secret } : {})
        },
        account.id
      )
    );
  });

  app.post('/api/auth/logout', json, (req, res) => {
    auth.revokeSession(tokenFrom(req));
    res.setHeader('Set-Cookie', clearSessionCookie({ secure: secureCookies }));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true });
  });

  app.post('/api/auth/name', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const name = accounts.rename(session.accountId, req.body?.name);
    return res.json({ ok: true, account: { id: session.accountId, name } });
  });

  app.post('/api/auth/record', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const saved = accounts.saveRecord({
      accountId: session.accountId,
      mode: req.body?.mode,
      courseKey: req.body?.courseKey,
      timeMs: Number(req.body?.timeMs)
    });
    if (saved.reason) return res.status(400).json({ ok: false, error: saved.reason });
    return res.json({ ok: true, ...saved });
  });

  app.post('/api/cosmetics/equip', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!inventory) return res.status(503).json({ ok: false, error: 'inventory-disabled' });
    inventory.syncEntitlements(session.accountId);
    const equipped = inventory.equip(session.accountId, req.body?.slot, req.body?.cosmeticId);
    if (!equipped.ok) return res.status(400).json({ ok: false, error: equipped.reason });
    return res.json({ ok: true, inventory: inventory.profile(session.accountId) });
  });

  // Эмоция в одну из четырёх ячеек. Отдельный маршрут, а не расширение equip: у эмоций не слот, а
  // позиция, и подмешивать её в тот же параметр значило бы принимать «слот» двух разных природ.
  app.post('/api/cosmetics/emote', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    if (!inventory) return res.status(503).json({ ok: false, error: 'inventory-disabled' });
    inventory.syncEntitlements(session.accountId);
    const equipped = inventory.equipEmote(session.accountId, req.body?.position, req.body?.cosmeticId);
    if (!equipped.ok) return res.status(400).json({ ok: false, error: equipped.reason });
    return res.json({ ok: true, inventory: inventory.profile(session.accountId) });
  });

  return { tokenFrom, sessionFrom, requireSession };
}

module.exports = { installAuthRoutes };
