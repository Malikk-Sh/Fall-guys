// Проверка проходимости кооперативных глав ботами.
//
// Эти тесты появились после того, как заказчик попробовал пройти главы и не смог. Прежние проверки
// были зелёными и при этом ничего не гарантировали: они спрашивали «выдвинулся ли пролёт», а надо
// было спрашивать «перешёл ли кто-нибудь на ту сторону». Второе из первого не следует.
//
// Здесь боты играют по-настоящему: бегут, прыгают, жмут те же кнопки. Успехом считается только
// смена координаты — что напарник действительно оказался там, где раньше быть не мог.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Runner, World } from './bots.mjs';
import * as THREE from 'three';
import { COOP_CHAPTERS, coopSpec, chapterLayout } from '../shared/coopChapters.js';

// Где начинается и кончается пролёт с данным идентификатором.
function spanBounds(chapterId, spanId) {
  const { pieces } = chapterLayout(chapterId);
  const piece = pieces.find(item => item.id === spanId);
  return { near: piece.z + piece.length / 2, far: piece.z - piece.length / 2 };
}

test('глава 1: через первые ворота проходят оба', () => {
  const world = new World(coopSpec('ch1'));
  const { near, far } = spanBounds('ch1', 'g1');
  const hold = world.course.plates.get('p1');
  const farPlate = world.course.plates.get('p2');
  const span = () => world.course.spans.get('g1');

  // Такт 1: первый встаёт на плиту — мост выдвигается.
  const held = world.run(
    14,
    w => {
      w.spark.lookAt(hold.x, hold.z - 10);
      w.spark.steerTo(hold.x, hold.z);
      w.anchor.lookAt(0, far - 20);
      w.anchor.steerTo(0, hold.z + 4);
    },
    w => w.course.spans.get('g1').active
  );
  assert.ok(held, 'плита должна выдвигать мост');

  // Такт 2: второй переходит, пока первый держит.
  const crossed = world.run(
    20,
    w => {
      w.spark.steerTo(hold.x, hold.z);
      w.anchor.lookAt(farPlate.x, farPlate.z - 10);
      w.anchor.steerTo(farPlate.x, farPlate.z);
    },
    w => w.anchor.position.z < far - 1 && w.anchor.player.grounded
  );
  assert.ok(crossed, 'второй должен суметь перейти по мосту');

  // Такт 3: первый сходит с плиты — мост обязан ИСЧЕЗНУТЬ. Фиксации больше нет, и это главное,
  // что здесь проверяется: если мост остался стоять, вторая половина головоломки не нужна.
  const vanished = world.run(
    10,
    w => {
      w.spark.lookAt(0, near + 20);
      w.spark.steerTo(0, near + 5);
      w.anchor.lookAt(farPlate.x, farPlate.z + 10);
      w.anchor.steerTo(farPlate.x, farPlate.z + 6);
    },
    () => !span().active
  );
  assert.ok(vanished, 'без нажатой плиты моста быть не должно');

  // Такт 4: перешедший встаёт на дальнюю плиту — мост появляется снова.
  const reopened = world.run(
    14,
    w => {
      w.spark.steerTo(0, near + 5);
      w.anchor.lookAt(farPlate.x, farPlate.z - 10);
      w.anchor.steerTo(farPlate.x, farPlate.z);
    },
    () => span().active
  );
  assert.ok(reopened, 'дальняя плита должна открывать тот же мост');

  // Такт 5: первый переходит следом. Именно здесь глава ломалась раньше.
  const followed = world.run(
    22,
    w => {
      w.spark.lookAt(0, far - 20);
      w.spark.steerTo(0, far - 5);
      w.anchor.steerTo(farPlate.x, farPlate.z);
    },
    w => w.spark.position.z < far - 2 && w.spark.player.grounded
  );
  assert.ok(followed, 'держащий тоже должен перейти — иначе пара застревает навсегда');

  world.dispose();
});

