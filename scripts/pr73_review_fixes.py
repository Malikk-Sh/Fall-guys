from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f'missing patch anchor in {path}: {old[:140]!r}')
    p.write_text(text.replace(old, new, 1))


# Protocol: distinguish a moderation block from an invalid/expired WST.
replace_once(
    'shared/protocol.js',
    "  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',\n  ROOM_NOT_FOUND:",
    "  AUTH_UNAVAILABLE: 'AUTH_UNAVAILABLE',\n  ACCOUNT_SANCTIONED: 'ACCOUNT_SANCTIONED',\n  ROOM_NOT_FOUND:",
)

# NetworkManager: a known sanction is a hard online-access block, not the normal anonymous path.
replace_once(
    'client/net/NetworkManager.js',
    "  AUTH_UNAVAILABLE: 'Авторизация сети временно недоступна.',\n  ROOM_NOT_FOUND:",
    "  AUTH_UNAVAILABLE: 'Авторизация сети временно недоступна.',\n  ACCOUNT_SANCTIONED: 'Онлайн-доступ аккаунта ограничен модерацией.',\n  ROOM_NOT_FOUND:",
)
replace_once(
    'client/net/NetworkManager.js',
    "    this.versionMismatch = false;\n\n    this.clock = new ClockSync();",
    "    this.versionMismatch = false;\n    this.accessBlocked = false;\n    this.accessBlockSanction = null;\n    this.ui.clearNetworkAccessBlock = () => this.clearAccessBlock();\n\n    this.clock = new ClockSync();",
)
replace_once(
    'client/net/NetworkManager.js',
    "  connect() {\n    if (this.ws && this.ws.readyState <= 1) return;",
    "  connect() {\n    if (this.accessBlocked) {\n      this.ui.status('Онлайн-доступ аккаунта ограничен модерацией.');\n      return;\n    }\n    if (this.ws && this.ws.readyState <= 1) return;",
)
replace_once(
    'client/net/NetworkManager.js',
    "    if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;\n    if (!ticket) {",
    "    if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return;\n    if (ticket && typeof ticket === 'object' && ticket.blocked === true) {\n      this.blockAccess(ticket.sanction || null);\n      return;\n    }\n    if (!ticket) {",
)
replace_once(
    'client/net/NetworkManager.js',
    "  // Принять личность, выданную сервером новому сокету. Вызывается после socket-auth либо когда\n  // аккаунт офлайн/отсутствует и соединение сознательно остаётся анонимным.\n  adoptWelcome() {",
    "  blockAccess(sanction = null) {\n    this.accessBlocked = true;\n    this.accessBlockSanction = sanction || null;\n    this.intentionalClose = true;\n    clearTimeout(this.reconnectTimer);\n    this.queue.length = 0;\n    this.pendingWelcome = null;\n    this.resumeInFlight = false;\n    this.resumeToken = null;\n    this.authInFlight = false;\n    this.authRetryCount = 0;\n    this.handshakeReady = false;\n    this.id = null;\n    this.roomCode = null;\n    this.matchId = null;\n    this.finishSentFor = null;\n    this.saveSession(null);\n    this.setLinkState(LINK_STATE.FAILED);\n    this.ui.error?.(ERROR_TEXT.ACCOUNT_SANCTIONED);\n    this.emit('accountSanctioned', { sanction: this.accessBlockSanction });\n    try {\n      this.ws?.close();\n    } catch {\n      // A stale browser socket may already be closed. The local hard block still remains active.\n    }\n    return false;\n  }\n\n  clearAccessBlock() {\n    this.accessBlocked = false;\n    this.accessBlockSanction = null;\n    this.intentionalClose = false;\n    if (this.linkState === LINK_STATE.FAILED) this.setLinkState(LINK_STATE.OFFLINE);\n  }\n\n  // Принять личность, выданную сервером новому сокету. Вызывается после socket-auth либо когда\n  // аккаунт офлайн/отсутствует и соединение сознательно остаётся анонимным.\n  adoptWelcome() {",
)
replace_once(
    'client/net/NetworkManager.js',
    "      case S2C.ERROR:\n        if (this.authInFlight && message.code === 'AUTH_FAILED'",
    "      case S2C.ERROR:\n        if (message.code === ERROR_CODES.ACCOUNT_SANCTIONED) {\n          this.blockAccess();\n          return;\n        }\n        if (this.authInFlight && message.code === 'AUTH_FAILED'",
)
replace_once(
    'client/net/NetworkManager.js',
    "  send(type, data = {}) {\n    // Несовместимый клиент молчит:",
    "  send(type, data = {}) {\n    if (this.accessBlocked) {\n      this.ui.status('Онлайн-доступ аккаунта ограничен модерацией.');\n      return false;\n    }\n    // Несовместимый клиент молчит:",
)

