import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { Accounts } = require('./accounts');
const { SocialSafety } = require('./socialSafety');
const { ModerationQueue, MODERATION_STATUSES } = require('./moderation');

const here = dirname(fileURLToPath(import.meta.url));

function fresh() {
  const db = openDatabase(':memory:');
  const accounts = new Accounts({ db });
  const social = new SocialSafety({ db, reportCooldownMs: 1000 });
  const moderation = new ModerationQueue({ db });
  return { db, accounts, social, moderation };
}

function partner(accounts, reporter, target, chapterId, playedAt) {
  accounts.recordCoopPartners({
    accountIds: [reporter.id, target.id],
    chapterId,
    playedAt
  });
}

test('moderation queue groups reports by target and keeps report-time evidence', () => {
  const context = fresh();
  const target = context.accounts.create('Старое имя');
  const reporterA = context.accounts.create('Репортёр A');
  const reporterB = context.accounts.create('Репортёр B');
  const otherTarget = context.accounts.create('Другая цель');
  const reporterC = context.accounts.create('Репортёр C');

  partner(context.accounts, reporterA, target, 'ch4', 100);
  assert.equal(
    context.social.report({
      accountId: reporterA.id,
      targetAccountId: target.id,
      reason: 'griefing',
      now: 1000
    }).accepted,
    true
  );

  context.accounts.rename(target.id, 'Новое имя');
  partner(context.accounts, reporterB, target, 'ch5', 200);
  assert.equal(
    context.social.report({
      accountId: reporterB.id,
      targetAccountId: target.id,
      reason: 'exploit-cheat',
      now: 1100
    }).accepted,
    true
  );

  partner(context.accounts, reporterC, otherTarget, 'ch2', 300);
  context.social.report({
    accountId: reporterC.id,
    targetAccountId: otherTarget.id,
    reason: 'afk',
    now: 1200
  });

  const queue = context.moderation.queue();
  assert.equal(queue.ok, true);
  assert.equal(queue.status, 'open');
  assert.equal(queue.cases.length, 2);
  assert.equal(queue.cases[0].targetAccountId, target.id, 'two independent reporters rank first');
  assert.equal(queue.cases[0].currentName, 'Новое имя');
  assert.equal(queue.cases[0].uniqueReporters, 2);
  assert.equal(queue.cases[0].totalReports, 2);
  assert.deepEqual(queue.cases[0].reasons, {
    afk: 0,
    griefing: 1,
    offensiveName: 0,
    exploitCheat: 1
  });

  const detail = context.moderation.get(target.id);
  assert.equal(detail.reports.length, 2);
  assert.deepEqual(
    detail.reports.map(report => [report.reason, report.targetNameSnapshot, report.chapterIdSnapshot]),
    [
      ['exploit-cheat', 'Новое имя', 'ch5'],
      ['griefing', 'Старое имя', 'ch4']
    ]
  );
  assert.deepEqual(
    detail.evidence.map(report => [report.reason, report.targetNameSnapshot, report.chapterIdSnapshot]),
    [
      ['exploit-cheat', 'Новое имя', 'ch5'],
      ['griefing', 'Старое имя', 'ch4']
    ]
  );
  assert.deepEqual(detail.history, []);
  context.db.close();
});

test('repeat reports preserve every accepted name and chapter snapshot', () => {
  const context = fresh();
  const target = context.accounts.create('Имя до жалобы');
  const reporter = context.accounts.create('Репортёр');

  partner(context.accounts, reporter, target, 'ch4', 100);
  assert.equal(
    context.social.report({
      accountId: reporter.id,
      targetAccountId: target.id,
      reason: 'offensive-name',
      now: 1000
    }).accepted,
    true
  );

  context.accounts.rename(target.id, 'Имя после жалобы');
  partner(context.accounts, reporter, target, 'ch5', 200);
  assert.equal(
    context.social.report({
      accountId: reporter.id,
      targetAccountId: target.id,
      reason: 'offensive-name',
      now: 2100
    }).accepted,
    true
  );

  const detail = context.moderation.get(target.id);
  assert.equal(detail.totalReports, 2);
  assert.equal(detail.reports.length, 1, 'aggregate row remains compact');
  assert.equal(detail.reports[0].reportCount, 2);
  assert.equal(detail.reports[0].targetNameSnapshot, 'Имя до жалобы');
  assert.equal(detail.reports[0].chapterIdSnapshot, 'ch4');
  assert.deepEqual(
    detail.evidence.map(event => [
      event.reportedAt,
      event.occurrences,
      event.targetNameSnapshot,
      event.chapterIdSnapshot
    ]),
    [
      [2100, 1, 'Имя после жалобы', 'ch5'],
      [1000, 1, 'Имя до жалобы', 'ch4']
    ]
  );
  context.db.close();
});

