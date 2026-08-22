import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EventPairing } = require('./shadowInputRuntime');

// Сопоставление сбивающих ударов сервера с сбиваниями, видимыми у клиента.
//
// Величина, которую оно даёт, — одно из двух доказательств, по которым однажды будут открывать
// ворота движения. Поэтому здесь проверяется не «примерно похоже», а ровно заявленное поведение:
// границы допуска, независимость игроков и судьба хвостовых событий.

// Складывает то, что вернули вызовы, — так же, как это делает runtime.
function totalsOf(...decisions) {
  const total = { left: 0, right: 0, matched: 0, leftOnly: 0, rightOnly: 0 };
  for (const decided of decisions) {
    for (const key of Object.keys(total)) total[key] += decided[key];
  }
  return total;
}

function idleUntil(pairing, from, to) {
  const decisions = [];
  for (let tick = from; tick <= to; tick++) decisions.push(pairing.observe(tick, false, false));
  return decisions;
}

test('допуск в 10 тиков значит ровно 10', () => {
  // Ровно на границе пара обязана сойтись.
  const onEdge = new EventPairing(10);
  const opened = onEdge.observe(0, true, false);
  const closed = onEdge.observe(10, false, true);
  const edge = totalsOf(opened, ...idleUntil(onEdge, 1, 9), closed);
  assert.equal(edge.matched, 1, 'разница в 10 тиков обязана считаться совпадением');
  assert.equal(edge.leftOnly, 0);

  // На тик дальше — уже нет. Раньше сходилось и это: просрочка закрывалась ПОСЛЕ сопоставления,
  // и ожидание возраста 11 успевало найти пару прежде, чем его удаляли.
  const past = new EventPairing(10);
  const openedLate = past.observe(0, true, false);
  const late = totalsOf(openedLate, ...idleUntil(past, 1, 10), past.observe(11, false, true));
  assert.equal(late.matched, 0, 'разница в 11 тиков совпадением быть не должна');
  assert.equal(late.leftOnly, 1, 'удар сервера обязан остаться выдуманным');
  assert.equal(late.right, 1);
});

test('события разных игроков не закрывают друг друга', () => {
  // Ожидания живут у КАЖДОГО игрока свои. Пока набор был один на весь runtime, удар сервера по
  // игроку A мог закрыться сбиванием игрока B, оказавшимся рядом по времени. Ошибка приукрашивающая:
  // чужая пара повышает долю совпадений и снижает число выдуманных ударов.
  const alice = new EventPairing(10);
  const bob = new EventPairing(10);

  // Сервер ударил Алису; у Алисы сбивания не было. У Боба сбивание было, а сервер его не бил.
  const decisions = [alice.observe(0, true, false), bob.observe(1, false, true)];
  // Оба ожидания доживают до просрочки.
  for (let tick = 2; tick <= 12; tick++) {
    decisions.push(alice.observe(tick, false, false), bob.observe(tick, false, false));
  }
  const totals = totalsOf(...decisions);

  assert.equal(totals.matched, 0, 'удар по одному игроку не может закрыться сбиванием другого');
  assert.equal(totals.leftOnly, 1, 'выдуманный сервером удар обязан остаться выдуманным');
  assert.equal(totals.rightOnly, 1, 'прозеванное сбивание обязано остаться прозеванным');
});

test('хвостовые события забега не исчезают, а становятся односторонними', () => {
  // Пока матч идёт, незакрытое ожидание правильно не считать ни совпадением, ни промахом: пара ещё
  // может прийти. Но после финиша тиков по этому игроку больше нет, и без явного закрытия событие
  // просто пропадало — в том числе выдуманный сервером удар за пару тиков до финиша, то есть ровно
  // тот случай, который порог `maxServerOnlyHits: 0` обязан ловить.
  const pairing = new EventPairing(10);
  const opened = pairing.observe(100, true, false);
  assert.equal(totalsOf(opened).leftOnly, 0, 'пока допуск не вышел, событие ещё не решено');
  assert.equal(pairing.pending, 1);

  const finalized = pairing.finalize();
  assert.equal(finalized.leftOnly, 1, 'после финиша ожидание обязано стать выдуманным ударом');
  assert.equal(pairing.pending, 0, 'закрытые ожидания не должны учитываться дважды');

  // Повторное закрытие ничего не добавляет: иначе один удар считался бы несколько раз.
  assert.deepEqual(pairing.finalize(), { left: 0, right: 0, matched: 0, leftOnly: 0, rightOnly: 0 });
});

test('закрытие забега не превращает уже сошедшуюся пару в промах', () => {
  const pairing = new EventPairing(10);
  const totals = totalsOf(
    pairing.observe(0, true, false),
    pairing.observe(2, false, true),
    pairing.finalize()
  );
  assert.equal(totals.matched, 1);
  assert.equal(totals.leftOnly, 0);
  assert.equal(totals.rightOnly, 0);
});
