// Отказ в финише обязан быть ВЫХОДОМ, а не кругом.
//
// Игрок, пролетевший сбоку от финишной арки над пустотой, не заканчивал забег вовсе: экран
// оставался в «Подтверждаем результат…», персонаж висел в воздухе. Механика была такая:
//
//  1. клиент засчитывает последний чекпоинт (его правило — «я за чертой», и оно срабатывает, когда
//     игрока сносит обратно к оси уже ЗА аркой);
//  2. сервер тот же чекпоинт не засчитывает (его правило — ПЕРЕСЕЧЕНИЕ, а в момент пересечения
//     игрок был вне рамок);
//  3. клиент шлёт финиш, сервер отказывает и возвращает игрока в `player.last` — ровно ту точку,
//     из которой отказал;
//  4. в этой точке снова выполняется клиентское условие финиша (`z < finishZ`, `y > -3`), клиент
//     шлёт финиш ещё раз — и так каждый кадр, без конца.
//
// Тест держит именно замыкание: точка возврата обязана НЕ удовлетворять условию финиша на клиенте,
// когда причина отказа — непройденная арка. Порог `y > -3` и границу `z < finishZ` тест берёт из
// клиентского кода (client/game/Player.js), а не выдумывает свои.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCourseSpec, canFinish, finishRejection, spawnFor } from './gameRules.js';

const spec = createCourseSpec(4242, 'normal');

// Условие финиша на клиенте — см. Player.step. Держим его здесь одной функцией: если клиентское
// правило изменится, а это — нет, тест начнёт проверять несуществующее замыкание.
const clientWouldFinish = (position, checkpoint) =>
  checkpoint >= spec.segmentCount && position.z < spec.finishZ && position.y > -3;

// Игрок над пустотой сбоку от финишной арки: за чертой, ещё не упал, последней арки серверу не
// предъявил.
const besideTheFinish = () => ({
  checkpoint: spec.segmentCount - 1,
  last: { x: 14, y: -1.2, z: spec.finishZ - 2, vx: 0, vy: -9, vz: -6, state: 'air' }
});

test('пролёт сбоку от финиша: сервер финиш не принимает', () => {
  const player = besideTheFinish();
  assert.equal(canFinish(player, spec), false);
});

test('клиент в этой же точке считает, что финишировал', () => {
  const player = besideTheFinish();
  // Клиент своё правило чекпоинта уже применил и держит счётчик полным — в этом и расхождение.
  assert.equal(clientWouldFinish(player.last, spec.segmentCount), true);
});

test('отказ из-за непройденной арки не возвращает игрока туда, где он снова финиширует', () => {
  const player = besideTheFinish();
  const rejection = finishRejection(player, spec);

  assert.equal(rejection.reason, 'checkpoint-missing');
  // Вот это и есть разомкнутая петля: с точки возврата клиент финиш не пошлёт.
  assert.equal(clientWouldFinish(rejection.position, spec.segmentCount), false);
});

test('точка возврата лежит ПЕРЕД непройденной аркой, а не за ней', () => {
  const player = besideTheFinish();
  const rejection = finishRejection(player, spec);
  const missingArch = spec.checkpoints[player.checkpoint];

  // Прогресс идёт в минус по Z: «перед аркой» значит z больше её координаты.
  assert.ok(
    rejection.position.z > missingArch,
    `точка возврата ${rejection.position.z} должна быть перед аркой ${missingArch}`
  );
  assert.deepEqual(rejection.position, spawnFor(spec, player.checkpoint));
});

test('пересечение арки с точки возврата серверу видно', () => {
  const player = besideTheFinish();
  const rejection = finishRejection(player, spec);
  const missingArch = spec.checkpoints[player.checkpoint];

  // Условие пересечения из validateState: предыдущее состояние перед чертой, новое — за ней.
  // Если бы точка возврата лежала за аркой, оно не выполнилось бы уже никогда.
  assert.ok(rejection.position.z >= missingArch);
});

test('старое поведение — возврат в last — замыкало петлю', () => {
  const player = besideTheFinish();
  // Ровно то, что стояло в обработчике C2S.FINISH до исправления.
  const legacyPosition = player.last;
  assert.equal(clientWouldFinish(legacyPosition, spec.segmentCount), true);
  assert.notDeepEqual(finishRejection(player, spec).position, legacyPosition);
});

test('вторая причина отказа лечится повтором с места и место не меняет', () => {
  // Все арки пройдены, но последнее состояние до ленты не дошло: сервер видит игрока перед ней.
  const player = {
    checkpoint: spec.segmentCount,
    last: { x: 0.4, y: 1.1, z: spec.finishZ + 4, vx: 0, vy: 0, vz: -8, state: 'ground' }
  };
  assert.equal(canFinish(player, spec), false);

  const rejection = finishRejection(player, spec);
  assert.equal(rejection.reason, 'finish-validation');
  // Здесь откатывать некуда и незачем: игроку осталось добежать четыре единицы.
  assert.deepEqual(rejection.position, player.last);
  assert.equal(clientWouldFinish(rejection.position, spec.segmentCount), false);
});

test('без принятого состояния отказ всё равно даёт точку, а не undefined', () => {
  const player = { checkpoint: spec.segmentCount, last: null };
  const rejection = finishRejection(player, spec);
  assert.deepEqual(rejection.position, spawnFor(spec, spec.segmentCount));
});

test('игрок в самом начале трассы получает свой стартовый спавн', () => {
  const player = { checkpoint: 0, last: { x: 0, y: 1, z: spec.finishZ - 1 } };
  const rejection = finishRejection(player, spec);
  assert.equal(rejection.reason, 'checkpoint-missing');
  assert.deepEqual(rejection.position, spawnFor(spec, 0));
  assert.deepEqual(rejection.position, { ...spec.start });
});
