'use strict';

const express = require('express');
const { BoundedIpRateLimiter } = require('./ipRateLimiter');

// Аккаунты по коду восстановления.
//
// Разговор идёт по HTTP, а не по WebSocket, сознательно: одиночный забег сокет вообще не открывает,
// а рекорд после него сохранить надо. Заводить ради этого соединение значило бы держать его ради
// одного сообщения.
//
// Код восстановления присылается с каждым запросом вместо серверной сессии. Отдельная таблица
// сессий здесь ничего не добавила бы: код и так хранится у игрока, живёт долго и передаётся по тому
// же TLS, что и любая сессия.

// Разбор тела с жёстким потолком: тут ждут короткий JSON, и принимать мегабайты незачем.
const BODY_LIMIT = '2kb';

// Ограничители по адресу, отдельные от комнатных.
//
// У создания аккаунта и у входа разные опасности: первое спамят, второе перебирают. Общий счётчик
// означал бы, что спам создания закрывает вход честному игроку с того же адреса — а за NAT это
// целый дом.
const HTTP_WINDOW_MS = 10 * 60 * 1000;
const HTTP_LIMITS = Object.freeze({ create: 20, login: 40, record: 200 });

function installLegacyAccountRoutes(app, { accounts, accountAccessPolicy, clientIp, log }) {
  const accountJson = express.json({ limit: BODY_LIMIT });
  const limiters = new Map(
    Object.entries(HTTP_LIMITS).map(([kind, max]) => [
      kind,
      { max, limiter: new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS }) }
    ])
  );

  function rateLimited(kind, ip) {
    if (!ip) return false;
    const entry = limiters.get(kind);
    return entry.limiter.limited(ip, entry.max);
  }

  // Личные рекорды отдаются вместе с аккаунтом: клиенту они нужны сразу после входа, чтобы показать
  // рекорд трассы в меню, и отдельный запрос за ними был бы лишним кругом.
  const accountPayload = account => ({
    ok: true,
    account: { id: account.id, name: account.name },
    records: accounts.records(account.id),
    progress: accounts.progress(account.id)
  });

  function sanctionOf(account) {
    const item = account?.id ? accountAccessPolicy.sanction(account.id) : null;
    if (!item) return null;
    return {
      reason: String(item.reason || 'other'),
      expiresAt: item.expiresAt == null ? null : Number(item.expiresAt),
      permanent: Boolean(item.permanent)
    };
  }

  function rejectSanctioned(res, account) {
    const sanction = sanctionOf(account);
    if (!sanction) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.status(403).json({ ok: false, error: 'account-sanctioned', sanction });
    return true;
  }

  app.post('/account', accountJson, (req, res) => {
    if (rateLimited('create', clientIp(req))) {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const account = accounts.create(req.body?.name);
    log('info', 'account_created', { accountId: account.id });
    // Код возвращается ровно здесь и больше нигде: на сервере остаётся только его хеш.
    return res.status(201).json({ ...accountPayload(account), secret: account.secret });
  });

  app.post('/account/login', accountJson, (req, res) => {
    if (rateLimited('login', clientIp(req))) {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const account = accounts.login(req.body?.secret);
    // 404, а не 403: «такого аккаунта нет» и «код неверный» — для игрока одно и то же событие, и
    // различать их вслух значило бы подсказывать перебирающему, что он угадал половину.
    if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
    if (rejectSanctioned(res, account)) return undefined;
    return res.json(accountPayload(account));
  });

  app.post('/account/name', accountJson, (req, res) => {
    const account = accounts.login(req.body?.secret);
    if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
    if (rejectSanctioned(res, account)) return undefined;
    const name = accounts.rename(account.id, req.body?.name);
    return res.json({ ok: true, account: { id: account.id, name } });
  });

  app.post('/account/record', accountJson, (req, res) => {
    if (rateLimited('record', clientIp(req))) {
      return res.status(429).json({ ok: false, error: 'rate-limited' });
    }
    const account = accounts.login(req.body?.secret);
    if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });
    if (rejectSanctioned(res, account)) return undefined;
    const saved = accounts.saveRecord({
      accountId: account.id,
      mode: req.body?.mode,
      courseKey: req.body?.courseKey,
      timeMs: Number(req.body?.timeMs)
    });
    if (saved.reason) return res.status(400).json({ ok: false, error: saved.reason });
    return res.json({ ok: true, ...saved });
  });

  // Ограничители переживают отдельные запросы, поэтому их уборка и сброс принадлежат владельцу
  // процесса: housekeeping чистит просроченные окна, тесты сбрасывают счётчики между сценариями.
  return Object.freeze({
    cleanup(now) {
      for (const { limiter } of limiters.values()) limiter.cleanup(now, { force: true });
    },
    clear() {
      for (const { limiter } of limiters.values()) limiter.clear();
    }
  });
}

module.exports = Object.freeze({ HTTP_LIMITS, HTTP_WINDOW_MS, installLegacyAccountRoutes });
