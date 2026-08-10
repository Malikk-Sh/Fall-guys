import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { SocialSafety, REPORT_REASONS, pairFor } = require('./socialSafety');
const { keysOnly } = require('./socialRoutes');

function fresh() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const social = new SocialSafety({ db, reportCooldownMs: 1000 });
  return { db, accounts, social };
}

function partnered(context) {
  const first = context.accounts.create('Первый');
  const second = context.accounts.create('Второй');
  context.accounts.recordCoopPartners({
    accountIds: [first.id, second.id],
    chapterId: 'ch4',
    playedAt: 100
  });
  return { first, second };
}

test('avoid хранит одну симметричную пару и не влияет на произвольные аккаунты', () => {
  const context = fresh();
  const { first, second } = partnered(context);
  const stranger = context.accounts.create('Незнакомец');

  assert.deepEqual(pairFor(second.id, first.id), [first.id, second.id].sort());
  assert.deepEqual(context.social.avoid({ accountId: first.id, targetAccountId: stranger.id }), {
    ok: false,
    reason: 'not-recent-partner'
  });
  assert.equal(context.social.shouldAvoid(first.id, second.id), false);

  const created = context.social.avoid({ accountId: first.id, targetAccountId: second.id, now: 200 });
  assert.deepEqual(created, { ok: true, avoided: true, created: true });
  assert.equal(context.social.shouldAvoid(first.id, second.id), true);
  assert.equal(context.social.shouldAvoid(second.id, first.id), true);
  assert.equal(
    context.social.avoid({ accountId: second.id, targetAccountId: first.id, now: 300 }).created,
    false
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM matchmaking_avoids').get().count, 1);
  context.db.close();
});

test('report принимает только фиксированные причины и подавляет spam в cooldown', () => {
  const context = fresh();
  const { first, second } = partnered(context);

  assert.deepEqual(REPORT_REASONS, ['afk', 'griefing', 'offensive-name', 'exploit-cheat']);
  assert.deepEqual(
    context.social.report({
      accountId: first.id,
      targetAccountId: second.id,
      reason: 'free text',
      now: 1000
    }),
    { ok: false, reason: 'invalid-reason' }
  );

  assert.deepEqual(
    context.social.report({ accountId: first.id, targetAccountId: second.id, reason: 'afk', now: 1000 }),
    { ok: true, accepted: true, duplicate: false, reportCount: 1 }
  );
  assert.deepEqual(
    context.social.report({ accountId: first.id, targetAccountId: second.id, reason: 'afk', now: 1500 }),
    { ok: true, accepted: false, duplicate: true, reportCount: 1 }
  );
  assert.deepEqual(
    context.social.report({ accountId: first.id, targetAccountId: second.id, reason: 'afk', now: 2100 }),
    { ok: true, accepted: true, duplicate: false, reportCount: 2 }
  );
  const row = context.db
    .prepare('SELECT report_count, first_reported_at, last_reported_at FROM social_reports')
    .get();
  assert.deepEqual({ ...row }, { report_count: 2, first_reported_at: 1000, last_reported_at: 2100 });
  context.db.close();
});

test('social API payload не имеет канала свободного текста', () => {
  assert.equal(keysOnly({ targetAccountId: 'p2' }, new Set(['targetAccountId'])), true);
  assert.equal(
    keysOnly({ targetAccountId: 'p2', reason: 'afk' }, new Set(['targetAccountId', 'reason'])),
    true
  );
  assert.equal(
    keysOnly(
      { targetAccountId: 'p2', reason: 'afk', text: 'произвольный текст' },
      new Set(['targetAccountId', 'reason'])
    ),
    false
  );
});
