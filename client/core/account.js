// Аккаунты на стороне игрока.
//
// Recovery code остаётся только средством восстановления. После успешного входа сервер ставит
// HttpOnly session cookie; rename/records/cosmetics и обновление сетевой личности используют уже
// сессию. Для совместимости со старой схемой WebSocket клиент получает короткий network ticket,
// но сам cookie JavaScript прочитать не может.

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

export function writeAccounts(state, storage) {
  const store = storageOf(storage);
  if (!store) return state;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Переполненное хранилище не должно ломать вход.
  }
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

export function forgetAccount(id, storage) {
  const state = readAccounts(storage);
  state.accounts = state.accounts.filter(a => a.id !== id);
  if (state.current === id) state.current = state.accounts[0]?.id || null;
  return writeAccounts(state, storage);
}

async function post(path, body = {}, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
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
  if (!ok) return null;
  return serverAccount(data, secret);
}

export async function loginGoogle(credential, options) {
  const { ok, status, data } = await post('/api/auth/google', { credential }, options);
  if (status === 409) return { conflict: true };
  if (!ok) return null;
  return serverAccount(data);
}

export async function logoutAccount(options) {
  const { ok } = await post('/api/auth/logout', {}, options);
  return ok;
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

  if (session && !session.missing) {
    return {
      account: session,
      records: session.records,
      progress: session.progress,
      online: true
    };
  }

  const created = await quiet(() => createAccount(options.name, options));
  if (!created) return { account: currentAccount(storage), records: [], online: false };
  rememberAccount(created, storage);
  return { account: created, records: created.records, progress: created.progress, online: true };
}
