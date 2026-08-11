from pathlib import Path


def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


Path("server/migrations/010_recovery_rotation.js").write_text("""module.exports = {
  version: 10,
  sql: `
    ALTER TABLE accounts ADD COLUMN pending_secret_hash TEXT;
    ALTER TABLE accounts ADD COLUMN pending_secret_created_at INTEGER;
  `
};
""")

replace_once(
    "server/migrations/index.js",
    "const moderationWorkflow = require('./009_moderation_workflow');\n",
    "const moderationWorkflow = require('./009_moderation_workflow');\nconst recoveryRotation = require('./010_recovery_rotation');\n"
)
replace_once(
    "server/migrations/index.js",
    "  directionalAvoids,\n  moderationWorkflow\n]);",
    "  directionalAvoids,\n  moderationWorkflow,\n  recoveryRotation\n]);"
)

Path("server/accountSelfService.js").write_text("""'use strict';

const crypto = require('crypto');
const { generateCode, normalizeCode } = require('./accounts');

const RECOVERY_ROTATION_TTL_MS = 15 * 60 * 1000;

function recoveryHash(secret) {
  const normalized = normalizeCode(secret);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

class AccountSelfService {
  constructor({ db, auth, rotationTtlMs = RECOVERY_ROTATION_TTL_MS } = {}) {
    if (!db) throw new Error('AccountSelfService требует открытую базу');
    if (!auth) throw new Error('AccountSelfService требует AuthService');
    this.db = db;
    this.auth = auth;
    this.rotationTtlMs = rotationTtlMs;
    this.account = db.prepare(`
      SELECT id, secret_hash, pending_secret_hash, pending_secret_created_at
      FROM accounts
      WHERE id = ?
    `);
    this.prepare = db.prepare(`
      UPDATE accounts
      SET pending_secret_hash = ?, pending_secret_created_at = ?
      WHERE id = ?
    `);
    this.clearPending = db.prepare(`
      UPDATE accounts
      SET pending_secret_hash = NULL, pending_secret_created_at = NULL
      WHERE id = ? AND pending_secret_hash = ?
    `);
    this.promote = db.prepare(`
      UPDATE accounts
      SET
        secret_hash = pending_secret_hash,
        pending_secret_hash = NULL,
        pending_secret_created_at = NULL,
        last_seen_at = ?
      WHERE id = ? AND pending_secret_hash = ?
    `);
  }

  prepareRecoveryCode({ accountId, now = Date.now() } = {}) {
    const id = String(accountId || '');
    if (!id || !this.account.get(id)) return null;
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const secret = generateCode();
    const hash = recoveryHash(secret);
    if (!hash) throw new Error('Не удалось подготовить новый recovery code');
    this.prepare.run(hash, at, id);
    return { secret, expiresAt: at + this.rotationTtlMs };
  }

  confirmRecoveryCode({ accountId, currentToken, secret, now = Date.now() } = {}) {
    const id = String(accountId || '');
    const hash = recoveryHash(secret);
    if (!id) return { ok: false, reason: 'invalid-account' };
    if (!hash) return { ok: false, reason: 'invalid-code' };
    const at = Number.isFinite(now) && now >= 0 ? Math.round(now) : Date.now();
    const row = this.account.get(id);
    if (!row) return { ok: false, reason: 'unknown-account' };

    // Повтор confirm после потерянного HTTP-ответа безопасен: если новый hash уже активен,
    // клиенту достаточно получить подтверждение, ничего повторно менять не нужно.
    if (row.secret_hash === hash) {
      return { ok: true, confirmed: true, alreadyConfirmed: true, revokedSessions: 0 };
    }

    if (!row.pending_secret_hash) return { ok: false, reason: 'rotation-not-prepared' };
    if (row.pending_secret_hash !== hash) return { ok: false, reason: 'rotation-mismatch' };
    const preparedAt = Number(row.pending_secret_created_at || 0);
    if (!preparedAt || at - preparedAt > this.rotationTtlMs) {
      this.clearPending.run(id, hash);
      return { ok: false, reason: 'rotation-expired' };
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const promoted = this.promote.run(at, id, hash).changes;
      if (promoted !== 1) {
        this.db.exec('ROLLBACK');
        return { ok: false, reason: 'rotation-mismatch' };
      }
      const revokedSessions = this.auth.revokeOtherSessions(id, currentToken, at);
      this.db.exec('COMMIT');
      return {
        ok: true,
        confirmed: true,
        alreadyConfirmed: false,
        revokedSessions
      };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = {
  AccountSelfService,
  RECOVERY_ROTATION_TTL_MS,
  recoveryHash
};
""")

