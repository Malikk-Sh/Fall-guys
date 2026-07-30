// Тесты кооперативных глав и построителя уровней.
//
// Главная проверка здесь — не «код не падает», а игровое свойство: главу нельзя пройти одному.
// Именно ради него весь режим и делается, и именно оно ломается тише всего: достаточно сделать
// пропасть на метр уже или забыть пометить плиту тяжёлой, и участок незаметно станет проходимым в
// одиночку.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  COOP_CHAPTERS,
  UNJUMPABLE_GAP,
  chapterLayout,
  coopSpec,
  coopSpawnFor,
  getChapter
} from '../shared/coopChapters.js';
import { COOP_ROLE } from '../shared/protocol.js';
import { CoopCourse } from '../client/game/CoopCourse.js';

const build = id => new CoopCourse(new THREE.Scene(), coopSpec(id), { quality: 'low' });

test('глав ровно пять и у каждой есть всё необходимое', () => {
  assert.equal(COOP_CHAPTERS.length, 5);
  const ids = new Set();
  for (const chapter of COOP_CHAPTERS) {
    assert.ok(chapter.title, `${chapter.id}: нет названия`);
    assert.ok(chapter.hint, `${chapter.id}: нет подсказки`);
    assert.ok(chapter.segmentCount >= 3, `${chapter.id}: слишком мало чекпоинтов`);
    assert.ok(!ids.has(chapter.id), `повторяющийся идентификатор ${chapter.id}`);
    ids.add(chapter.id);
  }
});

test('чекпоинты идут по порядку, финиш за последним', () => {
  for (const chapter of COOP_CHAPTERS) {
    const spec = coopSpec(chapter.id);
    for (let i = 1; i < spec.checkpoints.length; i++) {
      assert.ok(spec.checkpoints[i] < spec.checkpoints[i - 1], `${chapter.id}: чекпоинты не убывают по Z`);
    }
    assert.ok(spec.finishZ < spec.checkpoints.at(-1), `${chapter.id}: финиш не за последней аркой`);
    assert.ok(spec.start.z > spec.checkpoints[0], `${chapter.id}: старт не перед первой аркой`);
  }
});

test('отрезки не накладываются друг на друга', () => {
  // Ровно та ошибка, ради которой формат сделан последовательным: при ручных координатах
  // перекрытие пола и пропасти проходит незамеченным, а головоломка тихо ломается.
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const sorted = [...pieces].sort((a, b) => b.z - a.z);
    for (let i = 1; i < sorted.length; i++) {
      const previousBack = sorted[i - 1].z - sorted[i - 1].length / 2;
      const currentFront = sorted[i].z + sorted[i].length / 2;
      assert.ok(
        currentFront <= previousBack + 1e-6,
        `${chapter.id}: отрезки перекрываются около z=${Math.round(sorted[i].z)}`
      );
    }
  }
});

test('в каждой главе есть участок, непроходимый в одиночку', () => {
  // Управляемые пролёты (плиты, луч, синхронность) — это и есть преграды, требующие напарника.
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const coopSpans = pieces.filter(p => ['gateSpan', 'beamSpan', 'syncSpan'].includes(p.kind));
    assert.ok(coopSpans.length > 0, `${chapter.id}: нет ни одной кооперативной преграды`);

    // И каждая такая преграда должна быть шире любого одиночного прыжка.
    for (const span of coopSpans) {
      assert.ok(
        span.length >= UNJUMPABLE_GAP,
        `${chapter.id}: пролёт ${span.id} длиной ${span.length} — его перепрыгнут в одиночку`
      );
    }
  }
});

