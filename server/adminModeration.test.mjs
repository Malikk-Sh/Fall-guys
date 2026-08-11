import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService, hasCapability } = require('./adminAuth');
const { AdminControlService } = require('./adminControl');
const { installAdminRoutes } = require('./adminRoutes');

function prepareDatabase() {
  const db = openDatabase(':memory:');
  const adminAuth = new AdminAuthService({ db });
  db.exec(`
    CREATE TABLE IF NOT EXISTS leaderboard_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL,
      course_key TEXT NOT NULL,
      player_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      color INTEGER NOT NULL,
      time_ms INTEGER NOT NULL,
      achieved_at INTEGER NOT NULL,
      verification_version INTEGER NOT NULL,
      match_id TEXT NOT NULL
    );
  `);
  const insertAccount = db.prepare(`
    INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertAccount.run('target', 'Reported Player', 'target-hash', 1, 1);
  insertAccount.run('reporter-a', 'Reporter A', 'reporter-a-hash', 1, 1);
  insertAccount.run('reporter-b', 'Reporter B', 'reporter-b-hash', 1, 1);

  db.prepare(
    `
    INSERT INTO social_reports
      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,
       last_reported_at, target_name_snapshot, chapter_id_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run('reporter-a', 'target', 'griefing', 1, 1000, 1000, 'Old Name', 'ch4');
  db.prepare(
    `
    INSERT INTO social_report_evidence
      (reporter_account_id, target_account_id, reason, reported_at, occurrences,
       target_name_snapshot, chapter_id_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run('reporter-a', 'target', 'griefing', 1000, 1, 'Old Name', 'ch4');

  const control = new AdminControlService({
    db,
    adminAuth,
    health: () => ({ ok: true }),
    gameplay: { summary: () => ({ days: 7, from: '2026-08-05', dropped: 0, rows: [] }) }
  });
  return { db, adminAuth, control };
}

function createModerator(adminAuth, role = 'moderator') {
  const created = adminAuth.createUser({
    name: role === 'moderator' ? 'Moderator' : 'Viewer',
    role,
    now: 100
  });
  assert.equal(created.ok, true);
  return created;
}

test('admin moderation shows immutable evidence and writes moderation + admin audit atomically', () => {
  const { db, adminAuth, control } = prepareDatabase();
  const moderator = createModerator(adminAuth);
  assert.equal(hasCapability('moderator', 'moderation.write'), true);

  const before = control.moderationCase('target');
  assert.equal(before.status, 'open');
  assert.equal(before.evidence.length, 1);
  assert.equal(before.evidence[0].targetNameSnapshot, 'Old Name');
  assert.equal(before.evidence[0].chapterIdSnapshot, 'ch4');

  const result = control.moderationTransition({
    targetAccountId: 'target',
    status: 'reviewing',
    note: 'Evidence checked.',
    expectedStatus: before.status,
    expectedLastReportedAt: before.lastReportedAt,
    actor: moderator.user,
    now: 2000
  });
  assert.equal(result.ok, true);
  assert.equal(result.case.status, 'reviewing');
  assert.equal(result.case.moderatorName, 'Moderator');
  assert.equal(result.case.history.at(-1).moderatorName, 'Moderator');

  const moderationEvent = db
    .prepare(
      'SELECT from_status, to_status, moderator_id, note FROM moderation_events ORDER BY id DESC LIMIT 1'
    )
    .get();
  assert.deepEqual(
    { ...moderationEvent },
    {
      from_status: 'open',
      to_status: 'reviewing',
      moderator_id: `admin:${moderator.user.id}`,
      note: 'Evidence checked.'
    }
  );
  const audit = adminAuth.recentAudit().find(event => event.action === 'moderation.case.transition');
  assert.ok(audit);
  assert.equal(audit.adminUserId, moderator.user.id);
  assert.equal(audit.targetId, 'target');
  assert.deepEqual(audit.detail, {
    fromStatus: 'open',
    toStatus: 'reviewing',
    reviewedThrough: 0,
    notePresent: true
  });

  const noOp = control.moderationTransition({
    targetAccountId: 'target',
    status: 'reviewing',
    note: 'Duplicate click',
    expectedStatus: 'reviewing',
    expectedLastReportedAt: result.case.lastReportedAt,
    actor: moderator.user,
    now: 2100
  });
  assert.equal(noOp.ok, false);
  assert.equal(noOp.reason, 'already-status');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_events').get().count, 1);
  db.close();
});

test('admin moderation rejects stale decisions when new evidence arrives after the case was opened', () => {
  const { db, adminAuth, control } = prepareDatabase();
  const moderator = createModerator(adminAuth);
  const opened = control.moderationCase('target');

  db.prepare(
    `
    INSERT INTO social_reports
      (reporter_account_id, target_account_id, reason, report_count, first_reported_at,
       last_reported_at, target_name_snapshot, chapter_id_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `
  ).run('reporter-b', 'target', 'exploit-cheat', 1, 1100, 1100, 'New Snapshot', 'ch5');
  db.prepare(
    `
    INSERT INTO social_report_evidence
      (reporter_account_id, target_account_id, reason, reported_at, occurrences,
       target_name_snapshot, chapter_id_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `
  ).run('reporter-b', 'target', 'exploit-cheat', 1100, 1, 'New Snapshot', 'ch5');

  const stale = control.moderationTransition({
    targetAccountId: 'target',
    status: 'resolved',
    note: 'Would have closed old evidence only.',
    expectedStatus: opened.status,
    expectedLastReportedAt: opened.lastReportedAt,
    actor: moderator.user,
    now: 2000
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'case-changed');
  assert.equal(stale.case.lastReportedAt, 1100);
  assert.equal(stale.case.evidence.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_events').get().count, 0);
  assert.equal(
    adminAuth.recentAudit().filter(event => event.action === 'moderation.case.transition').length,
    0
  );
  db.close();
});

test('moderation transition rolls back when mandatory admin audit cannot be stored', () => {
  const { db, adminAuth, control } = prepareDatabase();
  const moderator = createModerator(adminAuth);
  const opened = control.moderationCase('target');
  db.exec(`
    CREATE TRIGGER reject_moderation_admin_audit
    BEFORE INSERT ON admin_audit_events
    WHEN NEW.action = 'moderation.case.transition'
    BEGIN
      SELECT RAISE(ABORT, 'moderation audit blocked');
    END;
  `);

  assert.throws(
    () =>
      control.moderationTransition({
        targetAccountId: 'target',
        status: 'reviewing',
        note: 'Must roll back together.',
        expectedStatus: opened.status,
        expectedLastReportedAt: opened.lastReportedAt,
        actor: moderator.user,
        now: 2000
      }),
    /moderation audit blocked/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_cases').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_events').get().count, 0);
  assert.equal(control.moderationCase('target').status, 'open');
  db.close();
});

test('moderation routes derive actor from admin session and reject spoofed moderator fields', async t => {
  const { db, adminAuth, control } = prepareDatabase();
  const moderator = createModerator(adminAuth);
  const viewer = createModerator(adminAuth, 'viewer');
  const app = express();
  installAdminRoutes({ app, adminAuth, control, enabled: true, secureCookies: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => {
    server.close();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function login(accessCode) {
    const response = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessCode })
    });
    assert.equal(response.status, 200);
    return {
      payload: await response.json(),
      cookie: response.headers.get('set-cookie').split(';', 1)[0]
    };
  }

  const moderatorLogin = await login(moderator.accessCode);
  const openedResponse = await fetch(`${base}/api/admin/moderation/case`, {
    method: 'POST',
    headers: {
      Cookie: moderatorLogin.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': moderatorLogin.payload.csrf
    },
    body: JSON.stringify({ targetAccountId: 'target' })
  });
  assert.equal(openedResponse.status, 200);
  const opened = (await openedResponse.json()).case;

  const spoofed = await fetch(`${base}/api/admin/moderation/transition`, {
    method: 'POST',
    headers: {
      Cookie: moderatorLogin.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': moderatorLogin.payload.csrf
    },
    body: JSON.stringify({
      targetAccountId: 'target',
      status: 'reviewing',
      note: '',
      expectedStatus: opened.status,
      expectedLastReportedAt: opened.lastReportedAt,
      moderatorId: 'forged-admin'
    })
  });
  assert.equal(spoofed.status, 400);

  const accepted = await fetch(`${base}/api/admin/moderation/transition`, {
    method: 'POST',
    headers: {
      Cookie: moderatorLogin.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': moderatorLogin.payload.csrf
    },
    body: JSON.stringify({
      targetAccountId: 'target',
      status: 'reviewing',
      note: '',
      expectedStatus: opened.status,
      expectedLastReportedAt: opened.lastReportedAt
    })
  });
  assert.equal(accepted.status, 200);
  const acceptedCase = (await accepted.json()).case;
  assert.equal(acceptedCase.moderatorName, 'Moderator');

  const viewerLogin = await login(viewer.accessCode);
  const forbidden = await fetch(`${base}/api/admin/moderation/transition`, {
    method: 'POST',
    headers: {
      Cookie: viewerLogin.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': viewerLogin.payload.csrf
    },
    body: JSON.stringify({
      targetAccountId: 'target',
      status: 'resolved',
      note: 'Viewer must never apply this.',
      expectedStatus: acceptedCase.status,
      expectedLastReportedAt: acceptedCase.lastReportedAt
    })
  });
  assert.equal(forbidden.status, 403);
});