old_route = """  app.post('/api/auth/recovery/rotate', json, (req, res) => {
    const session = requireSession(req, res);
    if (!session) return undefined;
    const rotated = selfService.rotateRecoveryCode({
      accountId: session.accountId,
      currentToken: tokenFrom(req)
    });
    if (!rotated) return res.status(404).json({ ok: false, error: 'unknown-account' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ ok: true, ...rotated });
  });
"""
new_route = """  app.post('/api/auth/recovery/rotate/prepare', json, (req, res) => {
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
"""
replace_once("server/authRoutes.js", old_route, new_route)

replace_once(
    "client/core/account.js",
    """export function writeAccounts(state, storage) {
  const store = storageOf(storage);
  if (!store) return state;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Переполненное хранилище не должно ломать вход.
  }
  return state;
}
""",
    """function persistAccounts(state, storage) {
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function writeAccounts(state, storage) {
  // Старые call sites ожидают state даже при недоступном storage. Операции безопасности ниже
  // используют отдельные checked helpers и никогда не считают молчаливый отказ успешной записью.
  persistAccounts(state, storage);
  return state;
}
"""
)

replace_once(
    "client/core/account.js",
    """export function forgetAccount(id, storage) {
  const state = readAccounts(storage);
  state.accounts = state.accounts.filter(a => a.id !== id);
  if (state.current === id) state.current = state.accounts[0]?.id || null;
  return writeAccounts(state, storage);
}
""",
    """export function forgetAccountChecked(id, storage) {
  const state = readAccounts(storage);
  state.accounts = state.accounts.filter(a => a.id !== id);
  if (state.current === id) state.current = state.accounts[0]?.id || null;
  const wrote = persistAccounts(state, storage);
  const saved = readAccounts(storage);
  return {
    persisted: wrote && !saved.accounts.some(account => account.id === id),
    state: saved
  };
}

export function forgetAccount(id, storage) {
  return forgetAccountChecked(id, storage).state;
}

export function stageRecoveryCode(accountId, secret, expiresAt, storage) {
  const state = readAccounts(storage);
  const account = state.accounts.find(item => item.id === accountId);
  if (!account || typeof secret !== 'string' || !secret) {
    return { persisted: false, state };
  }
  account.pendingRecovery = {
    secret,
    expiresAt: Number.isFinite(Number(expiresAt)) ? Number(expiresAt) : 0
  };
  const wrote = persistAccounts(state, storage);
  const saved = readAccounts(storage);
  const staged = saved.accounts.find(item => item.id === accountId)?.pendingRecovery;
  return {
    persisted: wrote && staged?.secret === secret,
    state: saved
  };
}

export function commitStagedRecoveryCode(accountId, storage) {
  const state = readAccounts(storage);
  const account = state.accounts.find(item => item.id === accountId);
  const secret = account?.pendingRecovery?.secret;
  if (!account || !secret) return { persisted: false, state, secret: null };
  account.secret = secret;
  delete account.pendingRecovery;
  const wrote = persistAccounts(state, storage);
  const saved = readAccounts(storage);
  const stored = saved.accounts.find(item => item.id === accountId);
  return {
    persisted: wrote && stored?.secret === secret && !stored.pendingRecovery,
    state: saved,
    secret
  };
}

export function discardStagedRecoveryCode(accountId, storage) {
  const state = readAccounts(storage);
  const account = state.accounts.find(item => item.id === accountId);
  if (!account?.pendingRecovery) return { persisted: true, state };
  delete account.pendingRecovery;
  const wrote = persistAccounts(state, storage);
  const saved = readAccounts(storage);
  return {
    persisted: wrote && !saved.accounts.find(item => item.id === accountId)?.pendingRecovery,
    state: saved
  };
}
"""
)

replace_once(
    "client/core/account.js",
    """export async function rotateRecoveryCode(options) {
  const { ok, data } = await post('/api/auth/recovery/rotate', {}, options);
  return ok && typeof data?.secret === 'string' ? data : null;
}
""",
    """export async function prepareRecoveryCode(options) {
  const { ok, data } = await post('/api/auth/recovery/rotate/prepare', {}, options);
  return ok && typeof data?.secret === 'string' ? data : null;
}

export async function confirmRecoveryCode(secret, options) {
  const { ok, status, data } = await post('/api/auth/recovery/rotate/confirm', { secret }, options);
  if (ok) return { ok: true, ...data };
  return { ok: false, status, error: data?.error || 'confirm-failed' };
}
"""
)

