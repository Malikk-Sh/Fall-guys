// Распределение задержки между парой событий одного удара.
//
// Зачем оно существует. Паритет ударов на проде — 66.5 %: совпало 161 из 242, 34 удара видит только
// сервер, 47 только клиент. Причин ровно две — постоянный сдвиг по времени и разная геометрия
// препятствий, — и нынешние метрики их не различают, потому что пишут только ИТОГ сопоставления.
// Разница между парой событий в момент совпадения известна и просто выбрасывалась.
//
// Тест держит именно РАЗЛИЧАЮЩУЮ способность: каждый из трёх случаев должен читаться по-своему,
// иначе замер бесполезен. Проверяются те же три чтения, что описаны у самой функции.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EventPairing,
  HIT_MATCH_TOLERANCE_TICKS,
  createMatchDelayHistogram
} = require('./shadowInputRuntime');

// Прогон двух потоков событий через сопоставление, как это делает runtime: решённое складывается,
// задержки уходят в гистограмму.
//
// `stamp` — возраст клиентского снимка в тиках: столько времени проходит между тем, как клиент
// увидел удар, и тем, как сервер об этом узнал. Ноль означает «штампуем часами», то есть прежнее
// поведение.
function run(events, { tolerance = HIT_MATCH_TOLERANCE_TICKS, ticks = 400, stamp = 0 } = {}) {
  const pairing = new EventPairing(tolerance);
  const delays = createMatchDelayHistogram(tolerance);
  const totals = { matched: 0, leftOnly: 0, rightOnly: 0 };

  for (let tick = 0; tick <= ticks; tick++) {
    const decided = pairing.observe(tick, events.server.has(tick), events.client.has(tick), {
      tick: tick - stamp
    });
    totals.matched += decided.matched;
    totals.leftOnly += decided.leftOnly;
    totals.rightOnly += decided.rightOnly;
    for (const { ticks } of decided.delays || []) delays.add(ticks);
  }
  const tail = pairing.finalize();
  totals.leftOnly += tail.leftOnly;
  totals.rightOnly += tail.rightOnly;
  return { totals, delays: delays.snapshot() };
}

// Удары в одни и те же моменты у обеих сторон, сдвинутые на `offset` серверных тиков.
function pairedHits(moments, offset) {
  return {
    server: new Set(moments.map(t => t + offset)),
    client: new Set(moments)
  };
}

const MOMENTS = [20, 60, 100, 140, 180, 220, 260, 300];

test('совпадение день в день читается как нулевая задержка', () => {
  const { totals, delays } = run(pairedHits(MOMENTS, 0));
  assert.equal(totals.matched, MOMENTS.length);
  assert.equal(delays.samples, MOMENTS.length);
  assert.equal(delays.meanTicks, 0);
  assert.equal(delays.simultaneous, MOMENTS.length);
  assert.equal(delays.serverLeads, 0);
  assert.equal(delays.clientLeads, 0);
});

// Первое из трёх чтений: центр смещён — сдвиг есть, и знак говорит, кто опаздывает.
test('постоянный сдвиг виден как ненулевое среднее и перекос сторон', () => {
  const offset = 4;
  const { totals, delays } = run(pairedHits(MOMENTS, offset));

  assert.equal(totals.matched, MOMENTS.length, 'внутри допуска пары обязаны сойтись');
  assert.equal(delays.meanTicks, offset, 'среднее и есть величина сдвига');
  assert.equal(delays.clientLeads, MOMENTS.length, 'клиент раньше — сервер опаздывает');
  assert.equal(delays.serverLeads, 0);
  // Знак читается в обе стороны.
  const mirrored = run(pairedHits(MOMENTS, -offset));
  assert.equal(mirrored.delays.meanTicks, -offset);
  assert.equal(mirrored.delays.serverLeads, MOMENTS.length);
});

