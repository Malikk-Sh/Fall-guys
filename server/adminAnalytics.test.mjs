import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDatabase } = require('./db');
const { GameplayMetrics } = require('./metrics');
const { AdminAnalytics, MAX_DAYS, normalizeFilter } = require('./adminAnalytics');

const DAY = 24 * 60 * 60 * 1000;

function addCounts(gameplay, metric, count, dimensions) {
  for (let index = 0; index < count; index += 1) gameplay.count(metric, dimensions);
}

test('admin analytics explains the current period, previous period, trends, filters and hotspots', () => {
  let now = Date.UTC(2026, 0, 13);
  const db = openDatabase(':memory:');
  const gameplay = new GameplayMetrics({ db, now: () => now });
  const analytics = new AdminAnalytics({ db, gameplay, now: () => now });

  addCounts(gameplay, 'match_started', 2, {
    mode: 'race',
    course: 'easy',
    device: 'mobile'
  });
  addCounts(gameplay, 'match_finished', 1, {
    mode: 'race',
    course: 'easy',
    device: 'mobile'
  });
  addCounts(gameplay, 'fall', 1, {
    mode: 'race',
    course: 'easy',
    detail: 'bridge',
    device: 'mobile'
  });
  gameplay.flush();

  now += DAY;
  addCounts(gameplay, 'match_started', 3, {
    mode: 'coop',
    course: 'ch1',
    device: 'desktop'
  });
  addCounts(gameplay, 'match_finished', 2, {
    mode: 'coop',
    course: 'ch1',
    device: 'desktop'
  });
  addCounts(gameplay, 'match_abandoned', 1, {
    mode: 'coop',
    course: 'ch1',
    detail: 'checkpoint_2',
    device: 'desktop'
  });
  addCounts(gameplay, 'fall', 2, {
    mode: 'coop',
    course: 'ch1',
    detail: 'checkpoint_2',
    device: 'desktop'
  });
  gameplay.flush();

  now += DAY;
  addCounts(gameplay, 'match_started', 1, {
    mode: 'race',
    course: 'easy',
    device: 'mobile'
  });
  addCounts(gameplay, 'match_finished', 1, {
    mode: 'race',
    course: 'easy',
    device: 'mobile'
  });
  addCounts(gameplay, 'fall', 1, {
    mode: 'race',
    course: 'easy',
    detail: 'bridge',
    device: 'mobile'
  });
  gameplay.observe('finish_time', 24_000, {
    mode: 'race',
    course: 'easy',
    detail: 'verified',
    device: 'mobile'
  });

  const report = analytics.report({ days: 2, limit: 100 });
  assert.equal(report.from, '2026-01-14');
  assert.equal(report.comparisonAvailable, true);
  assert.equal(report.previousFrom, '2026-01-12');
  assert.equal(report.previousTo, '2026-01-13');
  assert.deepEqual(report.kpis.current, {
    started: 4,
    finished: 3,
    completionPercent: 75,
    abandoned: 1,
    falls: 3,
    verifiedFinishes: 1,
    unverifiedFinishes: 0,
    verifiedAverageMs: 24_000
  });
  assert.equal(report.kpis.previous.started, 2);
  assert.equal(report.kpis.previous.finished, 1);
  assert.equal(report.kpis.previous.falls, 1);
  assert.deepEqual(
    report.trend.map(point => [
      point.day,
      point.matchStarted,
      point.matchFinished,
      point.matchAbandoned,
      point.falls
    ]),
    [
      ['2026-01-14', 3, 2, 1, 2],
      ['2026-01-15', 1, 1, 0, 1]
    ]
  );
  assert.deepEqual(report.options.modes, ['coop', 'race']);
  assert.deepEqual(report.options.devices, ['desktop', 'mobile']);
  assert.equal(report.hotspots.falls[0].samples, 2);
  assert.equal(report.hotspots.falls[0].course, 'ch1');
  assert.equal(report.hotspots.abandons[0].detail, 'checkpoint_2');

  const raceOnly = analytics.report({ days: 2, mode: 'race' });
  assert.equal(raceOnly.kpis.current.started, 1);
  assert.equal(raceOnly.kpis.current.finished, 1);
  assert.equal(raceOnly.kpis.current.falls, 1);
  assert.ok(raceOnly.rows.every(row => row.mode === 'race'));
  assert.deepEqual(
    raceOnly.options.modes,
    ['coop', 'race'],
    'filter options remain available so the user can switch without clearing filters first'
  );
  db.close();
});

test('admin analytics bounds periods, rows and untrusted filter strings', () => {
  const now = Date.UTC(2026, 0, 15);
  const db = openDatabase(':memory:');
  const gameplay = new GameplayMetrics({ db, now: () => now });
  const analytics = new AdminAnalytics({ db, gameplay, now: () => now });
  for (let index = 0; index < 4; index += 1) {
    gameplay.count('fall', {
      mode: `mode-${index}`,
      course: 'easy',
      detail: `segment-${index}`,
      device: 'mobile'
    });
  }

  const bounded = analytics.report({ days: 999, limit: 1 });
  assert.equal(bounded.days, MAX_DAYS);
  assert.equal(bounded.rows.length, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.comparisonAvailable, false);
  assert.equal(bounded.previousFrom, null);
  assert.equal(bounded.previousTo, null);
  assert.equal(bounded.kpis.previous, null);
  assert.equal(normalizeFilter('x'.repeat(100)).length, 32);
  assert.equal(normalizeFilter(''), 'all');
  db.close();
});

test('comparison availability follows the metric retention window instead of showing fake zeroes', () => {
  const now = Date.UTC(2026, 0, 15);
  const db = openDatabase(':memory:');
  const gameplay = new GameplayMetrics({ db, now: () => now, retentionDays: 10 });
  const analytics = new AdminAnalytics({ db, gameplay, now: () => now });
  gameplay.count('match_started', { mode: 'race', course: 'easy', device: 'mobile' });

  assert.equal(analytics.report({ days: 5 }).comparisonAvailable, true);
  const tooLong = analytics.report({ days: 7 });
  assert.equal(tooLong.comparisonAvailable, false);
  assert.equal(tooLong.kpis.previous, null);
  assert.equal(tooLong.retentionDays, 10);
  db.close();
});
