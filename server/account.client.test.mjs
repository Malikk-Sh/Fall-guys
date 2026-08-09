// Клиентская сторона аккаунтов: хранение в браузере и разговор с сервером.
//
// Сервер здесь настоящий не нужен — важно поведение клиента на каждый возможный ответ, включая
// молчание. Именно оно и опасно: потеря связи не должна стоить игроку recovery code.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readAccounts,
  currentAccount,
  listAccounts,
  rememberAccount,
  switchAccount,
  forgetAccount,
  ensureAccount,
  loginAccount,
  submitRecord
} from '../client/core/account.js';

function memoryStorage(initial = null) {
  let value = initial;
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next;
    }
  };
}

// Подставной сервер: очередь ответов, чтобы описать любой ход событий, включая обрыв.
function fakeServer(handlers) {
  const calls = [];
  const fetchImpl = async (path, init) => {
    const body = JSON.parse(init.body);
    calls.push({ path, body, credentials: init.credentials });
    const handler = handlers[path];
    if (!handler) throw new Error(`нет обработчика для ${path}`);
    const result = await handler(body, calls);
    if (result === 'offline') throw new Error('сеть недоступна');
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.data
    };
  };
  return { fetchImpl, calls };
}

const missingSession = () => ({ status: 401, data: { ok: false, error: 'no-session' } });
const recovered = (id, name, secret, extra = {}) => ({
  status: 200,
  data: {
    ok: true,
    account: { id, name },
    records: [],
    progress: null,
    identities: [],
    networkTicket: `WST.${id}`,
    ...extra
  },
  secret
});

test('пустое хранилище даёт пустой список без падений', () => {
  assert.deepEqual(readAccounts(memoryStorage()), { current: null, accounts: [] });
  assert.equal(currentAccount(memoryStorage()), null);
  assert.deepEqual(readAccounts(memoryStorage('это не json')), { current: null, accounts: [] });
});

test('аккаунт запоминается и становится текущим', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'Первый', secret: 'S1' }, storage);
  rememberAccount({ id: 'b', name: 'Второй', secret: 'S2' }, storage);

  assert.equal(currentAccount(storage).id, 'b', 'текущим становится последний добавленный');
  assert.deepEqual(
    listAccounts(storage).map(a => [a.id, a.current]),
    [
      ['b', true],
      ['a', false]
    ]
  );

  switchAccount('a', storage);
  assert.equal(currentAccount(storage).id, 'a');
  switchAccount('нет-такого', storage);
  assert.equal(currentAccount(storage).id, 'a');
});

test('повторное запоминание не стирает recovery code и не сохраняет network ticket', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'Имя', secret: 'КОД' }, storage);
  rememberAccount({ id: 'a', name: 'Новое имя', networkTicket: 'WST.secret' }, storage);

  const account = currentAccount(storage);
  assert.equal(account.secret, 'КОД', 'recovery code остался на месте');
  assert.equal(account.name, 'Новое имя', 'а имя обновилось');
  assert.equal(account.networkTicket, undefined, 'короткий bearer не попал в localStorage');
});

test('Google-only аккаунт можно запомнить без recovery code', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'google', name: 'Google Player', provider: 'google' }, storage);
  assert.equal(currentAccount(storage).provider, 'google');
  assert.equal(currentAccount(storage).secret, undefined);
});

test('обычный аккаунт без recovery code или Google identity не добавляется', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'нет-кода', name: 'Никто' }, storage);
  assert.deepEqual(listAccounts(storage), []);
});

test('забытый аккаунт уходит, а текущим становится соседний', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'A', secret: 'S1' }, storage);
  rememberAccount({ id: 'b', name: 'B', secret: 'S2' }, storage);
  forgetAccount('b', storage);
  assert.equal(currentAccount(storage).id, 'a');
  forgetAccount('a', storage);
  assert.equal(currentAccount(storage), null);
});

