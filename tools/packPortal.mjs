// Упаковка портального билда в архив, который принимает площадка.
//
// Площадка не монтирует ничего: ей отдают ZIP, она распаковывает его и раздаёт со своего пути.
// Поэтому `index.html` обязан лежать В КОРНЕ архива, а не внутри папки — иначе площадка его просто
// не найдёт, а сообщение об этом придёт из чужой формы загрузки и через час ожидания.
//
// ПОЧЕМУ СВОЙ ПИСАТЕЛЬ ZIP, А НЕ ВЫЗОВ `zip`. Не из-за переносимости, хотя и она тут кстати. Дело в
// том, что архив надо ПРОВЕРЯТЬ, а не только собрать. Со своим писателем тест читает центральный
// каталог готового файла и утверждает то, что действительно важно: что имена внутри именно те, что
// `index.html` в корне, что ничего лишнего не уехало. С внешней утилитой тест сам зависел бы от
// неё же и проверял бы в лучшем случае «команда вернула ноль».
//
// Формат намеренно минимальный: deflate или store, без ZIP64 и без шифрования. Билд — это две с
// половиной сотни килобайт в архиве и полторы сотни файлов; пределов формата тут не видно даже
// вдалеке. Понадобится больше — станет видно сразу, потому что архив просто перестанет собираться,
// а не соберётся неправильно.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

import { buildPortal, PLATFORMS } from './buildPortal.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Поля читаются UTC-геттерами, а не локальными.
//
// С локальными один и тот же `SOURCE_DATE_EPOCH` давал на разных машинах разные заголовки: замер по
// трём поясам дал три разные суммы SHA-256, а в Токио разъезжалась и дата. То есть воспроизводимость
// держалась на одной машине и ломалась ровно там, где она нужна, — между агентом CI и локальной
// сборкой. Значение по умолчанию при этом было устойчиво случайно: локальная конструкция и
// локальные геттеры взаимно сокращались. Теперь обе половины определены в UTC явно.
function dosStamp(date) {
  const time =
    ((date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1)) & 0xffff;
  const day =
    (((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate()) & 0xffff;
  return { time, day };
}

// Метка времени по умолчанию — начало эпохи ZIP, а не «сейчас».
//
// Сортировки имён для воспроизводимости НЕ ХВАТАЕТ, и я это сначала утверждал, не проверив: при
// повторной упаковке того же дерева `new Date()` пишет другое время во все заголовки, и архив
// одинакового размера выходит другими байтами. Проверено — два прогона подряд дают разный файл.
//
// Раз время в архиве всё равно ничего не значит для площадки, оно берётся постоянным. Снаружи его
// можно задать через `SOURCE_DATE_EPOCH` — общепринятое соглашение воспроизводимых сборок.
export const ZIP_EPOCH = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

export function defaultDate(environment = process.env) {
  const fromEnvironment = Number.parseInt(environment.SOURCE_DATE_EPOCH || '', 10);
  return Number.isFinite(fromEnvironment) ? new Date(fromEnvironment * 1000) : ZIP_EPOCH;
}

// Записи идут в том порядке, в каком переданы. Порядок держит вызывающий — сортировкой по имени;
// вместе с постоянной меткой времени это и даёт байт в байт одинаковый архив на одном и том же
// дереве.
export function makeZip(entries, { date = defaultDate() } = {}) {
  const { time, day } = dosStamp(date);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Сжатие берётся, только если оно действительно меньше: на уже сжатом (png, mp3) deflate растит.
    const packed = deflated.length < raw.length;
    const body = packed ? deflated : raw;
    const method = packed ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена в UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// Чтение имён из готового архива — по центральному каталогу, как это делает распаковщик. Нужно
// тесту: утверждать состав архива по списку файлов на диске значило бы проверять свой же замысел,
// а не то, что действительно уехало.
export function listZip(buffer) {
  const endSignature = 0x06054b50;
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== endSignature) end -= 1;
  if (end < 0) throw new Error('это не ZIP: нет конца центрального каталога');

  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('повреждён центральный каталог');
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function walk(dir, base = dir) {
  const found = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) found.push(...walk(full, base));
    else found.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return found;
}

export function packPortal({ platform = 'yandex', outFile } = {}) {
  const root = buildPortal({ platform });
  // Сортировка — ради воспроизводимости: обход каталога порядок не гарантирует, а одинаковый билд
  // должен давать одинаковый архив.
  const names = walk(root).sort();

  // Проверка стоит ДО записи файла: негодный архив лучше не создавать вовсе, чем создать и потом
  // объяснять в консоли, что он негоден.
  if (!names.includes('index.html')) {
    throw new Error('в корне билда нет index.html — площадка такой архив не примет');
  }

  const zip = makeZip(names.map(name => ({ name, data: fs.readFileSync(path.join(root, name)) })));
  const target = outFile || path.join(ROOT, 'dist', `wobble-rush-${platform}.zip`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, zip);

  return { file: target, files: names.length, bytes: zip.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === url.fileURLToPath(import.meta.url)) {
  const platform = process.argv[2] || 'yandex';
  try {
    const { file, files, bytes } = packPortal({ platform });
    const mb = (bytes / 1024 / 1024).toFixed(2);
    console.log(`Архив для площадки ${platform}: ${path.relative(ROOT, file)} — ${files} файлов, ${mb} МБ`);
    console.log(`Известные площадки: ${PLATFORMS.join(', ')}`);
  } catch (error) {
    // Ненулевой код обязателен: молчаливо «успешная» упаковка негодного архива хуже падения.
    console.error(`Архив не собран: ${error.message}`);
    process.exitCode = 1;
  }
}
