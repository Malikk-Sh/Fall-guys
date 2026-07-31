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
import { CoopCourse } from '../client/game/CoopCourse.js';
import { PLAYER_FOOT } from '../client/game/CourseBuilder.js';

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
  // Управляемые пролёты (плиты, синхронность) — это и есть преграды, требующие напарника.
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const coopSpans = pieces.filter(p => ['gateSpan', 'syncSpan'].includes(p.kind));
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

test('каждая объявленная плита кем-то используется', () => {
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
    for (const piece of pieces) {
      for (const prop of piece.props || []) {
        if (prop.type === 'plate') declaredPlates.add(prop.id);
      }
    }

    const usedPlates = new Set();
    for (const piece of pieces) {
      for (const id of piece.requires || []) usedPlates.add(id);
    }

    for (const id of usedPlates) {
      assert.ok(declaredPlates.has(id), `${chapter.id}: ссылка на несуществующую плиту ${id}`);
    }
    for (const id of declaredPlates) {
      assert.ok(usedPlates.has(id), `${chapter.id}: плита ${id} ни на что не влияет`);
    }
  }
});

test('все пять глав строятся без ошибок и дают проходимую геометрию', () => {
  for (const chapter of COOP_CHAPTERS) {
    const course = build(chapter.id);
    assert.ok(course.platforms.length > 5, `${chapter.id}: слишком мало опор`);
    assert.ok(course.materials.size < 40, `${chapter.id}: кэш материалов не работает`);
    // Старт должен стоять на твёрдом полу, иначе игра начинается с падения.
    const start = coopSpawnFor(coopSpec(chapter.id), 0, 0);
    const ground = course.surfaceAt(new THREE.Vector3(start.x, start.y, start.z), start.y + 1, -1);
    assert.ok(ground, `${chapter.id}: под точкой старта нет пола`);
    course.dispose();
  }
});

test('игроки стартуют в разных точках, но на одном полу', () => {
  const spec = coopSpec('ch1');
  const first = coopSpawnFor(spec, 0, 0);
  const second = coopSpawnFor(spec, 0, 1);
  // Совпадающие точки старта означали бы, что персонажи выталкивают друг друга на первом же кадре.
  assert.notEqual(first.x, second.x);
  assert.equal(first.z, second.z);
});

// Ворота живут ровно столько, сколько на плите кто-то стоит. Никакой фиксации: сошёл — моста нет.
// Поэтому плиты стоят по обе стороны пропасти, и проход всегда пятитактный.
test('мост держится только нажатой плитой, с обеих сторон', () => {
  const course = build('ch1');
  const span = course.spans.get('g1');
  assert.ok(span, 'в первой главе должен быть пролёт g1');
  assert.equal(span.active, false, 'изначально пролёт убран');
  assert.equal(span.platform.disabled, true, 'убранный пролёт не должен держать');

  const onPlate = (id, role = 0) => {
    const plate = course.plates.get(id);
    return { id: role, position: new THREE.Vector3(plate.x, plate.baseY + 0.48, plate.z) };
  };

  // Такт 1: первый встал на ближнюю плиту — мост появился.
  const holder = onPlate('p1');
  course.updateCoop([holder], 0);
  assert.equal(course.spans.get('g1').active, true, 'плита выдвигает мост');
  assert.equal(course.spans.get('g1').platform.disabled, false);

  // Такт 3: первый сошёл — моста нет. Это главное отличие от прежней фиксации.
  course.updateCoop([], 0);
  assert.equal(course.spans.get('g1').active, false, 'без нажатой плиты моста быть не должно');
  assert.equal(course.spans.get('g1').platform.disabled, true);

  // Такт 4: перешедший встал на ДАЛЬНЮЮ плиту — тот же мост появился снова.
  course.updateCoop([onPlate('p2', 'b')], 0);
  assert.equal(course.spans.get('g1').active, true, 'дальняя плита открывает тот же мост');

  // И как только он сходит, мост снова исчезает: закрепить его нечем и незачем.
  course.updateCoop([], 0);
  assert.equal(course.spans.get('g1').active, false, 'фиксации не осталось нигде');

  // Любая плита ворот подходит: их несколько по разные стороны дорожки.
  course.updateCoop([onPlate('p1b')], 0);
  assert.equal(course.spans.get('g1').active, true, 'вторая ближняя плита работает так же');
  course.dispose();
});

