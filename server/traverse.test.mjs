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

test('глава 1: парные плиты — кто-то должен суметь перейти', () => {
  const world = new World(coopSpec('ch1'));
  const { far } = spanBounds('ch1', 'g1');
  const p1 = world.course.plates.get('p1');
  const p2 = world.course.plates.get('p2');

  // Оба идут к своим плитам и встают на них.
  const reached = world.run(
    12,
    w => {
      w.spark.lookAt(p1.x, p1.z - 10);
      w.anchor.lookAt(p2.x, p2.z - 10);
      w.spark.steerTo(p1.x, p1.z);
      w.anchor.steerTo(p2.x, p2.z);
    },
    w => w.course.plates.get('p1').pressed && w.course.plates.get('p2').pressed
  );
  assert.ok(reached, 'боты должны суметь дойти до плит и встать на них');
  assert.equal(world.course.spans.get('g1').active, true, 'на обеих плитах пролёт обязан быть');

  // А теперь главное: кто-то должен перейти на ту сторону. Именно здесь глава ломалась —
  // сойти с плиты значило убрать пролёт из-под напарника.
  const crossed = world.run(
    18,
    w => {
      w.spark.lookAt(p1.x, far - 20);
      w.anchor.lookAt(p2.x, far - 20);
      // Один остаётся на плите и держит, другой идёт вперёд.
      w.spark.steerTo(p1.x, p1.z);
      w.anchor.steerTo(p2.x, far - 6);
    },
    w => w.anchor.position.z < far - 2
  );
  assert.ok(crossed, 'ГРУЗ должен суметь перейти пролёт, пока ИСКРА держит плиту');

  // И второй тоже должен пройти — иначе глава кончается на первом же препятствии.
  const bothCrossed = world.run(
    18,
    w => {
      w.spark.lookAt(p1.x, far - 20);
      w.spark.steerTo(p1.x, far - 6);
    },
    w => w.spark.position.z < far - 2
  );
  assert.ok(bothCrossed, 'ИСКРА тоже должна суметь перейти — иначе пара застревает навсегда');

  world.dispose();
});

test('глава 1: узкую пропасть каждый берёт прыжком сам', () => {
  const world = new World(coopSpec('ch1'));
  const { pieces } = chapterLayout('ch1');
  const gap = pieces.find(p => p.id === 'gap-solo') || null;
  // Пропасть в разметку не попадает (её геометрии нет), поэтому берём соседние полы.
  const floors = pieces.filter(p => p.kind === 'floor').sort((a, b) => b.z - a.z);
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

  // ИСКРА встаёт на длинное плечо, ГРУЗ заходит на ударную площадку и бьёт сверху.
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

  assert.ok(launched, 'ГРУЗ должен суметь ударить по катапульте, а на плече должен кто-то стоять');
  void startY;

  // И подброс должен реально перенести ИСКРУ через пропасть, а не просто подкинуть на месте.
  const gate = world.course.spans.get('g1');
  const flew = world.run(
    8,
    w => {
      // В полёте ИСКРА планирует — это и делает подброс достаточным.
      w.spark.input.holding.jump = true;
      w.spark.lookAt(catapult.x, gate.z - 20);
      w.spark.steerTo(catapult.x, gate.z - 12);
    },
    w => w.spark.position.z < gate.z - gate.length / 2
  );
  assert.ok(flew, 'подброс обязан переносить ИСКРУ за пролёт — иначе катапульта бессмысленна');
  world.dispose();
});

test('глава 3: ИСКРА может навести луч со своей площадки', () => {
  const world = new World(coopSpec('ch3'));
  const emitter = world.course.emitters.get('e1');
  assert.ok(emitter, 'в главе 3 должен быть излучатель e1');

  // ИСКРА идёт к площадке, забирается на неё и наводит луч.
  const aimed = world.run(
    26,
    w => {
      const bot = w.spark;
      bot.input.holding.dive = true;
      bot.lookAt(emitter.position.x, emitter.position.z);
      const distance = bot.steerTo(emitter.position.x, emitter.position.z);
      // Площадка приподнята — на неё надо запрыгнуть.
      if (bot.player.grounded && distance < 6) bot.input.jumpQueued = true;
      bot.input.holding.jump = true;
    },
    w => w.course.spans.get('b1').active
  );
  assert.ok(aimed, 'ИСКРА обязана суметь навести луч и поднять мост — иначе главу не пройти');
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
    const solid = pieces.filter(p => p.kind === 'floor');
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
    const floors = pieces.filter(p => p.kind === 'floor').sort((a, b) => b.z - a.z);

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
        .filter(p => p.kind === 'floor' || p.kind === 'movingSpan')
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

// Луч не наводился вблизи, а обучение как раз велит подняться на площадку и встать рядом.
// Причина: направление на излучатель бралось в трёх измерениях, а взгляд по построению
// горизонтален — чем ближе к столбу, тем круче вверх смотрел вектор на цель. Игрок делал всё
// правильно, кнопку держал, и ничего не происходило.
test('луч наводится с любой дистанции, включая площадку под излучателем', () => {
  for (const chapter of COOP_CHAPTERS) {
    const world = new World(coopSpec(chapter.id));
    for (const emitter of world.course.emitters.values()) {
      const look = new THREE.Vector3(0, 0, -1);
      for (const distance of [20, 12, 6, 4, 2, 1]) {
        const from = new THREE.Vector3(emitter.position.x, 1.0, emitter.position.z + distance);
        assert.equal(
          world.course.aimedEmitter(from, look),
          emitter.id,
          `${chapter.id}/${emitter.id}: не наводится с ${distance} единиц`
        );
      }
      // И стоя прямо под ним, на самой площадке.
      const under = new THREE.Vector3(emitter.position.x, emitter.position.y - 1.2, emitter.position.z + 0.5);
      assert.equal(
        world.course.aimedEmitter(under, look),
        emitter.id,
        `${chapter.id}/${emitter.id}: не наводится с площадки, куда отправляет подсказка`
      );
    }
    world.dispose();
  }
});

// Обратная сторона: отвернувшись, луч терять надо — иначе мост держался бы сам собой.
test('отвернувшись от излучателя, наводку теряем', () => {
  const world = new World(coopSpec('ch3'));
  const emitter = world.course.emitters.get('e1');
  const from = new THREE.Vector3(emitter.position.x, 1.0, emitter.position.z + 10);
  assert.equal(world.course.aimedEmitter(from, new THREE.Vector3(0, 0, -1)), 'e1');
  assert.equal(
    world.course.aimedEmitter(from, new THREE.Vector3(0, 0, 1)),
    null,
    'взгляд в противоположную сторону не должен держать мост'
  );
  assert.equal(
    world.course.aimedEmitter(from, new THREE.Vector3(1, 0, 0)),
    null,
    'взгляд вбок не должен держать мост'
  );
  world.dispose();
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
      else if (piece.kind === 'beamSpan') ok = runner.passBeam(piece);
      else if (piece.kind === 'syncSpan') ok = runner.passSync(piece);

      assert.ok(
        ok,
        `${chapter.id}: застряли на ${piece.id}\n  ход прохождения:\n    ` + runner.log.join('\n    ')
      );
    }

    runner.dispose();
  }
});
