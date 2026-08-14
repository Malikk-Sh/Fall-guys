// Личность игрока, его рекорды и server-owned cosmetics.

import {
  ensureAccount,
  accountProfile,
  avoidRecentPartner,
  listAvoidedPlayers,
  listAccounts,
  currentAccount as accountForRecords,
  authConfig,
  createAccount,
  equipAccountCosmetic,
  forgetAccountChecked,
  listAccountSessions,
  loginAccount,
  loginGoogle,
  logoutAccount,
  renameAccount,
  rememberAccount,
  reportRecentPartner,
  restoreAvoidedPlayer,
  revokeAccountSession,
  revokeOtherAccountSessions,
  prepareRecoveryCode,
  confirmRecoveryCode,
  stageRecoveryCode,
  commitStagedRecoveryCode,
  discardStagedRecoveryCode,
  sessionAccount,
  switchAccount,
  submitRecord
} from './account.js';
import { setServerCosmeticEquipHandler, setServerInventory } from './cosmetics.js';
import { listLocalRecords } from './records.js';

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';

export class AccountFlow {
  constructor(game) {
    this.game = game;
    this.records = new Map();
    this.networkTicket = null;
    this.profileRevision = 0;
    this.online = false;
    // NetworkManager забирает WST ровно для socket-auth. Ticket не остаётся в UI после выдачи;
    // при новом сокете свежий WST можно безопасно получить из HttpOnly session.
    this.game.ui.accountToken = options => this.takeNetworkTicket(options);
    setServerCosmeticEquipHandler((slot, cosmeticId) => this.equipCosmetic(slot, cosmeticId));
    this.game.ui.onProfileRefresh = () => this.refreshProfile();
    this.game.ui.onRecentPartnerAvoid = partner => this.avoidPartner(partner);
    this.game.ui.onRecentPartnerReport = (partner, reason) => this.reportPartner(partner, reason);
    this.game.ui.onAvoidedPlayerRestore = player => this.restorePlayer(player);
    this.installSelfServicePanel();
  }

  installSelfServicePanel() {
    if (!globalThis.document) return;
    const status = document.querySelector('#accountStatus');
    if (!status || document.querySelector('#accountSecurity')) return;

    const section = document.createElement('div');
    section.id = 'accountSecurity';
    section.className = 'account-section hidden';
    section.innerHTML = `
      <small class="account-legend">БЕЗОПАСНОСТЬ АККАУНТА</small>
      <div id="accountSessions" class="account-list" aria-label="Активные сеансы"></div>
      <button id="accountRevokeOthers" class="button button-secondary" type="button">
        ЗАВЕРШИТЬ ДРУГИЕ СЕАНСЫ
      </button>
      <button id="accountRotateRecovery" class="button button-secondary" type="button">
        СМЕНИТЬ КОД ВОССТАНОВЛЕНИЯ
      </button>
      <button id="accountLogoutDevice" class="button button-secondary" type="button">
        ВЫЙТИ НА ЭТОМ УСТРОЙСТВЕ
      </button>
      <small>
        Список не хранит IP-адреса и названия устройств — только время активности. Новый код
        восстановления показывается один раз и сразу заменяет старый.
      </small>
    `;
    status.before(section);

    this.security = {
      section,
      sessions: section.querySelector('#accountSessions'),
      revokeOthers: section.querySelector('#accountRevokeOthers'),
      rotate: section.querySelector('#accountRotateRecovery'),
      logout: section.querySelector('#accountLogoutDevice')
    };

    document.querySelector('#accountChip')?.addEventListener('click', () => {
      queueMicrotask(() => this.refreshSessions());
    });
    this.security.revokeOthers.addEventListener('click', () => this.revokeOtherSessions());
    this.security.rotate.addEventListener('click', () => {
      if (this.security.rotate.dataset.confirm !== '1') {
        this.security.rotate.dataset.confirm = '1';
        this.security.rotate.textContent = 'ПОДТВЕРДИТЬ СМЕНУ КОДА';
        this.game.ui.accountStatus(
          'Новый код сначала будет сохранён на этом устройстве; после подтверждения старый перестанет работать, а остальные сеансы будут завершены.'
        );
        return;
      }
      this.rotateRecovery();
    });
    this.security.logout.addEventListener('click', () => {
      if (this.security.logout.dataset.confirm !== '1') {
        this.security.logout.dataset.confirm = '1';
        this.security.logout.textContent = 'ПОДТВЕРДИТЬ ВЫХОД';
        this.game.ui.accountStatus(
          'Код этого аккаунта будет удалён с устройства. Сохраните его или подключите Google перед выходом.'
        );
        return;
      }
      this.logoutCurrentDevice();
    });
  }

