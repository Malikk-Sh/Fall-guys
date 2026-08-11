#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { ModerationQueue, MODERATION_STATUSES } = require('./moderation');

function usage(exitCode = 0) {
  const out = exitCode ? console.error : console.log;
  out(`Wobble Rush moderation CLI

Usage:
  node server/moderationCli.mjs --db <sqlite> queue [--status open|reviewing|resolved|dismissed|all] [--limit N]
  node server/moderationCli.mjs --db <sqlite> show <account-id>
  node server/moderationCli.mjs --db <sqlite> set <account-id> <status> --moderator <id> [--note <text>]

Closed states (resolved/dismissed) require --note. This tool records decisions only; it does not
ban, suspend or rename players automatically. Run it locally on the VPS against the production DB;
there is intentionally no public HTTP moderation endpoint.`);
  process.exit(exitCode);
}

function parse(argv) {
  const args = [...argv];
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!['db', 'status', 'limit', 'moderator', 'note'].includes(key)) {
      throw new Error(`unknown option --${key}`);
    }
    const next = args[index + 1];
    if (next == null || next.startsWith('--')) throw new Error(`--${key} requires a value`);
    options[key] = next;
    index += 1;
  }
  return { options, positional };
}

function fail(message, extra = {}) {
  console.error(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  process.exitCode = 1;
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
  console.error('Refusing to moderate an unspecified/in-memory database. Pass --db <sqlite>.');
  usage(2);
}

const [command, targetAccountId, requestedStatus, ...extra] = parsed.positional;
if (!command || extra.length) usage(2);

const db = openDatabase(dbPath);
try {
  const moderation = new ModerationQueue({ db });

  if (command === 'queue') {
    if (targetAccountId || requestedStatus) usage(2);
    const result = moderation.queue({
      status: parsed.options.status || 'open',
      limit: parsed.options.limit || 50
    });
    if (!result.ok) fail(result.reason, { allowedStatuses: result.allowedStatuses });
    else console.log(JSON.stringify(result, null, 2));
  } else if (command === 'show') {
    if (!targetAccountId || requestedStatus) usage(2);
    const result = moderation.get(targetAccountId);
    if (!result) fail('no-reports', { targetAccountId });
    else console.log(JSON.stringify({ ok: true, case: result }, null, 2));
  } else if (command === 'set') {
    if (!targetAccountId || !requestedStatus) usage(2);
    const result = moderation.transition({
      targetAccountId,
      status: requestedStatus,
      moderatorId: parsed.options.moderator,
      note: parsed.options.note
    });
    if (!result.ok) {
      fail(result.reason, {
        ...(result.allowedStatuses ? { allowedStatuses: result.allowedStatuses } : {}),
        statuses: MODERATION_STATUSES
      });
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
  } else {
    usage(2);
  }
} finally {
  db.close();
}
