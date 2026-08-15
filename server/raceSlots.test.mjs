import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { raceSlotOrder, assignRaceSlots } = require('./raceSlots');

const players = () =>
  Array.from({ length: 16 }, (_, index) => ({
    id: `player:${index}`,
    joinOrder: index,
    slot: index
  }));

test('один matchId даёт одну и ту же перестановку на сервере', () => {
  const a = raceSlotOrder(players(), '0123456789abcdef').map(player => player.id);
  const b = raceSlotOrder(players(), '0123456789abcdef').map(player => player.id);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 16);
});

test('новый matchId меняет клетки и не закрепляет первый ряд за joinOrder', () => {
  const first = raceSlotOrder(players(), 'aaaaaaaaaaaaaaaa').map(player => player.id);
  const second = raceSlotOrder(players(), 'bbbbbbbbbbbbbbbb').map(player => player.id);
  assert.notDeepEqual(first, second);

  // Первые четыре клетки — передний ряд сетки. Они не должны всегда доставаться первым четырём
  // вошедшим; иначе хост и ранние участники сохраняют продольную фору в каждом матче.
  assert.notDeepEqual(new Set(first.slice(0, 4)), new Set(players().slice(0, 4).map(player => player.id)));
});

test('assignRaceSlots выдаёт полный набор уникальных slot 0..N-1', () => {
  const list = players().slice(0, 9);
  const room = { players: new Map(list.map(player => [player.id, player])) };
  const ordered = assignRaceSlots(room, 'fedcba9876543210');
  assert.equal(ordered.length, 9);
  assert.deepEqual(
    [...room.players.values()].map(player => player.slot).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8]
  );
});
