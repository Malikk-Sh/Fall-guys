import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { SocialSafety, REPORT_REASONS, pairFor } = require('./socialSafety');
const { installSocialRoutes, keysOnly } = require('./socialRoutes');

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

async function listen(app) {
  const server = await new Promise(resolve => {
    const opened = app.listen(0, '127.0.0.1', () => resolve(opened));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

test('avoid remains symmetric for matchmaking but each player owns their personal choice', () => {
  const context = fresh();
  const { first, second } = partnered(context);
  const stranger = context.accounts.create('Незнакомец');

  assert.deepEqual(pairFor(second.id, first.id), [first.id, second.id].sort());
  assert.deepEqual(context.social.avoid({ accountId: first.id, targetAccountId: stranger.id }), {
    ok: false,
    reason: 'not-recent-partner'
  });
  assert.equal(context.social.shouldAvoid(first.id, second.id), false);

  assert.deepEqual(context.social.avoid({ accountId: first.id, targetAccountId: second.id, now: 200 }), {
    ok: true,
    avoided: true,
    created: true
  });
  assert.equal(context.social.shouldAvoid(first.id, second.id), true);
  assert.deepEqual(context.social.listAvoided(first.id), [{ id: second.id, name: 'Второй', avoidedAt: 200 }]);
  assert.deepEqual(context.social.listAvoided(second.id), []);

  assert.equal(
    context.social.avoid({ accountId: second.id, targetAccountId: first.id, now: 300 }).created,
    true
  );
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM matchmaking_avoids').get().count, 1);

  assert.deepEqual(context.social.unavoid({ accountId: first.id, targetAccountId: second.id }), {
    ok: true,
    avoided: false,
    removed: true
  });
  assert.deepEqual(context.social.listAvoided(first.id), []);
  assert.equal(context.social.shouldAvoid(first.id, second.id), true, 'second choice still protects pair');

  assert.equal(context.social.unavoid({ accountId: second.id, targetAccountId: first.id }).removed, true);
  assert.equal(context.social.shouldAvoid(first.id, second.id), false);
  assert.equal(context.db.prepare('SELECT COUNT(*) AS count FROM matchmaking_avoids').get().count, 0);
  context.db.close();
});

test('profile only exposes the current account own avoid choice', () => {
  const context = fresh();
  const { first, second } = partnered(context);
  context.social.avoid({ accountId: first.id, targetAccountId: second.id, now: 200 });
  assert.equal(context.accounts.profile(first.id).recentPartner.avoided, true);
  assert.equal(context.accounts.profile(second.id).recentPartner.avoided, false);
  context.db.close();
});

test('social actions are limited to the most recent partner', () => {
  const context = fresh();
  const { first, second } = partnered(context);
  const third = context.accounts.create('Третий');
  context.accounts.recordCoopPartners({
    accountIds: [first.id, third.id],
    chapterId: 'ch5',
    playedAt: 500
  });

  assert.equal(context.social.isRecentPartner(first.id, third.id), true);
  assert.equal(context.social.isRecentPartner(first.id, second.id), false);
  assert.deepEqual(context.social.avoid({ accountId: first.id, targetAccountId: second.id }), {
    ok: false,
    reason: 'not-recent-partner'
  });
  assert.deepEqual(
    context.social.report({ accountId: first.id, targetAccountId: second.id, reason: 'afk' }),
    { ok: false, reason: 'not-recent-partner' }
  );
  context.db.close();
});

test('report accepts fixed reasons and suppresses spam during cooldown', () => {
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

test('social HTTP routes list and restore only the authenticated account own avoids', async () => {
  const context = fresh();
  const { first, second } = partnered(context);
  const app = express();
  installSocialRoutes({
    app,
    socialSafety: context.social,
    requireSession(req, res) {
      const accountId = req.headers['x-test-account'];
      if (accountId) return { accountId: String(accountId) };
      res.status(401).json({ ok: false, error: 'session-required' });
      return null;
    }
  });
  const server = await listen(app);
  try {
    const unauthenticated = await fetch(`${server.url}/api/social/avoid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetAccountId: second.id })
    });
    assert.equal(unauthenticated.status, 401);

    const freeText = await fetch(`${server.url}/api/social/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': first.id },
      body: JSON.stringify({ targetAccountId: second.id, reason: 'afk', text: 'не должно пройти' })
    });
    assert.equal(freeText.status, 400);
    assert.equal((await freeText.json()).error, 'invalid-payload');

    const avoid = await fetch(`${server.url}/api/social/avoid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': first.id },
      body: JSON.stringify({ targetAccountId: second.id })
    });
    assert.equal(avoid.status, 200);
    assert.equal((await avoid.json()).avoided, true);

    const firstList = await fetch(`${server.url}/api/social/avoids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': first.id },
      body: '{}'
    });
    assert.deepEqual(
      (await firstList.json()).players.map(player => player.id),
      [second.id]
    );

    const secondList = await fetch(`${server.url}/api/social/avoids`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': second.id },
      body: '{}'
    });
    assert.deepEqual((await secondList.json()).players, []);

    const restored = await fetch(`${server.url}/api/social/unavoid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-account': first.id },
      body: JSON.stringify({ targetAccountId: second.id })
    });
    assert.equal((await restored.json()).removed, true);
    assert.equal(context.social.shouldAvoid(first.id, second.id), false);
  } finally {
    await server.close();
    context.db.close();
  }
});

test('social API payload has no free-text channel', () => {
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
