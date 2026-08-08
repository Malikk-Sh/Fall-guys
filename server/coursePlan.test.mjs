import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCourseSpec,
  createSegmentPlan,
  createSegmentRoles,
  SEGMENT_ROLE,
  SEGMENT_TYPES,
  SEGMENT_VARIANTS,
  segmentIndexAt,
  segmentTypeAt
} from '../shared/courseSpec.js';
import { SEGMENT_LENGTH, FIRST_SEGMENT_CENTER, FINISH_TAIL, START } from '../shared/courseSpec.js';
import { variantCount } from '../client/game/segments.js';
import { RaceRun } from './bots.mjs';

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

test('каждый элемент плана содержит известный тип и один из объявленных вариантов', () => {
  const seenVariants = new Set();
  const seenTypes = new Set();
  for (let seed = 1; seed <= 200; seed++) {
    for (const segment of createCourseSpec(seed, 'chaos').segments) {
      assert.ok(SEGMENT_TYPES.includes(segment.type));
      assert.ok(Number.isInteger(segment.variant));
      assert.ok(segment.variant >= 0 && segment.variant < SEGMENT_VARIANTS);
      assert.ok(Object.values(SEGMENT_ROLE).includes(segment.role));
      seenTypes.add(segment.type);
      seenVariants.add(segment.variant);
    }
  }
  assert.deepEqual([...seenTypes].sort(), [...SEGMENT_TYPES].sort());
  assert.deepEqual(
    [...seenVariants].sort((a, b) => a - b),
    Array.from({ length: SEGMENT_VARIANTS }, (_, i) => i)
  );
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

// Каждый тип в каждом варианте обязан проходиться.
//
// Вариант — это не украшение, а расстановка препятствий, и ошибиться в ней легко: балка чуть
// длиннее, платформа чуть дальше — и участок становится непроходимым. Глазами это не ловится, а
// игрок упрётся в него посреди забега.
//
// Поэтому проверка играет: односегментная трасса нужного типа и варианта, живая физика, бот бежит
// до финиша. Прошёл — вариант проходим. Тест не про красоту расстановки, а про то, что она вообще
// решаема.
test('каждый тип сегмента проходится ботом в каждом варианте', () => {
  const soloSpec = (type, variant, seed) => ({
    seed,
    difficulty: 'normal',
    segmentCount: 1,
    segments: [{ type, role: SEGMENT_ROLE.SKILL, variant }],
    checkpoints: [-SEGMENT_LENGTH],
    finishZ: -SEGMENT_LENGTH - FINISH_TAIL,
    start: { ...START }
  });

  const finishes = (type, variant, seed) => {
    const run = new RaceRun(soloSpec(type, variant, seed));
    // Сорок пять секунд на один сегмент: замер по всем сочетаниям дал максимум 19.4 с («встречные
    // ступени»), запас взят двойной с лишним на случай неудачной фазы препятствий.
    const limit = Math.round(45 * 60);
    for (let step = 0; step < limit && !run.finished; step++) run.step();
    const finished = run.finished;
    run.dispose();
    return finished;
  };

  for (const type of SEGMENT_TYPES) {
    for (let variant = 0; variant < SEGMENT_VARIANTS; variant++) {
      // Несколько сидов: часть расстановки зависит от собственного генератора уровня, и вариант,
      // проходимый при одном сиде, обязан проходиться при любом.
      for (const seed of [7, 1000003, 55]) {
        assert.ok(
          finishes(type, variant, seed),
          `${type} вариант ${variant} (сид ${seed}): бот не смог дойти до финиша`
        );
      }
    }
  }
});

// Объявленное число вариантов и число написанных расстановок обязаны совпадать. Разойдись они —
// генератор плана выдал бы номер, которого нет, и сегмент строился бы по остатку от деления, то
// есть повторял бы чужой вариант молча.
test('у каждого типа есть столько расстановок, сколько объявлено', () => {
  for (const type of SEGMENT_TYPES) {
    assert.equal(
      variantCount(type),
      SEGMENT_VARIANTS,
      `${type}: расстановок ${variantCount(type)}, а план раздаёт ${SEGMENT_VARIANTS}`
    );
  }
});

// Точка → сегмент. По этому переводу метрики отвечают на вопрос «где упали», и ошибка на границе
// означала бы, что падения приписываются соседнему препятствию — счётчик при этом выглядит
// исправным.
test('точка трассы переводится в свой сегмент, включая границы', () => {
  const spec = createCourseSpec(8, 'normal');
  const at = z => segmentTypeAt(spec, z);
  const center = index => FIRST_SEGMENT_CENTER - SEGMENT_LENGTH * index;

  assert.equal(at(START.z), 'start', 'стартовая площадка — не препятствие');
  for (let i = 0; i < spec.segmentCount; i++) {
    assert.equal(at(center(i)), spec.segments[i].type, `середина сегмента ${i}`);
    assert.equal(segmentIndexAt(spec, center(i)), i);
  }

  // Сегменты стыкуются вплотную, и на самой границе точка обязана относиться к дальнему из двух:
  // игрок, пересёкший её, уже вошёл в следующий сегмент.
  const seam = center(0) - SEGMENT_LENGTH / 2;
  assert.equal(at(seam + 0.01), spec.segments[0].type, 'перед швом — предыдущий сегмент');
  assert.equal(at(seam), spec.segments[1].type, 'ровно на шве — уже следующий');

  const lastGate = -SEGMENT_LENGTH * spec.segmentCount;
  assert.equal(at(lastGate), spec.segments[spec.segmentCount - 1].type, 'на последней арке ещё трасса');
  assert.equal(at(lastGate - 0.01), 'finish', 'за ней — финишный выкат');
  assert.equal(at(spec.finishZ), 'finish');
});
