import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

import { listZip, makeZip, packPortal } from '../tools/packPortal.mjs';

// Архив читается ОБРАТНО, а не сверяется со списком файлов на диске.
//
// Сверка со списком проверяла бы замысел упаковщика его же глазами. Здесь разобран центральный
// каталог готового файла — то же самое делает распаковщик площадки.

test('в архиве лежит ровно то, что положили, и читается по центральному каталогу', () => {
  const entries = [
    { name: 'index.html', data: Buffer.from('<h1>меню</h1>', 'utf8') },
    { name: 'vendor/three.js', data: Buffer.from('x'.repeat(4096), 'utf8') },
    { name: 'shared/course.js', data: Buffer.from('export const seed = 1;', 'utf8') }
  ];
  assert.deepEqual(listZip(makeZip(entries)), ['index.html', 'vendor/three.js', 'shared/course.js']);
});

// Содержимое обязано доезжать байт в байт, и проверяется это распаковкой, а не длиной записи.
test('содержимое записей распаковывается обратно без изменений', () => {
  const payload = Buffer.from('трасса: '.repeat(500), 'utf8');
  const zip = makeZip([{ name: 'a.js', data: payload }]);

  // Локальный заголовок: 30 байт + имя, дальше тело.
  const nameLength = zip.readUInt16LE(26);
  const method = zip.readUInt16LE(8);
  const packedSize = zip.readUInt32LE(18);
  const body = zip.subarray(30 + nameLength, 30 + nameLength + packedSize);
  const restored = method === 8 ? zlib.inflateRawSync(body) : body;

  assert.deepEqual(restored, payload);
  assert.equal(zip.readUInt32LE(22), payload.length, 'исходный размер обязан быть записан честно');
});

// Уже сжатое deflate только растит, и тогда запись обязана лечь без сжатия.
//
// Проверяется ПОЛЕ МЕТОДА, а не размер архива. Сначала здесь стояло «архив не больше данных плюс
// запас» — и это утверждение не ловило ничего: накладные расходы deflate на четырёх килобайтах
// меньше любого разумного запаса, так что тест был зелёным и с принудительным сжатием. Проверено
// мутацией — потому и переписан.
test('несжимаемая запись ложится без сжатия, а не жмётся впустую', () => {
  // Байты берутся у генератора случайных, а не считаются формулой. Сначала здесь стояло
  // `(i * 2654435761) % 251` «как случайные» — последовательность с периодом 251, которую deflate
  // прекрасно сжимает. Тест падал на исправном коде, потому что неверны были данные.
  const noise = randomBytes(4096);
  const zip = makeZip([{ name: 'n.bin', data: noise }]);
  assert.equal(zip.readUInt16LE(8), 0, 'метод 0 — store; на несжимаемом deflate только растит');

  const text = Buffer.from('трасса '.repeat(1000), 'utf8');
  assert.equal(makeZip([{ name: 't.js', data: text }]).readUInt16LE(8), 8, 'сжимаемое обязано сжаться');
});

test('битый буфер отвергается, а не читается наугад', () => {
  assert.throws(() => listZip(Buffer.from('это не архив', 'utf8')), /не ZIP/);
});

// ГЛАВНОЕ ТРЕБОВАНИЕ ПЛОЩАДКИ.
//
// Площадка распаковывает архив и ищет `index.html` в его КОРНЕ. Уедь он внутри папки — загрузка
// отклоняется, и узнаём мы об этом из чужой формы, а не отсюда.
test('index.html лежит в корне архива, а не внутри папки', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-pack-'));
  try {
    const { file, files } = packPortal({ outFile: path.join(dir, 'p.zip') });
    const names = listZip(fs.readFileSync(file));

    assert.ok(names.includes('index.html'), 'index.html обязан быть в корне');
    assert.equal(files, names.length);
    assert.ok(names.length > 100, 'билд — это больше сотни файлов; пустой архив тоже «собрался бы»');
    // Ни одна запись не должна начинаться с общей папки-обёртки.
    const wrapped = names.filter(name => name.startsWith('dist/') || name.startsWith('yandex/'));
    assert.deepEqual(wrapped, [], 'архив не должен быть обёрнут в папку');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Подтверждения владения доменом подтверждают НАШ домен и на площадке не значат ничего. Исключены
// образцом, а не списком имён: файл уже сменился однажды, и список протух бы при следующей смене.
test('подтверждения домена Яндекс.Вебмастера в архив не уезжают', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-pack-'));
  try {
    const { file } = packPortal({ outFile: path.join(dir, 'p.zip') });
    const names = listZip(fs.readFileSync(file));
    const verification = names.filter(name => /^yandex_[0-9a-f]+\.html$/.test(name));
    assert.deepEqual(verification, [], `в архив уехали подтверждения домена: ${verification.join(', ')}`);

    // И заодно то, что не уезжает по устройству площадки, — чтобы проверка держала весь список,
    // а не одну свежую находку.
    assert.deepEqual(
      names.filter(name => name.startsWith('admin/') || name === 'service-worker.js'),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('неизвестная площадка не даёт «успешно собранного» архива', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-pack-'));
  try {
    const target = path.join(dir, 'p.zip');
    assert.throws(() => packPortal({ platform: 'yadnex', outFile: target }), /неизвестная площадка/);
    assert.equal(fs.existsSync(target), false, 'негодный архив не должен появляться на диске');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
