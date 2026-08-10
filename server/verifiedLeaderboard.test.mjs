import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { VerifiedLeaderboard, raceCourseKey, VERIFICATION_VERSION } = require('./verifiedLeaderboard');
const { openDatabase } = require('./db');

test('таблица принимает только подтверждённые времена и сортирует их', () => {
  const board = new VerifiedLeaderboard({ limit: 3 });
  assert.equal(
    board.record({
      matchId: 'm1',
      mode: 'race',
      courseKey: '7:normal',
      achievedAt: 100,
      entries: [
        { playerId: 'p1', name: 'Медленный', time: 20_000, verified: true, color: 1 },
        { playerId: 'p2', name: 'Читер', time: 100, verified: false, color: 2 },
        { playerId: 'p3', name: 'Быстрый', time: 18_000, verified: true, color: 3 }
      ]
    }),
    true
  );
  assert.deepEqual(board.get('race', '7:normal'), [
    {
      place: 1,
      name: 'Быстрый',
      time: 18_000,
      color: 3,
      achievedAt: 100,
      verificationVersion: VERIFICATION_VERSION,
      self: false
    },
    {
      place: 2,
      name: 'Медленный',
      time: 20_000,
      color: 1,
      achievedAt: 100,
      verificationVersion: VERIFICATION_VERSION,
      self: false
    }
  ]);
  board.close();
});

test('повтор одного matchId не дублирует результат', () => {
  const board = new VerifiedLeaderboard();
  const record = (matchId, time) =>
    board.record({
      matchId,
      mode: 'race',
      courseKey: '1:easy',
      entries: [{ playerId: `p-${matchId}`, name: matchId, time, verified: true }]
    });
  assert.equal(record('m1', 30_000), true);
  assert.equal(record('m1', 10_000), false, 'тот же матч второй раз не учитывается');
  record('m2', 20_000);
  assert.deepEqual(
    board.get('race', '1:easy').map(entry => entry.time),
    [20_000, 30_000]
  );
  board.close();
});

test('разные сиды и сложности не смешиваются', () => {
  const board = new VerifiedLeaderboard();
  board.record({
    matchId: 'a',
    mode: 'race',
    courseKey: '1:easy',
    entries: [{ playerId: 'p1', time: 10, verified: true }]
  });
  board.record({
    matchId: 'b',
    mode: 'race',
    courseKey: '1:chaos',
    entries: [{ playerId: 'p1', time: 20, verified: true }]
  });
  assert.equal(raceCourseKey(1, 'easy'), '1:easy');
  assert.equal(board.get('race', '1:easy')[0].time, 10);
  assert.equal(board.get('race', '1:chaos')[0].time, 20);
  assert.deepEqual(board.get('race', '2:easy'), []);
  board.close();
});

// Раньше дедупликация шла только по matchId: она отсекала повторную запись одного и того же матча,
// но не повторные забеги одного и того же человека. Пройдя трассу пять раз, игрок занимал пять
// верхних строк — таблица показывала не лучших, а самого настойчивого.
test('игрок занимает одну строку на трассу, и это его лучшее время', () => {
  const board = new VerifiedLeaderboard();
  const run = (matchId, time, achievedAt) =>
    board.record({
      matchId,
      mode: 'race',
      courseKey: '3:normal',
      achievedAt,
      entries: [{ playerId: 'один-и-тот-же', name: 'Упорный', time, verified: true }]
    });

  run('m1', 30_000, 100);
  run('m2', 24_000, 200);
  run('m3', 27_000, 300);

  const top = board.get('race', '3:normal');
  assert.equal(top.length, 1, 'три забега одного игрока — одна строка');
  assert.equal(top[0].time, 24_000, 'осталось лучшее время, а не последнее');
  board.close();
});

test('без идентификатора игроки не склеиваются в одну строку', () => {
  // Старый клиент не присылает playerId. Раньше такие записи ложились каждая отдельной строкой —
  // это и нужно сохранить: склеить двух разных людей в одну строку было бы хуже, чем не склеить
  // два забега одного.
  const board = new VerifiedLeaderboard();
  board.record({
    matchId: 'm1',
    mode: 'race',
    courseKey: '9:normal',
    entries: [
      { id: 'a', name: 'Первый', time: 10_000, verified: true },
      { id: 'b', name: 'Второй', time: 12_000, verified: true }
    ]
  });
  assert.equal(board.get('race', '9:normal').length, 2);
  board.close();
});

