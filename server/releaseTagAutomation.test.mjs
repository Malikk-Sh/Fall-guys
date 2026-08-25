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

test('workflow проверяет тег политикой релизов ДО создания', () => {
  const validate = workflow.indexOf('deploy/check-release.mjs');
  const create = workflow.indexOf('git tag -a');
  assert.ok(validate !== -1, 'проверка тега обязана быть в workflow');
  assert.ok(create !== -1, 'создание тега обязано быть в workflow');
  assert.ok(validate < create, 'проверять надо ДО создания: тег неизменяем');
});

test('workflow сам ничего не выпускает — только ставит метку', () => {
  assert.ok(!workflow.includes('gh release create'), 'публикация остаётся в release.yml');
  assert.match(workflow, /workflow_dispatch/, 'запуск только руками');
});

// Вторая часть автоматизации: выкат. Тег больше не набирается руками — он берётся из GitHub.

test('последним считается свежий выпущенный, а не наибольший номер', () => {
  // Так бывает, когда чинят старую ветку версий: свежий релиз имеет МЕНЬШИЙ номер.
  const releases = [
    { tag_name: 'v2.5.1', draft: false, prerelease: false },
    { tag_name: 'v2.6.0', draft: false, prerelease: false }
  ];
  assert.equal(pickLatestRelease(releases), 'v2.5.1');
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
  assert.match(deployLatest, /RELEASE_TAG="\$latest" bash "\$INSTALL"/);
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
