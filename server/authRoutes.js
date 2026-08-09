const express = require('express');
const { SESSION_COOKIE, parseCookies, cookieForSession, clearSessionCookie } = require('./auth');

const AUTH_WINDOW_MS = 10 * 60 * 1000;

function installAuthRoutes({
  app,
  accounts,
  recoveryLogin = secret => accounts.login(secret),
  auth,
  google,
  clientIp = req => req.socket.remoteAddress || 'unknown',
  accountPayload,
  secureCookies = process.env.NODE_ENV === 'production'
}) {
  const json = express.json({ limit: '20kb' });
  const attempts = {
    recovery: [40, new Map()],
    google: [80, new Map()]
  };

  const rateLimited = (kind, ip) => {
    if (!ip) return false;
    const [max, hits] = attempts[kind];
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.start > AUTH_WINDOW_MS) {
      hits.set(ip, { start: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > max;
  };

  const tokenFrom = req => parseCookies(req.headers.cookie)[SESSION_COOKIE] || '';
  const sessionFrom = req => auth.resolveSession(tokenFrom(req));

  const issue = (res, accountId) => {
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
    networkTicket: auth.createSocketTicket(accountId)?.token || null
  });

  const requireSession = (req, res) => {
    const session = sessionFrom(req);
    if (session) return session;
    res.status(401).json({ ok: false, error: 'session-required' });
    return null;
  };

  // Auth routes устанавливаются bootstrap-модулем после основного приложения. В index.js уже есть
  // catch-all GET для SPA, поэтому служебные чтения делаем POST: они не пересекаются с навигацией.
  app.post('/api/auth/config', json, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true, googleClientId: google.enabled ? google.clientId : null });
  });

  app.post('/api/auth/session', json, (req, res) => {
    const session = sessionFrom(req);
    if (!session) return res.status(401).json({ ok: false, error: 'no-session' });
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

  app.post('/api/auth/recovery', json, (req, res) => {
    if (rateLimited('recovery', clientIp(req)))
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    const account = recoveryLogin(req.body?.secret);
    if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
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

  return { tokenFrom, sessionFrom, requireSession };
}

module.exports = { installAuthRoutes };
