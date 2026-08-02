import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCourseSpec,
  createSegmentPlan,
  createSegmentRoles,
  SEGMENT_ROLE,
  SEGMENT_TYPES
} from '../shared/courseSpec.js';

test('план сегментов детерминирован и входит в общую спецификацию трассы', () => {
  const first = createCourseSpec(123456, 'chaos');
  const second = createCourseSpec(123456, 'chaos');
  assert.deepEqual(first.segments, second.segments);
  assert.deepEqual(first.segments, createSegmentPlan(123456, first.segmentCount));
  assert.equal(first.segments.length, first.segmentCount);
  assert.equal(first.segments[0].role, SEGMENT_ROLE.WARMUP);
  assert.equal(first.segments.at(-2).role, SEGMENT_ROLE.RECOVERY);
  assert.equal(first.segments.at(-1).role, SEGMENT_ROLE.FINALE);
});

test('каждый элемент плана содержит известный тип и один из трёх микровариантов', () => {
  const seenVariants = new Set();
  const seenTypes = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    for (const segment of createCourseSpec(seed, 'chaos').segments) {
      assert.ok(SEGMENT_TYPES.includes(segment.type));
      assert.ok(Number.isInteger(segment.variant));
      assert.ok(segment.variant >= 0 && segment.variant < 3);
      assert.ok(Object.values(SEGMENT_ROLE).includes(segment.role));
      seenTypes.add(segment.type);
      seenVariants.add(segment.variant);
    }
  }
  assert.deepEqual([...seenTypes].sort(), [...SEGMENT_TYPES].sort());
  assert.deepEqual([...seenVariants].sort(), [0, 1, 2]);
});

test('грамматика чередует нагрузку и ставит восстановление перед финалом', () => {
  assert.deepEqual(createSegmentRoles(5), ['warmup', 'skill', 'challenge', 'recovery', 'finale']);
  assert.deepEqual(createSegmentRoles(7), [
    'warmup',
    'skill',
    'challenge',
    'skill',
    'challenge',
    'recovery',
    'finale'
  ]);
  for (let seed = 1; seed <= 200; seed++) {
    const segments = createCourseSpec(seed, 'chaos').segments;
    assert.ok(['bumpers', 'bounce', 'movers'].includes(segments[0].type));
    assert.ok(['bounce', 'bumpers', 'movers'].includes(segments.at(-2).type));
    assert.ok(['bridge', 'punchers', 'crosswind', 'sweepers'].includes(segments.at(-1).type));
    for (let i = 1; i < segments.length; i++) {
      assert.notEqual(segments[i].type, segments[i - 1].type);
      assert.ok(!(segments[i].role === 'challenge' && segments[i - 1].role === 'challenge'));
    }
  }
});

test('разные сиды дают разные планы, сохраняя уникальные типы первых семи испытаний', () => {
  const a = createCourseSpec(7, 'chaos').segments;
  const b = createCourseSpec(8, 'chaos').segments;
  assert.notDeepEqual(a, b);
  assert.equal(new Set(a.map(segment => segment.type)).size, 7);
  assert.equal(new Set(b.map(segment => segment.type)).size, 7);
});
