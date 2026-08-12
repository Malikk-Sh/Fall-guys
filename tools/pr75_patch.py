from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# --- server/auth.js ---------------------------------------------------------
p = 'server/auth.js'
s = read(p)
s = replace_once(
    s,
    "  revokeAccountSessions(accountId) {\n    return this.statements.deleteAccountSessions.run(String(accountId || '')).changes;\n  }\n",
    "  revokeAccountSessions(accountId) {\n    return this.statements.deleteAccountSessions.run(String(accountId || '')).changes;\n  }\n\n  revokeAccountSocketTickets(accountId) {\n    const id = String(accountId || '');\n    if (!id) return 0;\n    let revoked = 0;\n    for (const [hash, ticket] of this.socketTickets) {\n      if (ticket?.accountId !== id) continue;\n      this.socketTickets.delete(hash);\n      revoked += 1;\n    }\n    return revoked;\n  }\n",
    'auth socket-ticket revocation'
)
write(p, s)

# --- server/networkIdentity.js ---------------------------------------------
p = 'server/networkIdentity.js'
s = read(p)
s = replace_once(
    s,
    "  disconnectAccount(accountId, { code = 4003, reason = 'account-sanctioned' } = {}) {\n",
    "  connectionCount(accountId) {\n    const id = String(accountId || '');\n    return id ? this.socketsByAccount.get(id)?.size || 0 : 0;\n  }\n\n  disconnectAccount(accountId, { code = 4003, reason = 'account-sanctioned' } = {}) {\n",
    'network identity connection count'
)
write(p, s)

# --- server/index.js --------------------------------------------------------
p = 'server/index.js'
s = read(p)
s = replace_once(
    s,
    "  sessions.set(ws.token, {\n    playerId: ws.id,\n    roomCode: room.code,\n    expiresAt: Date.now() + SESSION_TTL_MS\n  });\n",
    "  sessions.set(ws.token, {\n    playerId: ws.id,\n    roomCode: room.code,\n    accountId: ws.accountId || null,\n    expiresAt: Date.now() + SESSION_TTL_MS\n  });\n",
    'game reconnect session account binding'
)
marker = "// Уборка просроченных сессий — и продление живых.\n"
insert = """function revokeAccountReconnectSessions(accountId) {
  const id = String(accountId || '');
  if (!id) return 0;
  let revoked = 0;
  for (const [token, session] of sessions) {
    const player = rooms.get(session?.roomCode)?.players.get(session?.playerId);
    if (session?.accountId !== id && player?.accountId !== id) continue;
    sessions.delete(token);
    revoked += 1;
  }
  return revoked;
}

"""
s = replace_once(s, marker, insert + marker, 'game reconnect revocation helper')
s = replace_once(
    s,
    "  expireSessions,\n  SESSION_TTL_MS,\n",
    "  expireSessions,\n  revokeAccountReconnectSessions,\n  SESSION_TTL_MS,\n",
    'export reconnect revocation helper'
)
write(p, s)

# --- server/adminAuth.js ----------------------------------------------------
p = 'server/adminAuth.js'
s = read(p)
s = replace_once(
    s,
    "    'player-support.read',\n    'moderation.read',\n",
    "    'player-support.read',\n    'player-support.sessions.write',\n    'player-support.name.write',\n    'moderation.read',\n",
    'owner support capabilities'
)
s = replace_once(
    s,
    "    'player-support.read',\n    'moderation.read',\n    'audit.read'\n  ]),\n  moderator: Object.freeze(['dashboard.read', 'moderation.read', 'moderation.write', 'sanctions.write']),\n",
    "    'player-support.read',\n    'player-support.sessions.write',\n    'moderation.read',\n    'audit.read'\n  ]),\n  moderator: Object.freeze([\n    'dashboard.read',\n    'player-support.read',\n    'player-support.name.write',\n    'moderation.read',\n    'moderation.write',\n    'sanctions.write'\n  ]),\n",
    'operator and moderator support capabilities'
)
write(p, s)

