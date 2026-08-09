// Личность игрока, его рекорды и server-owned cosmetics.

import {
  ensureAccount,
  listAccounts,
  currentAccount as accountForRecords,
  authConfig,
  createAccount,
  equipAccountCosmetic,
  loginAccount,
  loginGoogle,
  renameAccount,
  rememberAccount,
  switchAccount,
  submitRecord
} from './account.js';

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';

export class AccountFlow {
  constructor(game) {
    this.game = game;
    this.records = new Map();
    this.networkTicket = null;
    this.game.ui.accountToken = () => this.networkTicket;
    this.game.ui.onCosmeticEquip = (slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId);
  }

  async signIn() {
    const { account, records, progress, online } = await ensureAccount({});
    this.apply(account, { online, records, progress });
    if (!online)
      this.game.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');
    this.setupGoogle().catch(() => {});
  }

  apply(account, { online = true, records = null, progress = null } = {}) {
    if (records) {
      this.records = new Map(records.map(record => [`${record.mode}:${record.courseKey}`, record.time]));
    }
    this.networkTicket = online ? account?.networkTicket || null : null;
    this.game.ui.setAccount(account, { online });
    this.game.ui.setAccountRecords(this.records);
    this.game.ui.setAccountProgress(progress);
    this.game.ui.setAccountList(listAccounts());
    if (this.game.previewSpec)
      this.game.ui.preview(this.game.previewSpec, this.recordFor('solo', this.game.previewSpec));
  }

  recordFor(mode, spec) {
    if (!spec) return null;
    const key = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    return this.records?.get(`${mode}:${key}`) ?? null;
  }

  async save(mode, spec, time) {
    const account = accountForRecords();
    if (!account || !Number.isFinite(time) || time <= 0) return;
    const courseKey = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    try {
      const saved = await submitRecord({ mode, courseKey, timeMs: Math.round(time) });
      if (saved?.best) this.records?.set(`${mode}:${courseKey}`, saved.best);
    } catch {
      // Рекорд не уехал — забег от этого не перестаёт быть пройденным, а локальная запись уже есть.
    }
  }

  async equipCosmetic(slot, cosmeticId) {
    if (!this.game.ui.account?.inventory) return;
    try {
      const inventory = await equipAccountCosmetic(slot, cosmeticId);
      if (!inventory) {
        this.game.ui.accountStatus('Сервер не подтвердил экипировку.');
        this.game.ui.renderCosmetics();
        return;
      }
      this.game.ui.setAccount({ ...this.game.ui.account, inventory }, { online: true });
      this.game.ui.onCosmeticChange?.();
    } catch {
      this.game.ui.accountStatus('Экипировку не удалось сохранить на сервере.');
      this.game.ui.renderCosmetics();
    }
  }

  async setupGoogle() {
    const config = await authConfig();
    if (!config?.googleClientId || !globalThis.document) return;
    const host =
      document.querySelector('#account .account-actions') || document.querySelector('#accountStatus');
    if (!host || document.querySelector('#googleSignIn')) return;

    const section = document.createElement('div');
    section.id = 'googleSignIn';
    section.style.cssText = 'display:flex;justify-content:center;margin:12px 0 4px';
    host.after(section);

    await this.loadGoogleScript();
    const identity = globalThis.google?.accounts?.id;
    if (!identity) return section.remove();
    identity.initialize({
      client_id: config.googleClientId,
      callback: response => this.handleGoogleCredential(response?.credential)
    });
    identity.renderButton(section, {
      theme: 'outline',
      size: 'large',
      shape: 'pill',
      text: 'continue_with',
      width: Math.min(320, Math.max(220, section.clientWidth || 280))
    });
  }

  loadGoogleScript() {
    if (globalThis.google?.accounts?.id) return Promise.resolve();
    const existing = document.querySelector(`script[src="${GOOGLE_SCRIPT}"]`);
    if (existing)
      return new Promise((resolve, reject) => {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
      });
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = GOOGLE_SCRIPT;
      script.async = true;
      script.defer = true;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      document.head.append(script);
    });
  }

  async handleGoogleCredential(credential) {
    if (!credential) return;
    const ui = this.game.ui;
    ui.accountStatus('Проверяем Google…');
    try {
      const entered = await loginGoogle(credential);
      if (!entered || entered.conflict)
        return ui.accountStatus(
          entered?.conflict
            ? 'Этот Google-аккаунт уже связан с другим Wobble account.'
            : 'Google-вход не подтвердился.'
        );
      const stored = accountForRecords();
      const account = {
        ...entered,
        ...(entered.secret || stored?.id === entered.id ? { secret: entered.secret || stored?.secret } : {})
      };
      rememberAccount(account);
      this.apply(account, { records: entered.records, progress: entered.progress });
      return ui.accountStatus(
        entered.secret
          ? 'Google подключён. Recovery code сохранён как резервный способ входа.'
          : `Google ✓ · ${entered.name}`
      );
    } catch {
      return ui.accountStatus('Google-вход сейчас недоступен.');
    }
  }

  async handleAction(action, value) {
    const ui = this.game.ui;
    try {
      if (action === 'switch') {
        switchAccount(value);
        ui.accountStatus('Переключаюсь…');
        return this.signIn();
      }
      if (action === 'create') {
        const created = await createAccount('Wobbler');
        if (!created) return ui.accountStatus('Не вышло создать аккаунт — сервер не ответил.');
        rememberAccount(created);
        this.apply(created, { records: created.records, progress: created.progress });
        return ui.accountStatus('Новый аккаунт готов. Загляните в «МОЙ КОД», чтобы не потерять его.');
      }
      if (action === 'login') {
        const entered = await loginAccount(value);
        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');
        const account = { ...entered, secret: value };
        rememberAccount(account);
        this.apply(account, { records: entered.records, progress: entered.progress });
        return ui.accountStatus(`Вошли как ${entered.name}.`);
      }
      if (action === 'rename') {
        const account = accountForRecords();
        if (!account) return ui.accountStatus('Сначала нужен аккаунт.');
        const renamed = await renameAccount(value);
        if (!renamed)
          return ui.accountStatus('Переименовать не вышло — сессия истекла или сервер недоступен.');
        const next = { ...this.game.ui.account, ...renamed, networkTicket: this.networkTicket };
        rememberAccount(next);
        this.game.ui.setAccount(next, { online: true });
        return ui.accountStatus('Имя изменено.');
      }
    } catch {
      ui.accountStatus('Не получилось — попробуйте ещё раз.');
    }
    return undefined;
  }
}
