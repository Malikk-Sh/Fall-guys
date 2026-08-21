import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sharedDirectory = path.join(root, 'shared');

function sharedModules() {
  return fs
    .readdirSync(sharedDirectory)
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, source: fs.readFileSync(path.join(sharedDirectory, name), 'utf8') }));
}

function importSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

// Общий код — это то, что исполняется и в браузере, и на сервере. Стоит ему потянуть за собой
// клиентский модуль, и серверная симуляция потребует Three.js или DOM, чтобы просто спросить про
// правила трассы. Именно это и мешало серверу строить геометрию, поэтому граница проверяется, а не
// держится на договорённости.
test('общий код не тянет за собой клиент', () => {
  for (const { name, source } of sharedModules()) {
    for (const specifier of importSpecifiers(source)) {
      assert.equal(
        specifier.includes('client/') || specifier.startsWith('../client'),
        false,
        `${name} импортирует клиентский модуль ${specifier}`
      );
    }
  }
});

test('общий код не тянет за собой сервер и не требует Three.js', () => {
  for (const { name, source } of sharedModules()) {
    for (const specifier of importSpecifiers(source)) {
      assert.equal(specifier.includes('server/'), false, `${name} импортирует серверный модуль`);
      assert.equal(specifier === 'three', false, `${name} импортирует Three.js`);
      assert.equal(specifier.startsWith('three/'), false, `${name} импортирует дополнение Three.js`);
    }
  }
});

test('расстановка сегментов трассы лежит в общем коде', () => {
  const names = sharedModules().map(item => item.name);
  assert.ok(names.includes('courseSegments.js'), 'сервер обязан иметь доступ к расстановке сегментов');
  assert.equal(
    fs.existsSync(path.join(root, 'client/game/segments.js')),
    false,
    'вторая копия расстановки в клиенте означала бы две расходящиеся трассы'
  );
});