test('каждая объявленная плита кем-то используется, каждый мост к чему-то привязан', () => {
  // Проверка в обе стороны: нет ссылок на несуществующие объекты и нет объектов, ни на что не
  // влияющих. Второе особенно коварно — забытая плита выглядит рабочей, игрок на неё встаёт,
  // и ничего не происходит.
  //
  // Одна плита может служить сразу двум целям: например, фиксировать мост и одновременно быть
  // условием следующих ворот. Поэтому объявленное и используемое сравниваются как множества,
  // а не вычёркиванием по одному.
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const declaredPlates = new Set();
    const declaredEmitters = new Set();
    for (const piece of pieces) {
      for (const prop of piece.props || []) {
        if (prop.type === 'plate') declaredPlates.add(prop.id);
        if (prop.type === 'emitter') declaredEmitters.add(prop.id);
      }
    }

    const usedPlates = new Set();
    const usedEmitters = new Set();
    for (const piece of pieces) {
      for (const id of piece.requires || []) usedPlates.add(id);
      if (piece.latch) usedPlates.add(piece.latch);
      if (piece.emitter) usedEmitters.add(piece.emitter);
    }

    for (const id of usedPlates) {
      assert.ok(declaredPlates.has(id), `${chapter.id}: ссылка на несуществующую плиту ${id}`);
    }
    for (const id of usedEmitters) {
      assert.ok(declaredEmitters.has(id), `${chapter.id}: ссылка на несуществующий излучатель ${id}`);
    }
    for (const id of declaredPlates) {
      assert.ok(usedPlates.has(id), `${chapter.id}: плита ${id} ни на что не влияет`);
    }
    for (const id of declaredEmitters) {
      assert.ok(usedEmitters.has(id), `${chapter.id}: излучатель ${id} ни к чему не ведёт`);
    }
  }
});

test('все пять глав строятся без ошибок и дают проходимую геометрию', () => {
  for (const chapter of COOP_CHAPTERS) {
    const course = build(chapter.id);
    assert.ok(course.platforms.length > 5, `${chapter.id}: слишком мало опор`);
    assert.ok(course.materials.size < 40, `${chapter.id}: кэш материалов не работает`);
    // Старт должен стоять на твёрдом полу, иначе игра начинается с падения.
    const start = coopSpawnFor(coopSpec(chapter.id), 0, COOP_ROLE.SPARK);
    const ground = course.surfaceAt(new THREE.Vector3(start.x, start.y, start.z), start.y + 1, -1);
    assert.ok(ground, `${chapter.id}: под точкой старта нет пола`);
    course.dispose();
  }
});

test('роли стартуют в разных точках, но на одном полу', () => {
  const spec = coopSpec('ch1');
  const spark = coopSpawnFor(spec, 0, COOP_ROLE.SPARK);
  const anchor = coopSpawnFor(spec, 0, COOP_ROLE.ANCHOR);
  // Совпадающие точки старта означали бы, что персонажи выталкивают друг друга на первом же кадре.
  assert.notEqual(spark.x, anchor.x);
  assert.equal(spark.z, anchor.z);
});

test('пролёт с плитами держит, только пока нажаты все требуемые плиты', () => {
  const course = build('ch1');
  const span = course.spans.get('g1');
  assert.ok(span, 'в первой главе должен быть пролёт g1');
  assert.equal(span.active, false, 'изначально пролёт убран');
  assert.equal(span.platform.disabled, true, 'убранный пролёт не должен держать');

  const onPlate = id => {
    const plate = course.plates.get(id);
    return { id, role: COOP_ROLE.SPARK, position: new THREE.Vector3(plate.x, plate.baseY + 0.48, plate.z) };
  };

  // Один игрок на одной плите — недостаточно.
  course.updateCoop([onPlate('p1')], 0);
  assert.equal(course.spans.get('g1').active, false, 'одной плиты мало');

  // Двое на обеих — пролёт выдвигается.
  course.updateCoop([onPlate('p1'), onPlate('p2')], 0);
  assert.equal(course.spans.get('g1').active, true, 'обе плиты нажаты — пролёт должен появиться');
  assert.equal(course.spans.get('g1').platform.disabled, false);

  // Сошли — пролёт убирается обратно.
  course.updateCoop([], 0);
  assert.equal(course.spans.get('g1').active, false, 'пролёт должен убираться');
  course.dispose();
});

test('тяжёлую плиту продавливает только ГРУЗ', () => {
  const course = build('ch1');
  const heavy = course.plates.get('p3');
  assert.equal(heavy.role, COOP_ROLE.ANCHOR, 'p3 задумана как тяжёлая');
  const at = role => [{ id: role, role, position: new THREE.Vector3(heavy.x, heavy.baseY + 0.48, heavy.z) }];

  course.updateCoop(at(COOP_ROLE.SPARK), 0);
  assert.equal(course.plates.get('p3').pressed, false, 'лёгкая ИСКРА не должна продавливать');

  course.updateCoop(at(COOP_ROLE.ANCHOR), 0);
  assert.equal(course.plates.get('p3').pressed, true, 'ГРУЗ должен продавливать');
  course.dispose();
});