# AccountFlow remembers a sanction after HTTP sessions are revoked and returns an explicit sentinel
# to NetworkManager. A successful later sign-in clears the hard block (e.g. after expiry/appeal).
replace_once(
    'client/core/AccountFlow.js',
    "  async takeNetworkTicket({ fresh = false } = {}) {\n    if (!fresh && this.networkTicket) {",
    "  async takeNetworkTicket({ fresh = false } = {}) {\n    const cachedSanction = this.game.accountSanction;\n    if (cachedSanction) {\n      const expiresAt = Number(cachedSanction.expiresAt);\n      const stillActive =\n        cachedSanction.permanent || !Number.isFinite(expiresAt) || expiresAt > Date.now();\n      if (stillActive) return { blocked: true, sanction: cachedSanction };\n      this.game.accountSanction = null;\n    }\n    if (!fresh && this.networkTicket) {",
)
replace_once(
    'client/core/AccountFlow.js',
    "      if (session.sanctioned) {\n        this.showSanction(session.sanction);\n        return null;\n      }",
    "      if (session.sanctioned) {\n        this.showSanction(session.sanction);\n        return { blocked: true, sanction: session.sanction };\n      }",
)
replace_once(
    'client/core/AccountFlow.js',
    "    this.online = Boolean(online && account);\n    if (this.online) this.game.accountSanction = null;",
    "    this.online = Boolean(online && account);\n    if (this.online) {\n      this.game.accountSanction = null;\n      this.game.ui.clearNetworkAccessBlock?.();\n    }",
)

# Shared policy for the pre-Auth-V2 recovery routes that still live in index.js.
replace_once(
    'server/index.js',
    "const { networkIdentity } = require('./networkIdentity');\nconst { socialCosmetics }",
    "const { networkIdentity } = require('./networkIdentity');\nconst { accountAccessPolicy } = require('./accountAccessPolicy');\nconst { socialCosmetics }",
)
replace_once(
    'server/index.js',
    "const accountPayload = account => ({\n  ok: true,\n  account: { id: account.id, name: account.name },\n  records: accounts.records(account.id),\n  progress: accounts.progress(account.id)\n});\n",
    "const accountPayload = account => ({\n  ok: true,\n  account: { id: account.id, name: account.name },\n  records: accounts.records(account.id),\n  progress: accounts.progress(account.id)\n});\n\nfunction legacySanction(account) {\n  const item = account?.id ? accountAccessPolicy.sanction(account.id) : null;\n  if (!item) return null;\n  return {\n    reason: String(item.reason || 'other'),\n    expiresAt: item.expiresAt == null ? null : Number(item.expiresAt),\n    permanent: Boolean(item.permanent)\n  };\n}\n\nfunction rejectSanctionedLegacy(res, account) {\n  const sanction = legacySanction(account);\n  if (!sanction) return false;\n  res.setHeader('Cache-Control', 'no-store');\n  res.status(403).json({ ok: false, error: 'account-sanctioned', sanction });\n  return true;\n}\n",
)
replace_once(
    'server/index.js',
    "  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  return res.json(accountPayload(account));\n});\n\napp.post('/account/name'",
    "  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  if (rejectSanctionedLegacy(res, account)) return undefined;\n  return res.json(accountPayload(account));\n});\n\napp.post('/account/name'",
)
replace_once(
    'server/index.js',
    "app.post('/account/name', accountJson, (req, res) => {\n  const account = accounts.login(req.body?.secret);\n  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  const name = accounts.rename(account.id, req.body?.name);",
    "app.post('/account/name', accountJson, (req, res) => {\n  const account = accounts.login(req.body?.secret);\n  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  if (rejectSanctionedLegacy(res, account)) return undefined;\n  const name = accounts.rename(account.id, req.body?.name);",
)
replace_once(
    'server/index.js',
    "  const account = accounts.login(req.body?.secret);\n  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  const saved = accounts.saveRecord({",
    "  const account = accounts.login(req.body?.secret);\n  if (!account) return res.status(404).json({ ok: false, error: 'unknown-code' });\n  if (rejectSanctionedLegacy(res, account)) return undefined;\n  const saved = accounts.saveRecord({",
)