# --- server/adminPlayerSupport.js ------------------------------------------
p = 'server/adminPlayerSupport.js'
s = read(p)
s = replace_once(
    s,
    "const { RECOVERY_ROTATION_TTL_MS } = require('./accountSelfService');\n",
    "const { RECOVERY_ROTATION_TTL_MS } = require('./accountSelfService');\nconst { PUBLIC_SESSION_ID_LENGTH } = require('./auth');\n",
    'support auth import'
)
s = replace_once(
    s,
    "const MAX_RECENT_REWARDS = 50;\n",
    "const MAX_RECENT_REWARDS = 50;\nconst MAX_SUPPORT_SESSIONS = 20;\nconst MAX_SUPPORT_HISTORY = 30;\nconst SUPPORT_ID_PREFIX = 'WBL-';\nconst SUPPORT_ID_HEX_LENGTH = 12;\n",
    'support constants'
)
s = replace_once(
    s,
    "function nullableNumber(value) {\n  return value == null ? null : Number(value);\n}\n",
    "function nullableNumber(value) {\n  return value == null ? null : Number(value);\n}\n\nfunction supportIdForAccount(accountId) {\n  const compact = String(accountId || '').replaceAll('-', '');\n  if (!/^[a-f0-9]{32}$/i.test(compact)) return null;\n  return `${SUPPORT_ID_PREFIX}${compact.slice(0, SUPPORT_ID_HEX_LENGTH).toUpperCase()}`;\n}\n\nfunction accountPrefixFromSupportId(value) {\n  const match = new RegExp(`^${SUPPORT_ID_PREFIX}([A-F0-9]{${SUPPORT_ID_HEX_LENGTH}})$`, 'i').exec(\n    String(value || '').trim()\n  );\n  if (!match) return '';\n  const compact = match[1].toLowerCase();\n  return `${compact.slice(0, 8)}-${compact.slice(8)}`;\n}\n\nfunction parseAuditDetail(value) {\n  if (!value) return null;\n  try {\n    return JSON.parse(value);\n  } catch {\n    return { unavailable: true };\n  }\n}\n",
    'support id helpers'
)
s = replace_once(
    s,
    "    const safeLimit = clampLimit(limit);\n    const idPrefix = `${escapeGlob(normalized)}*`;\n    const ftsQuery = ftsPrefixQuery(normalized);\n    const statement = ftsQuery ? statements.searchWithName : statements.searchIdOnly;\n    const rows = ftsQuery\n      ? statement.all(normalized, idPrefix, normalized, safeLimit, ftsQuery, safeLimit, now, safeLimit)\n      : statement.all(normalized, idPrefix, normalized, safeLimit, now, safeLimit);\n",
    "    const safeLimit = clampLimit(limit);\n    const supportAccountPrefix = accountPrefixFromSupportId(normalized);\n    const accountQuery = supportAccountPrefix || normalized;\n    const idPrefix = `${escapeGlob(accountQuery)}*`;\n    const ftsQuery = supportAccountPrefix ? '' : ftsPrefixQuery(normalized);\n    const statement = ftsQuery ? statements.searchWithName : statements.searchIdOnly;\n    const rows = ftsQuery\n      ? statement.all(accountQuery, idPrefix, accountQuery, safeLimit, ftsQuery, safeLimit, now, safeLimit)\n      : statement.all(accountQuery, idPrefix, accountQuery, safeLimit, now, safeLimit);\n",
    'support id search'
)
s = replace_once(
    s,
    "        id: row.id,\n        name: row.display_name,\n",
    "        id: row.id,\n        supportId: supportIdForAccount(row.id),\n        name: row.display_name,\n",
    'support id in search result'
)
s = replace_once(
    s,
    "        id: account.id,\n        name: account.display_name,\n",
    "        id: account.id,\n        supportId: supportIdForAccount(account.id),\n        name: account.display_name,\n",
    'support id in account detail'
)
s = replace_once(
    s,
    "        sessions: {\n          active: Number(session?.active_count || 0),\n          totalStored: Number(session?.stored_count || 0),\n          latestSeenAt: nullableNumber(session?.latest_seen_at),\n          oldestActiveCreatedAt: nullableNumber(session?.oldest_active_created_at),\n          soonestActiveExpiresAt: nullableNumber(session?.soonest_active_expires_at)\n        }\n      },\n",
    "        sessions: {\n          active: Number(session?.active_count || 0),\n          totalStored: Number(session?.stored_count || 0),\n          latestSeenAt: nullableNumber(session?.latest_seen_at),\n          oldestActiveCreatedAt: nullableNumber(session?.oldest_active_created_at),\n          soonestActiveExpiresAt: nullableNumber(session?.soonest_active_expires_at)\n        },\n        sessionList: statements.sessionList.all(id, now, MAX_SUPPORT_SESSIONS).map(row => ({\n          id: row.public_id,\n          createdAt: Number(row.created_at),\n          lastSeenAt: Number(row.last_seen_at),\n          expiresAt: Number(row.expires_at)\n        }))\n      },\n",
    'safe support session list'
)
s = replace_once(
    s,
    "        reportsSubmitted: Number(reportsSubmitted?.count || 0)\n      }\n    };\n",
    "        reportsSubmitted: Number(reportsSubmitted?.count || 0)\n      },\n      supportHistory: statements.supportHistory.all(id, MAX_SUPPORT_HISTORY).map(row => ({\n        id: Number(row.id),\n        actorName: row.actor_name,\n        actorRole: row.actor_role,\n        action: row.action,\n        detail: parseAuditDetail(row.detail_json),\n        createdAt: Number(row.created_at)\n      }))\n    };\n",
    'support audit history'
)
s = replace_once(
    s,
    "    sessions: db.prepare(`\n      SELECT\n        COUNT(*) AS stored_count,\n        SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS active_count,\n        MAX(CASE WHEN expires_at > ? THEN last_seen_at ELSE NULL END) AS latest_seen_at,\n        MIN(CASE WHEN expires_at > ? THEN created_at ELSE NULL END) AS oldest_active_created_at,\n        MIN(CASE WHEN expires_at > ? THEN expires_at ELSE NULL END) AS soonest_active_expires_at\n      FROM account_sessions\n      WHERE account_id = ?\n    `),\n",
    "    sessions: db.prepare(`\n      SELECT\n        COUNT(*) AS stored_count,\n        SUM(CASE WHEN expires_at > ? THEN 1 ELSE 0 END) AS active_count,\n        MAX(CASE WHEN expires_at > ? THEN last_seen_at ELSE NULL END) AS latest_seen_at,\n        MIN(CASE WHEN expires_at > ? THEN created_at ELSE NULL END) AS oldest_active_created_at,\n        MIN(CASE WHEN expires_at > ? THEN expires_at ELSE NULL END) AS soonest_active_expires_at\n      FROM account_sessions\n      WHERE account_id = ?\n    `),\n    sessionList: db.prepare(`\n      SELECT\n        substr(token_hash, 1, ${PUBLIC_SESSION_ID_LENGTH}) AS public_id,\n        created_at,\n        last_seen_at,\n        expires_at\n      FROM account_sessions\n      WHERE account_id = ? AND expires_at > ?\n      ORDER BY last_seen_at DESC, created_at DESC, token_hash ASC\n      LIMIT ?\n    `),\n",
    'support session list statement'
)
s = replace_once(
    s,
    "    reportsSubmitted: db.prepare(`\n      SELECT COALESCE(SUM(report_count), 0) AS count\n      FROM social_reports\n      WHERE reporter_account_id = ?\n    `)\n",
    "    reportsSubmitted: db.prepare(`\n      SELECT COALESCE(SUM(report_count), 0) AS count\n      FROM social_reports\n      WHERE reporter_account_id = ?\n    `),\n    supportHistory: db.prepare(`\n      SELECT id, actor_name, actor_role, action, detail_json, created_at\n      FROM admin_audit_events\n      WHERE target_type = 'player-account'\n        AND target_id = ?\n        AND action <> 'player.support.view'\n      ORDER BY created_at DESC, id DESC\n      LIMIT ?\n    `)\n",
    'support history statement'
)
s = replace_once(
    s,
    "  ftsPrefixQuery\n};\n",
    "  ftsPrefixQuery,\n  supportIdForAccount,\n  accountPrefixFromSupportId\n};\n",
    'support helper exports'
)
write(p, s)