test('плита не срабатывает от пролетающего сверху игрока', () => {
  const course = build('ch1');
  const plate = course.plates.get('p1');
  course.updateCoop([{ id: 'a', position: new THREE.Vector3(plate.x, plate.baseY + 5, plate.z) }], 0);
  assert.equal(course.plates.get('p1').pressed, false, 'над плитой — не значит на плите');
  course.dispose();
});

test('ворота синхронности не обмануть проходом по очереди', () => {
  const course = build('ch5');
  const span = course.spans.get('s1');
  const line = span.z + span.length / 2;
  const at = id => ({ id, position: new THREE.Vector3(0, 1.5, line) });

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
    position: new THREE.Vector3(catapult.x, 1.4, catapult.launchZ)
  };
  const bystander = {
    id: 'груз',
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
    const point = coopSpawnFor(spec, cp, 1);
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

// Обучение — тоже данные, и портится оно так же тихо, как геометрия: достаточно переименовать
// пролёт или удлинить отрезок, и подсказка либо начнёт ссылаться в пустоту, либо появится не там.
// Ни то, ни другое не уронит игру — она просто перестанет учить.
test('уроки ссылаются на существующие объекты своей главы и стоят в правильном порядке', () => {
  for (const chapter of COOP_CHAPTERS) {
    const spec = coopSpec(chapter.id);
    const { pieces } = chapterLayout(chapter.id);

    const plateIds = new Set();
    const spanIds = new Set();
    for (const piece of pieces) {
      if (piece.id) spanIds.add(piece.id);
      for (const prop of piece.props || []) if (prop.type === 'plate') plateIds.add(prop.id);
    }

    let previousZ = Infinity;
    for (const item of spec.lessons) {
      const where = `${chapter.id}/${item.id}`;
      assert.ok(item.text, `${where}: у урока должен быть текст`);
      assert.ok(
        item.z <= previousZ,
        `${where}: уроки должны идти вдоль трассы по порядку, иначе поздний перекроет ранний`
      );
      previousZ = item.z;

      assert.ok(item.z <= 14, `${where}: урок не может появляться до начала главы`);
      assert.ok(item.z > spec.finishZ, `${where}: урок не может появляться после финиша`);

      if (item.done.span) {
        assert.ok(spanIds.has(item.done.span), `${where}: ссылка на несуществующий пролёт`);
      }
      if (item.done.plates) {
        for (const id of item.done.plates) {
          assert.ok(plateIds.has(id), `${where}: ссылка на несуществующую плиту ${id}`);
        }
      }
      if (item.done.past !== undefined) {
        assert.equal(typeof item.done.past, 'number', `${where}: отметка должна разрешиться в число`);
      }
    }
  }
});

test('урок уходит с экрана, как только задача решена', () => {
  const course = build('ch1');
  const spec = coopSpec('ch1');
  const together = spec.lessons.find(item => item.done.span === 'g1');
  assert.ok(together, 'урок про совместные плиты должен существовать');

  // Пара дошла до плиты: урок виден.
  const at = id => {
    const plate = course.plates.get(id);
    return new THREE.Vector3(plate.x, plate.baseY + 0.48, plate.z);
  };
  const holdZ = course.plates.get('p1').z;

  // Никто ещё не встал на плиту — пролёта нет, урок висит. Плиты стоят по краям дорожки,
  // поэтому «между ними» — это центр.
  const waiting = [
    { id: 'a', position: new THREE.Vector3(0, 1, holdZ) },
    { id: 'b', position: new THREE.Vector3(0.5, 1, holdZ) }
  ];
  course.updateCoop(waiting, 0);
  assert.equal(course.activeLesson(waiting)?.id, together.id, 'пока задача не решена, урок держится');

  // Один встал на плиту — пролёт выдвинулся, урок больше не нужен.
  const holding = [{ ...waiting[0], position: at('p1') }, waiting[1]];
  course.updateCoop(holding, 0);
  assert.equal(course.spans.get('g1').active, true);
  assert.notEqual(course.activeLesson(holding)?.id, together.id, 'решённая задача убирает подсказку');
  course.dispose();
});

// Правило обучения: каждая механика объясняется ровно один раз, в той главе, где впервые
// появляется. Нарушения этого правила бывают в обе стороны и обе плохи: повтор мешает тому, кто
// уже понял, а пропуск оставляет пару перед задачей, решение которой ниоткуда не следует.
test('каждая механика объясняется ровно один раз', () => {
  const taught = new Map();
  for (const chapter of COOP_CHAPTERS) {
    for (const item of coopSpec(chapter.id).lessons) {
      assert.equal(
        taught.has(item.id),
        false,
        `урок «${item.id}» повторяется в ${chapter.id}, хотя уже был в ${taught.get(item.id)}`
      );
      taught.set(item.id, chapter.id);
    }
  }

  // Механики, которые невозможно вывести из вида уровня, обязаны быть объяснены. Список ведётся
  // руками намеренно: добавили новую механику — придётся сюда заглянуть и решить, учить ли её.
  for (const id of [
    'together',
    'gateSwap',
    'solo',
    'catapult',
    'conveyor',
    'pendulum',
    'fan',
    'collapsing',
    'crusher',
    'sync'
  ]) {
    assert.ok(taught.has(id), `механика «${id}» нигде не объясняется`);
  }
});

// Урок должен стоять в той же главе, где механика впервые встречается, — иначе он либо опоздает,
// либо расскажет о том, чего в этой главе ещё нет.
test('урок стоит в главе, где его механика впервые появляется', () => {
  const firstSeen = kind => {
    for (const chapter of COOP_CHAPTERS) {
      const { pieces } = chapterLayout(chapter.id);
      const found = pieces.some(
        piece => piece.kind === kind || (piece.props || []).some(prop => prop.type === kind)
      );
      if (found) return chapter.id;
    }
    return null;
  };

  const owner = id => {
    for (const chapter of COOP_CHAPTERS) {
      if (coopSpec(chapter.id).lessons.some(item => item.id === id)) return chapter.id;
    }
    return null;
  };

  for (const [lessonId, kind] of [
    ['catapult', 'catapult'],
    ['conveyor', 'conveyor'],
    ['pendulum', 'pendulum'],
    ['fan', 'fan'],
    ['crusher', 'crusher'],
    ['sync', 'syncSpan']
  ]) {
    assert.equal(
      owner(lessonId),
      firstSeen(kind),
      `урок «${lessonId}» должен быть в главе, где «${kind}» появляется впервые`
    );
  }
});

// Найдено при живой проверке в двух браузерах: пара решала первую задачу, переходила по пролёту —
// и подсказка «встаньте на плиты» возвращалась, потому что сойдя с плит они убрали пролёт, а
// условие проверялось как текущее состояние. Усвоенное не разучивается обратно.
test('усвоенный урок не возвращается, когда условие перестаёт выполняться', () => {
  const course = build('ch1');
  const at = id => {
    const plate = course.plates.get(id);
    return new THREE.Vector3(plate.x, plate.baseY + 0.48, plate.z);
  };

  const holding = [
    { id: 'a', position: at('p1') },
    { id: 'b', position: new THREE.Vector3(3, 1, course.plates.get('p1').z) }
  ];
  course.updateCoop(holding, 0);
  course.activeLesson(holding);
  assert.ok(course.learned.has('together'), 'решённая задача должна запомниться');

  // Держащий сошёл с плиты, фиксатор ещё не нажат: пролёт убрался, состояние вернулось в исходное.
  const crossed = holding.map(actor => ({
    ...actor,
    position: new THREE.Vector3(actor.position.x, actor.position.y, course.spans.get('g1').z + 4)
  }));
  course.updateCoop(crossed, 0);
  assert.equal(course.spans.get('g1').active, false, 'без плиты и фиксатора пролёт убирается');
  assert.notEqual(
    course.activeLesson(crossed)?.id,
    'together',
    'подсказка про плиты не должна возвращаться тем, кто уже на той стороне'
  );
  course.dispose();
});

// Инвариант проходимости, без которого глава молча превращается в тупик.
//
// Мост держится, пока нажата какая-нибудь его плита. Значит:
//   - если ВСЕ плиты стоят перед пропастью, перейти не может никто: чтобы шагнуть на мост, надо
//     сойти с плиты, а сойти — значит убрать мост;
//   - если все плиты стоят ЗА пропастью, до них не добраться ногами — такое допустимо только
//     когда через пропасть перебрасывает катапульта.
//
// Прежние проверки этого не видели: они спрашивали «выдвинулся ли мост», и ответ был «да».
// Он выдвигался. Просто ни для кого не был проходим.
test('через каждые ворота может перейти каждый', () => {
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);

    const plateZ = new Map();
    for (const piece of pieces) {
      for (const prop of piece.props || []) {
        if (prop.type === 'plate') plateZ.set(prop.id, piece.z);
      }
    }
    const catapultZ = pieces
      .flatMap(piece => (piece.props || []).filter(prop => prop.type === 'catapult').map(() => piece.z))
      .sort((a, b) => b - a);

    for (const piece of pieces) {
      if (piece.kind !== 'gateSpan') continue;
      const where = `${chapter.id}/${piece.id}`;
      // Уровень идёт в минус по Z, поэтому «за пропастью» — это Z меньше дальнего края.
      const farEdge = piece.z - piece.length / 2;
      const nearEdge = piece.z + piece.length / 2;

      for (const id of piece.requires) {
        assert.ok(plateZ.has(id), `${where}: плита «${id}» не существует`);
      }
      const beyond = piece.requires.filter(id => plateZ.get(id) < farEdge);
      const before = piece.requires.filter(id => plateZ.get(id) > nearEdge);

      assert.ok(
        beyond.length > 0,
        `${where}: нет плиты ЗА пропастью — держащий останется на своей стороне навсегда`
      );

      if (before.length > 0) continue;

      // Плит перед пропастью нет: единственный способ попасть на ту сторону — катапульта,
      // и она обязана стоять перед этой же пропастью.
      const launcher = catapultZ.find(z => z > nearEdge);
      assert.ok(
        launcher !== undefined,
        `${where}: все плиты за пропастью, но катапульты перед ней нет — попасть туда нечем`
      );
    }
  }
});

