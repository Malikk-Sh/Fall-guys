// Аккаунты на стороне игрока.
//
// Recovery code остаётся только средством восстановления. После успешного входа сервер ставит
// HttpOnly session cookie; rename/records/cosmetics и обновление сетевой личности используют уже
// сессию. Для совместимости со старой схемой WebSocket клиент получает короткий network ticket,
// но сам cookie JavaScript прочитать не может.

import { resolvePlatform, supportsOnlinePlay } from './PlatformResolver.js';

const STORAGE_KEY = 'wobble-accounts-v1';
const MAX_ACCOUNTS = 8;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

const empty = () => ({ current: null, accounts: [] });

export function readAccounts(storage) {
  const store = storageOf(storage);
  if (!store) return empty();
  try {
    const parsed = JSON.parse(store.getItem(STORAGE_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.accounts)) return empty();
    const accounts = parsed.accounts.filter(isUsable).slice(0, MAX_ACCOUNTS);
    const current = accounts.some(a => a.id === parsed.current) ? parsed.current : accounts[0]?.id || null;
    return { current, accounts };
  } catch {
    return empty();
  }
}

function isUsable(account) {
  return (
    account &&
    typeof account.id === 'string' &&
    account.id &&
    ((typeof account.secret === 'string' && account.secret) || account.provider === 'google')
  );
}

