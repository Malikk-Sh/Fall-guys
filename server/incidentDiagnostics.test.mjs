import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { IncidentDiagnostics } = require('./incidentDiagnostics');

function account(db, id = '11111111-2222-3333-4444-555555555555') {
  db.prepare(
    'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, 'Diag Player', `hash-${id}`, 1, 1);
  return id;
}

test('incident diagnostics stores only allowlisted privacy-safe event fields', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const id = account(db);
  const incidents = new IncidentDiagnostics({ db, now: () => 10_000 });

  assert.equal(
    incidents.record({
      accountId: id,
      kind: 'network-error',
      code: 'RECONNECT_EXPIRED',
      roomId: 'AB12CD',
      matchId: 'secret-match-id',
      mode: 'coop',
      phase: 'PLAYING',
      device: 'mobile',
      valueMs: 1234,
      ip: '203.0.113.9',
      token: 'never-store-this',
      detail: { arbitrary: 'payload' }
    }),
    true
  );
  assert.equal(incidents.record({ accountId: id, kind: 'arbitrary', code: 'anything' }), false);
  assert.equal(incidents.record({ accountId: id, kind: 'network-error', code: 'NOT_A_REAL_CODE' }), false);

  const timeline = incidents.timeline(id, { now: 10_001 });
  assert.equal(timeline.summary.networkErrors, 1);
  assert.equal(timeline.events.length, 1);
  assert.match(timeline.events[0].roomRef, /^[a-f0-9]{12}$/);
  assert.match(timeline.events[0].matchRef, /^[a-f0-9]{12}$/);
  const serialized = JSON.stringify(timeline);
  for (const secret of ['AB12CD', 'secret-match-id', '203.0.113.9', 'never-store-this', 'payload']) {
    assert.equal(serialized.includes(secret), false, `${secret} must not cross diagnostics boundary`);
  }
  db.close();
});

test('incident diagnostics prunes retention and bounds rows per account', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const id = account(db, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  const incidents = new IncidentDiagnostics({ db, retentionDays: 1, maxPerAccount: 10 });
  const day = 24 * 60 * 60 * 1000;
  incidents.record({ accountId: id, kind: 'connection', code: 'disconnected', occurredAt: 1 });
  for (let index = 0; index < 14; index += 1) {
    incidents.record({
      accountId: id,
      kind: 'connection',
      code: index % 2 ? 'resumed' : 'disconnected',
      occurredAt: day + 1000 + index
    });
  }
  const timeline = incidents.timeline(id, { limit: 200, now: day + 2000 });
  assert.equal(timeline.events.length, 10);
  assert.equal(
    timeline.events.some(event => event.occurredAt === 1),
    false
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM player_incident_events WHERE account_id = ?').get(id).count,
    10
  );
  db.close();
});

test('incident timeline returns null for an unknown account', () => {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  const incidents = new IncidentDiagnostics({ db });
  assert.equal(incidents.timeline('missing'), null);
  assert.equal(incidents.record({ accountId: 'missing', kind: 'connection', code: 'disconnected' }), false);
  db.close();
});