// Обратная сторона того же: держащая плита должна быть ДОСТИЖИМА, то есть перед пролётом.
test('держащая плита стоит перед своим пролётом', () => {
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const plateZ = new Map();
    for (const piece of pieces) {
      for (const prop of piece.props || []) {
        if (prop.type === 'plate') plateZ.set(prop.id, piece.z);
      }
    }
    for (const piece of pieces) {
      if (piece.kind !== 'gateSpan') continue;
      const nearEdge = piece.z + piece.length / 2;
      for (const id of piece.requires) {
        assert.ok(
          plateZ.get(id) > nearEdge || plateZ.get(id) < piece.z - piece.length / 2,
          `${chapter.id}/${piece.id}: плита «${id}» стоит внутри самого пролёта`
        );
      }
    }
  }
});

// Тупик того же класса, что и ворота без фиксатора, только с другой стороны: голая пропасть шире
// прыжка. ИСКРУ через такую перебрасывает катапульта, а ГРУЗУ перебраться нечем — и глава молча
// кончается. Найдено ботами: они дошли до места и не смогли идти дальше ни одним способом.
//
// Требование: любая пропасть шире прыжка обязана быть перекрыта управляемым пролётом.
test('нет пропастей, которые нечем перейти', () => {
  // Обычный прыжок берёт около шести единиц, рывок в прыжке — примерно девять. Всё шире
  // требует механизма.
  const JUMPABLE = 9;

  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const solid = pieces
      .filter(p => p.kind === 'floor' || p.kind === 'movingSpan' || p.kind === 'collapsing')
      .sort((a, b) => b.z - a.z);
    const spans = pieces.filter(p => p.kind.endsWith('Span') && p.kind !== 'movingSpan');

    for (let i = 1; i < solid.length; i++) {
      const back = solid[i - 1].z - solid[i - 1].length / 2;
      const front = solid[i].z + solid[i].length / 2;
      const width = back - front;
      if (width < 0.5) continue;

      const covered = spans.some(span => Math.abs(span.z + span.length / 2 - back) < 0.01);
      if (covered) continue;

      assert.ok(
        width <= JUMPABLE,
        `${chapter.id}: пропасть шириной ${width.toFixed(0)} около z=${back.toFixed(0)} ` +
          `не перекрыта пролётом — перепрыгнуть её нельзя, значит пройти её нечем`
      );
    }
  }
});

