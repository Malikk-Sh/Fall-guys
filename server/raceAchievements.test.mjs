// Награды за онлайн-гонку.
//
// Проверяется в первую очередь то, за что награда НЕ выдаётся: «первое место» в забеге, где никто
// больше не дошёл, и «пьедестал» там, где под ним никого нет. Без этих условий обе награды означали
// бы «доиграл до конца», а не результат.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { Accounts } = require('./accounts');
const { ACHIEVEMENT_CATALOG } = require('../shared/achievements.js');
const { COSMETIC_CATALOG } = require('../shared/cosmetics.js');

function freshAccounts() {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const accounts = new Accounts({ db });
  const account = accounts.create('Racer');
  return { accounts, id: account.id };
}

const unlocked = (accounts, id) => new Set(accounts.progress(id).achievements.map(item => item.id));

test('первый финиш открывает награду за финиш и ничего больше', () => {
  const { accounts, id } = freshAccounts();
  assert.equal(accounts.recordRaceFinish({ accountId: id, place: 1, finishers: 1 }), true);

  const ids = unlocked(accounts, id);
  assert.ok(ids.has('race-first-finish'));
  // Единственный дошедший — не победитель: обгонять было некого.
  assert.ok(!ids.has('race-win'), 'победа в одиночку не должна засчитываться');
  assert.ok(!ids.has('race-podium'), 'пьедестал из одного человека — не пьедестал');
  assert.deepEqual(accounts.raceStats(id), { finishes: 1, podiums: 0, wins: 0, bestPlace: 1 });
});

test('победа требует живого соперника, дошедшего до ленты', () => {
  const { accounts, id } = freshAccounts();
  accounts.recordRaceFinish({ accountId: id, place: 1, finishers: 2 });

  const ids = unlocked(accounts, id);
  assert.ok(ids.has('race-win'));
  // Двое дошедших — победа есть, а пьедестала ещё нет: третьего места не существует.
  assert.ok(!ids.has('race-podium'));
  assert.equal(accounts.raceStats(id).wins, 1);
});

test('пьедестал засчитывается от трёх дошедших', () => {
  const { accounts, id } = freshAccounts();
  accounts.recordRaceFinish({ accountId: id, place: 3, finishers: 3 });

  const ids = unlocked(accounts, id);
  assert.ok(ids.has('race-podium'));
  assert.ok(!ids.has('race-win'));
  assert.equal(accounts.raceStats(id).podiums, 1);
});

test('лучшее место не ухудшается последующими забегами', () => {
  const { accounts, id } = freshAccounts();
  accounts.recordRaceFinish({ accountId: id, place: 2, finishers: 4 });
  accounts.recordRaceFinish({ accountId: id, place: 7, finishers: 9 });

  assert.equal(accounts.raceStats(id).bestPlace, 2);
  assert.equal(accounts.raceStats(id).finishes, 2);
});

test('двадцать пятый финиш открывает завсегдатая, двадцать четвёртый — нет', () => {
  const { accounts, id } = freshAccounts();
  for (let run = 0; run < 24; run += 1) {
    accounts.recordRaceFinish({ accountId: id, place: 5, finishers: 8 });
  }
  assert.ok(!unlocked(accounts, id).has('race-veteran-25'), 'на 24 финишах награды быть не должно');

  accounts.recordRaceFinish({ accountId: id, place: 5, finishers: 8 });
  assert.ok(unlocked(accounts, id).has('race-veteran-25'));
});

test('бессмысленные итоги отвергаются, а не портят статистику', () => {
  const { accounts, id } = freshAccounts();
  assert.equal(accounts.recordRaceFinish({ accountId: id, place: 0, finishers: 3 }), false);
  assert.equal(accounts.recordRaceFinish({ accountId: id, place: 4, finishers: 3 }), false);
  assert.equal(accounts.recordRaceFinish({ accountId: id, place: 1.5, finishers: 3 }), false);
  assert.equal(accounts.recordRaceFinish({ accountId: 'нет такого', place: 1, finishers: 2 }), false);
  assert.deepEqual(accounts.raceStats(id), { finishes: 0, podiums: 0, wins: 0, bestPlace: null });
});

test('каждая косметика ссылается на существующее достижение', () => {
  const known = new Set(ACHIEVEMENT_CATALOG.map(item => item.id));
  for (const item of COSMETIC_CATALOG) {
    if (!item.achievement) continue;
    assert.ok(known.has(item.achievement), `${item.id} висит на несуществующем ${item.achievement}`);
  }
});

test('в каждом слоте есть из чего выбрать', () => {
  const bySlot = new Map();
  for (const item of COSMETIC_CATALOG) bySlot.set(item.slot, (bySlot.get(item.slot) || 0) + 1);
  for (const [slot, count] of bySlot) {
    // Один предмет в слоте — это не выбор, а выключатель: ради этого слот заводить незачем.
    assert.ok(count >= 2, `в слоте ${slot} всего ${count} предмет(а) — выбирать не из чего`);
  }
});

test('несколько аватаров одного аккаунта не делают из себя соперников', () => {
  const { accounts, id } = freshAccounts();
  // Два слота одного аккаунта дошли до ленты. Живого соперника при этом не было.
  accounts.recordRaceFinish({ accountId: id, place: 1, finishers: 1 });

  const ids = unlocked(accounts, id);
  assert.ok(!ids.has('race-win'), 'победа над собой не победа');
  assert.ok(!ids.has('race-podium'));
  assert.equal(accounts.raceStats(id).finishes, 1, 'один матч — один финиш, сколько бы ни было вкладок');
});

test('гоночные счётчики едут в прогрессе аккаунта', () => {
  const { accounts, id } = freshAccounts();
  assert.deepEqual(accounts.progress(id).race, { finishes: 0, podiums: 0, wins: 0, bestPlace: null });
  accounts.recordRaceFinish({ accountId: id, place: 1, finishers: 4 });
  assert.deepEqual(accounts.progress(id).race, { finishes: 1, podiums: 1, wins: 1, bestPlace: 1 });
});

test('место среди ботов считается по протоколу, а не по числу людей', () => {
  const { accounts, id } = freshAccounts();
  // Человек пришёл четвёртым после трёх ботов. Первая редакция записывала его первым из четырёх —
  // то есть выдавала победу и пьедестал за проигранный забег.
  accounts.recordRaceFinish({ accountId: id, place: 4, finishers: 4 });

  const ids = unlocked(accounts, id);
  assert.ok(ids.has('race-first-finish'), 'финиш засчитывается в любом случае');
  assert.ok(!ids.has('race-win'), 'победы за четвёртое место быть не может');
  assert.ok(!ids.has('race-podium'), 'пьедестала за четвёртое место быть не может');
  assert.equal(accounts.raceStats(id).bestPlace, 4);
});