old_ensure = """  const session = await quiet(() => sessionAccount(options));
  const sessionMatchesSelection = session && !session.missing && (!stored || stored.id === session.id);
  if (sessionMatchesSelection) {
    const secret = stored?.id === session.id ? stored.secret : '';
    const account = { ...session, ...(secret ? { secret } : {}) };
    rememberAccount(account, storage);
    return {
      account,
      records: session.records,
      progress: session.progress,
      online: true
    };
  }

  if (stored?.secret) {
    const entered = await quiet(() => loginAccount(stored.secret, options));
    if (entered?.unknown) {
      forgetAccount(stored.id, storage);
    } else if (entered) {
      const account = { ...entered, secret: stored.secret };
      rememberAccount(account, storage);
      return {
        account,
        records: entered.records,
        progress: entered.progress,
        online: true
      };
    } else {
      return { account: stored, records: [], online: false };
    }
  } else if (stored) {
    return { account: stored, records: [], online: false };
  }
"""
new_ensure = """  const session = await quiet(() => sessionAccount(options));
  const sessionMatchesSelection = session && !session.missing && (!stored || stored.id === session.id);
  if (sessionMatchesSelection) {
    const secret = stored?.id === session.id ? stored.secret : '';
    const pendingRecovery = stored?.id === session.id ? stored.pendingRecovery : null;
    const account = {
      ...session,
      ...(secret ? { secret } : {}),
      ...(pendingRecovery ? { pendingRecovery } : {})
    };
    rememberAccount(account, storage);
    return {
      account,
      records: session.records,
      progress: session.progress,
      online: true
    };
  }

  // Если confirm успел закоммититься, но его HTTP-ответ потерялся, active cookie мог исчезнуть
  // позже. Тогда сначала пробуем staged code. Старый code не удаляется, пока сервер не подтвердит
  // новый, поэтому при отказе staged code можно безопасно вернуться к прежнему.
  if (stored?.pendingRecovery?.secret) {
    const stagedSecret = stored.pendingRecovery.secret;
    const entered = await quiet(() => loginAccount(stagedSecret, options));
    if (entered && !entered.unknown) {
      commitStagedRecoveryCode(stored.id, storage);
      const account = { ...entered, secret: stagedSecret };
      rememberAccount(account, storage);
      return {
        account,
        records: entered.records,
        progress: entered.progress,
        online: true
      };
    }
    if (!entered) return { account: stored, records: [], online: false };
  }

  if (stored?.secret) {
    const entered = await quiet(() => loginAccount(stored.secret, options));
    if (entered?.unknown) {
      forgetAccount(stored.id, storage);
    } else if (entered) {
      if (stored.pendingRecovery) discardStagedRecoveryCode(stored.id, storage);
      const account = { ...entered, secret: stored.secret };
      rememberAccount(account, storage);
      return {
        account,
        records: entered.records,
        progress: entered.progress,
        online: true
      };
    } else {
      return { account: stored, records: [], online: false };
    }
  } else if (stored) {
    return { account: stored, records: [], online: false };
  }
"""
replace_once("client/core/account.js", old_ensure, new_ensure)

replace_once(
    "client/core/AccountFlow.js",
    "  equipAccountCosmetic,\n  forgetAccount,\n  listAccountSessions,",
    "  equipAccountCosmetic,\n  forgetAccountChecked,\n  listAccountSessions,"
)
replace_once(
    "client/core/AccountFlow.js",
    "  revokeOtherAccountSessions,\n  rotateRecoveryCode,\n  sessionAccount,",
    "  revokeOtherAccountSessions,\n  prepareRecoveryCode,\n  confirmRecoveryCode,\n  stageRecoveryCode,\n  commitStagedRecoveryCode,\n  discardStagedRecoveryCode,\n  sessionAccount,"
)
replace_once(
    "client/core/AccountFlow.js",
    "'Старый код сразу перестанет работать, а остальные постоянные сеансы будут завершены.'",
    "'Новый код сначала будет сохранён на этом устройстве; после подтверждения старый перестанет работать, а остальные сеансы будут завершены.'"
)

