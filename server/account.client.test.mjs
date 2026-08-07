// Клиентская сторона аккаунтов: хранение в браузере и разговор с сервером.
//
// Сервер здесь настоящий не нужен — важно поведение клиента на каждый возможный ответ, включая
// молчание. Именно оно и опасно: потеря связи не должна стоить игроку кода от аккаунта.

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
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) throw new Error(`нет обработчика для ${path}`);
    const result = await handler(body);
    if (result === 'offline') throw new Error('сеть недоступна');
    return {
      ok: result.status < 400,
      status: result.status,
      json: async () => result.data
    };
  };
  return { fetchImpl, calls };
}

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
  // Несуществующий аккаунт выбрать нельзя — иначе игрок остался бы вообще без текущего.
  switchAccount('нет-такого', storage);
  assert.equal(currentAccount(storage).id, 'a');
});

// Код возвращается сервером ровно один раз, при создании. Обычный вход его не присылает, и слепая
// перезапись стёрла бы единственный способ войти в этот аккаунт.
test('повторное запоминание не стирает код', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'a', name: 'Имя', secret: 'КОД' }, storage);
  rememberAccount({ id: 'a', name: 'Новое имя' }, storage);

  const account = currentAccount(storage);
  assert.equal(account.secret, 'КОД', 'код остался на месте');
  assert.equal(account.name, 'Новое имя', 'а имя обновилось');
});

test('аккаунт без кода не добавляется', () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'нет-кода', name: 'Никто' }, storage);
  assert.deepEqual(listAccounts(storage), [], 'войти в такой аккаунт всё равно было бы нечем');
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

test('первый заход заводит аккаунт и запоминает код', async () => {
  const storage = memoryStorage();
  const server = fakeServer({
    '/account': () => ({
      status: 201,
      data: { ok: true, account: { id: 'new', name: 'Wobbler' }, secret: 'WOBBLE-CODE', records: [] }
    })
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, true);
  assert.equal(result.account.id, 'new');
  assert.equal(currentAccount(storage).secret, 'WOBBLE-CODE');
});

test('следующий заход входит молча, без нового аккаунта', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'known', name: 'Старое имя', secret: 'КОД' }, storage);
  const server = fakeServer({
    '/account/login': body => {
      assert.equal(body.secret, 'КОД');
      return { status: 200, data: { ok: true, account: { id: 'known', name: 'Малик' }, records: [] } };
    }
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.account.id, 'known');
  assert.equal(result.account.name, 'Малик', 'имя подтягивается с сервера');
  assert.deepEqual(
    server.calls.map(c => c.path),
    ['/account/login'],
    'новый аккаунт не заводится'
  );
  assert.equal(currentAccount(storage).secret, 'КОД');
});

// База сервера может быть пересоздана. Тогда сохранённый код никуда не ведёт, и держаться за него
// значило бы навсегда оставить игрока без аккаунта.
test('неизвестный серверу аккаунт забывается и заводится новый', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'stale', name: 'Призрак', secret: 'СТАРЫЙ' }, storage);
  const server = fakeServer({
    '/account/login': () => ({ status: 404, data: { ok: false, error: 'unknown-code' } }),
    '/account': () => ({
      status: 201,
      data: { ok: true, account: { id: 'fresh', name: 'Wobbler' }, secret: 'НОВЫЙ', records: [] }
    })
  });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.account.id, 'fresh');
  assert.deepEqual(
    listAccounts(storage).map(a => a.id),
    ['fresh'],
    'мёртвый аккаунт не остаётся в списке'
  );
});

// Самое важное отличие: сервер промолчал — это НЕ «аккаунта нет».
test('недоступный сервер не стирает аккаунт', async () => {
  const storage = memoryStorage();
  rememberAccount({ id: 'mine', name: 'Малик', secret: 'КОД' }, storage);
  const server = fakeServer({ '/account/login': () => 'offline' });

  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, false, 'честно сообщаем, что связи нет');
  assert.equal(result.account.id, 'mine', 'играть можно и так');
  assert.equal(currentAccount(storage).secret, 'КОД', 'код остался у игрока');
});

test('обрыв при первом заходе оставляет игру без аккаунта, но работоспособной', async () => {
  const storage = memoryStorage();
  const server = fakeServer({ '/account': () => 'offline' });
  const result = await ensureAccount({ storage, fetchImpl: server.fetchImpl });
  assert.equal(result.online, false);
  assert.equal(result.account, null);
});

test('вход по коду отличает отказ сервера от его молчания', async () => {
  const denied = fakeServer({ '/account/login': () => ({ status: 404, data: {} }) });
  assert.deepEqual(await loginAccount('X', { fetchImpl: denied.fetchImpl }), { unknown: true });

  const silent = fakeServer({ '/account/login': () => 'offline' });
  await assert.rejects(() => loginAccount('X', { fetchImpl: silent.fetchImpl }));
});

test('рекорд уходит на сервер с режимом и трассой', async () => {
  const server = fakeServer({
    '/account/record': body => {
      assert.equal(body.mode, 'solo');
      assert.equal(body.courseKey, '7:normal');
      assert.equal(body.timeMs, 24_000);
      return { status: 200, data: { ok: true, best: 24_000, improved: true } };
    }
  });
  const saved = await submitRecord(
    { secret: 'КОД', mode: 'solo', courseKey: '7:normal', timeMs: 24_000 },
    { fetchImpl: server.fetchImpl }
  );
  assert.equal(saved.improved, true);
});