// Второе чтение: центр около нуля при разбросе — дрожание, а не сдвиг. По одному лишь `matchRate`
// этот случай неотличим от предыдущего, ради чего замер и делается.
test('дрожание вокруг нуля от сдвига отличается, хотя доля совпадений та же', () => {
  const jitter = [-3, 2, -1, 3, -2, 1, -3, 3];
  const events = {
    server: new Set(MOMENTS.map((t, i) => t + jitter[i])),
    client: new Set(MOMENTS)
  };
  const { totals, delays } = run(events);

  assert.equal(totals.matched, MOMENTS.length);
  assert.ok(Math.abs(delays.meanTicks) < 0.5, `центр обязан быть около нуля, а не ${delays.meanTicks}`);
  assert.ok(delays.serverLeads > 0 && delays.clientLeads > 0, 'обе стороны ведут примерно поровну');

  // Доля совпадений здесь та же, что и при сдвиге, — значит различает именно распределение.
  const shifted = run(pairedHits(MOMENTS, 4));
  assert.equal(totals.matched, shifted.totals.matched);
  assert.notEqual(Math.round(delays.meanTicks), Math.round(shifted.delays.meanTicks));
});

// Третье чтение, и самое важное: сдвиг БОЛЬШЕ допуска в гистограмму не попадает вовсе. Каждый
// настоящий удар превращается в пару односторонних — ровно та «симметрия», которую и наблюдаем на
// проде. Понять это можно только по краям, поэтому тест проверяет и то, что тело пустое.
test('сдвиг за пределом допуска не совпадает и в гистограмму не попадает', () => {
  const offset = HIT_MATCH_TOLERANCE_TICKS + 3;
  const { totals, delays } = run(pairedHits(MOMENTS, offset));

  assert.equal(totals.matched, 0, 'за допуском пар нет');
  assert.equal(totals.leftOnly, MOMENTS.length, 'сервер отдал по одностороннему на каждый удар');
  assert.equal(totals.rightOnly, MOMENTS.length, 'и клиент тоже — вот и симметрия');
  assert.equal(delays.samples, 0, 'задержка известна только для совпавших пар');
});

// Край допуска — граница между «видно» и «не видно», и она обязана быть ровно там, где заявлена.
test('сдвиг ровно на допуск ещё совпадает и попадает в крайнюю корзину', () => {
  const { totals, delays } = run(pairedHits(MOMENTS, HIT_MATCH_TOLERANCE_TICKS));
  assert.equal(totals.matched, MOMENTS.length);
  assert.equal(delays.meanTicks, HIT_MATCH_TOLERANCE_TICKS);
  // Рост к краю — признак обрезанного хвоста, и увидеть его можно только если край есть.
  assert.equal(delays.buckets.at(-1), MOMENTS.length);
  assert.equal(delays.buckets[0], 0);
});

test('гистограмма покрывает допуск целиком и раскладывает знак по местам', () => {
  const delays = createMatchDelayHistogram(3);
  assert.equal(delays.snapshot().buckets.length, 7, 'от -3 до +3 включительно');
  for (const ticks of [-3, -1, 0, 2, 3]) delays.add(ticks);
  const snapshot = delays.snapshot();
  assert.deepEqual(snapshot.buckets, [1, 0, 1, 1, 0, 1, 1]);
  assert.equal(snapshot.toleranceTicks, 3);
  assert.equal(snapshot.samples, 5);
});

test('мусор в гистограмму не попадает, а выходящее за допуск прижимается к краю', () => {
  const delays = createMatchDelayHistogram(3);
  assert.equal(delays.add(Number.NaN), false);
  assert.equal(delays.add(Number.POSITIVE_INFINITY), false);
  assert.equal(delays.snapshot().samples, 0);

  // Прижатие важнее отбрасывания: значение за допуском означает ошибку сопоставления, и потерять
  // её молча хуже, чем увидеть на краю.
  assert.equal(delays.add(99), true);
  assert.equal(delays.snapshot().buckets.at(-1), 1);
});

test('снимок не отдаёт наружу изменяемое нутро', () => {
  const delays = createMatchDelayHistogram(2);
  delays.add(1);
  const snapshot = delays.snapshot();
  snapshot.buckets[0] = 999;
  assert.equal(delays.snapshot().buckets[0], 0, 'правка снимка не должна менять счётчики');
});

