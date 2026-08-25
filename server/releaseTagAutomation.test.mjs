// Выбор следующего номера предрелиза и то, что его выбирает не человек.
//
// Этот шаг ломался трижды подряд, и каждый раз одинаково — тег вставал не на тот коммит:
// v2.6.0-beta.2 и v2.6.0-beta.4 были созданы на устаревшей локальной main (первая уронила прод на
// 502), v2.6.0-beta.5 назвали уже занятой. Теги неизменяемы, поэтому каждая такая ошибка навсегда.
//
// Тест держит обе половины починки: правило выдачи номера и то, что workflow берёт коммит из
// origin/main, а не из чьей-то копии.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { nextPrereleaseTag, parseReleaseTag, pickLatestRelease } from '../deploy/releasePolicy.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const workflow = fs.readFileSync(new URL('../.github/workflows/tag-release.yml', import.meta.url), 'utf8');
const deployLatest = fs.readFileSync(new URL('../deploy/deploy-latest.sh', import.meta.url), 'utf8');
const publish = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const releaseDoc = fs.readFileSync(new URL('../docs/RELEASE-PROCESS.md', import.meta.url), 'utf8');

test('пустая история даёт первый номер', () => {
  assert.equal(nextPrereleaseTag({ tags: [], version: '2.6.0' }), 'v2.6.0-beta.1');
});

test('номер берётся следующим за наибольшим занятым, а не за последним в списке', () => {
  // Порядок намеренно перемешан: `git tag --list` сортирует лексикографически, и там beta.10
  // стоит раньше beta.9.
  const tags = ['v2.6.0-beta.10', 'v2.6.0-beta.2', 'v2.6.0-beta.9', 'v2.6.0-beta.1'];
  assert.equal(nextPrereleaseTag({ tags, version: '2.6.0' }), 'v2.6.0-beta.11');
});

test('занятый номер повторно не выдаётся — ровно эта ошибка и случилась', () => {
  const tags = ['v2.6.0-beta.1', 'v2.6.0-beta.2', 'v2.6.0-beta.3', 'v2.6.0-beta.4', 'v2.6.0-beta.5'];
  const next = nextPrereleaseTag({ tags, version: '2.6.0' });
  assert.equal(next, 'v2.6.0-beta.6');
  assert.ok(!tags.includes(next), 'выданный тег обязан быть свободным');
});

test('чужие версии и чужие каналы номер не сдвигают', () => {
  const tags = ['v2.5.0-beta.9', 'v2.7.0-beta.4', 'v2.6.0-rc.7', 'v2.6.0-beta.2'];
  assert.equal(nextPrereleaseTag({ tags, version: '2.6.0' }), 'v2.6.0-beta.3');
  assert.equal(nextPrereleaseTag({ tags, version: '2.6.0', channel: 'rc' }), 'v2.6.0-rc.8');
});

test('мусор среди тегов не ломает выбор', () => {
  const tags = ['не-тег', '', 'v2.6.0-beta', 'v2.6.0-beta.x', 'vX.Y.Z-beta.1', 'v2.6.0-beta.3'];
  assert.equal(nextPrereleaseTag({ tags, version: '2.6.0' }), 'v2.6.0-beta.4');
});

test('предрелиз уже вышедшей версии не выдаётся вовсе', () => {
  // По semver `v2.6.0-beta.7` МЕНЬШЕ, чем `v2.6.0`: это шаг назад, а не вперёд. Молча выпустить
  // такое хуже, чем остановиться.
  assert.throws(
    () => nextPrereleaseTag({ tags: ['v2.6.0', 'v2.6.0-beta.6'], version: '2.6.0' }),
    /already released/
  );
});

test('мусор во входных данных отвергается, а не превращается в тег', () => {
  assert.throws(() => nextPrereleaseTag({ tags: [], version: '2.6' }), /invalid package version/);
  assert.throws(() => nextPrereleaseTag({ tags: [], version: 'latest' }), /invalid package version/);
  assert.throws(
    () => nextPrereleaseTag({ tags: [], version: '2.6.0', channel: 'beta.1' }),
    /invalid prerelease channel/
  );
});

test('выданный тег проходит ту же проверку, что и при публикации', () => {
  const next = nextPrereleaseTag({ tags: [], version: pkg.version });
  const parsed = parseReleaseTag(next);
  assert.ok(parsed, `${next} обязан разбираться политикой релизов`);
  assert.equal(parsed.version, pkg.version, 'тег обязан совпадать с версией пакета');
  assert.equal(parsed.prerelease, true);
});