# --- server/adminControl.js -------------------------------------------------
p = 'server/adminControl.js'
s = read(p)
s = replace_once(
    s,
    "const { ModerationQueue } = require('./moderation');\n",
    "const { ModerationQueue } = require('./moderation');\nconst { safeName: safeAccountName, MAX_NAME: MAX_PLAYER_NAME } = require('./accounts');\n",
    'admin control account helpers import'
)
s = replace_once(
    s,
    "const OWNER_MAX_BAN_MS = 365 * DAY_MS;\n",
    "const OWNER_MAX_BAN_MS = 365 * DAY_MS;\nconst MAX_SUPPORT_NOTE = 300;\n\nfunction normalizeSupportNote(value) {\n  const text = String(value || '')\n    .normalize('NFKC')\n    .replace(/\\s+/g, ' ')\n    .trim();\n  return text.length >= 3 && text.length <= MAX_SUPPORT_NOTE ? text : null;\n}\n\nfunction normalizeRequestedPlayerName(value) {\n  const normalized = String(value || '')\n    .normalize('NFKC')\n    .replace(/\\s+/g, ' ')\n    .trim();\n  if (!normalized || normalized.length > MAX_PLAYER_NAME) return null;\n  return safeAccountName(normalized) === normalized ? normalized : null;\n}\n",
    'support action validation helpers'
)
s = replace_once(
    s,
    "    sanctions = null,\n    auth = null,\n    disconnectAccount = null\n",
    "    sanctions = null,\n    auth = null,\n    accounts = null,\n    disconnectAccount = null,\n    connectionCount = null,\n    revokeReconnectSessions = null\n",
    'admin control constructor args'
)
s = replace_once(
    s,
    "    this.sanctions = sanctions;\n    this.auth = auth;\n    this.disconnectAccount = typeof disconnectAccount === 'function' ? disconnectAccount : null;\n",
    "    this.sanctions = sanctions;\n    this.auth = auth;\n    this.accounts = accounts;\n    this.disconnectAccount = typeof disconnectAccount === 'function' ? disconnectAccount : null;\n    this.connectionCount = typeof connectionCount === 'function' ? connectionCount : null;\n    this.revokeReconnectSessions =\n      typeof revokeReconnectSessions === 'function' ? revokeReconnectSessions : null;\n",
    'admin control support dependencies'
)
s = replace_once(
    s,
    "        sanctions: this.#sanctionContext(profile.account.id, now)\n      }\n    };\n",
    "        sanctions: this.#sanctionContext(profile.account.id, now),\n        live: {\n          sockets: Number(this.connectionCount?.(profile.account.id) || 0)\n        }\n      }\n    };\n",
    'player detail live sockets'
)
anchor = "  moderationQueue({ status = 'open', limit = 50 } = {}) {\n"
methods = """  playerLogout({ targetAccountId, note, actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'operator'].includes(actor.role)) return { ok: false, reason: 'support-action-forbidden' };
    if (!this.auth) return { ok: false, reason: 'player-support-actions-unavailable' };
    const id = String(targetAccountId || '').trim();
    if (!id || !this.statements.accountName.get(id)) return { ok: false, reason: 'unknown-account' };
    const internalNote = normalizeSupportNote(note);
    if (!internalNote) return { ok: false, reason: 'invalid-support-note', maxLength: MAX_SUPPORT_NOTE };

    let revokedSessions = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      revokedSessions = Number(this.auth.revokeAccountSessions(id) || 0);
      this.adminAuth.audit({
        actor,
        action: 'player.support.logout',
        targetType: 'player-account',
        targetId: id,
        detail: { note: internalNote, revokedSessions },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    let revokedSocketTickets = 0;
    let revokedReconnectSessions = 0;
    let disconnectedSockets = 0;
    try {
      revokedSocketTickets = Number(this.auth.revokeAccountSocketTickets?.(id) || 0);
    } catch {}
    try {
      revokedReconnectSessions = Number(this.revokeReconnectSessions?.(id) || 0);
    } catch {}
    try {
      disconnectedSockets = Number(
        this.disconnectAccount?.(id, { code: 4004, reason: 'support-logout' }) || 0
      );
    } catch {}
    return {
      ok: true,
      accountId: id,
      revokedSessions,
      revokedSocketTickets,
      revokedReconnectSessions,
      disconnectedSockets
    };
  }

  playerRename({ targetAccountId, name, note, actor, now = Date.now() } = {}) {
    if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
    if (!['owner', 'moderator'].includes(actor.role)) return { ok: false, reason: 'support-action-forbidden' };
    if (!this.accounts || typeof this.accounts.rename !== 'function') {
      return { ok: false, reason: 'player-support-actions-unavailable' };
    }
    const id = String(targetAccountId || '').trim();
    const account = id ? this.statements.accountName.get(id) : null;
    if (!account) return { ok: false, reason: 'unknown-account' };
    const requestedName = normalizeRequestedPlayerName(name);
    if (!requestedName) {
      return { ok: false, reason: 'invalid-player-name', maxLength: MAX_PLAYER_NAME };
    }
    const internalNote = normalizeSupportNote(note);
    if (!internalNote) return { ok: false, reason: 'invalid-support-note', maxLength: MAX_SUPPORT_NOTE };
    if (account.display_name === requestedName) {
      return { ok: false, reason: 'no-change', name: requestedName };
    }

    let updatedName;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      updatedName = this.accounts.rename(id, requestedName);
      this.adminAuth.audit({
        actor,
        action: 'player.support.rename',
        targetType: 'player-account',
        targetId: id,
        detail: { fromName: account.display_name, toName: updatedName, note: internalNote },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ok: true, accountId: id, previousName: account.display_name, name: updatedName };
  }

"""
s = replace_once(s, anchor, methods + anchor, 'admin control support actions')
s = replace_once(
    s,
    "    adminName: db.prepare('SELECT display_name FROM admin_users WHERE id = ?')\n",
    "    adminName: db.prepare('SELECT display_name FROM admin_users WHERE id = ?'),\n    accountName: db.prepare('SELECT display_name FROM accounts WHERE id = ?')\n",
    'admin control account statement'
)
s = replace_once(
    s,
    "  OWNER_MAX_BAN_MS\n};\n",
    "  OWNER_MAX_BAN_MS,\n  MAX_SUPPORT_NOTE,\n  normalizeSupportNote,\n  normalizeRequestedPlayerName\n};\n",
    'admin control support exports'
)
write(p, s)