test('плита не срабатывает от пролетающего сверху игрока', () => {
  const course = build('ch1');
  const plate = course.plates.get('p1');
  course.updateCoop(
    [{ id: 'a', role: COOP_ROLE.SPARK, position: new THREE.Vector3(plate.x, plate.baseY + 5, plate.z) }],
    0
  );
  assert.equal(course.plates.get('p1').pressed, false, 'над плитой — не значит на плите');
  course.dispose();
});

test('световой мост существует ровно пока держат луч', () => {
  const course = build('ch3');
  const span = course.spans.get('b1');
  assert.equal(span.active, false);

  course.setBeam('игрок-искра', 'e1');
  course.updateCoop([], 0);
  assert.equal(course.spans.get('b1').active, true, 'луч наведён — мост есть');

  course.setBeam('игрок-искра', null);
  course.updateCoop([], 0);
  assert.equal(course.spans.get('b1').active, false, 'луч убран — мост исчез');
  course.dispose();
});

test('луч наводится по конусу взгляда, а не по точному попаданию', () => {
  const course = build('ch3');
  const emitter = course.emitters.get('e1');
  const from = emitter.position.clone().add(new THREE.Vector3(0, -2, 10));

  const towards = emitter.position.clone().sub(from).normalize();
  assert.equal(course.aimedEmitter(from, towards), 'e1', 'взгляд прямо на излучатель');

  // Небольшое отклонение прощается — целиться в пиксель на телефоне невозможно.
  const slightlyOff = towards
    .clone()
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.25)
    .normalize();
  assert.equal(course.aimedEmitter(from, slightlyOff), 'e1', 'небольшое отклонение должно прощаться');

  // Отвернулся — наводки нет.
  assert.equal(course.aimedEmitter(from, towards.clone().negate()), null, 'спиной наводить нельзя');

  // Слишком далеко — тоже нет.
  const faraway = emitter.position.clone().add(new THREE.Vector3(0, 0, 200));
  assert.equal(course.aimedEmitter(faraway, towards), null, 'вне дальности луча');
  course.dispose();
});

test('ворота синхронности не обмануть проходом по очереди', () => {
  const course = build('ch5');
  const span = course.spans.get('s1');
  const line = span.z + span.length / 2;
  const at = id => ({ id, role: COOP_ROLE.SPARK, position: new THREE.Vector3(0, 1.5, line) });

  // Один у черты — ворота закрыты.
  course.updateCoop([at('a')], 1000);
  assert.equal(course.spans.get('s1').active, false, 'одного мало');

  // Второй подошёл сильно позже — окно уже истекло.
  course.updateCoop([at('b')], 1000 + span.windowMs * 3);
  assert.equal(course.spans.get('s1').active, false, 'проход по очереди не должен засчитываться');

  // А вот одновременно — открываются.
  const now = 50_000;
  course.updateCoop([at('a'), at('b')], now);
  assert.equal(course.spans.get('s1').active, true, 'одновременный проход должен открывать ворота');
  course.dispose();
});

test('ветер сносит ИСКРУ и не трогает ГРУЗ', () => {
  const course = build('ch4');
  const zone = course.winds[0];
  assert.ok(zone, 'в четвёртой главе должен быть ветер');

  const make = role => ({
    role,
    position: new THREE.Vector3(0, 1.5, (zone.zMin + zone.zMax) / 2),
    velocity: new THREE.Vector3()
  });

  const spark = make(COOP_ROLE.SPARK);
  const anchor = make(COOP_ROLE.ANCHOR);
  for (let i = 0; i < 30; i++) {
    course.interact(spark, i / 60, null, null);
    course.interact(anchor, i / 60, null, null);
  }
  assert.ok(Math.abs(spark.velocity.x) > 0.5, 'ИСКРУ должно сносить');
  assert.equal(anchor.velocity.x, 0, 'ГРУЗ должен стоять твёрдо');
  course.dispose();
});

test('удар засчитывается только рядом с катапультой', () => {
  const course = build('ch2');
  const catapult = course.catapults[0];
  assert.ok(catapult, 'во второй главе должна быть катапульта');

  assert.equal(
    course.slamTarget(new THREE.Vector3(catapult.x, 1, catapult.slamZ)),
    catapult.id,
    'удар по ударной площадке должен срабатывать'
  );
  assert.equal(
    course.slamTarget(new THREE.Vector3(catapult.x, 1, catapult.slamZ + 20)),
    null,
    'удар вдалеке не должен ничего запускать'
  );
});

