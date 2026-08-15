// Трасса сквозных браузерных тестов и правило, по которому её разрешено укорачивать.
//
// Playwright гоняет полный матч на фиксированной трассе: WOBBLE_FIXED_SEED задаёт сид, а
// WOBBLE_E2E_SEGMENTS — длину (см. playwright.config.js). Ни то, ни другое не выбрано наугад:
// водитель в тесте намеренно простой — держит «вперёд», подруливает к оси и жмёт прыжок, — и
// трасса под него подобрана замером.
//
// Зачем этот файл. Сид задаёт трассу не сам по себе: он проходит через генератор, и любое изменение
// генератора — новый тип сегмента, другой порядок ролей, правка перемешивания — тихо выдаёт по тому
// же числу ДРУГУЮ трассу. Обнаружилось бы это только падением Playwright: двенадцать минут прогона,
// два браузера и сообщение «хост обязан дойти до финиша», из которого причину не видно вовсе.
//
// Здесь то же самое ловится за долю секунды и называет себя по имени. Если этот тест упал —
// генератор изменился, и сид надо подобрать заново (инструмент: tools/e2eSeedSweep.mjs), а не
// «чинить» браузерный тест.
//
// Как подбирался сид 184:
//   • простой водитель гонялся на 112 вариантах тайминга (период решения 100–700 мс × 8 фаз) —
//     период в браузере плавает, потому что обмен со страницей стоит по-разному, а на раннере CI
//     программный WebGL роняет FPS;
//   • и в одиночку, и вдвоём с настоящим расталкиванием участников: в матче водители мешают
//     друг другу, и сид, годный только для одного, ничего не гарантировал бы;
//   • годным считался только сид, прошедший ВСЕ варианты без единого не дошедшего прогона.
// Результат: 112/112 в обоих составах, худшее время 20.0 с при бюджете 150 с. Из 200 проверенных
// сидов это условие выдержал единственный кандидат с таким запасом.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCourseSpec, DIFFICULTY_SEGMENTS } from '../shared/courseSpec.js';
import { e2eSegmentCount, MIN_SEGMENTS } from './e2eCourse.js';

// Ровно те значения, что стоят в playwright.config.js. Продублированы намеренно: тест обязан
// сломаться и в том случае, если трассу поменяют в конфиге, не подобрав новую.
const E2E_SEED = 184;
const E2E_DIFFICULTY = 'easy';
const E2E_SEGMENTS = 3;

const e2eSpec = () => createCourseSpec(E2E_SEED, E2E_DIFFICULTY, E2E_SEGMENTS);

test('трасса сквозных тестов остаётся той, под которую подобран сид', () => {
  assert.deepEqual(
    e2eSpec().segments.map(segment => `${segment.type}/v${segment.variant}`),
    ['bumpers/v1', 'bounce/v2', 'crosswind/v3'],
    'план трассы E2E изменился — сид надо подобрать заново, см. заголовок файла'
  );
});

test('трасса сквозных тестов — настоящая гонка, а не пустой коридор', () => {
  const spec = e2eSpec();
  const types = spec.segments.map(segment => segment.type);

  // Три сегмента и три разных типа: тест бежит по нормальной трассе с препятствиями, а не по
  // расчищенной дорожке. Подобранный сид без этого условия обесценил бы весь сценарий.
  assert.equal(types.length, E2E_SEGMENTS);
  assert.equal(new Set(types).size, E2E_SEGMENTS, 'каждый сегмент — своего типа');

  // Узкий мост исключён сознательно: там прохождение держится на точном моменте прыжка, а простой
  // водитель момент не выбирает. Это не «слишком сложно для игры» — это не его зона ответственности.
  assert.equal(types.includes('bridge'), false, 'узкий мост в E2E-трассе не участвует');

  // Чекпоинты и финиш пересчитаны под укороченную длину, а не остались от полной трассы: по ним
  // сервер засчитывает прохождение, и рассогласование здесь означало бы незакрываемый забег.
  assert.equal(spec.segmentCount, E2E_SEGMENTS);
  assert.equal(spec.checkpoints.length, E2E_SEGMENTS);
  assert.equal(spec.finishZ, -18 * E2E_SEGMENTS - 13);
});

// Дальше — про сам override. Он трогает правило игры, поэтому проверяется не «работает ли», а
// «нельзя ли получить его случайно».

test('без тестового флага переменная длины не читается вовсе', () => {
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E_SEGMENTS: '3' }), null);
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E: '0', WOBBLE_E2E_SEGMENTS: '3' }), null);
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E: 'true', WOBBLE_E2E_SEGMENTS: '3' }), null);
  assert.equal(e2eSegmentCount('easy', {}), null);
});

test('с флагом, но без длины трасса остаётся обычной', () => {
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E: '1' }), null);
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E: '1', WOBBLE_E2E_SEGMENTS: '' }), null);
});

test('оба флага вместе укорачивают трассу заданной сложности', () => {
  assert.equal(e2eSegmentCount('easy', { WOBBLE_E2E: '1', WOBBLE_E2E_SEGMENTS: '3' }), 3);
  assert.equal(e2eSegmentCount('chaos', { WOBBLE_E2E: '1', WOBBLE_E2E_SEGMENTS: '6' }), 6);
});

test('негодное значение падает сразу, а не притворяется обычной трассой', () => {
  const env = value => ({ WOBBLE_E2E: '1', WOBBLE_E2E_SEGMENTS: value });
  // Молча проигнорированный override означал бы полную трассу и падение Playwright через
  // двенадцать минут с сообщением, из которого причину не видно.
  assert.throws(() => e2eSegmentCount('easy', env('три')), /ожидалось целое/);
  assert.throws(() => e2eSegmentCount('easy', env('3.5')), /ожидалось целое/);
  assert.throws(() => e2eSegmentCount('easy', env(String(MIN_SEGMENTS - 1))), /допустимо от/);
  // Удлинить нельзя: тестовый флаг существует ради короткого прогона, а не ради новой игры.
  assert.throws(() => e2eSegmentCount('easy', env(String(DIFFICULTY_SEGMENTS.easy))), /допустимо от/);
  assert.throws(() => e2eSegmentCount('easy', env('99')), /допустимо от/);
});
