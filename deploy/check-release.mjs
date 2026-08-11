#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateReleaseVersions } from './releasePolicy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tag = process.argv[2];

if (!tag || tag === '--help' || tag === '-h') {
  console.error('usage: node deploy/check-release.mjs <tag>');
  process.exit(tag ? 0 : 2);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const release = validateReleaseVersions({
  tag,
  packageVersion: pkg.version,
  lockVersion: lock.version || lock.packages?.['']?.version
});

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

const head = git('rev-parse', 'HEAD');
let tagCommit;
try {
  tagCommit = git('rev-parse', `${tag}^{commit}`);
} catch {
  throw new Error(`tag ${tag} does not exist in this checkout`);
}
if (tagCommit !== head) {
  throw new Error(`tag ${tag} points to ${tagCommit.slice(0, 12)}, HEAD is ${head.slice(0, 12)}`);
}

console.log(
  JSON.stringify({
    ok: true,
    tag: release.tag,
    version: release.version,
    prerelease: release.prerelease,
    commit: head
  })
);