test('своё место считается и за пределами показанной десятки', () => {
  const board = new VerifiedLeaderboard({ limit: 3 });
  for (let i = 0; i < 12; i++) {
    board.record({
      matchId: `m${i}`,
      mode: 'race',
      courseKey: '4:normal',
      achievedAt: 1000 + i,
      entries: [{ playerId: `p${i}`, name: `Игрок ${i}`, time: 10_000 + i * 500, verified: true }]
    });
  }

  const top = board.get('race', '4:normal', 3, 'p11');
  assert.equal(top.length, 3, 'показываем ровно запрошенное число строк');
  assert.ok(
    top.every(entry => !entry.self),
    'последний игрок в тройку не входит'
  );

  const standing = board.standing('race', '4:normal', 'p11');
  assert.equal(standing.place, 12, 'место считается по всей таблице, а не по выданному куску');
  assert.equal(standing.total, 12);
  assert.equal(standing.gap, 500, 'отставание — от строки прямо над собой');

  const leader = board.standing('race', '4:normal', 'p0');
  assert.equal(leader.place, 1);
  // Не ноль: ноль читался бы как «идёт вровень с кем-то», а над лидером никого нет.
  assert.equal(leader.gap, null, 'лидеру отставать не от кого');

  assert.equal(board.standing('race', '4:normal', 'кого-тут-нет'), null);
  board.close();
});

test('своя строка помечается признаком self', () => {
  const board = new VerifiedLeaderboard();
  board.record({
    matchId: 'm1',
    mode: 'race',
    courseKey: '6:normal',
    entries: [
      { playerId: 'мой', name: 'Я', time: 11_000, verified: true },
      { playerId: 'чужой', name: 'Не я', time: 9_000, verified: true }
    ]
  });
  assert.deepEqual(
    board.get('race', '6:normal', 10, 'мой').map(entry => [entry.name, entry.self]),
    [
      ['Не я', false],
      ['Я', true]
    ]
  );
  board.close();
});