# --- server/adminRoutes.js --------------------------------------------------
p = 'server/adminRoutes.js'
s = read(p)
anchor = "  app.post('/api/admin/moderation/queue', json, (req, res) => {\n"
routes = """  app.post('/api/admin/players/logout', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.sessions.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId', 'note'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.playerLogout !== 'function') {
      return res.status(503).json({ ok: false, error: 'player-support-actions-unavailable' });
    }
    const result = control.playerLogout({
      targetAccountId: req.body.accountId,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable'
              ? 503
              : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {})
      });
    }
    return res.json(result);
  });

  app.post('/api/admin/players/rename', json, (req, res) => {
    const resolved = requireAdmin(req, res, 'player-support.name.write');
    if (!resolved) return undefined;
    if (!keysOnly(req.body, new Set(['accountId', 'name', 'note'])) || !req.body?.accountId) {
      return res.status(400).json({ ok: false, error: 'invalid-payload' });
    }
    if (!control || typeof control.playerRename !== 'function') {
      return res.status(503).json({ ok: false, error: 'player-support-actions-unavailable' });
    }
    const result = control.playerRename({
      targetAccountId: req.body.accountId,
      name: req.body.name,
      note: req.body.note,
      actor: resolved.session.user
    });
    if (!result.ok) {
      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable'
              ? 503
              : result.reason === 'no-change'
                ? 409
                : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {})
      });
    }
    return res.json(result);
  });

"""
s = replace_once(s, anchor, routes + anchor, 'support mutation routes')
write(p, s)

# --- server/bootstrap.js ----------------------------------------------------
p = 'server/bootstrap.js'
s = read(p)
s = replace_once(
    s,
    "  sanctions,\n  auth,\n  disconnectAccount: accountId => networkIdentity.disconnectAccount(accountId)\n",
    "  sanctions,\n  auth,\n  accounts: core.accounts,\n  disconnectAccount: (accountId, options) => networkIdentity.disconnectAccount(accountId, options),\n  connectionCount: accountId => networkIdentity.connectionCount(accountId),\n  revokeReconnectSessions: accountId => core.revokeAccountReconnectSessions(accountId)\n",
    'bootstrap support dependencies'
)
write(p, s)

# --- client/admin/index.html -----------------------------------------------
p = 'client/admin/index.html'
s = read(p)
s = replace_once(
    s,
    "              Это безопасная карточка поддержки. Найдите игрока по имени или ID, чтобы проверить его прогресс,\n              активность, достижения, косметику, количество активных входов и связанный социальный контекст.\n",
    "              Это безопасная карточка поддержки. Найдите игрока по имени, ID аккаунта или короткому Support ID,\n              чтобы проверить его прогресс, активность, достижения, косметику, игровые подключения и социальный контекст.\n",
    'player help support id'
)
s = replace_once(
    s,
    "              Панель принципиально не показывает recovery-коды, хеши кодов, session tokens, Google ID или\n              другие данные, с которыми можно войти в аккаунт. История санкций доступна здесь для поддержки, а\n              применять ограничения можно только ролям с отдельным правом модерации.\n",
    "              Панель принципиально не показывает recovery-коды, хеши кодов, session tokens, Google ID или\n              другие данные, с которыми можно войти в аккаунт. Короткие ID сессий ниже не являются токенами.\n              Опасные действия разделены отдельными правами и всегда записываются в журнал.\n",
    'player help safety text'
)
s = replace_once(
    s,
    "                placeholder=\"Например: Malik или UUID аккаунта\"\n",
    "                placeholder=\"Например: Malik, WBL-… или UUID\"\n",
    'support search placeholder'
)
s = replace_once(
    s,
    "                игровых сессий Wobble сейчас не собирает, поэтому панель честно показывает только количество и\n                время сессий.</span\n",
    "                игровых сессий Wobble сейчас не собирает. Панель показывает только безопасные короткие ID и\n                время сессий — они не позволяют войти в аккаунт.</span\n",
    'player explain safe sessions'
)
action_anchor = "            <div id=\"player-summary-cards\" class=\"cards\"></div>\n"
actions = """            <section class="support-actions" aria-labelledby="player-support-actions-title">
              <div class="card-head support-actions-head">
                <div>
                  <p class="eyebrow">ИНСТРУМЕНТЫ ПОДДЕРЖКИ</p>
                  <h3 id="player-support-actions-title">Действия с аккаунтом</h3>
                  <p class="section-help">
                    Support ID безопасно сообщать игроку. Изменяющие действия требуют внутреннюю причину и двойное подтверждение.
                  </p>
                </div>
                <div class="support-id-box">
                  <span class="muted">Support ID</span>
                  <strong id="player-support-id" class="mono">—</strong>
                  <button id="player-copy-support-id" class="ghost" type="button">Скопировать ID</button>
                </div>
              </div>
              <label class="support-note-label">
                Внутренняя причина действия
                <input id="player-support-note" maxlength="300" placeholder="Например: запрос владельца аккаунта" />
              </label>
              <div class="support-action-grid">
                <section id="player-name-actions" class="support-action-box" hidden>
                  <strong>Имя игрока</strong>
                  <p class="muted">Меняет сохранённое имя. Текущий матч не прерывается; новое имя гарантированно применяется в следующей комнате.</p>
                  <input id="player-rename-input" maxlength="16" placeholder="Новое имя" />
                  <div class="support-action-buttons">
                    <button id="player-rename" class="ghost" type="button">Изменить имя</button>
                    <button id="player-reset-name" class="ghost" type="button">Сбросить на Wobbler</button>
                  </div>
                </section>
                <section id="player-session-actions" class="support-action-box danger-zone" hidden>
                  <strong>Сессии и подключения</strong>
                  <p class="muted">Завершает HTTP-сессии, WebSocket tickets, reconnect-сеансы и активные игровые подключения.</p>
                  <button id="player-force-logout" class="danger" type="button">Завершить все сессии</button>
                </section>
              </div>
              <div class="support-action-buttons support-secondary-actions">
                <button id="player-open-moderation" class="ghost" type="button" hidden>Открыть дело модерации</button>
              </div>
              <p id="player-support-action-hint" class="muted"></p>
            </section>
"""
s = replace_once(s, action_anchor, action_anchor + actions, 'support action panel')
s = replace_once(
    s,
    "              <details class=\"support-details\" open>\n                <summary>Санкции и предупреждения</summary>\n                <div id=\"player-sanctions\" class=\"rank-list\"></div>\n              </details>\n",
    "              <details class=\"support-details\" open>\n                <summary>Активные сессии и игровые подключения</summary>\n                <div id=\"player-sessions\" class=\"rank-list\"></div>\n              </details>\n              <details class=\"support-details\" open>\n                <summary>История действий поддержки</summary>\n                <div id=\"player-support-history\" class=\"rank-list\"></div>\n              </details>\n              <details class=\"support-details\" open>\n                <summary>Санкции и предупреждения</summary>\n                <div id=\"player-sanctions\" class=\"rank-list\"></div>\n              </details>\n",
    'support sessions and history sections'
)
write(p, s)

