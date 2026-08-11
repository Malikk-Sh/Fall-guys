#!/usr/bin/env node

import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { AdminAuthService, ADMIN_ROLES } = require('./adminAuth');

function usage(exitCode = 0) {
  const out = exitCode ? console.error : console.log;
  out(`Wobble Rush admin CLI

Usage:
  node server/adminCli.mjs --db <sqlite> create --name <name> --role <role>
  node server/adminCli.mjs --db <sqlite> list
  node server/adminCli.mjs --db <sqlite> rotate <admin-id>
  node server/adminCli.mjs --db <sqlite> disable <admin-id>
  node server/adminCli.mjs --db <sqlite> enable <admin-id>

Roles: ${ADMIN_ROLES.join(', ')}

Access codes are shown only by create/rotate. Store them securely; the database keeps only hashes.`);
  process.exit(exitCode);
}

function parse(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!['db', 'name', 'role'].includes(key)) throw new Error(`unknown option --${key}`);
    const next = argv[index + 1];
    if (next == null || next.startsWith('--')) throw new Error(`--${key} requires a value`);
    options[key] = next;
    index += 1;
  }
  return { options, positional };
}

let parsed;
try {
  if (process.argv.includes('--help') || process.argv.includes('-h')) usage(0);
  parsed = parse(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage(2);
}

const dbPath = parsed.options.db || process.env.LEADERBOARD_DB;
if (!dbPath || dbPath === ':memory:') {
  console.error('Refusing an unspecified/in-memory admin database. Pass --db <sqlite>.');
  usage(2);
}
if (!existsSync(dbPath)) {
  console.error(`Refusing to create a new admin database: ${dbPath} does not exist.`);
  process.exit(2);
}
if (!statSync(dbPath).isFile()) {
  console.error(`Refusing admin database path that is not a file: ${dbPath}`);
  process.exit(2);
}

const [command, targetId, ...extra] = parsed.positional;
if (!command || extra.length) usage(2);

const db = openDatabase(dbPath);
db.exec('PRAGMA busy_timeout = 5000');
try {
  const admin = new AdminAuthService({ db });
  if (command === 'create') {
    if (targetId) usage(2);
    const result = admin.createUser({ name: parsed.options.name, role: parsed.options.role });
    if (!result.ok) {
      console.error(JSON.stringify(result, null, 2));
      process.exitCode = 1;
    } else {
      admin.audit({
        actor: { name: 'admin-cli', role: 'system' },
        action: 'admin.user.create',
        targetType: 'admin-user',
        targetId: result.user.id,
        detail: { role: result.user.role }
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (command === 'list') {
    if (targetId) usage(2);
    console.log(JSON.stringify({ ok: true, users: admin.listUsers() }, null, 2));
  } else if (command === 'rotate') {
    if (!targetId) usage(2);
    const result = admin.rotateAccessCode(targetId);
    if (!result.ok) process.exitCode = 1;
    else
      admin.audit({
        actor: { name: 'admin-cli', role: 'system' },
        action: 'admin.user.rotate-access',
        targetType: 'admin-user',
        targetId
      });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'disable' || command === 'enable') {
    if (!targetId) usage(2);
    const disabled = command === 'disable';
    const result = admin.setDisabled(targetId, disabled);
    if (!result.ok) process.exitCode = 1;
    else
      admin.audit({
        actor: { name: 'admin-cli', role: 'system' },
        action: disabled ? 'admin.user.disable' : 'admin.user.enable',
        targetType: 'admin-user',
        targetId
      });
    console.log(JSON.stringify(result, null, 2));
  } else {
    usage(2);
  }
} finally {
  db.close();
}