// Дубль идентификатора плиты — ошибка, которую видно только в бою: вторая плита затирает первую
// в карте объектов, и механика, ссылавшаяся на первую, тихо начинает управляться другой плитой
// в другом конце главы. Допущена при правке глав и найдена ботами.
test('идентификаторы объектов внутри главы уникальны', () => {
  for (const chapter of COOP_CHAPTERS) {
    const { pieces } = chapterLayout(chapter.id);
    const seen = new Set();
    const add = (id, what) => {
      assert.equal(seen.has(id), false, `${chapter.id}: ${what} «${id}» объявлен дважды`);
      seen.add(id);
    };
    for (const piece of pieces) {
      if (piece.id) add(piece.id, 'пролёт');
      for (const prop of piece.props || []) {
        if (prop.id) add(prop.id, prop.type);
      }
    }
  }
});

// Смертельная опасность обязана телеграфировать себя тремя тактами: предупреждение, окно удара,
// восстановление. Проверяем это по самому прессу, а не по картинке: такты должны идти в этом
// порядке, звук — приходиться на смену такта, а не на каждый кадр, и первый кадр главы не должен
// начинаться с удара из ниоткуда.
test('пресс проходит три такта и озвучивает каждую смену ровно один раз', () => {
  const course = build('ch5');
  assert.ok(course.crushers.length > 0, 'в этой главе прессы должны быть');
  const crusher = course.crushers[0];

  const heard = [];
  const sfx = {
    warn: () => heard.push('warn'),
    crush: () => heard.push('crush'),
    crack: () => heard.push('crack'),
    collapse: () => heard.push('collapse')
  };

  // Первый кадр только запоминает такт: звука быть не должно.
  course.update(1 / 60, 0, sfx);
  assert.deepEqual(heard, [], 'глава не начинается с удара пресса');
  assert.notEqual(crusher.beat, null, 'такт всё же должен запомниться');

  // Полный цикл с запасом. Прогоняем шагами по 1/60, как это делает игра. Считаем такты у ВСЕХ
  // прессов главы: звук слышен от каждого, и сверять его с одним прессом было бы враньём.
  const beatsBy = new Map(course.crushers.map(item => [item.id, []]));
  const dangerous = [];
  const longest = Math.max(...course.crushers.map(item => item.period));
  for (let i = 1; i <= Math.ceil(longest * 2 * 60); i++) {
    course.update(1 / 60, i / 60, sfx);
    for (const item of course.crushers) {
      const seen = beatsBy.get(item.id);
      if (seen[seen.length - 1] !== item.beat) seen.push(item.beat);
    }
    dangerous.push(crusher.danger);
  }

  // Такты идут по кругу в одном и том же порядке.
  const order = ['warn', 'strike', 'rise'];
  for (const [id, beats] of beatsBy) {
    for (let i = 1; i < beats.length; i++) {
      const expected = order[(order.indexOf(beats[i - 1]) + 1) % order.length];
      assert.equal(beats[i], expected, `${id}: после такта «${beats[i - 1]}» должен идти «${expected}»`);
    }
    assert.ok(beats.length >= 4, `${id}: за два периода такт должен смениться минимум четырежды`);
  }

  // Убивает только в такте удара.
  assert.equal(
    dangerous.some(Boolean),
    true,
    'окно опасности должно существовать, иначе пресс безобиден'
  );
  assert.ok(
    dangerous.filter(Boolean).length < dangerous.length * 0.6,
    'опасное окно не должно занимать большую часть цикла — это уже не препятствие, а стена'
  );

  // Звуков ровно столько, сколько смен такта: предупреждение и удар, восстановление молчит.
  const expectedSounds = [...beatsBy.values()]
    .map(beats => beats.slice(1).filter(beat => beat !== 'rise').length)
    .reduce((sum, count) => sum + count, 0);
  assert.equal(
    heard.length,
    expectedSounds,
    `звук привязан к смене такта: ожидалось ${expectedSounds}, услышано ${heard.length}`
  );
  assert.equal(
    heard.every(name => name === 'warn' || name === 'crush'),
    true,
    'у пресса только два звука — предупреждение и удар'
  );
});