# --- client/admin/admin.css -------------------------------------------------
p = 'client/admin/admin.css'
s = read(p)
anchor = ".player-detail {\n  margin-top: 12px;\n}\n"
css = """.support-actions {
  margin: 12px 0;
  padding: 14px;
  border: 1px solid #303751;
  border-radius: 14px;
  background: rgba(20, 24, 39, 0.82);
}
.support-actions-head {
  margin-bottom: 10px;
}
.support-id-box {
  display: grid;
  gap: 5px;
  justify-items: end;
}
.support-note-label {
  display: grid;
  gap: 6px;
  margin: 10px 0;
}
.support-action-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.support-action-box {
  display: grid;
  align-content: start;
  gap: 8px;
  padding: 12px;
  border: 1px solid #282f47;
  border-radius: 12px;
  background: #111522;
}
.support-action-box p {
  margin: 0;
}
.support-action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.support-secondary-actions {
  margin-top: 10px;
}
.danger-zone {
  border-color: rgba(255, 135, 154, 0.28);
}

"""
s = replace_once(s, anchor, anchor + css, 'support actions css')
s = replace_once(
    s,
    "  .support-search,\n  .support-grid {\n    grid-template-columns: 1fr;\n  }\n",
    "  .support-search,\n  .support-grid,\n  .support-action-grid {\n    grid-template-columns: 1fr;\n  }\n  .support-id-box {\n    justify-items: start;\n  }\n",
    'support mobile actions css'
)
write(p, s)