// Главное, ради чего таблица переехала из Map в SQLite: до этого любой перезапуск сервера стирал
// все рекорды, а интерфейс продолжал обещать «подтверждённый рекорд».
test('рекорды переживают перезапуск процесса', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wobble-board-'));
  const file = join(dir, 'leaderboard.db');
  try {
    const before = new VerifiedLeaderboard({ file });
    before.record({
      matchId: 'm1',
      mode: 'race',
      courseKey: '42:normal',
      achievedAt: 500,
      entries: [{ playerId: 'p1', name: 'Рекордсмен', time: 15_000, verified: true, color: 7 }]
    });
    before.close();

    const after = new VerifiedLeaderboard({ file });
    assert.deepEqual(
      after.get('race', '42:normal').map(entry => [entry.name, entry.time]),
      [['Рекордсмен', 15_000]],
      'после перезапуска рекорд на месте'
    );
    // И учтённые матчи тоже: иначе тот же матч записался бы повторно после каждого рестарта.
    assert.equal(
      after.record({
        matchId: 'm1',
        mode: 'race',
        courseKey: '42:normal',
        entries: [{ playerId: 'p1', name: 'Рекордсмен', time: 1, verified: true }]
      }),
      false,
      'матч, учтённый до перезапуска, остаётся учтённым'
    );
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('версия алгоритма проверки хранится вместе с рекордом', () => {
  const board = new VerifiedLeaderboard({ verificationVersion: 4 });
  board.record({
    matchId: 'm1',
    mode: 'race',
    courseKey: '8:normal',
    entries: [{ playerId: 'p1', name: 'Кто-то', time: 12_000, verified: true }]
  });
  assert.equal(board.get('race', '8:normal')[0].verificationVersion, 4);
  assert.equal(board.standing('race', '8:normal', 'p1').verificationVersion, 4);
  board.close();
});

test('таблица не растёт бесконечно', () => {
  const board = new VerifiedLeaderboard({ maxCourses: 2, storedPerCourse: 2 });
  for (const seed of [1, 2, 3]) {
    board.record({
      matchId: `seed-${seed}`,
      mode: 'race',
      courseKey: `${seed}:normal`,
      achievedAt: seed * 100,
      entries: [{ playerId: 'p1', time: 10_000, verified: true }]
    });
  }
  assert.deepEqual(board.get('race', '1:normal'), [], 'самая давняя трасса вытеснена целиком');
  assert.equal(board.get('race', '3:normal').length, 1);

  for (let i = 0; i < 5; i++) {
    board.record({
      matchId: `many-${i}`,
      mode: 'race',
      courseKey: '3:normal',
      achievedAt: 1000 + i,
      entries: [{ playerId: `p${i}`, time: 20_000 - i * 100, verified: true }]
    });
  }
  assert.equal(board.get('race', '3:normal', 25).length, 2, 'на трассу хранится не больше заданного');
  board.close();
});

// Ради этого перенос и делался: в таблице лежат рекорды живых людей, и «мы поменяли схему» для
// них означало бы просто исчезновение результата.
test('рекорды со старой схемы переносятся, а не теряются', () => {
  const db = openDatabase(':memory:');
  // Старая таблица ровно в том виде, в каком она жила до обобщения ключа.
  db.exec(`
    CREATE TABLE leaderboard_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_seed INTEGER NOT NULL,
      difficulty TEXT NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      achieved_at INTEGER NOT NULL,
      verification_version INTEGER NOT NULL,
      match_id TEXT NOT NULL,
      UNIQUE (course_seed, difficulty, player_id)
    );
    CREATE INDEX idx_entries_course
      ON leaderboard_entries (course_seed, difficulty, time_ms, achieved_at);
    CREATE TABLE recorded_matches (match_id TEXT PRIMARY KEY, recorded_at INTEGER NOT NULL);
  `);
  db.prepare(
    `INSERT INTO leaderboard_entries
       (course_seed, difficulty, player_id, display_name, color, time_ms, achieved_at,
        verification_version, match_id)
     VALUES (77, 'chaos', 'старожил', 'Старожил', 255, 31000, 1000, 1, 'старый-матч')`
  ).run();

  const board = new VerifiedLeaderboard({ db });
  assert.equal(board.migrated, true, 'перенос действительно случился');

  const top = board.get('race', '77:chaos');
  assert.equal(top.length, 1, 'запись на месте');
  assert.equal(top[0].name, 'Старожил');
  assert.equal(top[0].time, 31000);
  assert.equal(top[0].verificationVersion, 1, 'версия проверки не подменяется задним числом');
  assert.equal(board.standing('race', '77:chaos', 'старожил').place, 1, 'место считается по нему же');

  // Второй запуск на той же базе ничего не переносит и ничего не ломает.
  const again = new VerifiedLeaderboard({ db });
  assert.equal(again.migrated, false, 'повторный запуск переносить нечего');
  assert.equal(again.get('race', '77:chaos').length, 1);
  db.close();
});

test('кооперативная глава живёт в той же таблице и не смешивается с гонкой', () => {
  const board = new VerifiedLeaderboard();
  board.record({
    matchId: 'кооп-1',
    mode: 'coop',
    courseKey: 'chapter-1',
    entries: [
      { playerId: 'a', name: 'Аня', time: 60_000, verified: true },
      { playerId: 'b', name: 'Боря', time: 60_000, verified: true }
    ]
  });
  board.record({
    matchId: 'гонка-1',
    mode: 'race',
    courseKey: 'chapter-1',
    entries: [{ playerId: 'a', name: 'Аня', time: 10_000, verified: true }]
  });

  const chapter = board.get('coop', 'chapter-1');
  assert.equal(chapter.length, 2, 'оба напарника попадают в таблицу главы');
  assert.equal(chapter[0].time, 60_000);
  // Совпадение ключа при разных режимах не должно склеивать строки: режим — часть ключа, а не
  // подпись рядом с ним.
  assert.equal(board.get('race', 'chapter-1').length, 1, 'одноимённая гоночная трасса — отдельно');
  assert.equal(board.get('race', 'chapter-1')[0].time, 10_000);
  board.close();
});

// Гоночные трассы появляются потоком: сид случайный, число возможных трасс огромно. Глав же ровно
// столько, сколько написано руками. Общий потолок рано или поздно вытолкнул бы главу вместе с
// рекордами всех, кто её проходил, — и виноватым выглядел бы кооператив.
test('поток гоночных трасс не вытесняет кооперативные главы', () => {
  const board = new VerifiedLeaderboard({ maxCourses: 2 });
  board.record({
    matchId: 'глава',
    mode: 'coop',
    courseKey: 'chapter-1',
    achievedAt: 1,
    entries: [{ playerId: 'a', name: 'Аня', time: 60_000, verified: true }]
  });
  for (let seed = 1; seed <= 6; seed++) {
    board.record({
      matchId: `гонка-${seed}`,
      mode: 'race',
      courseKey: `${seed}:normal`,
      achievedAt: 100 + seed,
      entries: [{ playerId: 'r', name: 'Гонщик', time: 10_000, verified: true }]
    });
  }
  assert.equal(board.get('coop', 'chapter-1').length, 1, 'глава на месте после шести трасс');
  assert.deepEqual(board.get('race', '1:normal'), [], 'а давняя гоночная трасса вытеснена');
  board.close();
});

test('новая co-op verification version не повышает старые server-timed строки задним числом', () => {
  const db = openDatabase(':memory:');
  const legacy = new VerifiedLeaderboard({ db, verificationVersion: 2 });
  legacy.record({
    matchId: 'legacy-coop',
    mode: 'coop',
    courseKey: 'ch1',
    entries: [{ playerId: 'coop-old', name: 'Старый кооп', time: 9000, verified: true }]
  });
  legacy.record({
    matchId: 'legacy-race',
    mode: 'race',
    courseKey: '1:easy',
    entries: [{ playerId: 'race-old', name: 'Старая гонка', time: 12000, verified: true }]
  });
  assert.equal(legacy.get('coop', 'ch1').length, 1, 'подготовка: legacy co-op строка существует');
  const current = new VerifiedLeaderboard({ db });
  assert.equal(current.staleCoopPruned, 1);
  assert.deepEqual(
    current.get('coop', 'ch1'),
    [],
    'movement-unverified co-op v2 удалён из competitive board'
  );
  assert.equal(current.get('race', '1:easy').length, 1, 'race v2 не затронут co-op migration');
  db.close();
});