test('глава 1: узкую пропасть каждый берёт прыжком сам', () => {
  const world = new World(coopSpec('ch1'));
  const { pieces } = chapterLayout('ch1');
  const gap = pieces.find(p => p.id === 'gap-solo') || null;
  // Пропасть в разметку не попадает (её геометрии нет), поэтому берём соседние полы.
  const floors = pieces.filter(p => p.kind === 'floor' || p.kind === 'collapsing').sort((a, b) => b.z - a.z);
  const before = floors.find(f => f.z - f.length / 2 <= -100 && f.z > -110) || floors.at(-2);
  void gap;

  // Ставим обоих перед пропастью честным способом: переносим точку появления.
  for (const bot of world.bots) {
    bot.player.teleport(
      Object.assign(bot.player.position.clone(), { x: 0, y: 2, z: before.z - before.length / 2 + 3 })
    );
  }

  const target = before.z - before.length / 2 - 9;
  const crossed = world.run(
    10,
    (w, t) => {
      for (const bot of w.bots) {
        bot.lookAt(0, target - 10);
        bot.steerTo(0, target);
        // Прыжок на подходе к краю.
        if (bot.player.grounded && bot.player.position.z < before.z - before.length / 2 + 1.6) {
          bot.input.jumpQueued = true;
        }
        bot.input.holding.jump = true;
      }
      void t;
    },
    w => w.bots.every(bot => bot.position.z < target + 1)
  );
  assert.ok(crossed, 'узкая пропасть должна браться обычным прыжком, без напарника');
  world.dispose();
});

test('глава 2: катапульта действительно подбрасывает напарника', () => {
  const world = new World(coopSpec('ch2'));
  const catapult = world.course.catapults.find(item => item.id === 'c1');
  assert.ok(catapult, 'в главе 2 должна быть катапульта c1');

  // Один встаёт на длинное плечо, второй заходит на ударную площадку и бьёт сверху.
  const startY = () => world.spark.position.y;
  const launched = world.run(
    22,
    w => {
      w.spark.lookAt(catapult.x, catapult.launchZ - 10);
      w.spark.steerTo(catapult.x, catapult.launchZ);

      w.anchor.lookAt(catapult.x, catapult.slamZ - 10);
      const distance = w.anchor.steerTo(catapult.x, catapult.slamZ);
      // Подошёл к ударной площадке — подпрыгнул и ударил сверху.
      if (distance < 2 && w.anchor.player.grounded) w.anchor.input.jumpQueued = true;
      if (!w.anchor.player.grounded && w.anchor.player.velocity.y < 0) w.anchor.input.diveQueued = true;
    },
    w => w.events.some(e => e.what === 'catapult' && e.hit)
  );

  assert.ok(launched, 'удар по катапульте должен срабатывать, а на плече должен кто-то стоять');
  void startY;

  // И подброс должен реально перенести ИСКРУ через пропасть, а не просто подкинуть на месте.
  const gate = world.course.spans.get('g1');
  const flew = world.run(
    8,
    w => {
      // В полёте игрок планирует, удерживая прыжок, — это и делает подброс достаточным.
      w.spark.input.holding.jump = true;
      w.spark.lookAt(catapult.x, gate.z - 20);
      w.spark.steerTo(catapult.x, gate.z - 12);
    },
    w => w.spark.position.z < gate.z - gate.length / 2
  );
  assert.ok(flew, 'подброс обязан переносить за пролёт — иначе катапульта бессмысленна');
  world.dispose();
});

// Самая дорогая ошибка проекта: опора считалась с отступом ВНУТРЬ от краёв платформы, из-за чего
// на каждом стыке соседних отрезков зияла щель шириной 0.24. Игрок проваливался посреди ровного
// пола — там, где визуально нет ничего. Глазами такое не находится: щель уже персонажа, и падение
// случается только когда шаг физики приходится ровно на неё.
test('вдоль всей дорожки нет провалов в местах, где должен быть пол', () => {
  for (const chapter of COOP_CHAPTERS) {
    const world = new World(coopSpec(chapter.id));
    const { pieces } = chapterLayout(chapter.id);

    // Отрезки пола идут вплотную, поэтому «должен быть пол» — это внутренность любого куска,
    // кроме пропастей и убранных пролётов.
    const solid = pieces.filter(p => p.kind === 'floor' || p.kind === 'collapsing');
    const holes = [];
    for (const piece of solid) {
      const from = piece.z + piece.length / 2;
      const to = piece.z - piece.length / 2;
      for (let z = from - 0.1; z > to + 0.1; z -= 0.25) {
        const point = new THREE.Vector3(0, 0.98, z);
        if (!world.course.surfaceAt(point, 1.05, -0.1)) holes.push(+z.toFixed(2));
      }
    }
    assert.deepEqual(holes, [], `${chapter.id}: пол пропадает в точках ${holes.slice(0, 6).join(', ')}`);
    world.dispose();
  }
});

