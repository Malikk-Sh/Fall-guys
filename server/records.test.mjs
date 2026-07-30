// Тесты личных рекордов.
//
// Проверяется одно правило и все его края: забег без зачёта рекорд не переписывает. Правило
// появилось потому, что раньше обрыв связи молча превращал сетевой забег в одиночный — и время,
// набранное без соперников (а в коопе — с автоподъёмом вместо напарника), навсегда закрывало
// честный рекорд трассы.

import test from 'node:test';
import assert from 'node:assert/strict';
import { coopKey, readBest, saveBest, soloKey } from '../client/core/records.js';

const withStorage = (initial, fn) => {
  const data = new Map(Object.entries(initial));
  const store = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value))
  };
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  try {
    return fn(data);
  } finally {
    if (had) globalThis.localStorage = previous;
    else delete globalThis.localStorage;
  }
};

test('первое время сохраняется и помечается как первое', () => {
  withStorage({}, data => {
    const key = soloKey(1234, 'normal');
    const saved = saveBest(key, 41_500);
    assert.deepEqual(saved, { best: 41_500, improved: true, first: true });
    assert.equal(data.get(key), '41500');
  });
});

test('рекорд обновляется только лучшим временем', () => {
  withStorage({ [soloKey(7, 'easy')]: '30000' }, () => {
    const key = soloKey(7, 'easy');
    assert.deepEqual(saveBest(key, 31_000), { best: 30_000, improved: false }, 'худшее время не рекорд');
    assert.deepEqual(saveBest(key, 30_000), { best: 30_000, improved: false }, 'повтор не рекорд');
    const better = saveBest(key, 29_999);
    assert.equal(better.improved, true);
    assert.equal(better.first, false, 'это уже не первое время');
    assert.equal(readBest(key), 29_999);
  });
});

test('забег без зачёта рекорд не переписывает', () => {
  withStorage({ [coopKey('ch2')]: '90000' }, data => {
    const key = coopKey('ch2');
    const saved = saveBest(key, 42_000, { unranked: 'disconnect' });
    assert.deepEqual(saved, { best: 90_000, improved: false }, 'даже отличное время не идёт в зачёт');
    assert.equal(data.get(key), '90000', 'хранилище не тронуто');
  });
});

test('без зачёта и без прошлого рекорда ничего не сохраняется', () => {
  withStorage({}, data => {
    const key = coopKey('ch1');
    assert.deepEqual(saveBest(key, 30_000, { unranked: 'left' }), { best: null, improved: false });
    assert.equal(data.size, 0, 'первый же забег после обрыва не должен создавать рекорд');
  });
});

test('мусорное или нулевое время игнорируется', () => {
  withStorage({}, data => {
    const key = soloKey(3, 'chaos');
    for (const bad of [0, -5, NaN, Infinity, undefined])
      assert.equal(saveBest(key, bad).improved, false, `время ${bad} не рекорд`);
    assert.equal(data.size, 0);
  });
});

test('битое значение в хранилище читается как отсутствие рекорда', () => {
  withStorage({ [soloKey(9, 'normal')]: 'не-число' }, () => {
    const key = soloKey(9, 'normal');
    assert.equal(readBest(key), null);
    // И не мешает записать нормальный рекорд поверх.
    assert.equal(saveBest(key, 25_000).improved, true);
    assert.equal(readBest(key), 25_000);
  });
});

test('недоступное хранилище не роняет финиш', () => {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
  const previous = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    get() {
      throw new Error('приватный режим');
    },
    configurable: true
  });
  try {
    assert.equal(readBest(soloKey(1, 'easy')), null);
    assert.deepEqual(saveBest(soloKey(1, 'easy'), 10_000), { best: null, improved: false });
  } finally {
    delete globalThis.localStorage;
    if (had) globalThis.localStorage = previous;
  }
});

test('ключи гонки и кооператива не пересекаются', () => {
  assert.notEqual(soloKey('ch1', 'normal'), coopKey('ch1'));
  assert.equal(soloKey(42, 'easy'), 'wobble-best-42-easy');
  assert.equal(coopKey('ch3'), 'wobble-coop-best-ch3');
});