# A blocked WST or blocked room resume is rejected and the server closes that socket. A modified
# client therefore cannot ignore the UI and continue as a guest on the same transport.
replace_once(
    'server/index.js',
    "function resume(ws, token) {\n  const session = sessions.get(token);",
    "function resume(ws, token) {\n  ws.accountAccessDenied = false;\n  const session = sessions.get(token);",
)
replace_once(
    'server/index.js',
    "  if (!networkIdentity.bindResumedPlayer(ws, player)) return false;",
    "  if (player.accountId && !networkIdentity.allowed(player.accountId)) {\n    ws.accountAccessDenied = true;\n    return false;\n  }\n  if (!networkIdentity.bindResumedPlayer(ws, player)) return false;",
)
replace_once(
    'server/index.js',
    "    if (message.type === C2S.RESUME) {\n      if (resume(ws, message.token)) return;\n      metrics.resumeFailed++;\n      log('info', 'resume_failed', { playerId: ws.id });\n      return send(ws, { type: S2C.RESUME_FAILED, code: ERROR_CODES.RECONNECT_EXPIRED });\n    }",
    "    if (message.type === C2S.RESUME) {\n      if (resume(ws, message.token)) return;\n      metrics.resumeFailed++;\n      if (ws.accountAccessDenied) {\n        log('info', 'resume_sanctioned', { playerId: ws.id });\n        sendError(ws, ERROR_CODES.ACCOUNT_SANCTIONED, 'Онлайн-доступ аккаунта ограничен модерацией.', false);\n        try {\n          ws.close(4003, 'account-sanctioned');\n        } catch {\n          // The access decision is already final; close failure cannot authorize the socket.\n        }\n        return;\n      }\n      log('info', 'resume_failed', { playerId: ws.id });\n      return send(ws, { type: S2C.RESUME_FAILED, code: ERROR_CODES.RECONNECT_EXPIRED });\n    }",
)
replace_once(
    'server/index.js',
    "        const code =\n          authenticated.reason === 'already-bound'\n            ? ERROR_CODES.AUTH_ALREADY_BOUND\n            : authenticated.reason === 'unavailable'\n              ? ERROR_CODES.AUTH_UNAVAILABLE\n              : ERROR_CODES.AUTH_FAILED;",
    "        const code =\n          authenticated.reason === 'already-bound'\n            ? ERROR_CODES.AUTH_ALREADY_BOUND\n            : authenticated.reason === 'unavailable'\n              ? ERROR_CODES.AUTH_UNAVAILABLE\n              : authenticated.reason === 'blocked-account'\n                ? ERROR_CODES.ACCOUNT_SANCTIONED\n                : ERROR_CODES.AUTH_FAILED;",
)
replace_once(
    'server/index.js',
    "        const detail =\n          authenticated.reason === 'already-bound'\n            ? 'Аккаунт уже привязан к этому соединению.'\n            : authenticated.reason === 'unavailable'\n              ? 'Сетевая авторизация временно недоступна.'\n              : 'WebSocket ticket недействителен, истёк или уже использован.';\n        return sendError(ws, code, detail, false);",
    "        const detail =\n          authenticated.reason === 'already-bound'\n            ? 'Аккаунт уже привязан к этому соединению.'\n            : authenticated.reason === 'unavailable'\n              ? 'Сетевая авторизация временно недоступна.'\n              : authenticated.reason === 'blocked-account'\n                ? 'Онлайн-доступ аккаунта ограничен модерацией.'\n                : 'WebSocket ticket недействителен, истёк или уже использован.';\n        sendError(ws, code, detail, false);\n        if (authenticated.reason === 'blocked-account') {\n          try {\n            ws.close(4003, 'account-sanctioned');\n          } catch {\n            // The account remains blocked by the server-side policy even if close races transport teardown.\n          }\n        }\n        return;",
)

