// Тесты на стык процессов, а не на модуль.
//
// Все остальные тесты проекта проверяют компоненты поодиночке, и именно поэтому мимо них прошла
// ошибка, ради которой написан этот файл: игровой процесс и панель — разные процессы, работающие с
// одним файлом базы, и ломалось не внутри какого-то из них, а между ними. Проверять такое можно
// только по-настоящему: подняв второй процесс и заняв им файл.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase, DEFAULT_BUSY_TIMEOUT_MS } = require('./db');

const here = path.dirname(fileURLToPath(import.meta.url));

// Синхронная пауза. Обычный setTimeout здесь не годится: node:sqlite синхронен, и весь смысл
// проверки в том, что происходит на заблокированном потоке.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tempDatabaseFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-db-'));
  return path.join(dir, name);
}

function cleanup(file) {
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${file}${suffix}`, { force: true });
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

test('база на диске открывается с ненулевым ожиданием блокировки', () => {
  const file = tempDatabaseFile('timeout.db');
  try {
    const db = openDatabase(file);
    const [row] = db.prepare('PRAGMA busy_timeout').all();
    assert.equal(Object.values(row)[0], DEFAULT_BUSY_TIMEOUT_MS);
    db.close();
  } finally {
    cleanup(file);
  }
});

test('ожидание можно уменьшить: панель ждёт меньше игры', () => {
  const file = tempDatabaseFile('short.db');
  try {
    const db = openDatabase(file, { busyTimeoutMs: 3000 });
    const [row] = db.prepare('PRAGMA busy_timeout').all();
    assert.equal(Object.values(row)[0], 3000);
    assert.ok(3000 < DEFAULT_BUSY_TIMEOUT_MS, 'панель обязана ждать меньше игры, а не больше');
    db.close();
  } finally {
    cleanup(file);
  }
});

test('запись из игры дожидается чужой транзакции вместо немедленной ошибки', async () => {
  const file = tempDatabaseFile('shared.db');
  const marker = `${file}.locked`;
  try {
    const game = openDatabase(file);
    game.exec('CREATE TABLE metrics (id INTEGER PRIMARY KEY, samples INTEGER NOT NULL)');
    game.close();

    // Второй процесс — в роли control plane: занимает файл на запись и отпускает через 400 мс.
    // Ровно то, что делает панель, записывая строку аудита при входе администратора.
    const holder = spawn(
      process.execPath,
      [
        '-e',
        `
        const { openDatabase } = require(${JSON.stringify(path.join(here, 'db.js'))});
        const fs = require('fs');
        const db = openDatabase(${JSON.stringify(file)}, { busyTimeoutMs: 3000 });
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO metrics (samples) VALUES (?)').run(1);
        fs.writeFileSync(${JSON.stringify(marker)}, 'held');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        db.exec('COMMIT');
        db.close();
        `
      ],
      { stdio: 'ignore' }
    );

    try {
      // Ждём, пока блокировка действительно взята: иначе тест проверял бы не то, что задумано.
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(marker) && Date.now() < deadline) sleepSync(20);
      assert.ok(fs.existsSync(marker), 'второй процесс не успел занять файл');

      const game2 = openDatabase(file);
      const startedAt = Date.now();
      // Раньше эта строка бросала ERR_SQLITE_ERROR «database is locked» тем же тактом, исключение
      // поднималось из колбэка таймера и завершало процесс вместе со всеми забегами.
      game2.exec('BEGIN');
      game2.prepare('INSERT INTO metrics (samples) VALUES (?)').run(2);
      game2.exec('COMMIT');
      const waited = Date.now() - startedAt;

      assert.ok(waited > 50, `запись должна была подождать освобождения, а заняла ${waited} мс`);
      assert.equal(game2.prepare('SELECT COUNT(*) AS n FROM metrics').get().n, 2);
      game2.close();
    } finally {
      holder.kill();
      await new Promise(resolve => holder.on('exit', resolve));
    }
  } finally {
    fs.rmSync(marker, { force: true });
    cleanup(file);
  }
});
