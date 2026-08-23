import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BUCKETS, anomalyMeasurements, bucketFor } = require('./movementAnomalyTelemetry');
const { budgetFor: raceBudget } = require('./movementAudit.js');
const { budgetFor: coopBudget } = require('./coopMovementAudit.js');

test('корзина отделяет сработавший признак от близкого к порогу', () => {
  // Признак становится находкой при count > budget. Значит `over` обязана совпадать с этим
  // условием ровно, а не приблизительно: иначе сводка и правило расходятся, и по сводке нельзя
  // будет сказать, сколько забегов реально потеряли зачёт.
  const budget = 4;
  assert.equal(bucketFor(4, budget), '75-100', 'ровно запас — ещё не находка');
  assert.equal(bucketFor(5, budget), 'over', 'на единицу больше запаса — уже находка');

  // Между нулём и запасом должно быть видно, кто насколько подошёл. Сейчас этого не видно вовсе.
  assert.equal(bucketFor(0, budget), '0-25');
  assert.equal(bucketFor(1, budget), '0-25');
  assert.equal(bucketFor(2, budget), '25-50');
  assert.equal(bucketFor(3, budget), '50-75');

  assert.deepEqual(BUCKETS, ['0-25', '25-50', '50-75', '75-100', 'over']);
});

test('запас без величины не делит на ноль и не прячет расход', () => {
  // Такого среди известных признаков нет, но `budgetFor` возвращает значение и для незнакомых имён,
  // а незнакомое имя — как раз тот случай, когда признак добавили, а запас назначить забыли.
  // Молча показать «расхода нет» тут хуже всего: новый признак остался бы невидимым.
  for (const broken of [0, -1, Number.NaN, undefined, null]) {
    assert.equal(bucketFor(3, broken), 'over', `сломанный запас: ${broken}`);
    assert.equal(bucketFor(0, broken), '0-25', `без расхода корзина не выдумывается: ${broken}`);
  }
});

test('молчащие признаки в сводку не идут', () => {
  // Записывать «этот признак не сработал» значило бы заполнить сводку строками про молчащие
  // проверки. Сколько было забегов всего, уже известно по `finish_time`.
  const measurements = anomalyMeasurements(
    { 'off-platform': 0, flight: 2, 'sustained-speed': 0 },
    raceBudget
  );
  assert.deepEqual(
    measurements.map(item => item.reason),
    ['flight']
  );
});

test('раскладка берёт запас того режима, в котором шёл забег', () => {
  // Один и тот же по смыслу признак называется в режимах по-разному и стоит разных запасов.
  // Перепутанный режим дал бы корзины, которые ни с чем не сходятся, и заметить это по сводке
  // было бы уже нельзя.
  assert.equal(raceBudget('flight'), 2);
  assert.equal(coopBudget('coop-flight'), 2);
  assert.equal(raceBudget('horizontal-acceleration'), 30);

  const race = anomalyMeasurements({ 'horizontal-acceleration': 20 }, raceBudget);
  assert.deepEqual(race, [{ reason: 'horizontal-acceleration', count: 20, budget: 30, bucket: '50-75' }]);

  // Тот же счёт по чужому запасу лёг бы в другую корзину — вот цена перепутанного режима.
  assert.equal(bucketFor(20, coopBudget('coop-observed-speed')), 'over');
});

test('порядок признаков не зависит от порядка обхода объекта', () => {
  // Сводку читает человек, и одинаковые забеги должны выглядеть одинаково.
  const forward = anomalyMeasurements({ flight: 1, 'off-platform': 1, 'ground-height': 1 }, raceBudget);
  const backward = anomalyMeasurements({ 'ground-height': 1, 'off-platform': 1, flight: 1 }, raceBudget);
  assert.deepEqual(
    forward.map(item => item.reason),
    ['flight', 'ground-height', 'off-platform']
  );
  assert.deepEqual(forward, backward);
});

test('мусор вместо счётчиков ничего не роняет', () => {
  // Отчётная метрика не имеет права уронить завершение матча: это была бы поломка игры ради
  // наблюдаемости.
  for (const broken of [null, undefined, 'нет', 42, []]) {
    assert.deepEqual(anomalyMeasurements(broken, raceBudget), [], `вход: ${JSON.stringify(broken)}`);
  }
  assert.deepEqual(anomalyMeasurements({ flight: 'много', 'off-platform': Number.NaN }, raceBudget), []);
  // Отсутствующая функция запаса — тоже не повод падать: признак попадёт в `over` и будет виден.
  assert.deepEqual(anomalyMeasurements({ flight: 1 }, null), [
    { reason: 'flight', count: 1, budget: Number.NaN, bucket: 'over' }
  ]);
});