old_rotate = """  async rotateRecovery() {
    if (!this.online || !this.game.ui.account) return null;
    this.security.rotate.disabled = true;
    try {
      const result = await rotateRecoveryCode();
      if (!result?.secret) return this.game.ui.accountStatus('Не удалось заменить код восстановления.');
      const next = { ...this.game.ui.account, secret: result.secret };
      rememberAccount(next);
      this.game.ui.setAccount(next, { online: true });
      this.game.ui.setAccountList(listAccounts());
      const code = document.querySelector('#accountCode');
      const value = document.querySelector('#accountCodeValue');
      code?.classList.remove('hidden');
      if (value) value.textContent = result.secret;
      this.resetSecurityConfirmations();
      this.game.ui.accountStatus(
        `Новый код готов. Старый больше не работает. Завершено других сеансов: ${Number(
          result.revokedSessions || 0
        )}.`
      );
      await this.refreshSessions();
      return result;
    } catch {
      this.game.ui.accountStatus('Не удалось заменить код восстановления.');
      return null;
    } finally {
      if (this.security?.rotate?.isConnected) this.security.rotate.disabled = false;
    }
  }
"""
new_rotate = """  showRecoveryCode(secret) {
    const code = document.querySelector('#accountCode');
    const value = document.querySelector('#accountCodeValue');
    code?.classList.remove('hidden');
    if (value) value.textContent = secret;
  }

  async resumePendingRecovery() {
    const stored = accountForRecords();
    const pending = stored?.pendingRecovery;
    if (!this.online || !stored?.id || !pending?.secret) return null;
    const accountId = stored.id;
    try {
      const result = await confirmRecoveryCode(pending.secret);
      if (result?.ok) {
        const committed = commitStagedRecoveryCode(accountId);
        if (this.game.ui.account?.id === accountId) {
          const next = { ...this.game.ui.account, secret: pending.secret };
          delete next.pendingRecovery;
          this.game.ui.setAccount(next, { online: true });
          this.game.ui.setAccountList(listAccounts());
          this.showRecoveryCode(pending.secret);
          this.game.ui.accountStatus(
            committed.persisted
              ? 'Смена кода восстановления завершена после повторного подключения.'
              : 'Новый код уже активен на сервере, но браузер не смог обновить локальную запись. Сохраните показанный код вручную.'
          );
          await this.refreshSessions();
        }
        return result;
      }

      if (['rotation-expired', 'rotation-mismatch', 'rotation-not-prepared'].includes(result?.error)) {
        discardStagedRecoveryCode(accountId);
        if (this.game.ui.account?.id === accountId) {
          this.game.ui.accountStatus('Незавершённая смена кода отменена; прежний код остался действующим.');
        }
      }
      return null;
    } catch {
      if (this.game.ui.account?.id === accountId) {
        this.game.ui.accountStatus(
          'Смена кода ожидает подтверждения сервера. Старый и подготовленный новый код сохранены на устройстве; повторим автоматически.'
        );
      }
      return null;
    }
  }

  async rotateRecovery() {
    const initiatingAccount = this.game.ui.account;
    if (!this.online || !initiatingAccount?.id) return null;
    const accountId = initiatingAccount.id;
    const revision = this.profileRevision;
    this.security.rotate.disabled = true;
    try {
      const prepared = await prepareRecoveryCode();
      if (!prepared?.secret) return this.game.ui.accountStatus('Не удалось подготовить новый код восстановления.');

      // Prepare ничего не инвалидирует. Если игрок успел переключиться, просто оставляем server-side
      // pending hash истечь: секрет другого аккаунта никогда не попадёт в текущую запись.
      if (revision !== this.profileRevision || this.game.ui.account?.id !== accountId) return null;

      const staged = stageRecoveryCode(accountId, prepared.secret, prepared.expiresAt);
      if (!staged.persisted) {
        this.game.ui.accountStatus(
          'Браузер не смог безопасно сохранить новый код. Смена отменена, прежний код продолжает работать.'
        );
        return null;
      }

      let result;
      try {
        result = await confirmRecoveryCode(prepared.secret);
      } catch {
        this.resetSecurityConfirmations();
        this.game.ui.accountStatus(
          'Ответ подтверждения потерян. Старый и подготовленный новый код сохранены; Wobble повторит подтверждение при следующем подключении.'
        );
        return { pending: true };
      }

      if (!result?.ok) {
        if (['rotation-expired', 'rotation-mismatch', 'rotation-not-prepared'].includes(result?.error)) {
          discardStagedRecoveryCode(accountId);
        }
        this.game.ui.accountStatus('Смена кода не подтверждена; прежний код остался действующим.');
        return null;
      }

      const committed = commitStagedRecoveryCode(accountId);
      const stillCurrent = revision === this.profileRevision && this.game.ui.account?.id === accountId;
      if (stillCurrent) {
        const next = { ...this.game.ui.account, secret: prepared.secret };
        delete next.pendingRecovery;
        this.game.ui.setAccount(next, { online: true });
        this.game.ui.setAccountList(listAccounts());
        this.showRecoveryCode(prepared.secret);
        this.resetSecurityConfirmations();
        this.game.ui.accountStatus(
          committed.persisted
            ? `Новый код готов. Старый больше не работает. Завершено других сеансов: ${Number(
                result.revokedSessions || 0
              )}.`
            : 'Новый код уже активен, но браузер не смог обновить локальную запись. Сохраните показанный код вручную.'
        );
        await this.refreshSessions();
      }
      return result;
    } catch {
      if (this.game.ui.account?.id === accountId) {
        this.game.ui.accountStatus('Не удалось заменить код восстановления.');
      }
      return null;
    } finally {
      if (this.security?.rotate?.isConnected) this.security.rotate.disabled = false;
    }
  }
"""
replace_once("client/core/AccountFlow.js", old_rotate, new_rotate)