  resetSecurityConfirmations() {
    if (!this.security) return;
    this.security.rotate.dataset.confirm = '';
    this.security.rotate.textContent = 'СМЕНИТЬ КОД ВОССТАНОВЛЕНИЯ';
    this.security.logout.dataset.confirm = '';
    this.security.logout.textContent = 'ВЫЙТИ НА ЭТОМ УСТРОЙСТВЕ';
  }

  updateSelfService(account, online) {
    if (!this.security) return;
    this.security.section.classList.toggle('hidden', !account);
    for (const button of [this.security.revokeOthers, this.security.rotate, this.security.logout]) {
      button.disabled = !account || !online;
    }
    this.resetSecurityConfirmations();
    if (!account) this.security.sessions.replaceChildren();
    else if (!online) this.renderSessions(null, 'Для управления сеансами нужен доступ к серверу.');
  }

  formatSessionTime(value) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '—';
    try {
      return new Date(timestamp).toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '—';
    }
  }

  renderSessions(sessions, message = '') {
    if (!this.security?.sessions) return;
    const list = this.security.sessions;
    list.replaceChildren();
    if (!Array.isArray(sessions)) {
      const empty = document.createElement('small');
      empty.textContent = message || 'Не удалось загрузить активные сеансы.';
      list.append(empty);
      this.security.revokeOthers.disabled = true;
      return;
    }
    if (!sessions.length) {
      const empty = document.createElement('small');
      empty.textContent = 'Активных сеансов нет.';
      list.append(empty);
      this.security.revokeOthers.disabled = true;
      return;
    }

    let otherCount = 0;
    for (const session of sessions) {
      if (!session.current) otherCount += 1;
      const row = document.createElement('div');
      row.className = 'account-item';
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px';
      const copy = document.createElement('span');
      copy.style.cssText = 'display:grid;gap:2px;text-align:left';
      const title = document.createElement('strong');
      title.textContent = session.current ? 'ЭТО УСТРОЙСТВО' : 'ДРУГОЙ СЕАНС';
      const detail = document.createElement('small');
      detail.textContent = `АКТИВНОСТЬ ${this.formatSessionTime(session.lastSeenAt)} · ДО ${this.formatSessionTime(
        session.expiresAt
      )}`;
      copy.append(title, detail);
      row.append(copy);

      if (!session.current) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'button button-secondary';
        revoke.textContent = 'ЗАВЕРШИТЬ';
        revoke.addEventListener('click', () => this.revokeSession(session.id, revoke));
        row.append(revoke);
      }
      list.append(row);
    }
    this.security.revokeOthers.disabled = !this.online || otherCount === 0;
  }

  async refreshSessions() {
    if (!this.security || !this.game.ui.account || !this.online) return null;
    const revision = this.profileRevision;
    this.renderSessions(null, 'Загрузка активных сеансов…');
    try {
      const sessions = await listAccountSessions();
      if (revision !== this.profileRevision) return null;
      this.renderSessions(sessions);
      return sessions;
    } catch {
      if (revision === this.profileRevision) this.renderSessions(null);
      return null;
    }
  }

  async revokeSession(sessionId, button) {
    if (!sessionId) return null;
    if (button) button.disabled = true;
    try {
      const result = await revokeAccountSession(sessionId);
      if (!result) {
        this.game.ui.accountStatus('Не удалось завершить этот сеанс.');
        return null;
      }
      this.game.ui.accountStatus(result.removed ? 'Сеанс завершён.' : 'Этот сеанс уже был завершён.');
      await this.refreshSessions();
      return result;
    } catch {
      this.game.ui.accountStatus('Не удалось завершить этот сеанс.');
      return null;
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  async revokeOtherSessions() {
    if (!this.online) return null;
    this.security.revokeOthers.disabled = true;
    try {
      const result = await revokeOtherAccountSessions();
      if (!result) return this.game.ui.accountStatus('Не удалось завершить другие сеансы.');
      this.game.ui.accountStatus(
        result.revoked ? `Завершено других сеансов: ${result.revoked}.` : 'Других активных сеансов уже нет.'
      );
      await this.refreshSessions();
      return result;
    } catch {
      this.game.ui.accountStatus('Не удалось завершить другие сеансы.');
      return null;
    } finally {
      if (this.security?.revokeOthers?.isConnected)
        this.security.revokeOthers.disabled = !this.online || !this.security.sessions.querySelector('button');
    }
  }

  showRecoveryCode(secret) {
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
      if (!prepared?.secret)
        return this.game.ui.accountStatus('Не удалось подготовить новый код восстановления.');

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

  async logoutCurrentDevice() {
    const account = this.game.ui.account;
    if (!account?.id || !this.online) return null;
    this.security.logout.disabled = true;
    try {
      const loggedOut = await logoutAccount();
      if (!loggedOut) return this.game.ui.accountStatus('Не удалось завершить текущий сеанс.');
      const forgotten = forgetAccountChecked(account.id);
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
      if (remaining.length) {
        await this.signIn();
        this.game.ui.accountStatus(`Вышли из ${account.name}. Выбран другой сохранённый аккаунт.`);
      } else {
        this.records = new Map();
        this.apply(null, { online: false, records: [], progress: null });
        this.game.ui.accountStatus(
          'Вы вышли. Данные входа этого аккаунта удалены с устройства; вернуться можно по коду или Google.'
        );
      }
      return true;
    } catch {
      this.game.ui.accountStatus('Не удалось завершить текущий сеанс.');
      return null;
    } finally {
      if (this.security?.logout?.isConnected) this.security.logout.disabled = false;
    }
  }

  async takeNetworkTicket({ fresh = false } = {}) {
    const cachedSanction = this.game.accountSanction;
    if (cachedSanction) {
      const expiresAt = Number(cachedSanction.expiresAt);
      const stillActive = cachedSanction.permanent || !Number.isFinite(expiresAt) || expiresAt > Date.now();
      if (stillActive) return { blocked: true, sanction: cachedSanction };
      this.game.accountSanction = null;
    }
    if (!fresh && this.networkTicket) {
      const ticket = this.networkTicket;
      this.networkTicket = null;
      return ticket;
    }

    this.networkTicket = null;
    try {
      const session = await sessionAccount();
      if (!session || session.missing) return null;
      if (session.sanctioned) {
        this.showSanction(session.sanction);
        return { blocked: true, sanction: session.sanction };
      }
      return session.networkTicket || null;
    } catch {
      return null;
    }
  }

  sanctionMessage(sanction) {
    const reasons = {
      afk: 'бездействие (AFK)',
      griefing: 'намеренное создание помех другим игрокам',
      'offensive-name': 'недопустимое имя',
      'exploit-cheat': 'использование читов или эксплуатация ошибки',
      other: 'нарушение правил'
    };
    const reason = reasons[sanction?.reason] || reasons.other;
    if (sanction?.permanent) return `Онлайн-доступ заблокирован без срока. Причина: ${reason}.`;
    const expires = Number(sanction?.expiresAt);
    const until = Number.isFinite(expires)
      ? new Date(expires).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
      : 'указанного модерацией срока';
    return `Онлайн-доступ временно ограничен до ${until}. Причина: ${reason}.`;
  }

  showSanction(sanction) {
    this.game.accountSanction = sanction || null;
    this.networkTicket = null;
    const message = this.sanctionMessage(sanction);
    this.game.ui.accountStatus(message);
    this.game.ui.toast?.(message);
    return message;
  }

  async signIn() {
    const { account, records, progress, online, sanction = null } = await ensureAccount({});
    this.apply(account, { online, records, progress });
    if (sanction) this.showSanction(sanction);
    else if (!online)
      this.game.ui.accountStatus('Сервер не ответил — рекорды сохранятся только на этом устройстве.');
    this.setupGoogle().catch(() => {});
  }

  apply(account, { online = true, records = null, progress = null } = {}) {
    this.profileRevision += 1;
    this.online = Boolean(online && account);
    if (this.online) {
      this.game.accountSanction = null;
      this.game.ui.clearNetworkAccessBlock?.();
    }
    if (records) {
      this.records = new Map(records.map(record => [`${record.mode}:${record.courseKey}`, record.time]));
    }
    this.networkTicket = online ? account?.networkTicket || null : null;
    setServerInventory(online ? account?.inventory || null : null);
    this.game.ui.setAccount(account, { online });
    this.game.ui.setAccountRecords(this.records);
    this.game.ui.setAccountProgress(progress);
    this.game.ui.setServerProfile(online ? account?.profile || null : null);
    this.game.ui.setAvoidedPlayers(null);
    this.game.ui.setAccountList(listAccounts());
    this.updateSelfService(account, this.online);
    if (this.online) {
      this.refreshSessions();
      if (account?.pendingRecovery?.secret) this.resumePendingRecovery();
    }
    if (this.game.previewSpec)
      this.game.ui.preview(this.game.previewSpec, this.recordFor('solo', this.game.previewSpec));
  }

  // Перечитать награды после матча, который их мог выдать.
  //
  // Прогресс и инвентарь приезжают один раз, при входе. Достижение за гонку выдаётся сервером
  // ПОСЛЕ этого, а в итогах матча его нет — они одинаковые для всей комнаты и ничего личного нести
  // не могут. Без этого обновления игрок выигрывал гонку, получал награду в базе и не видел её до
  // перезагрузки страницы: самый важный момент — первый — выглядел бы как «ничего не дали».
  async refreshRewards() {
    if (!this.online) return null;
    const revision = this.profileRevision;
    const session = await sessionAccount().catch(() => null);
    // Ответ, начатый под другим аккаунтом, не должен дорисовывать чужие награды.
    if (!session || session.missing || revision !== this.profileRevision) return null;
    setServerInventory(session.inventory || null);
    this.game.ui.setAccount({ ...this.game.ui.account, inventory: session.inventory }, { online: true });
    this.game.ui.setAccountProgress(session.progress || null);
    this.game.ui.onCosmeticChange?.();
    return session;
  }

  async refreshProfile() {
    const revision = this.profileRevision;
    const [profile, avoidedPlayers] = await Promise.all([
      accountProfile().catch(() => null),
      listAvoidedPlayers().catch(() => null)
    ]);
    // A response that started under another local/session account must never paint
    // private profile data into the newly selected account UI.
    if (revision !== this.profileRevision) return null;
    if (profile) this.game.ui.setServerProfile(profile);
    if (avoidedPlayers) this.game.ui.setAvoidedPlayers(avoidedPlayers);
    return profile;
  }

  async avoidPartner(partner) {
    if (!partner?.id) return null;
    try {
      const result = await avoidRecentPartner(partner.id);
      if (!result) return this.game.ui.toast('Не удалось сохранить исключение — попробуйте ещё раз.');
      await this.refreshProfile();
      this.game.ui.toast('Этого игрока больше не подберёт вам быстрый поиск.');
      return result;
    } catch {
      this.game.ui.toast('Не удалось сохранить исключение — попробуйте ещё раз.');
      return null;
    }
  }

  async restorePlayer(player) {
    if (!player?.id) return null;
    try {
      const result = await restoreAvoidedPlayer(player.id);
      if (!result) return this.game.ui.toast('Не удалось вернуть игрока в подбор.');
      await this.refreshProfile();
      this.game.ui.toast(
        result.removed
          ? 'Ваше исключение снято — игрок снова разрешён для быстрого подбора.'
          : 'Это исключение уже было снято.'
      );
      return result;
    } catch {
      this.game.ui.toast('Не удалось вернуть игрока в подбор.');
      return null;
    }
  }

  async reportPartner(partner, reason) {
    if (!partner?.id || !reason) return null;
    try {
      const result = await reportRecentPartner(partner.id, reason);
      if (!result) return this.game.ui.toast('Жалобу не удалось отправить.');
      this.game.ui.toast(
        result.duplicate ? 'Такая жалоба уже отправлена недавно.' : 'Жалоба отправлена. Спасибо.'
      );
      return result;
    } catch {
      this.game.ui.toast('Жалобу не удалось отправить.');
      return null;
    }
  }

  recordFor(mode, spec) {
    if (!spec) return null;
    const key = mode === 'coop' ? spec.chapterId || spec.id : `${spec.seed}:${spec.difficulty}`;
    return this.records?.get(`${mode}:${key}`) ?? null;
  }

  // Перенос гостевых рекордов в только что открытый аккаунт.
  //
  // Что переносится и почему именно это. Личные рекорды игрок и так объявляет сам: соло-забег
  // сервер не судит вовсе, о чём прямо сказано в README, поэтому отправка накопленного не добавляет
  // серверу ни капли нового доверия к клиенту — он принимает ровно то же, что принимал бы по ходу
  // игры.
  //
  // Достижения НЕ переносятся, и это осознанно. Их выдаёт сервер за игру, которую он видел сам;
  // принять их списком из localStorage значило бы завести путь, которым любой может выдать себе
  // и награды, и открываемую ими косметику. Такой путь в этом проекте уже находили в гоночных
  // наградах, и заводить его заново ради удобства переноса не стоит: достижения начнут копиться с
  // первого же матча под аккаунтом.
  async migrateGuestRecords() {
    if (!this.online) return 0;
    const local = listLocalRecords();
    if (!local.length) return 0;
    let moved = 0;
    for (const record of local) {
      try {
        const saved = await submitRecord({
          mode: record.mode,
          courseKey: record.courseKey,
          timeMs: Math.round(record.time)
        });
        // Сервер отдаёт лучшее из своего и присланного: аккаунт, у которого рекорд уже сильнее,
        // не испортится гостевым временем с этого устройства.
        if (saved?.best) {
          this.records?.set(`${record.mode}:${record.courseKey}`, saved.best);
          moved += 1;
        }
      } catch {
        // Один не уехавший рекорд не повод бросать остальные и тем более пугать игрока.
      }
    }
    return moved;
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
      setServerInventory(inventory);
      this.game.ui.setAccount({ ...this.game.ui.account, inventory }, { online: true });
      this.game.ui.onCosmeticChange?.();
    } catch {
      this.game.ui.accountStatus('Экипировку не удалось сохранить на сервере.');
      this.game.ui.renderCosmetics();
    }
  }

  async setupGoogle() {
    if (!globalThis.document) return;
    const config = await authConfig();
    const host =
      document.querySelector('#accountSignIn') ||
      document.querySelector('#account .account-actions') ||
      document.querySelector('#accountStatus');
    if (!host) return;

    // Google может быть не настроен — на своём сервере, в закрытом контуре, до получения client id.
    // Оставлять в этом случае пустое место нельзя: блок входа — единственное, что предлагает гостю
    // перестать быть гостем, и пустота там читается как «войти нельзя». Показываем запасной путь,
    // который есть всегда, и называем его входом, а не «создать новый».
    if (!config?.googleClientId) {
      if (document.querySelector('#accountSignInFallback')) return;
      const fallback = document.createElement('button');
      fallback.id = 'accountSignInFallback';
      fallback.type = 'button';
      fallback.className = 'button button-primary';
      fallback.textContent = 'СОЗДАТЬ АККАУНТ И СОХРАНИТЬ ПРОГРЕСС';
      fallback.addEventListener('click', () => this.handleAction('create'));
      host.append(fallback);
      return;
    }
    if (document.querySelector('#googleSignIn')) return;

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
      if (entered?.sanctioned) return this.showSanction(entered.sanction);
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
      return this.afterSignIn(
        entered.secret
          ? 'Google подключён. Код восстановления сохранён как запасной способ входа.'
          : `Вошли через Google · ${entered.name}.`
      );
    } catch {
      return ui.accountStatus('Google-вход сейчас недоступен.');
    }
  }

  // Один и тот же хвост у всех трёх путей входа: Google, код восстановления и создание аккаунта.
  // Игрок в любом из них приходит из гостевого режима, и накопленное на устройстве должно уехать
  // с ним, иначе вход выглядит как потеря прогресса — ровно то, из-за чего его и откладывают.
  async afterSignIn(baseMessage) {
    const moved = await this.migrateGuestRecords();
    if (!moved) return this.game.ui.accountStatus(baseMessage);
    return this.game.ui.accountStatus(
      `${baseMessage} Перенесено рекордов: ${moved}. Достижения начнут копиться с этого забега — их выдаёт сервер за подтверждённую игру.`
    );
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
        return this.afterSignIn('Новый аккаунт готов. Загляните в «МОЙ КОД», чтобы не потерять его.');
      }
      if (action === 'login') {
        const entered = await loginAccount(value);
        if (entered?.sanctioned) return this.showSanction(entered.sanction);
        if (!entered || entered.unknown) return ui.accountStatus('Такой код не подошёл. Проверьте символы.');
        const account = { ...entered, secret: value };
        rememberAccount(account);
        this.apply(account, { records: entered.records, progress: entered.progress });
        return this.afterSignIn(`Вошли как ${entered.name}.`);
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