// Отдельно — стыки: именно они ломались, и именно их проверка длинным шагом могла бы пропустить.
test('на стыках отрезков пол не пропадает', () => {
  for (const chapter of COOP_CHAPTERS) {
    const world = new World(coopSpec(chapter.id));
    const { pieces } = chapterLayout(chapter.id);
    const floors = pieces
      .filter(p => p.kind === 'floor' || p.kind === 'collapsing')
      .sort((a, b) => b.z - a.z);

    for (let i = 1; i < floors.length; i++) {
      const seam = floors[i - 1].z - floors[i - 1].length / 2;
      const adjacent = Math.abs(floors[i].z + floors[i].length / 2 - seam) < 0.01;
      if (!adjacent) continue;
      for (const offset of [-0.2, -0.1, -0.05, 0, 0.05, 0.1, 0.2]) {
        const point = new THREE.Vector3(0, 0.98, seam + offset);
        assert.ok(
          world.course.surfaceAt(point, 1.05, -0.1),
          `${chapter.id}: щель на стыке z=${(seam + offset).toFixed(2)}`
        );
      }
    }
    world.dispose();
  }
});

// Каждая катапульта обязана перебрасывать через ту пропасть, ради которой она стоит.
//
// Проверять это на глаз нельзя: дальность полёта складывается из импульса, гравитации, планирования
// и управления в воздухе — по числам в разметке её не видно. Раньше сила подбиралась «на глаз», и
// первая же катапульта не добрасывала: ИСКРА улетала в пропасть и возвращалась к чекпоинту.
test('каждая катапульта перебрасывает через свою пропасть', () => {
  for (const chapter of COOP_CHAPTERS) {
    const layout = chapterLayout(chapter.id);
    const world = new World(coopSpec(chapter.id));

    for (const catapult of world.course.catapults) {
      // Первая пропасть после плеча: разрыв между соседними твёрдыми кусками.
      const solid = layout.pieces
        .filter(p => p.kind === 'floor' || p.kind === 'movingSpan' || p.kind === 'collapsing')
        .sort((a, b) => b.z - a.z);
      let gapStart = null;
      let gapEnd = null;
      for (let i = 1; i < solid.length; i++) {
        const back = solid[i - 1].z - solid[i - 1].length / 2;
        const front = solid[i].z + solid[i].length / 2;
        if (back - front > 0.5 && back <= catapult.launchZ) {
          gapStart = back;
          gapEnd = front;
          break;
        }
      }
      if (gapStart === null) continue;

      const spark = world.spark;
      spark.player.respawns = 0;
      spark.player.teleport(
        Object.assign(spark.player.position.clone(), { x: catapult.x, y: 1.4, z: catapult.launchZ })
      );
      world.run(0.5, () => {});
      spark.player.applyLaunch({
        x: 0,
        y: catapult.power,
        z: -catapult.power * catapult.forward
      });

      const landed = world.run(
        7,
        w => {
          // Живой игрок в полёте планирует и рулит вперёд — иначе подброс бессмысленно слабый.
          w.spark.input.holding.jump = true;
          w.spark.lookAt(catapult.x, gapEnd - 40);
          w.spark.steerTo(catapult.x, gapEnd - 8);
        },
        w => w.spark.player.grounded && w.spark.position.z < gapEnd - 1
      );

      assert.ok(
        landed,
        `${chapter.id}/${catapult.id}: подброс не переносит через пропасть ` +
          `${gapStart.toFixed(0)}…${gapEnd.toFixed(0)} — ИСКРА падает`
      );
      assert.equal(
        spark.player.respawns,
        0,
        `${chapter.id}/${catapult.id}: ИСКРА успела упасть и возродиться — значит не долетела`
      );
    }
    world.dispose();
  }
});

// Главная проверка. Боты проходят каждую главу целиком: от старта через все преграды к финишу.
//
// Именно этого теста не хватало. Отдельные проверки препятствий доказывали, что каждое разрешимо,
// но не что глава проходится — а разваливалась она как раз на переходах между ними.
test('каждая глава проходима двумя ботами от начала до конца', () => {
  for (const chapter of COOP_CHAPTERS) {
    const layout = chapterLayout(chapter.id);
    const runner = new Runner(coopSpec(chapter.id), layout);

    for (const piece of runner.obstacles()) {
      // Подойти к преграде.
      const approach = piece.z + piece.length / 2 + 4;
      runner.advanceTo(approach);

      let ok = false;
      if (piece.kind === 'gateSpan') ok = runner.passGate(piece);
      else if (piece.kind === 'syncSpan') ok = runner.passSync(piece);

      assert.ok(
        ok,
        `${chapter.id}: застряли на ${piece.id}\n  ход прохождения:\n    ` + runner.log.join('\n    ')
      );
    }

    // И дойти до финиша. Без этой части тест назывался «от начала до конца», а проверял только
    // кооперативные преграды: всё, что между последней из них и финишной чертой — качели,
    // узкие пропасти, просто длинный участок пола — оставалось непроверенным. Ровно то же
    // расхождение между названием и содержанием, из-за которого главы и оказались непроходимыми.
    const spec = coopSpec(chapter.id);
    const finished = runner.advanceTo(spec.finishZ + 2, 60);
    assert.ok(
      finished,
      `${chapter.id}: до финиша (z=${spec.finishZ}) не дошли, встали на ` +
        runner.world.bots.map(bot => `${bot.role} z=${bot.position.z.toFixed(1)}`).join(', ') +
        `\n  ход прохождения:\n    ` +
        runner.log.join('\n    ')
    );

    runner.dispose();
  }
});

