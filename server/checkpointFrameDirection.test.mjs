// Клиентский счётчик чекпоинтов обязан УМЕТЬ ДОГНАТЬ серверный.
//
// Рамки арки у клиента и сервера разные, и разными останутся: у гоночного клиента 10, у
// кооперативного `LANE_WIDTH` (12), у сервера `CHECKPOINT_HALF_WIDTH` (11). Кооперативные 12
// выглядят как обмолвка — рядом `LANE_WIDTH / 2` означает половину дорожки, — и тянет «исправить»
// их на 6. Гоночные 10, наоборот, у́же серверных 11, и тянет расширить.
//
// Ни то ни другое делать не надо, и вот почему. Разница в числах безопасна не сама по себе, а
// потому что клиентская проверка ДОГОНЯЮЩАЯ: она спрашивает «я за чертой?», и ответ остаётся
// истинным на всех следующих кадрах. Игрок, которому сервер арку засчитал, а клиент нет, получает
// её от клиента при первом же кадре внутри клиентской рамки — а внутри неё он оказывается сразу,
// как только его сносит обратно к оси.
//
// Серверная проверка так не умеет: пересечение случается один раз. Поэтому опасна только обратная
// подмена — заменить клиентское «я за чертой» на проверку пересечения. Тогда клиент, отставший
// однажды, отстанет навсегда, а клиент с неполным счётчиком не пошлёт финиш вовсе: забег не
// закончится ничем. Разбор — в шапке `shared/courseProgress.js`.
//
// Тест держит именно догоняемость, а не совпадение чисел. Он и написан после того, как я эту
// разницу принял за расхождение и чуть не «починил» число.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { Course } from '../client/game/Course.js';
import { CoopCourse } from '../client/game/CoopCourse.js';
import { courseSpec } from '../client/core/Config.js';
import { coopSpec, COOP_CHAPTER_IDS } from '../shared/coopChapters.js';
import { CHECKPOINT_HALF_WIDTH, crossedCheckpoint } from '../shared/courseProgress.js';

// Точка сбоку, где серверная рамка ещё засчитывает арку. Она заведомо шире гоночной клиентской.
const EDGE_X = CHECKPOINT_HALF_WIDTH - 0.5;

function withCourse(course, run) {
  try {
    return run(course);
  } finally {
    course.dispose();
  }
}

// Сервер засчитывает арку по ПЕРЕСЕЧЕНИЮ её плоскости, клиент — по положению за чертой.
function serverGrants(line, x, y = 1) {
  return crossedCheckpoint({ x, y, z: line + 0.5 }, { x, y, z: line - 0.5 }, line);
}

function assertCatchesUp(course, spec, label) {
  const line = spec.checkpoints[0];
  assert.ok(serverGrants(line, EDGE_X), `${label}: подготовка — сервер обязан засчитать край`);

  // Игрок пересёк арку у самого края. Клиент может арку не увидеть — и это законно.
  const atEdge = { x: EDGE_X, y: 1, z: line - 0.5 };
  const seenAtEdge = course.checkpointFor(atEdge, 0);

  // Главное: как только игрок оказывается внутри клиентской рамки, счётчик догоняет.
  const backOnTrack = { x: 0, y: 1, z: line - 4 };
  assert.equal(
    course.checkpointFor(backOnTrack, seenAtEdge),
    1,
    `${label}: клиент обязан догнать сервер, вернувшись к оси`
  );
  return seenAtEdge;
}

test('гоночный клиент догоняет сервер, даже когда арка взята с края', () => {
  const spec = courseSpec(4242, 'normal');
  const seen = withCourse(new Course(new THREE.Scene(), spec, { quality: 'low' }), course =>
    assertCatchesUp(course, spec, 'гонка')
  );
  // Гоночная рамка у́же серверной, поэтому отставание тут действительно возникает: без этого
  // проверка догоняемости выше ничего бы не проверяла.
  assert.equal(seen, 0, 'подготовка: на краю гоночный клиент арку не засчитывает');
});

test('кооперативный клиент догоняет сервер во всех главах', () => {
  for (const id of COOP_CHAPTER_IDS) {
    const spec = coopSpec(id);
    withCourse(new CoopCourse(new THREE.Scene(), spec, { quality: 'low' }), course =>
      assertCatchesUp(course, spec, `глава ${id}`)
    );
  }
});

// Догоняемость — свойство ФОРМЫ проверки, а не её ширины. Держим и форму: условие обязано остаться
// истинным на следующих кадрах, иначе отставание станет вечным.
test('клиентская проверка остаётся истинной и дальше по трассе, а не срабатывает однажды', () => {
  const spec = courseSpec(4242, 'normal');
  withCourse(new Course(new THREE.Scene(), spec, { quality: 'low' }), course => {
    const line = spec.checkpoints[0];
    for (const z of [line - 0.1, line - 3, line - 9, line - 17]) {
      assert.equal(
        course.checkpointFor({ x: 0, y: 1, z }, 0),
        1,
        `на z ${z} клиент обязан всё ещё видеть арку пройденной`
      );
    }
  });
});

// Обратная сторона: рамка не бесконечна ни у кого. Клиент, стоящий далеко за краем трассы, арку не
// засчитывает — иначе «догоняемость» означала бы просто «засчитывает всегда».
test('вне рамки клиент арку не засчитывает ни на клиенте гонки, ни на клиенте кооператива', () => {
  const raceSpec = courseSpec(4242, 'normal');
  withCourse(new Course(new THREE.Scene(), raceSpec, { quality: 'low' }), course => {
    assert.equal(course.checkpointFor({ x: 40, y: 1, z: raceSpec.checkpoints[0] - 4 }, 0), 0);
    assert.equal(course.checkpointFor({ x: 0, y: -20, z: raceSpec.checkpoints[0] - 4 }, 0), 0);
  });

  const chapter = coopSpec(COOP_CHAPTER_IDS[0]);
  withCourse(new CoopCourse(new THREE.Scene(), chapter, { quality: 'low' }), course => {
    assert.equal(course.checkpointFor({ x: 40, y: 1, z: chapter.checkpoints[0] - 4 }, 0), 0);
    assert.equal(course.checkpointFor({ x: 0, y: -20, z: chapter.checkpoints[0] - 4 }, 0), 0);
  });
});