# --- client/admin/admin.js --------------------------------------------------
p = 'client/admin/admin.js'
s = read(p)
s = replace_once(
    s,
    "  playerDetailRevision: 0,\n  playerSearchQuery: '',\n",
    "  playerDetailRevision: 0,\n  playerSearchQuery: '',\n  playerDetail: null,\n  playerActionConfirmation: null,\n  playerActionTimer: null,\n",
    'support client state'
)
s = replace_once(
    s,
    "  'player.support.view': 'Открыта карточка игрока',\n",
    "  'player.support.view': 'Открыта карточка игрока',\n  'player.support.logout': 'Завершены сессии игрока',\n  'player.support.rename': 'Изменено имя игрока',\n",
    'support audit labels'
)
s = replace_once(
    s,
    "    '#player-partners',\n    '#player-sanctions'\n",
    "    '#player-partners',\n    '#player-sanctions',\n    '#player-sessions',\n    '#player-support-history'\n",
    'support clear list selectors'
)
s = replace_once(
    s,
    "  const name = $('#player-detail-name');\n",
    "  state.playerDetail = null;\n  resetPlayerActionConfirmation();\n  const name = $('#player-detail-name');\n",
    'support clear state'
)
# Insert helpers before hidePlayerDetail.
anchor = "function hidePlayerDetail() {\n"
helpers = """function clearPlayerActionTimer() {
  if (state.playerActionTimer) clearTimeout(state.playerActionTimer);
  state.playerActionTimer = null;
}

function resetPlayerActionConfirmation(message = '') {
  clearPlayerActionTimer();
  state.playerActionConfirmation = null;
  const labels = [
    ['#player-force-logout', 'Завершить все сессии'],
    ['#player-rename', 'Изменить имя'],
    ['#player-reset-name', 'Сбросить на Wobbler']
  ];
  for (const [selector, text] of labels) {
    const button = $(selector);
    if (!button) continue;
    button.disabled = false;
    button.textContent = text;
    button.classList.remove('confirm');
  }
  const hint = $('#player-support-action-hint');
  if (hint && message) hint.textContent = message;
}

function armPlayerAction(key, button, confirmationText) {
  if (state.playerActionConfirmation === key) return true;
  resetPlayerActionConfirmation();
  state.playerActionConfirmation = key;
  button.textContent = confirmationText;
  button.classList.add('confirm');
  $('#player-support-action-hint').textContent = 'Проверьте данные и нажмите ту же кнопку ещё раз в течение 10 секунд.';
  state.playerActionTimer = setTimeout(() => resetPlayerActionConfirmation('Подтверждение истекло.'), 10_000);
  return false;
}

function supportActionNote() {
  const note = $('#player-support-note').value
    .normalize('NFKC')
    .replace(/\\s+/g, ' ')
    .trim();
  if (note.length < 3) {
    setStatus('Укажите внутреннюю причину действия минимум из 3 символов.', 'warn');
    return '';
  }
  return note;
}

function supportHistoryMeta(event) {
  const actor = event.actorName || 'Система';
  const role = ROLE_LABELS[event.actorRole] || event.actorRole || 'system';
  const note = event.detail?.note ? ` · причина: ${event.detail.note}` : '';
  const renamed = event.action === 'player.support.rename'
    ? ` · ${event.detail?.fromName || '—'} → ${event.detail?.toName || '—'}`
    : '';
  return `${formatTime(event.createdAt)} · ${actor} (${role})${renamed}${note}`;
}

async function copyPlayerSupportId() {
  const supportId = state.playerDetail?.account?.supportId;
  if (!supportId) return setStatus('У этого legacy-аккаунта нет короткого Support ID.', 'warn');
  try {
    await navigator.clipboard.writeText(supportId);
    setStatus(`Support ID ${supportId} скопирован`, 'good');
  } catch {
    setStatus(`Не удалось скопировать автоматически. Support ID: ${supportId}`, 'warn');
  }
}

async function forceLogoutPlayer() {
  const player = state.playerDetail;
  if (!player?.account?.id) return;
  const note = supportActionNote();
  if (!note) return;
  const button = $('#player-force-logout');
  const key = `logout:${player.account.id}:${note}`;
  if (!armPlayerAction(key, button, 'Подтвердить завершение всех сессий')) return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/players/logout', { accountId: player.account.id, note });
    resetPlayerActionConfirmation();
    setStatus(
      `Сессии завершены: HTTP ${formatNumber(result.revokedSessions)}, WST ${formatNumber(result.revokedSocketTickets)}, reconnect ${formatNumber(result.revokedReconnectSessions)}, WebSocket ${formatNumber(result.disconnectedSockets)}.`,
      'good'
    );
    await openPlayerDetail(player.account.id, { preserveStatus: true });
  } catch (error) {
    resetPlayerActionConfirmation();
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Не удалось завершить сессии: ${error.message}`, 'bad');
  }
}

async function renamePlayer(name) {
  const player = state.playerDetail;
  if (!player?.account?.id) return;
  const requested = String(name || '').normalize('NFKC').replace(/\\s+/g, ' ').trim();
  if (!requested) return setStatus('Введите новое имя.', 'warn');
  const note = supportActionNote();
  if (!note) return;
  const reset = requested === 'Wobbler';
  const button = reset ? $('#player-reset-name') : $('#player-rename');
  const key = `rename:${player.account.id}:${requested}:${note}`;
  if (!armPlayerAction(key, button, reset ? 'Подтвердить сброс имени' : `Подтвердить имя «${requested}»`)) return;
  button.disabled = true;
  try {
    const result = await api('/api/admin/players/rename', {
      accountId: player.account.id,
      name: requested,
      note
    });
    resetPlayerActionConfirmation();
    setStatus(`Имя изменено: ${result.previousName} → ${result.name}`, 'good');
    await openPlayerDetail(player.account.id, { preserveStatus: true });
  } catch (error) {
    resetPlayerActionConfirmation();
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    const message =
      error.payload?.error === 'invalid-player-name'
        ? 'Имя содержит недопустимые символы или длиннее 16 знаков.'
        : error.payload?.error === 'no-change'
          ? 'Это имя уже установлено.'
          : error.message;
    setStatus(`Не удалось изменить имя: ${message}`, 'bad');
  }
}

function openPlayerModeration() {
  const player = state.playerDetail;
  if (!player?.account?.id || !player.moderation) return;
  openModerationCase(player.account.id);
}

"""
s = replace_once(s, anchor, helpers + anchor, 'support client action helpers')
s = replace_once(
    s,
    "function hidePlayerDetail() {\n  state.playerDetailRevision += 1;\n  $('#player-detail').hidden = true;\n}\n",
    "function hidePlayerDetail() {\n  state.playerDetailRevision += 1;\n  state.playerDetail = null;\n  resetPlayerActionConfirmation();\n  $('#player-detail').hidden = true;\n}\n",
    'hide support detail state'
)
s = replace_once(
    s,
    "  const sanctions = player.sanctions || { active: null, history: [] };\n",
    "  const sanctions = player.sanctions || { active: null, history: [] };\n  const live = player.live || {};\n  state.playerDetail = player;\n  resetPlayerActionConfirmation();\n",
    'support render live state'
)
s = replace_once(
    s,
    "  $('#player-detail-name').textContent = account.name || 'Wobbler';\n  $('#player-detail-id').textContent = `ID аккаунта: ${account.id}`;\n",
    "  $('#player-detail-name').textContent = account.name || 'Wobbler';\n  $('#player-detail-id').textContent = `ID аккаунта: ${account.id}`;\n  $('#player-support-id').textContent = account.supportId || 'legacy — недоступен';\n  $('#player-copy-support-id').disabled = !account.supportId;\n  $('#player-support-note').value = '';\n  $('#player-rename-input').value = account.name || 'Wobbler';\n  $('#player-name-actions').hidden = !state.capabilities.has('player-support.name.write');\n  $('#player-session-actions').hidden = !state.capabilities.has('player-support.sessions.write');\n  const moderationButton = $('#player-open-moderation');\n  moderationButton.hidden = !(state.capabilities.has('moderation.read') && moderation);\n",
    'support render action controls'
)
s = replace_once(
    s,
    "    statCard('Активных входов', formatNumber(sessions.active), 'только количество, без token/IP'),\n",
    "    statCard(\n      'Активных входов',\n      formatNumber(sessions.active),\n      `${formatNumber(live.sockets)} игровых WebSocket сейчас`\n    ),\n",
    'support live socket card'
)
s = replace_once(
    s,
    "    ['Создан', formatTime(account.createdAt)],\n",
    "    ['Support ID', account.supportId || 'legacy — недоступен'],\n    ['Создан', formatTime(account.createdAt)],\n",
    'support id account details'
)
s = replace_once(
    s,
    "  renderPlayerSanctions(sanctions);\n",
    "  renderSimpleList(\n    '#player-sessions',\n    login.sessionList,\n    row => [\n      `Сессия ${row.id}`,\n      `создана ${formatTime(row.createdAt)} · активность ${formatTime(row.lastSeenAt)} · истекает ${formatTime(row.expiresAt)}`\n    ],\n    'Активных HTTP-сессий нет.'\n  );\n  if (Number(live.sockets || 0) > 0) {\n    playerListItem(\n      $('#player-sessions'),\n      `Игровые WebSocket: ${formatNumber(live.sockets)}`,\n      'Показывается только количество; сетевые адреса панель не раскрывает.'\n    );\n  }\n  renderSimpleList(\n    '#player-support-history',\n    player.supportHistory,\n    event => [AUDIT_ACTION_LABELS[event.action] || event.action, supportHistoryMeta(event)],\n    'Изменяющих действий поддержки по этому аккаунту ещё не было.'\n  );\n  renderPlayerSanctions(sanctions);\n",
    'support sessions and history render'
)
s = replace_once(
    s,
    "async function openPlayerDetail(accountId) {\n",
    "async function openPlayerDetail(accountId, { preserveStatus = false } = {}) {\n",
    'open player detail options'
)
s = replace_once(
    s,
    "    renderPlayerDetail(payload.player);\n    setStatus('Карточка игрока загружена', 'good');\n",
    "    renderPlayerDetail(payload.player);\n    if (!preserveStatus) setStatus('Карточка игрока загружена', 'good');\n",
    'preserve support action status'
)
s = replace_once(
    s,
    "      `${player.name} · ${player.id}`,\n",
    "      `${player.name} · ${player.supportId ? `${player.supportId} · ` : ''}${player.id}`,\n",
    'support id search result UI'
)
s = replace_once(
    s,
    "$('#player-detail-close').addEventListener('click', hidePlayerDetail);\n",
    "$('#player-detail-close').addEventListener('click', hidePlayerDetail);\n$('#player-copy-support-id').addEventListener('click', copyPlayerSupportId);\n$('#player-force-logout').addEventListener('click', forceLogoutPlayer);\n$('#player-rename').addEventListener('click', () => renamePlayer($('#player-rename-input').value));\n$('#player-reset-name').addEventListener('click', () => renamePlayer('Wobbler'));\n$('#player-open-moderation').addEventListener('click', openPlayerModeration);\n$('#player-support-note').addEventListener('input', () => resetPlayerActionConfirmation());\n$('#player-rename-input').addEventListener('input', () => resetPlayerActionConfirmation());\n",
    'support action event listeners'
)
write(p, s)