// Вторая половина: коммит. Правило выдачи номера бесполезно, если тег по-прежнему можно поставить
// на устаревшую копию — а именно это и уронило прод.
test('workflow тегирует origin/main, а не локальную копию', () => {
  assert.match(workflow, /ref:\s*main/, 'checkout обязан брать main');
  assert.match(workflow, /fetch-depth:\s*0/, 'нужна полная история и теги');
  assert.match(workflow, /rev-parse origin\/main/, 'сверка с origin/main обязана быть явной');
  assert.match(workflow, /exit 1/, 'расхождение обязано останавливать, а не печатать предупреждение');
});

// Порядок: создать локально → проверить → запушить.
//
// Обратный («проверить, потом создать») выглядит осторожнее и не работает вовсе: check-release.mjs
// сверяет тег с HEAD, то есть требует существующего тега, и для ещё не созданного падает всегда.
// Прежняя версия этого теста закрепляла именно тот порядок — то есть держала workflow сломанным.
//
// Неизменяемым тег становится только на push, и проверка стоит до него. Локальный тег живёт в
// runner'е и исчезает вместе с ним.
test('workflow создаёт тег локально, проверяет и только потом пушит', () => {
  const create = workflow.indexOf('git tag -a');
  const validate = workflow.indexOf('deploy/check-release.mjs');
  const push = workflow.indexOf('git push origin');
  assert.ok(create !== -1 && validate !== -1 && push !== -1);
  assert.ok(create < validate, 'проверять нечего, пока тега нет');
  assert.ok(validate < push, 'проверка обязана стоять до того, как тег станет неизменяемым');
});

// Отдельным шагом сверка оставляла бы между собой и пушем границу шага — окно, в которое main
// успевает уйти вперёд, а `release.yml` такой тег примет: она проверяет вхождение в main, а не то,
// что коммит её голова.
test('сверка с origin/main стоит в одном шаге с пушем', () => {
  const step = workflow.slice(workflow.indexOf('- name: Push the tag'));
  const body = step.slice(0, step.indexOf('- name: Start the publishing'));
  assert.match(body, /rev-parse origin\/main/, 'сверка обязана быть в том же шаге');
  assert.match(body, /git push origin "refs\/tags\/\$TAG"/);
  const check = body.indexOf('rev-parse origin/main');
  const push = body.indexOf('git push origin');
  assert.ok(check < push, 'сверять надо до пуша');
});

test('workflow пушит ровно один ref, а не все теги', () => {
  assert.match(workflow, /git push origin "refs\/tags\/\$TAG"/);
  assert.ok(!workflow.includes('push origin --tags'), '--tags отправил бы и посторонние теги');
});

// Пуш с GITHUB_TOKEN новых запусков не создаёт — так GitHub закрывает рекурсию workflow'ов.
// Исключены ровно workflow_dispatch и repository_dispatch. Без явного запуска тег создавался бы,
// а релиз не выходил.
test('после пуша публикация запускается явно', () => {
  const push = workflow.indexOf('git push origin');
  const dispatch = workflow.indexOf('gh workflow run release.yml');
  assert.ok(dispatch !== -1, 'публикацию надо запустить явно');
  assert.ok(push < dispatch, 'запускать публикацию имеет смысл только после пуша');
  assert.match(workflow, /--field tag=/, 'публикация обязана получить имя тега');
});

test('публикация умеет запускаться явно и берёт тег из входа', () => {
  assert.match(publish, /workflow_dispatch:/, 'без этого входа явный запуск невозможен');
  assert.match(publish, /RELEASE_TAG: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/);
  assert.match(publish, /ref: \$\{\{ inputs\.tag \|\| github\.ref_name \}\}/, 'checkout обязан взять тег');
  assert.ok(!publish.includes('GITHUB_REF_NAME'), 'имя тега обязано браться из одного места');
});

// При запуске через workflow_dispatch GITHUB_SHA — это голова ветки, с которой запустили, а не
// коммит тега. Проверка «коммит содержится в main» по нему смотрела бы не на то и проходила всегда.
test('публикация проверяет коммит из checkout, а не GITHUB_SHA', () => {
  assert.match(publish, /head="\$\(git rev-parse HEAD\)"/);
  assert.match(publish, /merge-base --is-ancestor "\$head" origin\/main/);
  assert.ok(!publish.includes('--is-ancestor "$GITHUB_SHA"'));
});

test('workflow сам ничего не выпускает — только ставит метку', () => {
  assert.ok(!workflow.includes('gh release create'), 'публикация остаётся в release.yml');
  assert.match(workflow, /workflow_dispatch/, 'запуск только руками');
});

