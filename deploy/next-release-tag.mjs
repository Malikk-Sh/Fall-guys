#!/usr/bin/env node
// Печатает следующий свободный тег предрелиза для текущей версии пакета.
//
// Существует, чтобы номер выбирал не человек. Правило живёт в общем releasePolicy.mjs — там же,
// где проверка тега при публикации, — иначе выдача номеров и их проверка разъехались бы.
//
//   node deploy/next-release-tag.mjs            → v2.6.0-beta.6
//   node deploy/next-release-tag.mjs rc         → v2.6.0-rc.1
//
// Теги берутся из локального репозитория, поэтому вызывающий обязан сперва их получить
// (`git fetch --tags`). В CI это делает checkout с fetch-depth: 0.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

import { nextPrereleaseTag } from './releasePolicy.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

const channel = process.argv[2] || 'beta';
const tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' })
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean);

process.stdout.write(`${nextPrereleaseTag({ tags, version: pkg.version, channel })}\n`);
