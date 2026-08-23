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
  // Значение экранируется, а не подставляется внутрь литеральных кавычек: конфиг исполняется при
  // чтении, и апостроф в значении сломал бы следующий запуск. См. отдельный тест на экранирование.
  assert.match(install, /SAVED_RELEASE_TAG=\$\(shell_quote "\$RELEASE_TAG"\)/);
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
  const sources = [
    ['playwright.config.js', readFileSync(new URL('../playwright.config.js', import.meta.url), 'utf8')]
  ];
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

test('обрыв после перезапуска говорит, куда возвращаться', () => {
  // До перезапуска обрыв безобиден: работает старый процесс, и «смотрите journalctl» —
  // исчерпывающий совет. После перезапуска на машине уже новый код, и тот же текст оставляет
  // человека наедине с лежащим сайтом. Так и вышло: релиз, собранный до исправления запуска,
  // ушёл в crash-loop, установщик сказал «сервер не отвечает» и вышел.
  //
  // Первая редакция этой проверки сторожила ОДНО НАПИСАНИЕ отказа — что все `fail` после
  // перезапуска заменены на `fail_deployed`. Codex показал дыру: не всякий обрыв идёт через
  // `fail`. Проба публичного WebSocket в shared-443 — это `node`, который сам выходит с кодом 1,
  // и при `set -e` скрипт умирал бы молча, а проверка на `fail "` этого не видела бы вовсе.
  //
  // Поэтому сторожится КОНСТРУКЦИЯ, а не написание: ловушка на EXIT срабатывает независимо от
  // того, как именно оборвались.
  assert.match(install, /^trap outage_hint EXIT$/m, 'подсказка обязана висеть на выходе процесса');

  // Ловушка обязана быть взведена ДО первого перезапуска, иначе ранний обрыв её не застанет.
  assert.ok(
    install.indexOf('trap outage_hint EXIT') < install.indexOf('restart_gameplay\n'),
    'ловушка обязана взводиться до первого перезапуска службы'
  );

  // Молчит, пока служба не перезапущена, и молчит при успехе. Иначе обычный отказ конфигурации
  // пугал бы разговором об откате там, где откатывать нечего.
  assert.match(install, /\[ "\$code" -ne 0 \] \|\| return 0/);
  assert.match(install, /\[ "\$service_restarted" -eq 1 \] \|\| return 0/);
});

test('перезапуск игрового процесса идёт только через хелпер', () => {
  // Флаг, включающий подсказку, живёт внутри `restart_gameplay`. Допиши кто-нибудь ещё один
  // `systemctl restart wobble` напрямую — и обрывы после него снова стали бы молчаливыми, причём
  // ровно тем же способом, каким подсказка терялась до сих пор.
  const direct = install
    .split('\n')
    .map((line, index) => [index + 1, line.trim()])
    .filter(([, line]) => line === 'systemctl restart wobble');

  assert.equal(direct.length, 1, 'единственный прямой перезапуск обязан быть внутри restart_gameplay');
  const helper = install.indexOf('restart_gameplay() {');
  const helperEnd = install.indexOf('\n}', helper);
  const directOffset = install.indexOf('\n  systemctl restart wobble\n');
  assert.ok(
    helper >= 0 && directOffset > helper && directOffset < helperEnd,
    'прямой `systemctl restart wobble` допустим только внутри restart_gameplay'
  );

  // Флаг обязан выставляться ДО перезапуска, и это самая тонкая часть всей затеи.
  //
  // `systemctl restart` сначала останавливает старый процесс и только потом поднимает новый. Не
  // поднялся — возвращает ненулевой код, и `set -e` убивает скрипт немедленно. Стой присваивание
  // после вызова, оно бы не выполнилось, и подсказка молчала бы ровно в том случае, ради которого
  // написана: юнит в crash-loop, сайт лежит. Проверено имитацией падающего systemctl — при старом
  // порядке подсказки нет вовсе.
  const helperBody = install.slice(helper, helperEnd);
  assert.ok(
    helperBody.indexOf('service_restarted=1') < helperBody.indexOf('systemctl restart wobble'),
    'флаг обязан выставляться до перезапуска: иначе провал самого перезапуска гасит подсказку'
  );
});

