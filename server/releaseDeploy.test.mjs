import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import buildInfo from './buildInfo.js';

const { buildIdentity } = buildInfo;
const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../deploy/restore.sh', import.meta.url), 'utf8');
const unit = readFileSync(new URL('../deploy/wobble.service', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

// Флаги node, которые ЗАГРУЖАЮТ КОД. Их расхождение между `npm start` и юнитом меняет то, ЧТО
// выполняется, а не то, как быстро. Флаги настройки (`--max-old-space-size=…`) юнит вправе иметь
// свои: у прода другая машина, чем у разработчика, и заставлять его совпадать по ним незачем.
const CODE_LOADING_FLAGS = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader']);

// Разбор строки запуска node на то, что она загружает. Первый токен — сам бинарник, и он намеренно
// отбрасывается: юнит обязан звать node по абсолютному пути, а `npm start` зовёт его из PATH.
//
// Оговорка: флаг настройки, отделённый от значения ПРОБЕЛОМ (`--max-old-space-size 512`), будет
// принят за точку входа. Канонической записи с `=` это не касается, и ошибка получится громкой —
// тест упадёт с несовпадением точек входа, а не пропустит расхождение молча.
function nodeInvocation(command) {
  const argv = command.trim().split(/\s+/).slice(1);
  const loads = [];
  let entry = null;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('-')) {
      if (entry === null) entry = token;
      continue;
    }
    const separator = token.indexOf('=');
    const flag = separator === -1 ? token : token.slice(0, separator);
    if (!CODE_LOADING_FLAGS.has(flag)) continue;
    const value = separator === -1 ? argv[++index] : token.slice(separator + 1);
    // `./server/x.js` и `server/x.js` — один файл; расхождением это считать нельзя.
    loads.push(`${flag} ${String(value).replace(/^\.\//, '')}`);
  }
  return { entry: entry?.replace(/^\.\//, '') ?? null, loads: loads.sort() };
}

test('systemd-юнит запускает сервер тем же способом, что и npm start', () => {
  // Расхождение здесь не ломает сервер — оно молча выключает часть его. Preload обрабатывает
  // `CLIENT_INPUT` и пишет `shadow_simulation_metrics`; в `index.js` этого сообщения нет вовсе.
  // Юнит без `--require` поднимает сервер, который выбрасывает поток ввода от клиентов и не ведёт
  // ни одной серверной симуляции, — и выглядит при этом полностью здоровым: `/health` отвечает,
  // матчи идут, а отсутствие строки метрик неотличимо от отсутствия игроков.
  //
  // Так и было. `add24ef` добавил preload в `start` и `dev`, юнит не тронул, и на проде симуляция
  // не работала ни дня. Диагностику писали, мерили и обсуждали поверх прода, где её не запускали.
  const execStart = unit.match(/^ExecStart=(.+)$/m);
  assert.ok(execStart, 'в юните обязана быть строка ExecStart');

  const production = nodeInvocation(execStart[1]);
  const development = nodeInvocation(pkg.scripts.start);

  assert.equal(production.entry, development.entry, 'юнит и npm start обязаны звать один файл входа');
  assert.deepEqual(
    production.loads,
    development.loads,
    'юнит и npm start обязаны загружать одни и те же модули до входа'
  );
  // Пустой список сошёлся бы сам с собой, и проверка стала бы декоративной ровно в тот момент,
  // когда preload убрали бы из обоих мест.
  assert.ok(development.loads.length > 0, 'npm start обязан загружать preload');
});

test('установщик кладёт на прод именно тот юнит, который проверен', () => {
  // Без этой связки предыдущий тест сторожил бы файл, который никуда не едет.
  assert.match(install, /cp "\$APP_DIR\/deploy\/wobble\.service" \/etc\/systemd\/system\/wobble\.service/);
});

test('production installer can pin and persist an exact release tag', () => {
  assert.match(install, /RELEASE_TAG="\$\{RELEASE_TAG-\$\{SAVED_RELEASE_TAG:-\}\}"/);
  assert.match(install, /refs\/wobble-release-candidates\/\$\{RELEASE_TAG\}/);
  assert.match(install, /remote_release_object/);
  assert.match(install, /local_release_object/);
  assert.match(install, /release tag \$\{RELEASE_TAG\} изменился/);
  assert.match(install, /checkout --detach --force "\$release_commit"/);
  assert.match(install, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(install, /release \$\{RELEASE_TAG\} ещё не опубликован/);
  assert.match(install, /check-release\.mjs" "\$RELEASE_TAG"/);
  assert.match(install, /SAVED_RELEASE_TAG='\$\{RELEASE_TAG\}'/);
});

test('deploy smoke can require the exact version, commit and release identity', () => {
  assert.match(smoke, /SMOKE_EXPECT_VERSION/);
  assert.match(smoke, /SMOKE_EXPECT_COMMIT/);
  assert.match(smoke, /SMOKE_EXPECT_RELEASE/);
  assert.match(smoke, /health\.release !== expectedRelease/);
});

test('build identity exposes a release tag only when production supplies one', () => {
  const plain = buildIdentity({ env: { WOBBLE_BUILD_SHA: 'abcdef0123456789' }, startedAt: 'now' });
  assert.equal(Object.hasOwn(plain, 'release'), false);
  const tagged = buildIdentity({
    env: { WOBBLE_BUILD_SHA: 'abcdef0123456789', WOBBLE_RELEASE_TAG: 'v2.6.0-beta.1' },
    startedAt: 'now'
  });
  assert.equal(tagged.release, 'v2.6.0-beta.1');
  assert.equal(tagged.commit, 'abcdef012345');
});

test('restore protects the requested recovery point before backup retention can run', () => {
  const protect = restore.indexOf(
    'install -o "$APP_USER" -g "$APP_GROUP" -m 0600 "$REQUESTED_BACKUP" "$protected_source"'
  );
  const retentionRun = restore.indexOf('systemctl start wobble-backup.service');
  assert.ok(protect >= 0, 'restore must create a protected source copy');
  assert.ok(
    retentionRun > protect,
    'selected restore point must be protected before retention-producing backup'
  );
  assert.match(restore, /trap cleanup_restore_source EXIT/);
  assert.match(restore, /BACKUP="\$protected_source"/);
});
