// Перенос гостевых рекордов в аккаунт.
//
// Разбор ключей localStorage — то место, где ошибка не видна: рекорд не «сломается», он просто
// молча не уедет, а игрок узнает об этом, когда своего времени в аккаунте не окажется.

import test from 'node:test';
import assert from 'node:assert/strict';
import { listLocalRecords, soloKey, coopKey, saveBest } from '../client/core/records.js';

function memoryStorage() {
  const data = new Map();
  return {
    get length() {
      return data.size;
    },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key)
  };
}

test('соло и кооп собираются с теми courseKey, которых ждёт сервер', () => {
  globalThis.localStorage = memoryStorage();
  saveBest(soloKey(12345, 'chaos'), 31000);
  saveBest(coopKey('ch7'), 42000);

  const found = listLocalRecords().sort((a, b) => a.mode.localeCompare(b.mode));
  assert.deepEqual(found, [
    { mode: 'coop', courseKey: 'ch7', time: 42000 },
    { mode: 'solo', courseKey: '12345:chaos', time: 31000 }
  ]);
});

test('чужие ключи хранилища не превращаются в рекорды', () => {
  globalThis.localStorage = memoryStorage();
  globalThis.localStorage.setItem('wobble-cosmetics-v1', '{"body":"classic"}');
  globalThis.localStorage.setItem('wobble-settings', '{}');
  saveBest(soloKey(1, 'easy'), 9000);

  assert.deepEqual(listLocalRecords(), [{ mode: 'solo', courseKey: '1:easy', time: 9000 }]);
});

test('пустое хранилище переносит пустой список, а не падает', () => {
  globalThis.localStorage = memoryStorage();
  assert.deepEqual(listLocalRecords(), []);
  globalThis.localStorage = undefined;
  assert.deepEqual(listLocalRecords(), []);
});
