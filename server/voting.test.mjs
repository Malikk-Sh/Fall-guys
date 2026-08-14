// Счёт голосов на экране итогов.
//
// Проверка написана после того, как ошибку нашли глазами в браузере: в гонке с тремя ботами
// единственный живой игрок видел «ЕЩЁ РАЗ · 0/4». Ни один автоматический сценарий этого не ловил —
// на сервере электорат уже считался правильно, и решение принималось одним нажатием, а надпись
// говорила игроку, что его никто не поддержал.

import test from 'node:test';
import assert from 'node:assert/strict';
import { voteTally } from '../client/core/voting.js';

const human = (id, choice = null, online = true) => ({ id, choice, online, bot: false });
const bot = id => ({ id, choice: null, online: true, bot: true });

test('боты не входят в знаменатель', () => {
  const votes = voteTally([human('me', 'rematch'), bot('bot:0'), bot('bot:1'), bot('bot:2')], 'me');
  assert.equal(votes.total, 1, 'голосовать в этой комнате может один человек');
  assert.equal(votes.rematch, 1, 'и он уже проголосовал');
});

test('оборвавшийся не голосует', () => {
  const votes = voteTally([human('a', 'lobby'), human('b', null, false)], 'a');
  assert.equal(votes.total, 1);
  assert.equal(votes.lobby, 1);
});

test('свой выбор находится среди голосующих', () => {
  const votes = voteTally([human('a', 'next'), human('b')], 'b');
  assert.equal(votes.self.id, 'b');
  assert.equal(votes.self.choice, null);
  assert.equal(votes.next, 1);
});

test('чужой идентификатор не выдаёт себя за участника', () => {
  assert.equal(voteTally([human('a')], 'нет-такого').self, null);
});

test('пустой состав не ломает счёт', () => {
  const votes = voteTally([], 'me');
  assert.deepEqual(votes, { total: 0, self: null, next: 0, rematch: 0, lobby: 0 });
  assert.deepEqual(voteTally(undefined, null).total, 0);
});

test('голоса считаются по видам и не смешиваются', () => {
  const votes = voteTally([human('a', 'rematch'), human('b', 'lobby'), human('c', 'next'), human('d')], 'a');
  assert.equal(votes.total, 4);
  assert.equal(votes.rematch, 1);
  assert.equal(votes.lobby, 1);
  assert.equal(votes.next, 1);
});
