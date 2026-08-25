#!/usr/bin/env node
// Читает ответ GitHub Releases со stdin и печатает тег последнего подходящего релиза.
//
// Отдельным файлом, а не строкой внутри shell-скрипта, по одной причине: правило «что считать
// последним релизом» знает про черновики и предрелизы, и его надо проверять тестами. Строку внутри
// bash проверить нечем.
//
//   curl … | node deploy/latest-release-tag.mjs
//   curl … | node deploy/latest-release-tag.mjs --prerelease
//
// Пустой вывод означает «подходящего релиза нет» — это не ошибка, а ответ.

import { pickLatestRelease } from './releasePolicy.mjs';

const allowPrerelease = process.argv.includes('--prerelease');

let raw = '';
for await (const chunk of process.stdin) raw += chunk;

let releases;
try {
  releases = JSON.parse(raw);
} catch {
  process.stderr.write('ответ GitHub не разобрался как JSON\n');
  process.exit(1);
}

const tag = pickLatestRelease(releases, { allowPrerelease });
if (tag) process.stdout.write(`${tag}\n`);