// Осыпающаяся плитка — тоже опасность с предупреждением: наступил, треснуло, через задержку
// провалилось, потом вернулось. Если бы плитка не возвращалась, идущий вторым остался бы без пола.
test('осыпающаяся плитка трещит, проваливается и возвращается', () => {
  // Глава без прессов: иначе их такты подмешивали бы посторонние звуки в тот же счётчик.
  const course = build('ch4');
  assert.ok(course.tiles.length > 0, 'в этой главе должны быть осыпающиеся плитки');
  const tile = course.tiles[0];
  const mesh = tile.platform.mesh;

  const heard = [];
  const sfx = { crack: () => heard.push('crack'), collapse: () => heard.push('collapse') };

  // Игрок наступает на плитку. Полноценный Player здесь не нужен: interact читает позицию,
  // grounded и checkpoint.
  const player = {
    position: new THREE.Vector3(mesh.position.x, PLAYER_FOOT + 0.5, mesh.position.z),
    velocity: new THREE.Vector3(),
    grounded: true,
    checkpoint: 0,
    impact: 0,
    respawn: () => {}
  };

  course.interact(player, 0, null, sfx);
  assert.deepEqual(heard, ['crack'], 'наступили — плитка должна треснуть, но ещё не провалиться');
  assert.equal(tile.fallen, false);
  assert.notEqual(tile.platform.disabled, true, 'пол под ногами обязан продержаться всю задержку');

  // Ждём обрушения.
  for (let i = 0; i < Math.ceil(tile.delay * 60) + 2; i++) course.update(1 / 60, i / 60, sfx);
  assert.equal(tile.fallen, true, 'после задержки плитка проваливается');
  assert.equal(tile.platform.disabled, true, 'провалившаяся плитка перестаёт быть полом');
  assert.deepEqual(heard, ['crack', 'collapse']);

  // И возвращается — иначе второй игрок остался бы без пола навсегда.
  for (let i = 0; i < Math.ceil(tile.respawn * 60) + 2; i++) course.update(1 / 60, i / 60, sfx);
  assert.equal(tile.fallen, false, 'плитка обязана вернуться');
  assert.equal(tile.platform.disabled, false, 'вернувшаяся плитка снова пол');
  assert.deepEqual(heard, ['crack', 'collapse'], 'возвращение не должно ничего озвучивать');
});