test('первый заход заводит аккаунт, обменивает recovery code на session и запоминает код', async () => {
  const storage = memoryStorage();
  const server = fakeServer({
    '/api/auth/session': missingSession,
    '/account': () => ({
      status: 201,
      data: { ok: true, account: { id: 'new', name: 'Wobbler' }, secret: 'WOBBLE-CODE', records: [] }
    }),
    '/api/auth/recovery': body => {
      assert.equal(body.secret, 'WOBBLE-CODE');
      return recovered('new', 'Wobbler', body.secret);
    }
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, true);
  assert.equal(result.account.id, 'new');
  assert.equal(result.account.networkTicket, 'WST.new');
  assert.equal(currentAccount(storage).secret, 'WOBBLE-CODE');
  assert.equal(currentAccount(storage).networkTicket, undefined);
  assert.ok(server.calls.every(call => call.credentials === 'same-origin'));
});

test('следующий заход использует HttpOnly session без повторной отправки recovery code', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'known', name: 'Старое имя', secret: 'КОД' }, storage);
  const server = fakeServer({
    '/api/auth/session': () => ({
      status: 200,
      data: {
        ok: true,
        account: { id: 'known', name: 'Малик' },
        records: [],
        networkTicket: 'WST.session',
        identities: [],
        progress: { chapters: [{ chapterId: 'ch7', completions: 1 }], achievements: [] }
      }
    })
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.account.id, 'known');
  assert.equal(result.account.name, 'Малик');
  assert.equal(result.progress.chapters[0].chapterId, 'ch7');
  assert.deepEqual(server.calls.map(c => c.path), ['/api/auth/session']);
  assert.equal(currentAccount(storage).secret, 'КОД');
});

test('явно выбранный сохранённый аккаунт заменяет session предыдущего аккаунта', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'first', name: 'A', secret: 'FIRST' }, storage);
  rememberAccount({ id: 'second', name: 'B', secret: 'SECOND' }, storage);
  switchAccount('first', storage);
  const server = fakeServer({
    '/api/auth/session': () => ({
      status: 200,
      data: {
        ok: true,
        account: { id: 'second', name: 'B' },
        records: [],
        identities: [],
        networkTicket: 'WST.old'
      }
    }),
    '/api/auth/recovery': body => {
      assert.equal(body.secret, 'FIRST');
      return recovered('first', 'A', body.secret, { networkTicket: 'WST.new' });
    }
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.account.id, 'first');
  assert.deepEqual(server.calls.map(c => c.path), ['/api/auth/session', '/api/auth/recovery']);
});

test('неизвестный серверу recovery code забывается и заводится новый аккаунт', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'stale', name: 'Призрак', secret: 'СТАРЫЙ' }, storage);
  const server = fakeServer({
    '/api/auth/session': missingSession,
    '/api/auth/recovery': body =>
      body.secret === 'СТАРЫЙ'
        ? { status: 404, data: { ok: false, error: 'unknown-code' } }
        : recovered('fresh', 'Wobbler', body.secret),
    '/account': () => ({
      status: 201,
      data: { ok: true, account: { id: 'fresh', name: 'Wobbler' }, secret: 'НОВЫЙ', records: [] }
    })
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.account.id, 'fresh');
  assert.deepEqual(listAccounts(storage).map(a => a.id), ['fresh']);
});

test('недоступный сервер не стирает аккаунт', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'mine', name: 'Малик', secret: 'КОД' }, storage);
  const server = fakeServer({
    '/api/auth/session': () => 'offline',
    '/api/auth/recovery': () => 'offline'
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, false);
  assert.equal(result.account.id, 'mine');
  assert.equal(currentAccount(storage).secret, 'КОД');
});

test('обрыв при первом заходе оставляет игру без аккаунта, но работоспособной', async () => {
  const storage = memoryStorage();
  const server = fakeServer({
    '/api/auth/session': () => 'offline',
    '/account': () => 'offline'
  });
  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, false);
  assert.equal(result.account, null);
});

test('вход по recovery code отличает отказ сервера от его молчания', async () => {
  const denied = fakeServer({ '/api/auth/recovery': () => ({ status: 404, data: {} }) });
  assert.deepEqual(await loginAccount('X', { fetchImpl: denied.fetchImpl }), { unknown: true });

  const silent = fakeServer({ '/api/auth/recovery': () => 'offline' });
  await assert.rejects(() => loginAccount('X', { fetchImpl: silent.fetchImpl }));
});

test('рекорд уходит по session без recovery code в теле запроса', async () => {
  const server = fakeServer({
    '/api/auth/record': body => {
      assert.equal(body.mode, 'solo');
      assert.equal(body.courseKey, '7:normal');
      assert.equal(body.timeMs, 24_000);
      assert.equal(body.secret, undefined);
      return { status: 200, data: { ok: true, best: 24_000, improved: true } };
    }
  });
  const saved = await submitRecord(
    { mode: 'solo', courseKey: '7:normal', timeMs: 24_000 },
    { fetchImpl: server.fetchImpl }
  );
  assert.equal(saved.improved, true);
});
