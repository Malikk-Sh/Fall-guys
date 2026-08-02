import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { VerifiedLeaderboard, courseKey } = require('./verifiedLeaderboard');

test('таблица принимает только подтверждённые времена и сортирует их', () => {
  const board = new VerifiedLeaderboard({ limit: 3 });
  assert.equal(
    board.record({
      matchId: 'm1',
      seed: 7,
      difficulty: 'normal',
      achievedAt: 100,
      entries: [
        { name: 'Медленный', time: 20_000, verified: true, color: 1 },
        { name: 'Читер', time: 100, verified: false, color: 2 },
        { name: 'Быстрый', time: 18_000, verified: true, color: 3 }
      ]
    }),
    true
  );
  assert.deepEqual(board.get(7, 'normal'), [
    { place: 1, name: 'Быстрый', time: 18_000, color: 3, achievedAt: 100 },
    { place: 2, name: 'Медленный', time: 20_000, color: 1, achievedAt: 100 }
  ]);
});

test('повтор одного matchId не дублирует результат и таблица ограничена', () => {
  const board = new VerifiedLeaderboard({ limit: 2 });
  const record = (matchId, time) =>
    board.record({
      matchId,
      seed: 1,
      difficulty: 'easy',
      entries: [{ name: matchId, time, verified: true }]
    });
  assert.equal(record('m1', 30_000), true);
  assert.equal(record('m1', 10_000), false);
  record('m2', 20_000);
  record('m3', 25_000);
  assert.deepEqual(
    board.get(1, 'easy').map(entry => entry.time),
    [20_000, 25_000]
  );
});

test('разные сиды и сложности не смешиваются', () => {
  const board = new VerifiedLeaderboard({ maxCourses: 2 });
  board.record({ matchId: 'a', seed: 1, difficulty: 'easy', entries: [{ time: 10, verified: true }] });
  board.record({ matchId: 'b', seed: 1, difficulty: 'chaos', entries: [{ time: 20, verified: true }] });
  assert.equal(courseKey(1, 'easy'), '1:easy');
  assert.equal(board.get(1, 'easy')[0].time, 10);
  assert.equal(board.get(1, 'chaos')[0].time, 20);
  assert.deepEqual(board.get(2, 'easy'), []);
});