# --- server/adminPlayerSupport.test.mjs ------------------------------------
p = 'server/adminPlayerSupport.test.mjs'
s = read(p)
s = replace_once(
    s,
    "const { AdminPlayerSupport, normalizeSearchQuery, ftsPrefixQuery } = require('./adminPlayerSupport');\n",
    "const {\n  AdminPlayerSupport,\n  normalizeSearchQuery,\n  ftsPrefixQuery,\n  supportIdForAccount\n} = require('./adminPlayerSupport');\n",
    'support test helper import'
)
s = replace_once(
    s,
    "  insertAccount.run('other-player', 'Игорь', 'OTHER-HASH', 3000, 20_000, null, null);\n",
    "  insertAccount.run('other-player', 'Игорь', 'OTHER-HASH', 3000, 20_000, null, null);\n  insertAccount.run(\n    '12345678-90ab-cdef-1234-567890abcdef',\n    'Диагностика',\n    'UUID-HASH',\n    3500,\n    21_000,\n    null,\n    null\n  );\n",
    'support id test account'
)
s = replace_once(
    s,
    "  db.prepare(\n    `INSERT INTO social_reports\n      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,\n       last_reported_at, target_name_snapshot, chapter_id_snapshot)\n     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`\n  ).run('player-main', 'partner-one', 'afk', 1, 43_000, 43_000, 'Напарник', 'ch3');\n\n  return { db, now, support: new AdminPlayerSupport({ db }) };\n",
    "  db.prepare(\n    `INSERT INTO social_reports\n      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,\n       last_reported_at, target_name_snapshot, chapter_id_snapshot)\n     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`\n  ).run('player-main', 'partner-one', 'afk', 1, 43_000, 43_000, 'Напарник', 'ch3');\n\n  db.prepare(\n    `INSERT INTO admin_audit_events\n      (admin_user_id, actor_name, actor_role, action, target_type, target_id, detail_json, created_at)\n     VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`\n  ).run(\n    'Support Agent',\n    'operator',\n    'player.support.logout',\n    'player-account',\n    'player-main',\n    JSON.stringify({ note: 'Проверка поддержки', revokedSessions: 1 }),\n    49_000\n  );\n\n  return { db, now, support: new AdminPlayerSupport({ db }) };\n",
    'support history test seed'
)
s = replace_once(
    s,
    "  assert.equal(profile.login.sessions.latestSeenAt, 48_000);\n",
    "  assert.equal(profile.login.sessions.latestSeenAt, 48_000);\n  assert.deepEqual(profile.login.sessionList, [\n    { id: 'SECRET-ACTIVE-SESSION-H', createdAt: 10_000, lastSeenAt: 48_000, expiresAt: 80_000 }\n  ]);\n",
    'support safe session assertion'
)
s = replace_once(
    s,
    "  assert.equal(profile.social.reportsSubmitted, 1);\n",
    "  assert.equal(profile.social.reportsSubmitted, 1);\n  assert.equal(profile.supportHistory[0].action, 'player.support.logout');\n  assert.equal(profile.supportHistory[0].detail.note, 'Проверка поддержки');\n",
    'support history assertion'
)
s = replace_once(
    s,
    "  assert.equal(ftsPrefixQuery('Иван игрок'), '\"Иван\"* AND \"игрок\"*');\n",
    "  assert.equal(ftsPrefixQuery('Иван игрок'), '\"Иван\"* AND \"игрок\"*');\n  assert.equal(\n    supportIdForAccount('12345678-90ab-cdef-1234-567890abcdef'),\n    'WBL-1234567890AB'\n  );\n  assert.deepEqual(\n    support.search('WBL-1234567890AB', { now }).results.map(item => item.id),\n    ['12345678-90ab-cdef-1234-567890abcdef']\n  );\n",
    'support id search assertions'
)
write(p, s)