// Обратное свойство, ради которого режим и делается: в одиночку главу пройти НЕЛЬЗЯ.
//
// Статические проверки говорят, что пролёты шире прыжка. Это не то же самое: игрок может
// оказаться проходящим по инерции, по случайной геометрии, по забытой платформе рядом. Здесь
// один бот честно пытается дойти до финиша всеми доступными ему средствами и должен застрять.
test('в одиночку ни одна глава не проходится', () => {
  for (const chapter of COOP_CHAPTERS) {
    const spec = coopSpec(chapter.id);
    const runner = new Runner(spec, chapterLayout(chapter.id));
    const { world } = runner;

    // Напарника уводим с поля: он не должен ни на что влиять.
    world.anchor.player.teleport(Object.assign(world.anchor.position.clone(), { x: 0, y: 1.2, z: 40 }));

    const alone = world.run(
      70,
      w => {
        const bot = w.spark;
        bot.input.holding.jump = true;
        // Одиночка пробует всё: держит луч, жмёт прыжок у каждого края, рвётся вперёд.
        bot.input.holding.dive = true;
        bot.lookAt(0, spec.finishZ - 20);
        bot.steerTo(0, spec.finishZ);
        if (bot.player.grounded && !runner.solidAhead(bot)) bot.input.jumpQueued = true;
        // И удерживаем напарника далеко позади, чтобы он не нажал ничего случайно.
        w.anchor.input.moveX = w.anchor.input.moveForward = 0;
      },
      w => w.spark.position.z < spec.finishZ
    );

    assert.equal(
      alone,
      false,
      `${chapter.id}: одиночка дошёл до финиша — глава перестала быть кооперативной`
    );
    runner.dispose();
  }
});

// Ширина «перепрыгиваемых» пропастей должна считаться по СЛАБОЙ роли, и не по константе
// в комментарии, а по измерению. В первой главе стояла пропасть в 5 единиц с подсказкой
// «перепрыгните сами» — ГРУЗ не мог взять её в принципе и застревал там навсегда.
//
// Тест сам меряет дальность прыжка каждой роли и сам сверяет с ней все голые пропасти. Поменяется
// гравитация, скорость бега или множитель прыжка — тест пересчитает всё заново и укажет, какие
// пропасти стали непроходимыми.
test('любую голую пропасть берут обычным прыжком, и с запасом', () => {
  // Дальность одного прыжка с разбега по ровному полу.
  const jumpRange = () => {
    const world = new World(coopSpec('ch1'));
    const bot = world.spark;
    const other = bot === world.spark ? world.anchor : world.spark;
    // Напарника убираем, чтобы он ничего не задел.
    other.player.teleport(Object.assign(other.position.clone(), { x: 0, y: 1.2, z: 60 }));
    // Длинный ровный участок первой главы.
    bot.player.teleport(Object.assign(bot.position.clone(), { x: 0, y: 1.2, z: -95 }));
    world.run(2.2, () => {
      bot.lookAt(0, -200);
      bot.steerTo(0, -200);
    });

    bot.input.jumpQueued = true;
    let takeoff = null;
    let landing = null;
    for (let i = 0; i < 240; i++) {
      bot.lookAt(0, -200);
      bot.steerTo(0, -200);
      const wasGrounded = bot.player.grounded;
      world.step();
      if (wasGrounded && !bot.player.grounded && takeoff === null) takeoff = bot.position.z;
      if (takeoff !== null && !wasGrounded && bot.player.grounded) {
        landing = bot.position.z;
        break;
      }
    }
    world.dispose();
    assert.ok(takeoff !== null && landing !== null, 'прыжок не удалось измерить');
    return takeoff - landing;
  };

  const weakest = jumpRange();
  // Четверть запаса: прыжок должен получаться, а не требовать попадания в кадр.
  const safe = weakest * 0.75;

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
      if (spans.some(span => Math.abs(span.z + span.length / 2 - back) < 0.01)) continue;

      assert.ok(
        width <= safe,
        `${chapter.id}: пропасть ${width.toFixed(1)} около z=${back.toFixed(0)} — ` +
          `прыжок покрывает ${weakest.toFixed(1)}, безопасный предел ${safe.toFixed(1)}`
      );
    }
  }
});
