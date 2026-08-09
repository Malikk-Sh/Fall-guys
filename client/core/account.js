// Аккаунты на стороне игрока.
//
// Здесь два разных знания, и их важно не смешивать:
//   • что лежит в браузере — список аккаунтов и код каждого (readAccounts и соседи);
//   • что говорит сервер — имя и личные рекорды (createAccount, loginAccount и соседи).
//
// Всё, что ходит в сеть, обязано переживать недоступный сервер. Игра работает и без него: забег
// пройдёт, локальный рекорд запишется. Молча потерять возможность играть из-за того, что не удалось
// войти, было бы худшим решением из возможных.

const STORAGE_KEY = 'wobble-accounts-v1';
const MAX_ACCOUNTS = 8;

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage || null;
  } catch {
    // Приватный режим или отключённые куки. Не повод падать: без хранилища игра просто не помнит
    // аккаунт между заходами.
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
    typeof account.secret === 'string' &&
    account.secret
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

// Добавляет аккаунт или обновляет уже известный и делает его текущим.
//
// Код НЕ затирается пустым: при обычном входе сервер его не возвращает (он отдаётся один раз, при
// создании), и слепая перезапись стёрла бы единственный способ войти.
export function rememberAccount(account, storage) {
  if (!account?.id) return readAccounts(storage);
  const state = readAccounts(storage);
  const known = state.accounts.find(a => a.id === account.id);
  if (known) {
    known.name = account.name || known.name;
    if (account.secret) known.secret = account.secret;
  } else {
    if (!account.secret) return state;
    state.accounts.unshift({ id: account.id, name: account.name || 'Wobbler', secret: account.secret });
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

// --- разговор с сервером -----------------------------------------------------------------------

async function post(path, body, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

export async function createAccount(name, options) {
  const { ok, data } = await post('/account', { name }, options);
  if (!ok || !data?.account) return null;
  return {
    ...data.account,
    secret: data.secret,
    records: data.records || [],
    progress: data.progress || null
  };
}

export async function loginAccount(secret, options) {
  const { ok, status, data } = await post('/account/login', { secret }, options);
  // Отличаем «сервер сказал нет» от «сервер не ответил»: в первом случае аккаунт надо забыть, во
  // втором — ни в коем случае, иначе потеря связи на минуту стёрла бы игроку код.
  if (status === 404) return { unknown: true };
  if (!ok || !data?.account) return null;
  return { ...data.account, records: data.records || [], progress: data.progress || null };
}

export async function renameAccount(secret, name, options) {
  const { ok, data } = await post('/account/name', { secret, name }, options);
  return ok && data?.account ? data.account : null;
}

export async function submitRecord({ secret, mode, courseKey, timeMs }, options) {
  const { ok, data } = await post('/account/record', { secret, mode, courseKey, timeMs }, options);
  return ok ? data : null;
}

// Приводит игрока в состояние «вошёл»: возвращает текущий аккаунт, заводя его при первом заходе.
//
// Возможные исходы честно разделены:
//   • сервер подтвердил аккаунт — обычный случай;
//   • сервер такого не знает (базу пересоздали) — забываем и заводим новый, иначе игрок навсегда
//     остался бы с кодом, который никуда не ведёт;
//   • сервер не ответил — оставляем всё как есть и работаем без него.
export async function ensureAccount(options = {}) {
  const { storage } = options;
  const stored = currentAccount(storage);

  // Ошибку сети ловим здесь, а не внутри loginAccount и createAccount. Те обязаны отвечать честно:
  // «сервер отказал» и «сервер недоступен» — разные события, и их различает как раз этот код.
  // Проглоти их ниже — и обрыв связи стал бы неотличим от «такого аккаунта нет», то есть стоил бы
  // игроку кода.
  const quiet = async call => {
    try {
      return await call();
    } catch {
      return null;
    }
  };

  if (stored) {
    const entered = await quiet(() => loginAccount(stored.secret, options));
    if (entered?.unknown) {
      forgetAccount(stored.id, storage);
    } else if (entered) {
      rememberAccount({ ...entered, secret: stored.secret }, storage);
      return {
        account: { ...stored, name: entered.name },
        records: entered.records,
        progress: entered.progress,
        online: true
      };
    } else {
      return { account: stored, records: [], online: false };
    }
  }

  const created = await quiet(() => createAccount(options.name, options));
  if (!created) return { account: currentAccount(storage), records: [], online: false };
  rememberAccount(created, storage);
  return { account: created, records: created.records, progress: created.progress, online: true };
}