// Возраст снимка — не расхождение симуляций, и путать их нельзя.
//
// Клиентский удар СЛУЧАЕТСЯ у клиента, а сервер лишь УЗНАЁТ о нём — из снимка, который старше на
// интервал рассылки плюс задержку сети. Пока обе стороны штамповались часами сервера, замер видел
// этот возраст как сдвиг: на проде вышло среднее −2.07 тика при 19 «сервер раньше» против 5
// «клиент раньше». Половина интервала рассылки (33 мс) плюс типичная задержка и есть эти 69 мс.
//
// Тест держит различающую способность: один и тот же поток событий, отмеченный своим временем,
// обязан дать нулевой центр, а отмеченный временем приёма — сдвиг ровно на возраст снимка.
//
// ВНИМАНИЕ на границу утверждения. Здесь `stamp` — вся задержка от удара до приёма, то есть отметка
// идеальная. В бою она такой не бывает: `courseTime` снимается в момент ОТПРАВКИ пакета, а сбивание
// случилось раньше, внутри предыдущего интервала рассылки. Поэтому в бою остаётся смещение около
// тика, и ждать нулевого центра на проде нельзя — см. отдельный тест ниже.
test('возраст снимка перестаёт читаться как сдвиг, когда удар отмечен своим временем', () => {
  const age = 3;
  // Клиент видит удар одновременно с сервером, но сервер узнаёт об этом на `age` тиков позже.
  const events = {
    server: new Set(MOMENTS),
    client: new Set(MOMENTS.map(t => t + age))
  };

  const byArrival = run(events);
  assert.equal(byArrival.totals.matched, MOMENTS.length);
  assert.equal(byArrival.delays.meanTicks, -age, 'по времени приёма виден сдвиг величиной в возраст');
  assert.equal(byArrival.delays.serverLeads, MOMENTS.length, 'и весь перекос на серверную сторону');

  const byClientClock = run(events, { stamp: age });
  assert.equal(byClientClock.totals.matched, MOMENTS.length, 'пары обязаны сойтись и после сдвига');
  assert.equal(byClientClock.delays.meanTicks, 0, 'своим временем центр обязан встать на ноль');
  assert.equal(byClientClock.delays.serverLeads, 0);
  assert.equal(byClientClock.delays.clientLeads, 0);
  assert.equal(byClientClock.delays.simultaneous, MOMENTS.length);
});

// Остаток смещения от дискретности рассылки. Он ОСТАЁТСЯ, и знать его величину важнее, чем делать
// вид, что починка полная.
//
// Клиент снимает `courseTime` при отправке пакета, а удар случился где-то внутри предыдущего
// интервала. Значит отметка завышена на возраст удара внутри интервала — равномерно от нуля до
// интервала, в среднем на его половину. Тест моделирует именно это: удары равномерно разбросаны по
// интервалу, а отмечены его концом.
test('дискретность рассылки оставляет смещение около половины интервала', () => {
  // Интервал рассылки — 66 мс, то есть ДВА серверных тика по 33 мс. Удар равновероятен в любой его
  // точке, поэтому перебор идёт дробно: целыми тиками получилось бы {0, 1} со средним 0.5 —
  // половина настоящего интервала, и тест благословил бы вдвое меньшее смещение, чем ожидается.
  const intervalTicks = 2;
  const steps = 400;

  const delays = createMatchDelayHistogram(HIT_MATCH_TOLERANCE_TICKS);
  for (let i = 0; i < steps; i++) {
    // Сервер видит удар в его настоящий момент; клиент отмечает КОНЦОМ интервала, то есть позже на
    // возраст удара внутри интервала. Гистограмма округляет — на среднем это не сказывается.
    const offset = (i / steps) * intervalTicks;
    delays.add(-offset);
  }
  const snapshot = delays.snapshot();
  assert.ok(
    Math.abs(snapshot.meanTicks + intervalTicks / 2) < 0.05,
    `ожидаемый остаток — половина интервала (−1), а получено ${snapshot.meanTicks}`
  );
  assert.ok(snapshot.serverLeads > snapshot.clientLeads, 'и перекос остаётся на серверную сторону');
  assert.equal(snapshot.clientLeads, 0, 'клиент опережать при этом не может вовсе');
});

