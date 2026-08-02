import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAILY_MODIFIER,
  dailyCourseSpec,
  dailySeed,
  evaluateCourseObjectives
} from '../client/core/Config.js';

test('испытание дня одинаково для всех клиентов в пределах UTC-даты', () => {
  const morning = new Date('2026-08-02T00:01:00Z');
  const evening = new Date('2026-08-02T23:59:00Z');
  const nextDay = new Date('2026-08-03T00:01:00Z');
  const first = dailyCourseSpec('normal', morning);
  assert.deepEqual(first, dailyCourseSpec('normal', evening));
  assert.equal(first.seed, dailySeed(morning));
  assert.notEqual(first.seed, dailyCourseSpec('normal', nextDay).seed);
});

test('испытание дня содержит один прозрачный модификатор и цель без падений', () => {
  const spec = dailyCourseSpec('chaos', new Date('2026-08-02T12:00:00Z'));
  assert.equal(spec.challenge, 'daily');
  assert.deepEqual(spec.modifier, DAILY_MODIFIER);
  assert.equal(spec.modifier.obstacleSpeed, 1.18);
  assert.deepEqual(spec.objectives, ['no-falls']);
});

test('цель без падений учитывает любое возвращение на checkpoint', () => {
  const spec = dailyCourseSpec('easy', new Date('2026-08-02T12:00:00Z'));
  assert.deepEqual(evaluateCourseObjectives(spec, { respawns: 0 }), [{ id: 'no-falls', complete: true }]);
  assert.deepEqual(evaluateCourseObjectives(spec, { respawns: 1 }), [{ id: 'no-falls', complete: false }]);
  assert.deepEqual(evaluateCourseObjectives({ ...spec, objectives: [] }, { respawns: 0 }), []);
});