test('moderation decisions are audited and new reports reopen closed cases', () => {
  const context = fresh();
  const target = context.accounts.create('Цель');
  const reporter = context.accounts.create('Репортёр');
  partner(context.accounts, reporter, target, 'ch6', 100);
  context.social.report({
    accountId: reporter.id,
    targetAccountId: target.id,
    reason: 'offensive-name',
    now: 1000
  });

  assert.deepEqual(MODERATION_STATUSES, ['open', 'reviewing', 'resolved', 'dismissed']);
  assert.deepEqual(
    context.moderation.transition({
      targetAccountId: target.id,
      status: 'resolved',
      moderatorId: 'malik',
      now: 1500
    }),
    { ok: false, reason: 'note-required' }
  );

  let transition = context.moderation.transition({
    targetAccountId: target.id,
    status: 'reviewing',
    moderatorId: 'malik',
    now: 1600
  });
  assert.equal(transition.ok, true);
  assert.equal(transition.case.status, 'reviewing');
  assert.equal(transition.case.reviewedThrough, 0);

  transition = context.moderation.transition({
    targetAccountId: target.id,
    status: 'resolved',
    moderatorId: 'malik',
    note: 'Проверено вручную; решение принято вне игрового сервера.',
    now: 1700
  });
  assert.equal(transition.case.status, 'resolved');
  assert.equal(transition.case.reviewedThrough, 1000);
  assert.equal(context.moderation.queue({ status: 'open' }).cases.length, 0);
  assert.equal(context.moderation.queue({ status: 'resolved' }).cases.length, 1);

  context.social.report({
    accountId: reporter.id,
    targetAccountId: target.id,
    reason: 'offensive-name',
    now: 2500
  });
  const reopened = context.moderation.get(target.id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.storedStatus, 'resolved');
  assert.equal(reopened.totalReports, 2);
  assert.equal(context.moderation.queue({ status: 'open' }).cases.length, 1);

  transition = context.moderation.transition({
    targetAccountId: target.id,
    status: 'dismissed',
    moderatorId: 'malik',
    note: 'Новая жалоба проверена; подтверждения нарушения нет.',
    now: 3000
  });
  assert.equal(transition.case.status, 'dismissed');
  assert.equal(transition.case.reviewedThrough, 2500);
  assert.deepEqual(
    transition.case.history.map(event => [event.fromStatus, event.toStatus, event.createdAt]),
    [
      ['open', 'reviewing', 1600],
      ['reviewing', 'resolved', 1700],
      ['open', 'dismissed', 3000]
    ]
  );
  context.db.close();
});

test('moderation input is bounded and no-report accounts cannot get fake cases', () => {
  const context = fresh();
  const account = context.accounts.create('Без жалоб');
  assert.deepEqual(context.moderation.queue({ status: 'bad' }), {
    ok: false,
    reason: 'invalid-status',
    allowedStatuses: ['open', 'reviewing', 'resolved', 'dismissed', 'all']
  });
  assert.deepEqual(
    context.moderation.transition({
      targetAccountId: account.id,
      status: 'reviewing',
      moderatorId: 'malik'
    }),
    { ok: false, reason: 'no-reports' }
  );
  assert.deepEqual(
    context.moderation.transition({
      targetAccountId: account.id,
      status: 'reviewing',
      moderatorId: 'bad\nid'
    }),
    { ok: false, reason: 'invalid-moderator' }
  );
  context.db.close();
});

test('moderation CLI refuses a missing database instead of creating an empty one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wobble-moderation-'));
  const missing = join(directory, 'typo.db');
  try {
    const result = spawnSync(process.execPath, [join(here, 'moderationCli.mjs'), '--db', missing, 'queue'], {
      encoding: 'utf8'
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /does not exist/);
    assert.equal(existsSync(missing), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