test('настоящее расхождение отметка своим временем не прячет', () => {
  // Обратная сторона: если стороны и правда расходятся, выравнивание обязано это сохранить, а не
  // списать на возраст. Иначе починка замера превратилась бы в способ его ослепить.
  const age = 3;
  const divergence = 4;
  const events = {
    server: new Set(MOMENTS),
    client: new Set(MOMENTS.map(t => t + age + divergence))
  };
  const aligned = run(events, { stamp: age });
  assert.equal(aligned.totals.matched, MOMENTS.length);
  assert.equal(aligned.delays.meanTicks, -divergence, 'остаётся ровно расхождение, без возраста');
  assert.equal(aligned.delays.serverLeads, MOMENTS.length);
});

// Отметка задним числом ОКНО НЕ РАСШИРЯЕТ, и это осознанное ограничение починки.
//
// Просрочка закрывается по часам — иначе клиент, отметивший удар далёким прошлым, воскрешал бы
// пару, которой в реальном времени уже нет. А в ожиданиях лежат СОБСТВЕННЫЕ времена событий, и это
// намеренно: пара попадает в гистограмму, только когда истинная разница внутри допуска. Прежний
// порядок брал и пары с истинной разницей БОЛЬШЕ допуска — с заниженной задержкой, прижатой к
// крайней корзине, — то есть подделывал признак обрезанного хвоста, по которому этот случай и
// распознают.
//
// Цена — несимметричная полоса достижимых разниц: клиентское свидетельство опаздывает на возраст
// снимка, поэтому дальний хвост «сервер сильно раньше» до сопоставления не доживает. При боевых
// двух тиках из десяти остаётся восемь; при возрасте в полдопуска стоило бы думать заново.
test('отметка задним числом не растягивает допуск', () => {
  const age = 6;

  // Пришло внутри допуска — пара сходится, а задержка считается по СВОИМ временам: 20 против 22.
  const inside = run({ server: new Set([20]), client: new Set([28]) }, { stamp: age });
  assert.equal(inside.totals.matched, 1, 'пришедшее вовремя обязано сойтись');
  assert.equal(inside.delays.meanTicks, -2, 'задержка считается по отметкам, а не по приёму');

  // Пришло за допуском — пары нет, хотя ОТМЕТКИ отстоят всего на 9 тиков и формально влезли бы.
  // Вот это и значит «окно осталось окном приёма».
  const late = run({ server: new Set([20]), client: new Set([35]) }, { stamp: age });
  assert.equal(late.totals.matched, 0, 'опоздавшее не спасает даже отметка внутри допуска');
  assert.equal(late.totals.leftOnly, 1);
  assert.equal(late.totals.rightOnly, 1);
});

test('без отметки поведение прежнее — часы на обе стороны', () => {
  // Клиентское время бывает недостоверным (старый клиент, разъехавшиеся часы). Тогда штамп
  // остаётся прежним, и это должно быть ровно прежнее поведение, а не что-то третье.
  const events = { server: new Set(MOMENTS), client: new Set(MOMENTS.map(t => t + 3)) };
  const withoutStamp = run(events, { stamp: 0 });
  const explicit = (() => {
    const pairing = new EventPairing(HIT_MATCH_TOLERANCE_TICKS);
    const delays = createMatchDelayHistogram(HIT_MATCH_TOLERANCE_TICKS);
    let matched = 0;
    for (let tick = 0; tick <= 400; tick++) {
      // Четвёртого довода нет вовсе — умолчание обязано совпасть с явными часами.
      const decided = pairing.observe(tick, events.server.has(tick), events.client.has(tick));
      matched += decided.matched;
      for (const { ticks } of decided.delays || []) delays.add(ticks);
    }
    return { matched, delays: delays.snapshot() };
  })();
  assert.equal(withoutStamp.totals.matched, explicit.matched);
  assert.deepEqual(withoutStamp.delays, explicit.delays);
});