# --- server/adminPlayerSupportRoutes.test.mjs ------------------------------
p = 'server/adminPlayerSupportRoutes.test.mjs'
s = read(p)
s = replace_once(
    s,
    "const { migrateDatabase } = require('./migrations');\n",
    "const { migrateDatabase } = require('./migrations');\nconst { Accounts } = require('./accounts');\nconst { AuthService } = require('./auth');\n",
    'support routes account/auth imports'
)
s = replace_once(
    s,
    "  const adminAuth = new AdminAuthService({ db });\n  const control = new AdminControlService({\n    db,\n    adminAuth,\n    health: () => ({ ok: true }),\n    gameplay: { summary: () => ({ days: 7, from: '2026-08-01', dropped: 0, rows: [] }) }\n  });\n",
    "  const accounts = new Accounts({ db });\n  const auth = new AuthService({ db });\n  const disconnected = [];\n  const reconnectRevocations = [];\n  const adminAuth = new AdminAuthService({ db });\n  const control = new AdminControlService({\n    db,\n    adminAuth,\n    accounts,\n    auth,\n    disconnectAccount: (accountId, options) => {\n      disconnected.push({ accountId, options });\n      return accountId === 'support-player' ? 2 : 0;\n    },\n    connectionCount: accountId => (accountId === 'support-player' ? 2 : 0),\n    revokeReconnectSessions: accountId => {\n      reconnectRevocations.push(accountId);\n      return accountId === 'support-player' ? 1 : 0;\n    },\n    health: () => ({ ok: true }),\n    gameplay: { summary: () => ({ days: 7, from: '2026-08-01', dropped: 0, rows: [] }) }\n  });\n",
    'support routes dependencies'
)
s = replace_once(
    s,
    "  return { db, adminAuth, app };\n",
    "  return { db, adminAuth, app, auth, accounts, disconnected, reconnectRevocations };\n",
    'support routes test return dependencies'
)
s = replace_once(
    s,
    "test('owner and operator can inspect player support while moderator cannot', async t => {\n",
    "test('owner, operator and moderator can inspect player support while viewer cannot', async t => {\n",
    'support routes read RBAC title'
)
s = replace_once(
    s,
    "  assert.equal(hasCapability('owner', 'player-support.read'), true);\n  assert.equal(hasCapability('operator', 'player-support.read'), true);\n  assert.equal(hasCapability('moderator', 'player-support.read'), false);\n",
    "  assert.equal(hasCapability('owner', 'player-support.read'), true);\n  assert.equal(hasCapability('operator', 'player-support.read'), true);\n  assert.equal(hasCapability('moderator', 'player-support.read'), true);\n  assert.equal(hasCapability('operator', 'player-support.sessions.write'), true);\n  assert.equal(hasCapability('operator', 'player-support.name.write'), false);\n  assert.equal(hasCapability('moderator', 'player-support.sessions.write'), false);\n  assert.equal(hasCapability('moderator', 'player-support.name.write'), true);\n",
    'support routes capability assertions'
)
s = replace_once(
    s,
    "  const moderator = await login(base, adminAuth, 'moderator');\n  const forbidden = await post(base, '/api/admin/players/search', moderator, { query: 'Support' });\n  assert.equal(forbidden.status, 403);\n",
    "  const moderator = await login(base, adminAuth, 'moderator');\n  const moderatorSearch = await post(base, '/api/admin/players/search', moderator, { query: 'Support' });\n  assert.equal(moderatorSearch.status, 200);\n\n  const viewer = await login(base, adminAuth, 'viewer');\n  const forbidden = await post(base, '/api/admin/players/search', viewer, { query: 'Support' });\n  assert.equal(forbidden.status, 403);\n",
    'support routes viewer RBAC'
)
append = r'''

test('support actions enforce split capabilities, revoke every login path and audit mutations', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const sessionA = auth.createSession('support-player', 10_000);
  const sessionB = auth.createSession('support-player', 10_100);
  const ticket = auth.createSocketTicket('support-player', 10_200);
  assert.ok(sessionA && sessionB && ticket);

  const operator = await login(base, adminAuth, 'operator');
  const logout = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Игрок попросил завершить все входы'
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), {
    ok: true,
    accountId: 'support-player',
    revokedSessions: 2,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2
  });
  assert.equal(auth.resolveSession(sessionA.token, 10_300), null);
  assert.equal(auth.resolveSession(sessionB.token, 10_300), null);
  assert.equal(auth.consumeSocketTicket(ticket.token, 10_300), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected[0].accountId, 'support-player');
  assert.equal(disconnected[0].options.reason, 'support-logout');

  const logoutAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.ok(logoutAudit);
  assert.equal(logoutAudit.detail.note, 'Игрок попросил завершить все входы');
  assert.equal(logoutAudit.detail.revokedSessions, 2);

  const moderator = await login(base, adminAuth, 'moderator');
  const moderatorLogout = await post(base, '/api/admin/players/logout', moderator, {
    accountId: 'support-player',
    note: 'Не должно пройти'
  });
  assert.equal(moderatorLogout.status, 403);

  const operatorRename = await post(base, '/api/admin/players/rename', operator, {
    accountId: 'support-player',
    name: 'Clean Name',
    note: 'Не должно пройти'
  });
  assert.equal(operatorRename.status, 403);

  const rename = await post(base, '/api/admin/players/rename', moderator, {
    accountId: 'support-player',
    name: 'Clean Name',
    note: 'Исправлено имя по жалобе'
  });
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).name, 'Clean Name');
  assert.equal(db.prepare('SELECT display_name FROM accounts WHERE id = ?').get('support-player').display_name, 'Clean Name');

  const invalidName = await post(base, '/api/admin/players/rename', moderator, {
    accountId: 'support-player',
    name: '<script>',
    note: 'Проверка валидации'
  });
  assert.equal(invalidName.status, 400);
  assert.equal((await invalidName.json()).error, 'invalid-player-name');

  const renameAudit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.rename');
  assert.ok(renameAudit);
  assert.equal(renameAudit.detail.fromName, 'Support Player');
  assert.equal(renameAudit.detail.toName, 'Clean Name');
  assert.equal(renameAudit.detail.note, 'Исправлено имя по жалобе');
});
'''
s += append
write(p, s)

# --- server/networkIdentity.test.mjs ---------------------------------------
p = 'server/networkIdentity.test.mjs'
s = read(p)
s += r'''

test('connectionCount exposes only the number of tracked sockets for support diagnostics', () => {
  const identity = new NetworkIdentity();
  const first = {};
  const second = {};
  identity.trackSocket(first, 'acc-support');
  identity.trackSocket(second, 'acc-support');
  identity.trackSocket({}, 'other');
  assert.equal(identity.connectionCount('acc-support'), 2);
  identity.untrackSocket(first, 'acc-support');
  assert.equal(identity.connectionCount('acc-support'), 1);
  assert.equal(identity.connectionCount('missing'), 0);
});
'''
write(p, s)

print('PR75 patch applied')