function persistAccounts(state, storage) {
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

export function currentAccount(storage) {
  const state = readAccounts(storage);
  return state.accounts.find(a => a.id === state.current) || null;
}

export function listAccounts(storage) {
  const state = readAccounts(storage);
  return state.accounts.map(a => ({ ...a, current: a.id === state.current }));
}

// Network ticket и server inventory намеренно НЕ кладём в localStorage. Первый — короткий bearer,
// второй — серверный источник истины, который надо получать заново из authenticated session.
export function rememberAccount(account, storage) {
  if (!account?.id) return readAccounts(storage);
  const state = readAccounts(storage);
  const known = state.accounts.find(a => a.id === account.id);
  const google =
    account.provider === 'google' || account.identities?.some?.(identity => identity.provider === 'google');
  if (known) {
    known.name = account.name || known.name;
    if (account.secret) known.secret = account.secret;
    if (google) known.provider = 'google';
  } else {
    if (!account.secret && !google) return state;
    state.accounts.unshift({
      id: account.id,
      name: account.name || 'Wobbler',
      ...(account.secret ? { secret: account.secret } : {}),
      ...(google ? { provider: 'google' } : {})
    });
    state.accounts.splice(MAX_ACCOUNTS);
  }
  state.current = account.id;
  return writeAccounts(state, storage);
}

export function switchAccount(id, storage) {
  const state = readAccounts(storage);
  if (!state.accounts.some(a => a.id === id)) return state;
  state.current = id;
  return writeAccounts(state, storage);
}

export function forgetAccountChecked(id, storage) {
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

// Единственный транспорт аккаунта: через него идут все двадцать вызовов `/api/auth/*`.
//
// Заслон стоит ЗДЕСЬ, а не у каждого вызывающего, и это не удобство, а вывод из трёх подряд
// пропущенных мест. Сетевые входы я перечислял вручную — и трижды список оказывался неполным:
// сначала забыл кнопки аккаунта, потом кооп-рейтинг, потом отправку соло-рекорда. Перечисление
// здесь негодный метод: закрывать надо горловину, через которую проходит всё, включая то, что
// напишут после.
//
// На площадке наш сервер недостижим по построению — он однодоменный, а запрос ушёл бы на чужой
// адрес. Возвращается та же форма, что у неудачного ответа, поэтому вызывающим ничего менять не
// нужно: они уже умеют обрабатывать отказ.
async function post(path, body = {}, { fetchImpl = globalThis.fetch } = {}) {
  if (!supportsOnlinePlay(resolvePlatform())) return { ok: false, status: 0, data: {} };
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

function sanctionResult(status, data) {
  return status === 403 && data?.error === 'account-sanctioned'
    ? { sanctioned: true, sanction: data.sanction || null }
    : null;
}

function serverAccount(data, fallbackSecret = '') {
  if (!data?.account) return null;
  const google = data.identities?.some?.(identity => identity.provider === 'google');
  return {
    ...data.account,
    ...(data.secret || fallbackSecret ? { secret: data.secret || fallbackSecret } : {}),
    ...(google ? { provider: 'google' } : {}),
    networkTicket: data.networkTicket || null,
    identities: data.identities || [],
    records: data.records || [],
    progress: data.progress || null,
    profile: data.profile || null,
    inventory: data.inventory || null
  };
}

export async function sessionAccount(options) {
  const { ok, status, data } = await post('/api/auth/session', {}, options);
  if (status === 401) return { missing: true };
  const blocked = sanctionResult(status, data);
  if (blocked) return blocked;
  return ok ? serverAccount(data) : null;
}

export async function accountProfile(options) {
  const { ok, data } = await post('/api/auth/profile', {}, options);
  return ok ? data.profile || null : null;
}

export async function authConfig(options) {
  const { ok, data } = await post('/api/auth/config', {}, options);
  return ok ? data : null;
}

export async function createAccount(name, options) {
  const { ok, data } = await post('/account', { name }, options);
  if (!ok || !data?.account) return null;
  const created = {
    ...data.account,
    secret: data.secret,
    records: data.records || [],
    progress: data.progress || null
  };
  try {
    return (await loginAccount(created.secret, options)) || created;
  } catch {
    return created;
  }
}

export async function loginAccount(secret, options) {
  const { ok, status, data } = await post('/api/auth/recovery', { secret }, options);
  if (status === 404) return { unknown: true };
  const blocked = sanctionResult(status, data);
  if (blocked) return blocked;
  if (!ok) return null;
  return serverAccount(data, secret);
}

export async function loginGoogle(credential, options) {
  const { ok, status, data } = await post('/api/auth/google', { credential }, options);
  if (status === 409) return { conflict: true };
  const blocked = sanctionResult(status, data);
  if (blocked) return blocked;
  if (!ok) return null;
  return serverAccount(data);
}

export async function logoutAccount(options) {
  const { ok } = await post('/api/auth/logout', {}, options);
  return ok;
}

export async function listAccountSessions(options) {
  const { ok, data } = await post('/api/auth/sessions', {}, options);
  return ok && Array.isArray(data?.sessions) ? data.sessions : null;
}

export async function revokeAccountSession(sessionId, options) {
  const { ok, data } = await post('/api/auth/sessions/revoke', { sessionId }, options);
  return ok ? data : null;
}

export async function revokeOtherAccountSessions(options) {
  const { ok, data } = await post('/api/auth/sessions/revoke-others', {}, options);
  return ok ? data : null;
}

export async function prepareRecoveryCode(options) {
  const { ok, data } = await post('/api/auth/recovery/rotate/prepare', {}, options);
  return ok && typeof data?.secret === 'string' ? data : null;
}

export async function confirmRecoveryCode(secret, options) {
  const { ok, status, data } = await post('/api/auth/recovery/rotate/confirm', { secret }, options);
  if (ok) return { ok: true, ...data };
  return { ok: false, status, error: data?.error || 'confirm-failed' };
}

export async function renameAccount(name, options) {
  const { ok, data } = await post('/api/auth/name', { name }, options);
  return ok && data?.account ? data.account : null;
}

export async function submitRecord({ mode, courseKey, timeMs }, options) {
  const { ok, data } = await post('/api/auth/record', { mode, courseKey, timeMs }, options);
  return ok ? data : null;
}

export async function equipAccountCosmetic(slot, cosmeticId, options) {
  const { ok, data } = await post('/api/cosmetics/equip', { slot, cosmeticId }, options);
  return ok ? data.inventory || null : null;
}

// У эмоций не слот, а позиция: их четыре, и «слот эмоции» означал бы четыре псевдослота в общем
// equip. Отдельный маршрут честнее и проверяется сервером так же строго.
export async function equipAccountEmote(position, cosmeticId, options) {
  const { ok, data } = await post('/api/cosmetics/emote', { position, cosmeticId }, options);
  return ok ? data.inventory || null : null;
}

export async function avoidRecentPartner(targetAccountId, options) {
  const { ok, data } = await post('/api/social/avoid', { targetAccountId }, options);
  return ok ? data : null;
}

export async function listAvoidedPlayers(options) {
  const { ok, data } = await post('/api/social/avoids', {}, options);
  return ok && Array.isArray(data?.players) ? data.players : null;
}

export async function restoreAvoidedPlayer(targetAccountId, options) {
  const { ok, data } = await post('/api/social/unavoid', { targetAccountId }, options);
  return ok ? data : null;
}

export async function reportRecentPartner(targetAccountId, reason, options) {
  const { ok, data } = await post('/api/social/report', { targetAccountId, reason }, options);
  return ok ? data : null;
}

export async function ensureAccount(options = {}) {
  const { storage } = options;
  const stored = currentAccount(storage);
  const quiet = async call => {
    try {
      return await call();
    } catch {
      return null;
    }
  };

  const session = await quiet(() => sessionAccount(options));
  if (session?.sanctioned) {
    return { account: stored, records: [], progress: null, online: false, sanction: session.sanction };
  }
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
    if (entered?.sanctioned) {
      return { account: stored, records: [], progress: null, online: false, sanction: entered.sanction };
    }
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
    if (entered?.sanctioned) {
      return { account: stored, records: [], progress: null, online: false, sanction: entered.sanction };
    }
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

  if (session && !session.missing) {
    return {
      account: session,
      records: session.records,
      progress: session.progress,
      online: true
    };
  }

  // Ничего не нашлось — значит человек здесь впервые, и он ГОСТЬ.
  //
  // Раньше на этом месте молча заводился серверный аккаунт. Игрок его не просил и о нём не знал:
  // в углу появлялось имя «Wobbler», за которым стояла запись в базе и код восстановления, никогда
  // никому не показанный. Понять, что у тебя есть аккаунт, что он один на это устройство и что при
  // очистке браузера он исчезнет вместе с прогрессом, было неоткуда.
  //
  // Теперь состояние названо своим именем. Гость играет во всё, его прогресс лежит в браузере, и он
  // видит прямое предложение войти — а не обнаруживает потерю, когда уже поздно.
  return { account: null, records: [], progress: null, online: false, guest: true };
}
