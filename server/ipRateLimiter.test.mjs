import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BoundedIpRateLimiter } = require('./ipRateLimiter');

test('bounded IP limiter keeps fixed-window attempt semantics', () => {
  const limiter = new BoundedIpRateLimiter({ windowMs: 1_000, cleanupIntervalMs: 100, maxEntries: 10 });

  assert.equal(limiter.limited('10.0.0.1', 2, 0), false);
  assert.equal(limiter.limited('10.0.0.1', 2, 100), false);
  assert.equal(limiter.limited('10.0.0.1', 2, 200), true);
  assert.equal(limiter.limited('10.0.0.1', 2, 1_001), false, 'новое окно сбрасывает счётчик');
});

test('bounded IP limiter removes expired unique addresses', () => {
  const limiter = new BoundedIpRateLimiter({ windowMs: 1_000, cleanupIntervalMs: 100, maxEntries: 10 });
  limiter.limited('10.0.0.1', 2, 0);
  limiter.limited('10.0.0.2', 2, 0);
  limiter.limited('10.0.0.3', 2, 0);
  assert.equal(limiter.size, 3);

  limiter.cleanup(1_001, { force: true });
  assert.equal(limiter.size, 0, 'истёкшие IP не остаются в памяти процесса');
});

test('bounded IP limiter caps cardinality under unique-IP churn', () => {
  const limiter = new BoundedIpRateLimiter({ windowMs: 60_000, cleanupIntervalMs: 60_000, maxEntries: 3 });
  for (let i = 0; i < 20; i++) limiter.limited(`203.0.113.${i}`, 5, i);

  assert.equal(limiter.size, 3);
  assert.equal(limiter.entries.has('203.0.113.19'), true, 'последние адреса продолжают учитываться');
});