# Bootstrap configures both modern Auth V2 and the legacy recovery routes from one sanction service.
replace_once(
    'server/bootstrap.js',
    "const { PlayerSanctions } = require('./playerSanctions');\nconst { networkIdentity }",
    "const { PlayerSanctions } = require('./playerSanctions');\nconst { accountAccessPolicy } = require('./accountAccessPolicy');\nconst { networkIdentity }",
)
replace_once(
    'server/bootstrap.js',
    "networkIdentity.configure(\n  ticket => auth.consumeSocketTicket(ticket),",
    "accountAccessPolicy.configure(accountId => {\n  const active = sanctions.active(accountId);\n  return active ? sanctions.publicView(active) : null;\n});\nnetworkIdentity.configure(\n  ticket => auth.consumeSocketTicket(ticket),",
)

# Complete admin history: no silent hard-coded 50-row truncation. Optional limits remain available
# for callers that explicitly ask for them.
replace_once(
    'server/playerSanctions.js',
    "  history(accountId, { limit = 50, now = Date.now() } = {}) {\n    const id = String(accountId || '').trim();\n    if (!id) return [];\n    return this.statements.history.all(id, clampLimit(limit)).map(row => toSanction(row, now));\n  }",
    "  history(accountId, { limit = null, now = Date.now() } = {}) {\n    const id = String(accountId || '').trim();\n    if (!id) return [];\n    const rows =\n      limit == null\n        ? this.statements.historyAll.all(id)\n        : this.statements.historyLimited.all(id, clampLimit(limit));\n    return rows.map(row => toSanction(row, now));\n  }",
)
replace_once(
    'server/playerSanctions.js',
    "    history: db.prepare(`${select} WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`),",
    "    historyAll: db.prepare(`${select} WHERE account_id = ? ORDER BY created_at DESC, id DESC`),\n    historyLimited: db.prepare(\n      `${select} WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`\n    ),",
)
replace_once(
    'server/adminControl.js',
    "      history: this.sanctions.history(accountId, { limit: 50, now }).map(item => this.#decorateSanction(item))",
    "      history: this.sanctions.history(accountId, { now }).map(item => this.#decorateSanction(item))",
)

# Regression coverage for complete histories.
replace_once(
    'server/playerSanctions.test.mjs',
    "test('invalid reasons, empty notes and unsafe durations are rejected', () => {",
    "test('admin history does not silently truncate repeat offenders after 50 sanctions', () => {\n  const { db, moderator, sanctions } = setup();\n  for (let index = 0; index < 55; index += 1) {\n    const result = sanctions.apply({\n      accountId: 'player-1',\n      kind: 'warning',\n      reason: 'griefing',\n      note: `Warning ${index + 1}`,\n      createdByAdminId: moderator.user.id,\n      now: 10_000 + index\n    });\n    assert.equal(result.ok, true);\n  }\n  assert.equal(sanctions.history('player-1').length, 55);\n  assert.equal(sanctions.history('player-1', { limit: 10 }).length, 10);\n  db.close();\n});\n\ntest('invalid reasons, empty notes and unsafe durations are rejected', () => {",
)

# Make the two new bypass regression tests part of the ordinary suite.
replace_once(
    'package.json',
    "server/authSanctions.test.mjs server/networkSanctions.test.mjs server/adminAnalytics.test.mjs",
    "server/authSanctions.test.mjs server/networkSanctions.test.mjs server/networkManagerSanctions.test.mjs server/legacySanctions.test.mjs server/adminAnalytics.test.mjs",
)

print('PR73 review fixes applied')