test('подбрасывает того, кто стоит на длинном плече', () => {
  const course = build('ch2');
  const catapult = course.catapults[0];
  const rider = {
    id: 'искра',
    role: COOP_ROLE.SPARK,
    position: new THREE.Vector3(catapult.x, 1.4, catapult.launchZ)
  };
  const bystander = {
    id: 'груз',
    role: COOP_ROLE.ANCHOR,
    position: new THREE.Vector3(catapult.x, 1.4, catapult.slamZ)
  };

  const result = course.launchCandidate(catapult.id, [bystander, rider]);
  assert.equal(result.actor?.id, 'искра', 'подбрасывает стоящего на плече, а не бьющего');
  assert.equal(result.catapult.power, catapult.power);

  const empty = course.launchCandidate(catapult.id, [bystander]);
  assert.equal(empty.actor, null, 'если на плече никого — подбрасывать некого');
  course.dispose();
});

test('точки возрождения стоят за пройденной аркой', () => {
  const spec = coopSpec('ch1');
  for (let cp = 1; cp <= spec.segmentCount; cp++) {
    const point = coopSpawnFor(spec, cp, COOP_ROLE.ANCHOR);
    // Возрождение должно быть ЗА аркой по ходу движения, иначе игрок сразу пересечёт её снова
    // и счётчик чекпоинтов пойдёт вразнос.
    assert.ok(point.z < spec.checkpoints[cp - 1], `чекпоинт ${cp}: возрождение перед аркой, а не за ней`);
  }
});

test('глава по идентификатору находится, неизвестный откатывается к первой', () => {
  assert.equal(getChapter('ch3').id, 'ch3');
  assert.equal(getChapter('нет-такой').id, 'ch1');
});

test('у каждого светового моста есть фиксатор на дальней стороне', () => {
  // Регрессия на реальную ошибку проектирования. Без фиксатора головоломка не решается вовсе:
  // ИСКРА держит луч с площадки, ГРУЗ переходит — а сама ИСКРА перейти уже не может, потому что
  // мост исчезает в тот миг, когда она сходит с площадки и теряет наводку. Три главы были собраны
  // именно так, и тупик обнаружился только этой проверкой.
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    for (const span of pieces.filter(p => p.kind === 'beamSpan')) {
      assert.ok(span.latch, `${chapter.id}: у моста ${span.id} нет фиксатора — ИСКРА застрянет`);

      // Фиксатор обязан быть ЗА мостом: на этой стороне его нажал бы кто угодно заранее,
      // и мост потерял бы смысл.
      const spanBack = span.z - span.length / 2;
      const latchPiece = pieces.find(p => (p.props || []).some(prop => prop.id === span.latch));
      assert.ok(latchPiece, `${chapter.id}: фиксатор ${span.latch} нигде не установлен`);
      assert.ok(
        latchPiece.z < spanBack,
        `${chapter.id}: фиксатор ${span.latch} стоит перед мостом ${span.id}, а не за ним`
      );
    }
  }
});

test('фиксатор закрепляет мост навсегда, а луч — только пока его держат', () => {
  const course = build('ch3');
  const span = course.spans.get('b1');
  const latch = course.plates.get(span.latch);

  // Пока держат луч — мост есть, отпустили — исчез.
  course.setBeam('искра', 'e1');
  course.updateCoop([], 0);
  assert.equal(course.spans.get('b1').active, true);
  course.setBeam('искра', null);
  course.updateCoop([], 0);
  assert.equal(course.spans.get('b1').active, false);

  // ГРУЗ встал на фиксатор.
  const anchorOnLatch = {
    id: 'груз',
    role: COOP_ROLE.ANCHOR,
    position: new THREE.Vector3(latch.x, latch.baseY + 0.48, latch.z)
  };
  course.updateCoop([anchorOnLatch], 0);
  assert.equal(course.spans.get('b1').active, true, 'фиксатор должен закрепить мост');

  // И даже когда ГРУЗ сошёл, мост остаётся: иначе ИСКРА не перейдёт.
  course.updateCoop([], 0);
  assert.equal(course.spans.get('b1').active, true, 'закреплённый мост не должен исчезать');
  course.dispose();
});