// Вторая часть автоматизации: выкат. Тег больше не набирается руками — он берётся из GitHub.

test('последним считается свежий ВЫПУЩЕННЫЙ, а не наибольший номер', () => {
  // Так бывает, когда чинят старую ветку версий: свежий релиз имеет МЕНЬШИЙ номер.
  const releases = [
    { tag_name: 'v2.5.1', draft: false, prerelease: false, published_at: '2026-03-01T00:00:00Z' },
    { tag_name: 'v2.6.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.5.1');
});

// Ответ GitHub отсортирован по СОЗДАНИЮ тега, а не по публикации. Черновик, опубликованный после
// более новых релизов, встаёт в списке не первым — довериться порядку значило бы выкатить не то.
test('порядок ответа не решает: решает дата публикации', () => {
  const releases = [
    { tag_name: 'v2.6.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' },
    { tag_name: 'v2.5.1', draft: false, prerelease: false, published_at: '2026-04-01T00:00:00Z' },
    { tag_name: 'v2.4.9', draft: false, prerelease: false, published_at: '2026-02-01T00:00:00Z' }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.5.1', 'позже всех опубликован именно он');
});

test('релиз без даты публикации кандидатом остаётся, но уступает датированному', () => {
  const undated = { tag_name: 'v2.4.0', draft: false, prerelease: false };
  const dated = { tag_name: 'v2.5.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' };
  assert.equal(pickLatestRelease([undated, dated]), 'v2.5.0');
  assert.equal(pickLatestRelease([undated]), 'v2.4.0', 'без альтернативы годится и он');
  // Мусор в дате не должен выигрывать у настоящей.
  assert.equal(pickLatestRelease([{ ...undated, published_at: 'позавчера' }, dated]), 'v2.5.0');
});

test('черновик не выкатывается никогда', () => {
  const releases = [
    { tag_name: 'v2.7.0', draft: true, prerelease: false },
    { tag_name: 'v2.6.0', draft: false, prerelease: false }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.6.0');
  assert.equal(pickLatestRelease(releases, { allowPrerelease: true }), 'v2.6.0');
});

test('предрелиз берётся только по явному согласию', () => {
  const releases = [
    { tag_name: 'v2.6.0-beta.6', draft: false, prerelease: true },
    { tag_name: 'v2.5.0', draft: false, prerelease: false }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.5.0', 'по умолчанию бету не ставим');
  assert.equal(pickLatestRelease(releases, { allowPrerelease: true }), 'v2.6.0-beta.6');
});

test('мусорный ответ не превращается в тег', () => {
  assert.equal(pickLatestRelease(null), null);
  assert.equal(pickLatestRelease([]), null);
  assert.equal(pickLatestRelease([{ tag_name: 'не-тег', draft: false, prerelease: false }]), null);
  assert.equal(pickLatestRelease([null, undefined, 42]), null);
});

test('выкат не заводит вторую версию логики установки', () => {
  // Своя логика установки здесь разъехалась бы с install.sh ровно так же, как разъезжались два
  // правила чекпоинта. Скрипт обязан оставаться обёрткой.
  assert.match(deployLatest, /RELEASE_TAG="\$latest" RELEASE_REPOSITORY="\$REPO" bash "\$INSTALL"/);
  assert.ok(!deployLatest.includes('systemctl restart wobble'), 'перезапуск — дело install.sh');
  assert.ok(!deployLatest.includes('git clone'), 'выкладка — дело install.sh');
});

test('выкат не требует и не хранит секретов', () => {
  assert.ok(!/Authorization|GH_TOKEN|GITHUB_TOKEN|Bearer/i.test(deployLatest), 'репозиторий публичный');
});

test('сорвавшийся запрос к GitHub не превращается в выкат пустого тега', () => {
  const request = deployLatest.indexOf('api.github.com');
  const guard = deployLatest.indexOf('if [[ -z "$latest" ]]');
  const install = deployLatest.indexOf('bash "$INSTALL"');
  assert.ok(request !== -1 && guard !== -1 && install !== -1);
  assert.ok(guard < install, 'пустой тег обязан останавливать до установки');
  assert.match(deployLatest, /curl -fsS/, 'curl обязан падать на HTTP-ошибке, а не отдавать тело ошибки');
});

// install.sh берёт RELEASE_REPOSITORY из своего конфига или умолчания. Без явной передачи выбор
// тега и выбор репозитория расходятся: при WOBBLE_REPO=owner/fork тег выбирается в форке, а
// ищется в основном репозитории.
test('выкат передаёт установщику тот же репозиторий, в котором выбрал тег', () => {
  assert.match(deployLatest, /RELEASE_REPOSITORY="\$REPO"/);
});

// Если после последнего стабильного релиза накопится больше страницы бет, обычный режим получил бы
// одни беты и сообщил бы, что стабильных релизов нет — при живом стабильном релизе.
test('выкат смотрит дальше первой страницы релизов', () => {
  assert.match(deployLatest, /page=\$\{page\}/, 'страницы обязаны перебираться');
  assert.match(deployLatest, /MAX_PAGES=/, 'перебор обязан быть ограничен');
  assert.ok(!/per_page=30\b/.test(deployLatest), 'тридцати мало');
});

test('ручной путь в документации пушит один ref, а не все теги', () => {
  assert.ok(!releaseDoc.includes('git push origin --tags'), '--tags отправил бы посторонние теги');
  assert.match(releaseDoc, /git push origin "refs\/tags\/\$tag"/);
});

// Второй раунд ревью: пять находок, и первая снова оставляла бы теги неопубликованными.

// Объявленный блок permissions обнуляет всё неупомянутое, а создание workflow_dispatch требует
// записи в Actions. Без неё пуш проходит, dispatch получает 403 — и релиз опять не выходит.
test('у workflow есть право запустить публикацию, а не только запушить тег', () => {
  const permissions = workflow.slice(workflow.indexOf('permissions:'), workflow.indexOf('concurrency:'));
  assert.match(permissions, /contents: write/, 'пуш тега');
  assert.match(permissions, /actions: write/, 'запуск публикации');
});

// `${{ ... }}` подставляется в текст скрипта ДО того, как его увидит bash: канал вида `$(...)`
// выполнился бы как команда с токеном задания, а не отвалился бы на проверке канала.
test('входы приходят через env, а не подстановкой в текст скрипта', () => {
  for (const [step, script] of workflow.split(/^ {6}- name: /m).entries()) {
    const run = script.indexOf('run:');
    if (run === -1) continue;
    const body = script.slice(run);
    assert.ok(
      !/\$\{\{\s*inputs\./.test(body),
      `шаг ${step}: вход подставлен прямо в скрипт — это выполнение чужой строки`
    );
    assert.ok(!/\$\{\{\s*steps\./.test(body), `шаг ${step}: вывод шага подставлен прямо в скрипт`);
  }
  assert.match(workflow, /CHANNEL: \$\{\{ inputs\.channel \}\}/, 'канал обязан ехать через env');
});

test('предрелизом считается и тег с суффиксом, даже если флаг в GitHub забыли', () => {
  const releases = [
    { tag_name: 'v2.6.0-beta.9', draft: false, prerelease: false, published_at: '2026-05-01T00:00:00Z' },
    { tag_name: 'v2.5.0', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.5.0', 'бета не должна уехать на боевой сервер');
  assert.equal(pickLatestRelease(releases, { allowPrerelease: true }), 'v2.6.0-beta.9');
});

// install.sh берёт git-remote из своей настройки, а RELEASE_REPOSITORY — только для проверки
// публикации. При расхождении он проверил бы релиз в одном репозитории, а код взял из другого.
test('выкат не продолжает работу при расхождении репозиториев', () => {
  assert.match(deployLatest, /SAVED_RELEASE_REPOSITORY=/, 'сохранённый репозиторий обязан читаться');
  const mismatch = deployLatest.indexOf('"$current_repo" != "$REPO"');
  const install = deployLatest.indexOf('bash "$INSTALL"');
  assert.ok(mismatch !== -1, 'расхождение обязано проверяться');
  assert.ok(mismatch < install, 'проверка обязана стоять до установки');
});

test('«уже стоит» решается парой тег+репозиторий, а не одним тегом', () => {
  assert.match(deployLatest, /"\$latest" == "\$current" && "\$REPO" ==/);
});

// Отсутствие сохранённого репозитория — это «неизвестно», а не «совпадает». На свежей установке
// поля нет вовсе, и при явно заданном WOBBLE_REPO подтвердить совпадение нечем.
test('выкат отказывается от override, когда репозиторий установки неизвестен', () => {
  assert.match(deployLatest, /repo_overridden=1/, 'явное задание обязано отличаться от умолчания');
  assert.match(deployLatest, /WOBBLE_REPO\+set/, 'различать надо «задано пустым» и «не задано»');
  const guard = deployLatest.indexOf('"$repo_overridden" == 1 && -z "$current_repo"');
  const install = deployLatest.indexOf('bash "$INSTALL"');
  assert.ok(guard !== -1, 'неизвестный репозиторий при override обязан останавливать');
  assert.ok(guard < install, 'останавливать надо до установки');
});
