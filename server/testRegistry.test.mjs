import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Файл теста, не попавший в package.json, не запускается — и молчит об этом.
//
// Это не гипотеза: `shadowHitPairing.test.mjs` пролежал неучтённым целый PR, и четыре теста,
// которые предъявлялись как доказательство исправления, при ревью не выполнялись ни разу. Аудит
// нашёл ещё шесть таких файлов — 33 теста, не запускавшихся ничем.
//
// Списки в `test:server` и `test:client` поимённые, и это осознанно: клиентские тесты идут через
// свой загрузчик, а серверные без него, и глоб такого разделения не выражает. Значит нужна не
// замена списков, а проверка, что они полны — и она обязана быть тестом, потому что тест запускает
// CI, а договорённость не запускает никто.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Пути тестов из строки скрипта. Флаги и загрузчик (`./server/client-loader.mjs`) отсеиваются сами:
// они не начинаются с `server/`.
function listedFiles(script) {
  return script.split(/\s+/).filter(token => /^server\/[\w.-]+\.m?js$/.test(token));
}

function readScripts() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return {
    server: listedFiles(pkg.scripts['test:server']),
    client: listedFiles(pkg.scripts['test:client'])
  };
}

// Файлы, которые ОБЯЗАНЫ где-то числиться. `server/test.js` под шаблон не подходит и потому в это
// множество не входит, но обратной проверкой (всё перечисленное существует) он всё равно накрыт.
function testFilesOnDisk() {
  return readdirSync(join(root, 'server'))
    .filter(name => name.endsWith('.test.mjs') || name.endsWith('.test.js'))
    .map(name => `server/${name}`)
    .sort();
}

test('каждый файл тестов запускается ровно одним скриптом', () => {
  const { server, client } = readScripts();
  const listed = [...server, ...client];
  const missing = testFilesOnDisk().filter(file => !listed.includes(file));

  assert.deepEqual(
    missing,
    [],
    `эти файлы тестов не запускает ни один скрипт, то есть в CI их нет:\n  ${missing.join('\n  ')}`
  );
});

test('перечисленные файлы существуют', () => {
  // Обратная сторона: переименованный или удалённый файл оставляет запись, и node падает на старте
  // всего набора. Ошибка при этом выглядит как поломка тестов, а не как устаревший список.
  const { server, client } = readScripts();
  const absent = [...server, ...client].filter(file => !existsSync(join(root, file)));
  assert.deepEqual(absent, [], `перечислены, но не существуют:\n  ${absent.join('\n  ')}`);
});

// Файлы тестов, которые импортирует данный файл. Именно ИМПОРТ, а не перечисление: импортированный
// тест выполняется внутри чужого процесса, и manifest об этом ничего не знает.
function importedTestFiles(file) {
  const source = readFileSync(join(root, file), 'utf8');
  // Ловится ЛЮБАЯ статическая ссылка на файл теста, а не только импорт ради побочного эффекта.
  //
  // Первая редакция знала лишь форму `import './x.test.mjs'`. Но `import { helper } from
  // './x.test.mjs'`, импорт по умолчанию, `import * as`, реэкспорт и динамический `import()` — всё
  // это точно так же ВЫПОЛНЯЕТ импортируемый файл вместе с его тестами. Проверка, знающая одну
  // форму из шести, оставляла дыру ровно там, где её удобнее всего не заметить: помощник, вынесенный
  // в соседний тест, выглядит безобидно.
  const pattern =
    /(?:^|\s)(?:import|export)\s*(?:[\w*{},\s]*?\s*from\s*)?[('\s]*['"]\.\/([\w.-]+\.test\.m?js)['"]/gm;
  return [...source.matchAll(pattern)].map(match => `server/${match[1]}`);
}

test('тест не запускает другой тест', () => {
  // Один файл может импортировать другой, и тогда тот выполняется ВНУТРИ его процесса. Manifest об
  // этом не знает, поэтому файл, и перечисленный, и импортированный, проходит весь набор дважды —
  // а проверка на дубли по строке скрипта такого не видит вовсе.
  //
  // Так и случилось: шесть файлов подачи импортировал `pwaClient.test.mjs`, и в #193 я счёл их
  // незапускаемыми и добавил в manifest. Они не были осиротевшими — после добавления все 33 их
  // теста стали выполняться по два раза, и рост 430 → 463 был удвоением, а не покрытием.
  // `playerSimulation.test.mjs` дублировался так же через `e2eCourse.test.mjs`, но давно.
  //
  // Правило теперь одно: запуск задаёт manifest, и только он. Тогда «перечислен ровно один раз»
  // действительно означает «выполняется ровно один раз».
  const offenders = [];
  for (const file of testFilesOnDisk()) {
    for (const imported of importedTestFiles(file)) offenders.push(`${file} → ${imported}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `тесты импортируют другие тесты, и те выполняются дважды:\n  ${offenders.join('\n  ')}`
  );
});

test('ни один файл не запускается дважды', () => {
  // Дубль стоит времени CI, а при общем состоянии между файлами ещё и меняет результат в
  // зависимости от порядка.
  const { server, client } = readScripts();
  const listed = [...server, ...client];
  const duplicated = [...new Set(listed.filter(file => listed.indexOf(file) !== listed.lastIndexOf(file)))];
  assert.deepEqual(duplicated, [], `перечислены больше одного раза:\n  ${duplicated.join('\n  ')}`);
});
