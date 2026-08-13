import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { migrateDatabase } = require('./migrations');
const { ServiceReliabilityReader } = require('./serviceReliabilityReader');

function database() {
  const db = openDatabase(':memory:');
  migrateDatabase(db);
  return db;
}

function insertSample(db, at, commit = 'abc123') {
  db.prepare(
    `
    INSERT INTO service_reliability_samples
      (sampled_at, version, commit_sha, release_tag, event_loop_p95_ms, rss_mb, heap_used_mb,
       socket_count, active_matches, matchmaking_waiting, resume_succeeded, resume_failed,
       handler_errors, socket_send_failures, capacity_rejected, snapshots_skipped_for_load)
    VALUES (?, '2.6.0', ?, 'v2.6.0', 25, 120, 60, 4, 1, 0, 5, 1, 0, 0, 0, 0)
  `
  ).run(at, commit);
}

test('reliability reader keeps historical rows and performs no retention writes', async () => {
  const db = database();
  try {
    const now = 40 * 24 * 60 * 60 * 1000;
    insertSample(db, now - 35 * 24 * 60 * 60 * 1000, 'old');
    insertSample(db, now - 10 * 60 * 1000, 'current');
    const before = db.prepare('SELECT COUNT(*) AS count FROM service_reliability_samples').get().count;
    const reader = new ServiceReliabilityReader({ db, now: () => now, retentionDays: 30 });
    const report = await reader.report({ period: '24h' });
    const after = db.prepare('SELECT COUNT(*) AS count FROM service_reliability_samples').get().count;
    assert.equal(before, 2);
    assert.equal(after, 2);
    assert.equal(report.summary.samples, 1);
    assert.equal(report.summary.reconnectSucceeded, 5);
    assert.equal(report.summary.reconnectFailed, 1);
  } finally {
    db.close();
  }
});

test('reliability reader falls back to latest stored build while game is unavailable', async () => {
  const db = database();
  try {
    const now = 1_800_000;
    insertSample(db, 1_740_000, 'stored123');
    const reader = new ServiceReliabilityReader({ db, now: () => now, liveHealth: async () => null });
    const report = await reader.report({ period: '1h' });
    assert.equal(report.live, false);
    assert.deepEqual(report.build, {
      version: '2.6.0',
      commit: 'stored123',
      release: 'v2.6.0'
    });
  } finally {
    db.close();
  }
});

test('reliability reader prefers live build without persisting it', async () => {
  const db = database();
  try {
    const now = 1_800_000;
    insertSample(db, 1_740_000, 'stored123');
    const reader = new ServiceReliabilityReader({
      db,
      now: () => now,
      liveHealth: async () => ({ ok: true, version: '2.7.0', commit: 'live456', release: 'v2.7.0' })
    });
    const report = await reader.report({ period: '1h' });
    assert.equal(report.live, true);
    assert.deepEqual(report.build, {
      version: '2.7.0',
      commit: 'live456',
      release: 'v2.7.0'
    });
    const latest = db
      .prepare('SELECT version, commit_sha FROM service_reliability_samples ORDER BY sampled_at DESC LIMIT 1')
      .get();
    assert.deepEqual({ ...latest }, { version: '2.6.0', commit_sha: 'stored123' });
  } finally {
    db.close();
  }
});
