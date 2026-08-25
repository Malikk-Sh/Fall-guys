#!/usr/bin/env node
// Читает страницы ответа GitHub Releases со stdin и печатает тег последнего подходящего релиза.
//
// На вход — по JSON-массиву на строку: страницы приходят отдельными запросами, а склеивать их в
// один массив средствами bash значило бы редактировать JSON текстом.
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

const releases = [];
for (const line of raw.split('\n')) {
  const page = line.trim();
  if (!page) continue;
  let parsed;
  try {
    parsed = JSON.parse(page);
  } catch {
    process.stderr.write('ответ GitHub не разобрался как JSON\n');
    process.exit(1);
  }
  if (Array.isArray(parsed)) releases.push(...parsed);
  else releases.push(parsed);
}

const tag = pickLatestRelease(releases, { allowPrerelease });
if (tag) process.stdout.write(`${tag}\n`);