// Допуск проверяется по САМИМ ОТМЕТКАМ, а не только просрочкой по часам.
//
// Просрочки мало, и это стоило отдельного разбора: клиентская отметка едет назад на возраст снимка,
// а серверное ожидание живёт по часам. Снимок возрастом 15, принятый на тике 23, заставал в
// ожидании серверный удар с тика 20 и «совпадал» с ним, хотя отметки расходятся на 12 при допуске
// 10. Гистограмма прижимала такую пару к крайней корзине — то есть подделывала ровно тот признак
// обрезанного хвоста, по которому этот случай и распознают.
test('пара с отметками за допуском не засчитывается, даже если ожидание ещё живо', () => {
  const tolerance = HIT_MATCH_TOLERANCE_TICKS;
  const pairing = new EventPairing(tolerance);
  const delays = createMatchDelayHistogram(tolerance);
  const totals = { matched: 0, leftOnly: 0, rightOnly: 0 };
  const fold = decided => {
    totals.matched += decided.matched;
    totals.leftOnly += decided.leftOnly;
    totals.rightOnly += decided.rightOnly;
    for (const { ticks } of decided.delays || []) delays.add(ticks);
  };

  fold(pairing.observe(20, true, false));
  // Снимок возрастом 15 приходит на тике 23: по часам серверное ожидание ещё живо (23 − 20 = 3),
  // а по отметкам расхождение 20 − 8 = 12.
  fold(pairing.observe(23, false, true, { tick: 8, aligned: true }));
  fold(pairing.observe(40, false, false));
  const tail = pairing.finalize();
  totals.leftOnly += tail.leftOnly;
  totals.rightOnly += tail.rightOnly;

  assert.equal(totals.matched, 0, 'за допуском по отметкам пары быть не должно');
  assert.equal(totals.leftOnly, 1, 'серверное событие обязано остаться односторонним');
  assert.equal(totals.rightOnly, 1, 'и клиентское тоже');
  assert.equal(delays.snapshot().samples, 0, 'в гистограмму такая пара не попадает');
});

// Доля выровненных считается по ОБРАЗЦАМ ГИСТОГРАММЫ, а не по всем клиентским ударам.
//
// Иначе показатель врёт в самую опасную сторону: сотня выровненных ударов, ставших односторонними,
// и один невыровненный, составивший пару, дают «выровнено 99 %» при том, что каждый образец в
// гистограмме отмечен временем приёма.
test('признак выравнивания едет вместе с ожиданием и всплывает при выдаче задержки', () => {
  const pairing = new EventPairing(HIT_MATCH_TOLERANCE_TICKS);

  // Клиент пришёл первым, отмечен своим временем; сервер догоняет — задержка обязана унести
  // признак выравнивания с собой.
  const first = pairing.observe(10, false, true, { tick: 9, aligned: true, ageTicks: 1 });
  assert.equal(first.matched, 0);
  const second = pairing.observe(12, true, false);
  assert.deepEqual(second.delays, [{ ticks: 3, aligned: true, ageTicks: 1 }]);

  // И наоборот: невыровненное клиентское событие помечает пару как невыровненную.
  pairing.observe(40, true, false);
  const unaligned = pairing.observe(42, false, true);
  assert.deepEqual(unaligned.delays, [{ ticks: -2, aligned: false, ageTicks: null }]);

  // Возраст едет вместе с ожиданием и всплывает у того же образца — иначе его вычитали бы из
  // гистограммы, посчитав по другой совокупности.
  assert.equal(second.delays[0].ageTicks, 1, 'возраст обязан прийти от клиентского ожидания');
});

// Замер не имеет права трогать само сопоставление: `matchRate` — величина, по которой уже собраны
// боевые данные, и сдвинуть её значило бы порвать сравнимость с ними.
test('запись задержки не меняет ни одного решения сопоставления', () => {
  const events = {
    server: new Set([10, 12, 40, 100, 101]),
    client: new Set([11, 45, 100, 300])
  };
  const { totals } = run(events);
  // Инвариант тот же, на котором держится `pending` в runtime: пара забирает ДВА события, поэтому
  // сходится не число решений, а число событий.
  const consumed = 2 * totals.matched + totals.leftOnly + totals.rightOnly;
  assert.equal(consumed, events.server.size + events.client.size, 'ни одно событие не потеряно');
  assert.equal(totals.matched, 3, 'сошлись 10↔11, 40↔45 и 100↔100');
  assert.equal(totals.leftOnly, 2, 'серверные 12 и 101 пары не нашли');
  assert.equal(totals.rightOnly, 1, 'клиентский 300 остался хвостом и закрыт finalize');
});
