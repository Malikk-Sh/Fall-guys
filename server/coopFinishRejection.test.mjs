// Отказ в финише в КООПЕРАТИВЕ.
//
// Обработчик финиша один на оба режима, а геометрия возврата — нет. Отказ появился как гоночная
// починка (см. `raceFinishRejectionRecovery`) и вернул пару туда, куда возвращает гонка: на ось, на
// 6.2 единицы назад и ПЕРЕД аркой, которую пара уже прошла. Кооператив возвращает иначе, и это его
// заявленное правило — сразу за аркой, «чтобы игрок не пересекал её повторно», и по своей половине
// дорожки, чтобы напарники не стояли в одной точке.
//
// Обработчик возрождения (`C2S.RESPAWN`) различие соблюдал всегда. Отказ в финише — нет.

import test from 'node:test';
import assert from 'node:assert/strict';

import { canFinish, finishRejection, spawnFor } from './gameRules.js';
import { coopSpec, coopSpawnFor, COOP_CHAPTER_IDS, chapterLayout } from '../shared/coopChapters.js';
import { createCourseSpec } from '../shared/courseSpec.js';

const spec = coopSpec('ch1');

// Пара дошла до ленты, но одну арку сервер ей не засчитал.
function shortOfAnArch(slot = 0) {
  return {
    slot,
    checkpoint: spec.segmentCount - 1,
    last: { x: 3.4, y: -1.4, z: spec.finishZ - 2, vx: 0, vy: -9, vz: -6, state: 'air' }
  };
}

test('в кооперативе отказ возвращает по кооперативной геометрии, а не по гоночной', () => {
  const player = shortOfAnArch();
  assert.equal(canFinish(player, spec), false);

  const rejection = finishRejection(player, spec);
  assert.equal(rejection.reason, 'checkpoint-missing');
  assert.deepEqual(rejection.position, coopSpawnFor(spec, player.checkpoint, 0));
  // И это действительно ДРУГАЯ точка: иначе проверка выше ничего не значит.
  assert.notDeepEqual(rejection.position, spawnFor(spec, player.checkpoint));
});

test('напарники расходятся по своим половинам дорожки, а не встают в одну точку', () => {
  const first = finishRejection(shortOfAnArch(0), spec).position;
  const second = finishRejection(shortOfAnArch(1), spec).position;

  assert.notEqual(first.x, second.x, 'два игрока не должны получить одну и ту же точку');
  assert.equal(first.x, -2.2);
  assert.equal(second.x, 2.2);
  // Гоночная геометрия слота не знает вовсе — там оба оказывались на оси.
  assert.equal(spawnFor(spec, 1).x, 0);
});

test('точка возврата лежит ЗА уже пройденной аркой и ПЕРЕД непройденной', () => {
  const player = shortOfAnArch();
  const position = finishRejection(player, spec).position;
  const passed = spec.checkpoints[player.checkpoint - 1];
  const missing = spec.checkpoints[player.checkpoint];

  // Прогресс идёт в минус по Z: «за аркой» значит z меньше её координаты.
  assert.ok(position.z < passed, `${position.z} обязана быть за пройденной аркой ${passed}`);
  // Но не настолько далеко, чтобы непройденную нельзя было пересечь: её надо ещё догнать.
  assert.ok(position.z > missing, `${position.z} обязана быть перед непройденной аркой ${missing}`);
});

test('без слота отказ всё равно даёт кооперативную точку, а не гоночную', () => {
  const player = { checkpoint: spec.segmentCount - 1, last: null };
  const position = finishRejection(player, spec).position;
  assert.deepEqual(position, coopSpawnFor(spec, player.checkpoint, 0));
});

test('в начале главы пара получает свой стартовый угол, а не общий центр', () => {
  const position = finishRejection({ slot: 1, checkpoint: 0, last: null }, spec).position;
  assert.deepEqual(position, { ...spec.starts[1] });
  assert.notDeepEqual(position, { ...spec.start });
});

test('вторая причина отказа место не меняет и в кооперативе', () => {
  // Все арки пройдены, последнее состояние до ленты не дошло — добежать можно с места.
  const player = {
    slot: 0,
    checkpoint: spec.segmentCount,
    last: { x: -1.2, y: 1.35, z: spec.finishZ + 4, vx: 0, vy: 0, vz: -8, state: 'ground' }
  };
  const rejection = finishRejection(player, spec);
  assert.equal(rejection.reason, 'finish-validation');
  assert.deepEqual(rejection.position, player.last);
});

test('гоночный отказ кооперативной геометрии не набирается', () => {
  // Обратная сторона: правка не должна была тронуть гонку. Спека гонки `chapterId` не несёт.
  const race = createCourseSpec(4242, 'normal');
  const player = { slot: 1, checkpoint: race.segmentCount - 1, last: null };
  assert.equal(race.chapterId, undefined);
  assert.deepEqual(finishRejection(player, race).position, spawnFor(race, player.checkpoint));
});

// Место возврата обязано быть тем же куском главы, на который пару ставит обычное возрождение.
// Гоночная точка на 6.2 единицы назад иногда попадала на соседний кусок — и дважды на осыпающийся
// пол, который под ногами пропадает.
test('во всех главах точка возврата совпадает с той, куда пару ставит возрождение', () => {
  const pieceKindAt = (pieces, z) =>
    pieces
      .filter(piece => Math.abs(piece.z - z) <= piece.length / 2 + 0.01)
      .map(piece => piece.kind)
      .join('|');

  let checked = 0;
  for (const id of COOP_CHAPTER_IDS) {
    const chapter = coopSpec(id);
    const pieces = chapterLayout(id).pieces;
    for (let checkpoint = 1; checkpoint <= chapter.segmentCount; checkpoint++) {
      const player = { slot: 0, checkpoint, last: null };
      // Отказ по непройденной арке требует, чтобы арок не хватало: подставляем не последнюю.
      if (checkpoint >= chapter.segmentCount) continue;
      const position = finishRejection(player, chapter).position;
      const respawn = coopSpawnFor(chapter, checkpoint, 0);
      assert.deepEqual(position, respawn, `${id}, чекпоинт ${checkpoint}`);
      assert.equal(
        pieceKindAt(pieces, position.z),
        pieceKindAt(pieces, respawn.z),
        `${id}, чекпоинт ${checkpoint}: возврат и возрождение обязаны быть на одном куске главы`
      );
      checked++;
    }
  }
  assert.ok(checked >= 20, `проверено всего ${checked} чекпоинтов — выборка обязана быть полной`);
});
