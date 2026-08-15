import test from 'node:test';
import assert from 'node:assert/strict';
import { raceSpawnFor, RACE_GRID_COLUMNS } from '../shared/raceGrid.js';

const spec = { start: { x: 0, y: 1.2, z: 7 } };

test('одиночный участник сохраняет прежнюю стартовую точку', () => {
  assert.deepEqual(raceSpawnFor(spec, 0, 1), spec.start);
});

test('четыре участника стоят в одном центрированном ряду и не пересекаются', () => {
  const starts = Array.from({ length: 4 }, (_, slot) => raceSpawnFor(spec, slot, 4));
  assert.deepEqual(starts.map(point => point.z), [7, 7, 7, 7]);
  assert.equal(new Set(starts.map(point => point.x)).size, 4);
  for (let index = 1; index < starts.length; index += 1)
    assert.ok(starts[index].x - starts[index - 1].x > 0.96, 'между капсулами должен оставаться зазор');
});

test('полная гонка на 16 участников получает 16 уникальных безопасных мест', () => {
  const starts = Array.from({ length: 16 }, (_, slot) => raceSpawnFor(spec, slot, 16));
  const unique = new Set(starts.map(point => `${point.x.toFixed(3)}:${point.z.toFixed(3)}`));
  assert.equal(unique.size, 16);
  assert.equal(RACE_GRID_COLUMNS, 4);
  for (const point of starts) {
    assert.equal(point.y, spec.start.y);
    assert.ok(Math.abs(point.x) < 3, `слишком далеко по X: ${point.x}`);
    assert.ok(Math.abs(point.z - spec.start.z) < 2.1, `слишком далеко по Z: ${point.z}`);
    assert.ok(
      Math.hypot(point.x - spec.start.x, point.z - spec.start.z) < 3.4,
      'первый state должен оставаться внутри штатного античит-бюджета'
    );
  }
});

test('неполный последний ряд центрируется, а не липнет к левому краю', () => {
  const fifth = raceSpawnFor(spec, 4, 5);
  assert.equal(fifth.x, 0);
  assert.ok(fifth.z > spec.start.z);
});