replace_once(
    "client/core/AccountFlow.js",
    """      forgetAccount(account.id);
      this.networkTicket = null;
      const remaining = listAccounts();
""",
    """      const forgotten = forgetAccountChecked(account.id);
      this.networkTicket = null;
      if (!forgotten.persisted) {
        this.records = new Map();
        this.apply(null, { online: false, records: [], progress: null });
        this.game.ui.setAccountList([]);
        this.game.ui.accountStatus(
          'Сеанс на сервере завершён, но браузер не смог удалить сохранённый recovery code. Не перезагружайте страницу: очистите данные сайта вручную перед уходом.'
        );
        return false;
      }
      const remaining = listAccounts();
"""
)

replace_once(
    "client/core/AccountFlow.js",
    """    this.updateSelfService(account, this.online);
    if (this.online) this.refreshSessions();
""",
    """    this.updateSelfService(account, this.online);
    if (this.online) {
      this.refreshSessions();
      if (account?.pendingRecovery?.secret) this.resumePendingRecovery();
    }
"""
)

Path("server/accountSelfService.test.mjs").write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { AuthService, SESSION_COOKIE, hashToken, publicSessionId } = require('./auth');
const { AccountSelfService, RECOVERY_ROTATION_TTL_MS } = require('./accountSelfService');
const { installAuthRoutes } = require('./authRoutes');

function fresh() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const auth = new AuthService({ db });
  const selfService = new AccountSelfService({ db, auth });
  return { db, accounts, auth, selfService };
}

