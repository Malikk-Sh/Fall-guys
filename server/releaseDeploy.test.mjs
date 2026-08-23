import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import buildInfo from './buildInfo.js';

const { buildIdentity } = buildInfo;
const install = readFileSync(new URL('../deploy/install.sh', import.meta.url), 'utf8');
const smoke = readFileSync(new URL('../deploy/smoke.sh', import.meta.url), 'utf8');
const restore = readFileSync(new URL('../deploy/restore.sh', import.meta.url), 'utf8');
const service = readFileSync(new URL('../deploy/wobble.service', import.meta.url), 'utf8');
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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

test('production systemd starts the same shadow-preloaded entrypoint as npm start', () => {
  const execStart = service.match(/^ExecStart=(.+)$/m)?.[1];
  assert.ok(execStart, 'wobble.service must define ExecStart');

  // systemd uses the absolute Node path while package.json uses PATH. Everything after that must
  // stay byte-for-byte equivalent, otherwise a production-only startup path can silently omit
  // migration wiring while smoke tests still see a healthy legacy server.
  const normalizedServiceStart = execStart.replace(/^\/usr\/bin\/node\b/, 'node');
  assert.equal(normalizedServiceStart, packageJson.scripts.start);
  assert.match(normalizedServiceStart, /--require \.\/server\/shadowInputPreload\.js/);
});

// Все места, где вообще запускают сервер, и то, чем они его запускают.
//
// Юнит — не единственная копия строки запуска, и предыдущий тест сторожит только его. Копий было
// шесть: smoke в CI, Playwright, ночной стресс (две), недельный soak и сам юнит. Preload не грузила
// ни одна, кроме юнита, — то есть E2E, стресс и soak гоняли сервер БЕЗ моста `CLIENT_INPUT` →
// серверная симуляция и были при этом зелёными. Юнит-тесты моста грузят preload сами, поэтому дыра
// пришлась ровно на сквозные проверки: там, где её тяжелее всего заметить.
const PRELOAD_FLAG = '--require ./server/shadowInputPreload.js';
const workflowsDir = new URL('../.github/workflows/', import.meta.url);

// Где запуск без preload ОСОЗНАНЕН. Список именной и с причиной: молчаливая дыра — это то, с чего
// всё началось, и заменять её на молчаливое исключение смысла нет.
//
// Обе задачи меряют НАГРУЗКУ. Мост добавляет тик 30 Гц и обработчик на сокет, поэтому включение его
// сдвинет их базовые числа — а пороги там настроены по прежним замерам. Сдвиг базы это отдельное
// решение с отдельной калибровкой, а не побочный эффект чужого исправления. Пока оно не принято,
// нужно помнить, что их зелёный цвет описывает не тот сервер, который стоит на проде.
const LAUNCH_PARITY_EXEMPT = new Map([
  ['nightly-stress.yml', 'меряет нагрузку: включение моста сдвинет базовые числа и пороги'],
  ['weekly-soak.yml', 'меряет нагрузку: включение моста сдвинет базовые числа и пороги']
]);

function launchSites() {
  const sources = [['playwright.config.js', readFileSync(new URL('../playwright.config.js', import.meta.url), 'utf8')]];
  for (const name of readdirSync(workflowsDir).filter(file => file.endsWith('.yml'))) {
    sources.push([name, readFileSync(new URL(name, workflowsDir), 'utf8')]);
  }
  return sources.map(([name, source]) => [
    name,
    source
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes('server/bootstrap.js') && !line.startsWith('#'))
  ]);
}

test('всё, что запускает сервер, запускает его с preload', () => {
  const offenders = [];
  const staleExemptions = [...LAUNCH_PARITY_EXEMPT.keys()];

  for (const [name, lines] of launchSites()) {
    if (!lines.length) continue;
    const bare = lines.filter(line => !line.includes(PRELOAD_FLAG));
    if (LAUNCH_PARITY_EXEMPT.has(name)) {
      // Исключение обязано быть живым: как только задачу починят, запись становится враньём и
      // должна быть удалена, а не остаться прикрывать следующую дыру.
      if (bare.length) staleExemptions.splice(staleExemptions.indexOf(name), 1);
      continue;
    }
    for (const line of bare) offenders.push(`${name}: ${line}`);
  }

  assert.deepEqual(
    offenders,
    [],
    `сервер запускают без preload, и эти проверки не видят серверную симуляцию:\n  ${offenders.join('\n  ')}`
  );
  assert.deepEqual(
    staleExemptions,
    [],
    `исключения больше не нужны, удалите их из LAUNCH_PARITY_EXEMPT:\n  ${staleExemptions.join('\n  ')}`
  );
});

test('установщик кладёт на прод именно тот юнит, который сверяется', () => {
  // Предыдущий тест сверяет `deploy/wobble.service` с `npm start`. Он держит инвариант только
  // пока на прод едет именно этот файл: замени установщик источник или сгенерируй он юнит на
  // месте — проверка осталась бы зелёной, сторожа файл, который никуда не попадает.
  assert.match(install, /cp "\$APP_DIR\/deploy\/wobble\.service" \/etc\/systemd\/system\/wobble\.service/);
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