// Ветер должен ощущаться. Первая версия прибавляла силу к скорости, а торможение управления в
// Player.step тянет скорость к желаемой каждый кадр — от прибавки оставались проценты. Формально
// механика работала, на деле её не было: «слишком слабый ветер».
test('ветер сносит заметно и даёт окно затишья', () => {
  const course = build('ch4');
  assert.ok(course.fans.length > 0, 'в этой главе должны быть вентиляторы');
  const fan = course.fans[0];

  // Прогон цикла: собираем силу порыва по всему периоду.
  const gusts = [];
  for (let i = 0; i <= Math.ceil(fan.period * 60); i++) {
    course.update(1 / 60, i / 60);
    gusts.push(fan.gust);
  }
  const peak = Math.max(...gusts);
  const calm = Math.min(...gusts);
  assert.ok(peak > 0.9, `на пике ветер должен дуть в полную силу, а не ${peak.toFixed(2)}`);
  assert.ok(calm < 0.25, `в затишье ветер должен почти стихать, а не ${calm.toFixed(2)}`);

  // Окно затишья — это и есть механика: должно хватать на переход, но не на прогулку.
  const quiet = gusts.filter(g => g < 0.35).length / gusts.length;
  assert.ok(quiet > 0.2, `окно затишья слишком узкое: ${(quiet * 100).toFixed(0)}% цикла`);
  assert.ok(quiet < 0.6, `затишье занимает почти весь цикл (${(quiet * 100).toFixed(0)}%) — это не ветер`);

  // Снос стоящего игрока за секунду на пике. Сравнивать надо с шириной дорожки: сдвиг меньше
  // единицы игрок просто не заметит.
  const still = {
    position: new THREE.Vector3(0, PLAYER_FOOT + 0.5, (fan.zMin + fan.zMax) / 2),
    velocity: new THREE.Vector3(),
    grounded: true,
    checkpoint: 0,
    impact: 0,
    respawn: () => {}
  };
  // Ставим цикл на пик и держим его там: интересует сила, а не форма кривой.
  const peakAt = gusts.indexOf(peak) / 60;
  const startX = still.position.x;
  for (let i = 0; i < 60; i++) {
    course.update(1 / 60, peakAt);
    course.interact(still, peakAt, null, null);
  }
  const drift = Math.abs(still.position.x - startX);
  assert.ok(
    drift > 2.5,
    `за секунду на пике должно сносить заметно, а сносит на ${drift.toFixed(2)} единицы`
  );
  // И при этом не мгновенно за край: полосу шириной 12 нельзя пересекать за полсекунды.
  assert.ok(drift < 9, `снос ${drift.toFixed(2)} за секунду — это уже не ветер, а телепорт`);

  course.dispose();
});

// Вентилятор без разметки — несправедливая механика: игрока тащит, а почему, он не видит.
test('у каждого вентилятора есть чем показать себя', () => {
  for (const id of ['ch4', 'ch5']) {
    const course = build(id);
    for (const fan of course.fans) {
      assert.ok(fan.rotors.length > 0, `${id}: у вентилятора нет лопастей`);
      assert.ok(fan.streaks.length >= fan.rotors.length, `${id}: полос потока меньше, чем турбин`);
      // Полосы анимируются по отдельности, поэтому материал у каждой обязан быть свой:
      // общий кэшированный материал погасил бы половину сцены разом.
      const materials = new Set(fan.streaks.map(streak => streak.mesh.material));
      assert.equal(materials.size, fan.streaks.length, `${id}: полосы делят один материал`);
    }
    course.dispose();
  }
});