async function listen(app) {
  const server = await new Promise(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function cookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

function install(app, context) {
  return installAuthRoutes({
    app,
    accounts: context.accounts,
    auth: context.auth,
    google: { enabled: false, clientId: null },
    secureCookies: false,
    accountPayload: account => ({
      ok: true,
      account: { id: account.id, name: account.name },
      records: [],
      progress: null,
      profile: null,
      inventory: null
    })
  });
}

test('session self-service exposes opaque ids and can revoke only another session', () => {
  const context = fresh();
  const account = context.accounts.create('Devices');
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const other = context.auth.createSession(account.id, now + 10);

  const sessions = context.auth.listSessions(account.id, current.token, now + 20);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.match(sessions[0].id, /^[a-f0-9]{24}$/);
  assert.equal(sessions[0].id, publicSessionId(hashToken(current.token)));
  assert.equal(sessions.some(item => item.id === current.token), false, 'raw bearer never leaves AuthService');

  assert.deepEqual(
    context.auth.revokeAccountSession({
      accountId: account.id,
      sessionId: sessions[0].id,
      currentToken: current.token
    }),
    { ok: false, reason: 'current-session' }
  );

  const otherPublic = sessions.find(item => !item.current);
  assert.deepEqual(
    context.auth.revokeAccountSession({
      accountId: account.id,
      sessionId: otherPublic.id,
      currentToken: current.token
    }),
    { ok: true, removed: true }
  );
  assert.equal(context.auth.resolveSession(other.token, now + 30), null);
  assert.equal(context.auth.resolveSession(current.token, now + 30).accountId, account.id);
  context.db.close();
});

test('recovery rotation is staged, atomic on confirm and idempotent after a lost response', () => {
  const context = fresh();
  const account = context.accounts.create('Recovery');
  const oldSecret = account.secret;
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const otherA = context.auth.createSession(account.id, now + 1);
  const otherB = context.auth.createSession(account.id, now + 2);

  const prepared = context.selfService.prepareRecoveryCode({ accountId: account.id, now: now + 20 });
  assert.match(prepared.secret, /^WOBBLE-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);
  assert.equal(context.accounts.login(oldSecret).id, account.id, 'prepare keeps the old recovery code active');
  assert.equal(context.auth.resolveSession(otherA.token).accountId, account.id, 'prepare revokes no sessions');

  const confirmed = context.selfService.confirmRecoveryCode({
    accountId: account.id,
    currentToken: current.token,
    secret: prepared.secret,
    now: now + 100
  });
  assert.deepEqual(confirmed, {
    ok: true,
    confirmed: true,
    alreadyConfirmed: false,
    revokedSessions: 2
  });
  assert.equal(context.accounts.login(oldSecret), null);
  assert.equal(context.accounts.login(prepared.secret).id, account.id);
  assert.equal(context.auth.resolveSession(current.token).accountId, account.id);
  assert.equal(context.auth.resolveSession(otherA.token), null);
  assert.equal(context.auth.resolveSession(otherB.token), null);

  assert.deepEqual(
    context.selfService.confirmRecoveryCode({
      accountId: account.id,
      currentToken: current.token,
      secret: prepared.secret,
      now: now + 200
    }),
    { ok: true, confirmed: true, alreadyConfirmed: true, revokedSessions: 0 },
    'retry after an ambiguous response is safe'
  );
  context.db.close();
});

test('expired prepared recovery code never invalidates the active code', () => {
  const context = fresh();
  const account = context.accounts.create('Expiry');
  const oldSecret = account.secret;
  const now = Date.now();
  const current = context.auth.createSession(account.id, now);
  const prepared = context.selfService.prepareRecoveryCode({ accountId: account.id, now });

  assert.deepEqual(
    context.selfService.confirmRecoveryCode({
      accountId: account.id,
      currentToken: current.token,
      secret: prepared.secret,
      now: now + RECOVERY_ROTATION_TTL_MS + 1
    }),
    { ok: false, reason: 'rotation-expired' }
  );
  assert.equal(context.accounts.login(oldSecret).id, account.id);
  assert.equal(context.accounts.login(prepared.secret), null);
  context.db.close();
});

test('HTTP staged recovery requires a session and keeps the old code until confirm', async () => {
  const context = fresh();
  const account = context.accounts.create('HTTP Self Service');
  const oldSecret = account.secret;
  const current = context.auth.createSession(account.id);
  const other = context.auth.createSession(account.id);
  const app = express();
  install(app, context);
  const server = await listen(app);

  try {
    const denied = await fetch(`${server.url}/api/auth/recovery/rotate/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(denied.status, 401);

    const preparedResponse = await fetch(`${server.url}/api/auth/recovery/rotate/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: '{}'
    });
    assert.equal(preparedResponse.status, 200);
    assert.match(preparedResponse.headers.get('cache-control') || '', /no-store/);
    const prepared = await preparedResponse.json();
    assert.equal(context.accounts.login(oldSecret).id, account.id);
    assert.equal(context.auth.resolveSession(other.token).accountId, account.id);

    const confirm = await fetch(`${server.url}/api/auth/recovery/rotate/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ secret: prepared.secret })
    });
    assert.equal(confirm.status, 200);
    assert.match(confirm.headers.get('cache-control') || '', /no-store/);
    const confirmed = await confirm.json();
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.alreadyConfirmed, false);
    assert.equal(confirmed.revokedSessions, 1);
    assert.equal(context.accounts.login(oldSecret), null);
    assert.equal(context.accounts.login(prepared.secret).id, account.id);
    assert.equal(context.auth.resolveSession(other.token), null);
    assert.equal(context.auth.resolveSession(current.token).accountId, account.id);

    const retry = await fetch(`${server.url}/api/auth/recovery/rotate/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookie(current.token) },
      body: JSON.stringify({ secret: prepared.secret })
    });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).alreadyConfirmed, true);
  } finally {
    await server.close();
    context.db.close();
  }
});
""")

Path("server/accountSelfService.client.test.mjs").write_text("""import test from 'node:test';
import assert from 'node:assert/strict';
import {
  commitStagedRecoveryCode,
  confirmRecoveryCode,
  currentAccount,
  forgetAccountChecked,
  listAccountSessions,
  prepareRecoveryCode,
  rememberAccount,
  revokeAccountSession,
  revokeOtherAccountSessions,
  stageRecoveryCode,
  switchAccount
} from '../client/core/account.js';

function memoryStorage() {
  let value = null;
  let failWrites = false;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      if (failWrites) throw new Error('storage unavailable');
      value = next;
    },
    failWrites: () => {
      failWrites = true;
    }
  };
}

function fakeServer(handlers) {
  const calls = [];
  const fetchImpl = async (path, init) => {
    const body = JSON.parse(init.body || '{}');
    calls.push({ path, body, credentials: init.credentials });
    const result = await handlers[path](body);
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.data
    };
  };
  return { fetchImpl, calls };
}

