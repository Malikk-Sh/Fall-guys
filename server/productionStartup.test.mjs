import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Запускается ли сервер ТОЙ САМОЙ командой, которой его запускает production.
//
// Все прочие проверки читают файлы: `releaseDeploy.test.mjs` сверяет `ExecStart` с `npm start`,
// `shadowInputWiring.test.mjs` поднимает мост внутри тестового процесса. Ни одна из них не
// выполняет строку запуска целиком, и потому ни одна не заметила, что она НЕ РАБОТАЕТ.
//
// А она не работала. `--require ./server/shadowInputPreload.js` наследуется worker-тредом, который
// node поднимает под ESM-хуки при `register('./client-loader.mjs')`. В том треде preload грузился
// второй раз, тянул `shared/validation.js`, а тот — через `loadESMFromCJS` → `Hooks.resolveSync`,
// которого в loader-треде нет. Процесс падал с ERR_METHOD_NOT_IMPLEMENTED, и на VPS это дало бы
// crash-loop до срабатывания StartLimitBurst, после чего служба осталась бы лежать.
//
// Обманчивее всего был симптом: до `register()` сервер успевал написать `server_started`, так что
// падение выглядело поздней случайностью, а не отказом запуска.
//
// Поэтому тест здесь один и грубый: взять строку из юнита, выполнить её, дождаться `/health` и
// посмотреть, что мост жив. Он медленный — это цена того, что он проверяет запуск, а не текст.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Аргументы берутся ИЗ ЮНИТА, а не пишутся рядом. Копия строки запуска устарела бы молча — ровно
// так и появился весь этот класс ошибок.
function productionArgs() {
  const unit = readFileSync(join(root, 'deploy/wobble.service'), 'utf8');
  const execStart = unit.match(/^ExecStart=(.+)$/m);
  assert.ok(execStart, 'в юните обязана быть строка ExecStart');
  // Первый токен — путь к node на проде (`/usr/bin/node`); здесь берётся node, которым идёт прогон.
  return execStart[1].trim().split(/\s+/).slice(1);
}

async function waitForHealth(port, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch {
      // Сервер ещё не слушает — это нормально, пока не вышел срок.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return null;
}

test('production-команда из юнита поднимает сервер и мост', async t => {
  const port = 3400 + Math.floor(Math.random() * 200);
  const dataDir = mkdtempSync(join(tmpdir(), 'wobble-startup-'));
  const child = spawn(process.execPath, productionArgs(), {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LEADERBOARD_DB: join(dataDir, 'game.db'),
      BACKUP_DIR: join(dataDir, 'backups'),
      BACKUP_STATUS_FILE: join(dataDir, 'backups', 'status.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  child.stdout.on('data', chunk => (output += chunk));
  child.stderr.on('data', chunk => (output += chunk));

  let exited = null;
  child.on('exit', code => (exited = code));

  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });

  const health = await waitForHealth(port);

  assert.equal(exited, null, `сервер вышел вместо того, чтобы работать:\n${output.slice(-2000)}`);
  assert.ok(health, `сервер не ответил на /health:\n${output.slice(-2000)}`);

  // Мост обязан быть именно `started`. `absent` означало бы, что preload не загрузился, — то есть
  // ровно ту дыру, ради которой строка запуска и правилась.
  assert.equal(health.shadowBridge, 'started', `мост не поднялся:\n${output.slice(-2000)}`);

  // Падение может прийти и ПОСЛЕ `server_started`: у bootstrap есть обработчик uncaughtException,
  // который пишет ошибку и продолжает работу, поэтому по одному коду выхода такое не видно.
  // Загрузчик ботов регистрируется отложенно, так что даём ему время выстрелить.
  await new Promise(resolve => setTimeout(resolve, 3000));
  assert.equal(
    output.includes('ERR_METHOD_NOT_IMPLEMENTED'),
    false,
    `загрузчик ESM уронил модуль уже после старта:\n${output.slice(-2000)}`
  );
  assert.equal(exited, null, `сервер умер после старта:\n${output.slice(-2000)}`);
});
