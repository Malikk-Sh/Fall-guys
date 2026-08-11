import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { AdminAuthService } = require('./adminAuth');
const { PlayerSanctions } = require('./playerSanctions');

function setup() {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run('player-1', 'Target', 'hash', 1, 1);
  const adminAuth = new AdminAuthService({ db });
  const owner = adminAuth.createUser({ name: 'Owner', role: 'owner', now: 10 });
  const moderator = adminAuth.createUser({ name: 'Moderator', role: 'moderator', now: 11 });
  const sanctions = new PlayerSanctions({ db });
  return { db, adminAuth, owner, moderator, sanctions };
}

test('temporary bans become active, expire naturally and expose only safe public fields', () => {
  const { db, moderator, sanctions } = setup();
  const applied = sanctions.apply({
    accountId: 'player-1',
    kind: 'ban',
    reason: 'griefing',
    note: 'Reviewed repeated obstruction reports.',
    createdByAdminId: moderator.user.id,
    durationMs: 60 * 60 * 1000,
    now: 1000
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.sanction.active, true);
  assert.equal(applied.sanction.expiresAt, 3_601_000);
  assert.deepEqual(sanctions.publicView(applied.sanction), {
    reason: 'griefing',
    expiresAt: 3_601_000,
    permanent: false
  });
  assert.equal(JSON.stringify(sanctions.publicView(applied.sanction)).includes('Reviewed repeated'), false);
  assert.equal(sanctions.active('player-1', { now: 3_600_999 })?.id, applied.sanction.id);
  assert.equal(sanctions.active('player-1', { now: 3_601_000 }), null);
  assert.equal(sanctions.history('player-1', { now: 3_601_000 })[0].status, 'expired');
  db.close();
});

test('warnings are historical and do not block the account', () => {
  const { db, moderator, sanctions } = setup();
  const warning = sanctions.apply({
    accountId: 'player-1',
    kind: 'warning',
    reason: 'offensive-name',
    note: 'Name was changed after review.',
    createdByAdminId: moderator.user.id,
    now: 2000
  });
  assert.equal(warning.ok, true);
  assert.equal(warning.sanction.status, 'warning');
  assert.equal(sanctions.active('player-1', { now: 2000 }), null);
  assert.equal(sanctions.history('player-1')[0].kind, 'warning');
  db.close();
});

test('active bans cannot overlap and can be revoked with an immutable history entry', () => {
  const { db, owner, moderator, sanctions } = setup();
  const applied = sanctions.apply({
    accountId: 'player-1',
    kind: 'ban',
    reason: 'exploit-cheat',
    note: 'Exploit evidence confirmed.',
    createdByAdminId: moderator.user.id,
    durationMs: 24 * 60 * 60 * 1000,
    now: 5000
  });
  assert.equal(applied.ok, true);
  const overlapping = sanctions.apply({
    accountId: 'player-1',
    kind: 'ban',
    reason: 'griefing',
    note: 'Must revoke the current ban first.',
    createdByAdminId: moderator.user.id,
    durationMs: 60 * 60 * 1000,
    now: 6000
  });
  assert.equal(overlapping.ok, false);
  assert.equal(overlapping.reason, 'active-ban-exists');

  const revoked = sanctions.revoke({
    sanctionId: applied.sanction.id,
    revokedByAdminId: owner.user.id,
    note: 'Appeal accepted after additional review.',
    now: 7000
  });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.sanction.status, 'revoked');
  assert.equal(revoked.sanction.revokeNote, 'Appeal accepted after additional review.');
  assert.equal(sanctions.active('player-1', { now: 7000 }), null);
  db.close();
});

test('sanction and mandatory audit hook are atomic', () => {
  const { db, moderator, sanctions } = setup();
  assert.throws(
    () =>
      sanctions.apply({
        accountId: 'player-1',
        kind: 'ban',
        reason: 'griefing',
        note: 'Rollback this sanction.',
        createdByAdminId: moderator.user.id,
        durationMs: 60 * 60 * 1000,
        now: 9000,
        audit: () => {
          throw new Error('audit unavailable');
        }
      }),
    /audit unavailable/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM player_sanctions').get().count, 0);
  db.close();
});

test('invalid reasons, empty notes and unsafe durations are rejected', () => {
  const { db, moderator, sanctions } = setup();
  const base = {
    accountId: 'player-1',
    kind: 'ban',
    reason: 'griefing',
    note: 'Valid note.',
    createdByAdminId: moderator.user.id,
    durationMs: 60 * 60 * 1000,
    now: 1000
  };
  assert.equal(sanctions.apply({ ...base, reason: 'secret-freeform' }).reason, 'invalid-sanction-reason');
  assert.equal(sanctions.apply({ ...base, note: ' ' }).reason, 'sanction-note-required');
  assert.equal(sanctions.apply({ ...base, durationMs: 10 }).reason, 'invalid-sanction-duration');
  db.close();
});