test('account client lists and revokes sessions without ever handling the cookie bearer', async () => {
  const server = fakeServer({
    '/api/auth/sessions': () => ({
      status: 200,
      data: {
        ok: true,
        sessions: [
          { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', current: true, lastSeenAt: 1, expiresAt: 2 },
          { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', current: false, lastSeenAt: 1, expiresAt: 2 }
        ]
      }
    }),
    '/api/auth/sessions/revoke': body => ({
      status: 200,
      data: { ok: true, removed: body.sessionId === 'bbbbbbbbbbbbbbbbbbbbbbbb' }
    }),
    '/api/auth/sessions/revoke-others': () => ({ status: 200, data: { ok: true, revoked: 2 } })
  });

  const sessions = await listAccountSessions({ fetchImpl: server.fetchImpl });
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].current, true);
  assert.equal(
    (await revokeAccountSession('bbbbbbbbbbbbbbbbbbbbbbbb', { fetchImpl: server.fetchImpl })).removed,
    true
  );
  assert.equal((await revokeOtherAccountSessions({ fetchImpl: server.fetchImpl })).revoked, 2);
  assert.ok(server.calls.every(call => call.credentials === 'same-origin'));
  assert.equal(server.calls.some(call => 'token' in call.body || 'cookie' in call.body), false);
});

test('staged recovery keeps the active code and never changes the selected account', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'A', secret: 'OLD-A' }, storage);
  rememberAccount({ id: 'b', name: 'B', secret: 'OLD-B' }, storage);
  switchAccount('b', storage);

  const staged = stageRecoveryCode('a', 'NEW-A', Date.now() + 60_000, storage);
  assert.equal(staged.persisted, true);
  assert.equal(currentAccount(storage).id, 'b');
  const accountA = staged.state.accounts.find(account => account.id === 'a');
  assert.equal(accountA.secret, 'OLD-A');
  assert.equal(accountA.pendingRecovery.secret, 'NEW-A');

  const committed = commitStagedRecoveryCode('a', storage);
  assert.equal(committed.persisted, true);
  assert.equal(currentAccount(storage).id, 'b');
  const savedA = committed.state.accounts.find(account => account.id === 'a');
  assert.equal(savedA.secret, 'NEW-A');
  assert.equal(savedA.pendingRecovery, undefined);
});

test('checked logout detects a localStorage write failure instead of pretending the code was removed', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'A', secret: 'KEEP-ME' }, storage);
  storage.failWrites();

  const forgotten = forgetAccountChecked('a', storage);
  assert.equal(forgotten.persisted, false);
  assert.equal(currentAccount(storage).secret, 'KEEP-ME');
});

test('recovery prepare and confirm are separate same-origin requests', async () => {
  const replacement = 'replacement-code-for-test';
  const server = fakeServer({
    '/api/auth/recovery/rotate/prepare': () => ({
      status: 200,
      data: { ok: true, secret: replacement, expiresAt: Date.now() + 60_000 }
    }),
    '/api/auth/recovery/rotate/confirm': body => ({
      status: 200,
      data: { ok: true, confirmed: true, alreadyConfirmed: false, revokedSessions: 3, echoed: body.secret }
    })
  });

  const prepared = await prepareRecoveryCode({ fetchImpl: server.fetchImpl });
  assert.equal(prepared.secret, replacement);
  const confirmed = await confirmRecoveryCode(prepared.secret, { fetchImpl: server.fetchImpl });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.revokedSessions, 3);
  assert.deepEqual(
    server.calls.map(call => [call.path, call.body]),
    [
      ['/api/auth/recovery/rotate/prepare', {}],
      ['/api/auth/recovery/rotate/confirm', { secret: replacement }]
    ]
  );
});
""")

replace_once(
    "server/migrations.test.mjs",
    "assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6, 7, 8, 9]);",
    "assert.deepEqual(migrateDatabase(db, { now: 123 }), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);"
)
replace_once(
    "server/migrations.test.mjs",
    "    { version: 9, applied_at: 123 }\n  ]);",
    "    { version: 9, applied_at: 123 },\n    { version: 10, applied_at: 123 }\n  ]);"
)
replace_once(
    "server/migrations.test.mjs",
    "assert.deepEqual(migrateDatabase(db, { now: 200 }), [8, 9]);",
    "assert.deepEqual(migrateDatabase(db, { now: 200 }), [8, 9, 10]);"
)
replace_once(
    "server/migrations.test.mjs",
    "assert.deepEqual(migrateDatabase(db, { now: 200 }), [9]);",
    "assert.deepEqual(migrateDatabase(db, { now: 200 }), [9, 10]);"
)
marker = "test('неудачная миграция откатывает и схему, и отметку версии', () => {"
migration_test = """test('migration 010 stages recovery without changing the active recovery hash', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db, { migrations: MIGRATIONS.slice(0, 9), now: 100 });
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('legacy', 'Legacy', 'active-hash', 1, 1);

  assert.deepEqual(migrateDatabase(db, { now: 200 }), [10]);
  const row = db
    .prepare(
      'SELECT secret_hash, pending_secret_hash, pending_secret_created_at FROM accounts WHERE id = ?'
    )
    .get('legacy');
  assert.deepEqual(
    { ...row },
    {
      secret_hash: 'active-hash',
      pending_secret_hash: null,
      pending_secret_created_at: null
    }
  );
  db.close();
});