test('подсказка на возврат называет прошлое состояние, а не просто существует', () => {
  // Прошлые значения обязаны считываться ДО подстановки новых: иначе «предыдущий релиз» окажется
  // тем же, что и текущий, и подсказка предложит вернуться туда, где уже стоим.
  assert.ok(
    install.indexOf('PREVIOUS_RELEASE_TAG=') < install.indexOf('RELEASE_TAG="${RELEASE_TAG-'),
    'предыдущий релиз обязан считываться до подстановки нового'
  );
  assert.ok(
    install.indexOf('PREVIOUS_RELEASE_REPOSITORY=') <
      install.indexOf('RELEASE_REPOSITORY="${RELEASE_REPOSITORY'),
    'предыдущий репозиторий обязан считываться до подстановки нового'
  );

  // Репозиторий закрепляется вместе с тегом. Без этого команда возврата после разового
  // развёртывания с чужого форка увела бы в репозиторий по умолчанию — то есть не туда.
  assert.match(install, /SAVED_RELEASE_REPOSITORY=\$\(shell_quote "\$RELEASE_REPOSITORY"\)/);
  assert.match(install, /repo_prefix="RELEASE_REPOSITORY=\$\{PREVIOUS_RELEASE_REPOSITORY\} "/);

  // Ветка — из того же ряда. `RELEASE_TAG= bash …` без неё уходит на `main`, которой в
  // конфигурации с `BRANCH=stable` может не быть вовсе: тогда восстановление падает, не дойдя до
  // перезапуска, а сломанная сборка остаётся работать.
  assert.match(install, /SAVED_BRANCH=\$\(shell_quote "\$BRANCH"\)/);
  assert.match(install, /branch_prefix="BRANCH=\$\{PREVIOUS_BRANCH\} "/);
  assert.ok(
    install.indexOf('PREVIOUS_BRANCH=') > install.indexOf('BRANCH="${BRANCH:-${SAVED_BRANCH'),
    'предыдущая ветка обязана читаться из сохранённой, а не из подставленной'
  );

  // Первая установка и прошлое развёртывание с ветки — разные ответы, и пустой тег их не различает.
  assert.match(install, /DEPLOY_CONF_EXISTED=1/);
  assert.ok(
    install.indexOf('DEPLOY_CONF_EXISTED=1') < install.indexOf('. "$DEPLOY_CONF"'),
    'наличие конфига обязано проверяться до того, как он будет прочитан'
  );
});

test('сохраняемые настройки пишутся как данные, а не как код', () => {
  // `$DEPLOY_CONF` читается через `.`, то есть ИСПОЛНЯЕТСЯ. Значение, подставленное прямо внутрь
  // литеральных одинарных кавычек, ломается на первом апострофе: ветка `feature/o'hare` даёт
  // незакрытую строку, и следующий запуск установщика падает при чтении конфига — до того, как
  // успеет что-либо починить. Тег и репозиторий проверяются регуляркой на входе, ветка нет,
  // поэтому дыра была живой именно там.
  //
  // Проверяется КАЖДОЕ значение, а не только ветка: полагаться на то, что проверка формата выше
  // не изменится, — это ровно та молчаливая связь, которая здесь уже дорого обошлась.
  const confBlock = install.slice(install.indexOf('cat >"$DEPLOY_CONF"'), install.indexOf('\nCONF\n'));
  const raw = confBlock
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^SAVED_[A-Z0-9_]+='/.test(line));

  assert.deepEqual(
    raw,
    [],
    `эти значения подставляются в кавычки без экранирования и ломают конфиг на апострофе:\n  ${raw.join('\n  ')}`
  );

  const saved = confBlock.split('\n').filter(line => /^SAVED_[A-Z0-9_]+=/.test(line.trim()));
  assert.ok(saved.length >= 7, 'конфиг обязан сохранять все параметры развёртывания');
  for (const line of saved) {
    assert.match(line, /^SAVED_[A-Z0-9_]+=\$\(shell_quote "\$[A-Z0-9_]+"\)$/, `не экранировано: ${line}`);
  }
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