"""
replace_once("server/migrations.test.mjs", marker, migration_test + marker)

Path("docs/ACCOUNT-SELF-SERVICE.md").write_text("""# Account self-service

Wobble Rush uses a server-issued recovery code plus an HttpOnly persistent session. The recovery code
is a recovery credential, not the normal request credential: after sign-in the browser uses the
HttpOnly cookie and WebSocket authentication uses a short one-time WST ticket.

This self-service layer gives the player direct control over that account without exposing session
bearers to JavaScript.

## Active sessions

`POST /api/auth/sessions` returns the current account's unexpired persistent sessions. Each item has:

- an opaque public session ID derived from a short prefix of the SHA-256 token hash;
- `current`, which marks the browser making the request;
- creation, last-seen and expiry timestamps.

The API never returns the raw session token or its full hash. It also deliberately stores and shows
no IP address, user-agent or device fingerprint. The UI therefore labels sessions only as the current
device or another session and shows activity time.

`POST /api/auth/sessions/revoke` can revoke another session by public ID. It refuses to revoke the
current session; the explicit logout endpoint owns that operation. `POST /api/auth/sessions/revoke-others`
keeps the current session and removes every other persistent session for the account.

Existing authenticated WebSocket connections are not forcibly terminated by these HTTP operations.
A revoked browser cannot mint a new WST after its persistent session is gone, and an already issued
WST remains short-lived and one-time as before.

## Recovery-code rotation

Recovery rotation is deliberately staged so losing an HTTP response cannot destroy the only usable
recovery credential.

`POST /api/auth/recovery/rotate/prepare` requires the current HttpOnly session. It generates a new
high-entropy recovery code and stores only its hash in `accounts.pending_secret_hash`. The active
`secret_hash` is untouched, so the old recovery code and all sessions continue to work if the prepare
response is lost.

After receiving the prepared code, the browser stores it as `pendingRecovery` next to (not instead of)
the currently active code. It verifies that localStorage actually persisted the pending value before
sending `POST /api/auth/recovery/rotate/confirm`.

Confirmation matches the submitted code against the pending server hash and, in one SQLite
transaction:

1. promotes the pending hash to the active recovery hash;
2. clears the pending columns;
3. revokes every persistent session except the browser performing confirmation.

Only after a successful confirmation does the browser promote its local pending code to the active
saved recovery code. If the confirm response is lost after the transaction commits, both the old code
and the prepared new code remain stored locally and confirmation is idempotent: retrying with the new
code returns success when that hash is already active. If the active session later disappears, the
client tries the staged code before discarding any saved account, so a committed-but-unacknowledged
rotation is still recoverable.

A prepared hash expires after 15 minutes. Expiry or a mismatched prepared code never changes the
active recovery hash.

## Explicit logout on this device

The existing `POST /api/auth/logout` still revokes only the current server session and clears the
cookie. The account UI adds the important client-side half: after explicit confirmation it also
removes that account's saved recovery credential from localStorage.

Security-sensitive logout uses a checked storage write. If localStorage rejects the removal, Wobble
does not immediately sign in again with the credential that failed to disappear; it keeps the page
signed out and warns the player to clear site data manually before leaving.

If another saved local account exists after a successful removal, Wobble Rush selects it. Otherwise
the current page stays signed out. On a later reload the existing first-run behavior may create a new,
unrelated Wobble account; the signed-out account itself is not recovered again unless the player
supplies its recovery code or signs in through its linked Google identity.

## Safety properties

- Session bearer cookies remain HttpOnly and never enter JSON responses or localStorage.
- Public session IDs are revocation handles, not authentication credentials.
- Preparing a recovery change never invalidates the active code.
- Confirmation is idempotent and keeps the current browser session alive.
- Prepared recovery material is stored separately from the active local code until confirmation.
- Destructive UI operations use a two-step confirmation.
- Logout verifies that the local recovery credential was actually removed before continuing.
- No automatic account deletion is included in this scope.
""")
