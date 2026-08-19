import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateLoadResult, loadBudgetConfig, markdownSummary } from './loadGate.mjs';

const budgets = {
  baselineEventLoopP95Ms: 20.9,
  warningEventLoopP95Ms: 45,
  maxEventLoopP95Ms: 60,
  baselineRssMb: 108,
  maxRssMb: 180
};

function goodResult() {
  return {
    roomsRequested: 24,
    playersRequested: 48,
    seconds: 12,
    initial: { rooms: 0, players: 0 },
    after: {
      rooms: 24,
      players: 48,
      load: { eventLoopP95Ms: 20.9, rssMb: 108, overloaded: false }
    },
    readiness: { ok: true, status: 200 },
    deltas: {
      invalidMessages: 0,
      socketSendFailures: 0,
      handlerErrors: 0,
      capacityRejected: 0,
      snapshotsSkippedForLoad: 0
    }
  };
}

test('load budget config reads configurable nightly thresholds', () => {
  assert.deepEqual(
    loadBudgetConfig({
      WOBBLE_LOAD_BASELINE_EVENT_LOOP_P95_MS: '20.9',
      WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS: '45',
      WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS: '60',
      WOBBLE_LOAD_BASELINE_RSS_MB: '108',
      WOBBLE_LOAD_MAX_RSS_MB: '180'
    }),
    budgets
  );
});

test('load budget config rejects a warning threshold at or above the hard threshold', () => {
  assert.throws(
    () =>
      loadBudgetConfig({
        WOBBLE_LOAD_WARN_EVENT_LOOP_P95_MS: '60',
        WOBBLE_LOAD_MAX_EVENT_LOOP_P95_MS: '60'
      }),
    /must be below/
  );
});

test('good load result passes all functional and performance gates', () => {
  const evaluation = evaluateLoadResult(goodResult(), budgets);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failures, []);
  assert.deepEqual(evaluation.warnings, []);
});

test('event-loop warning is visible but does not fail the gate', () => {
  const result = goodResult();
  result.after.load.eventLoopP95Ms = 50;
  const evaluation = evaluateLoadResult(result, budgets);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.failures, []);
  assert.deepEqual(evaluation.warnings, ['event-loop p95 50 ms > warning budget 45 ms']);
  const summary = markdownSummary(result, evaluation);
  assert.match(
    summary,
    /Event-loop p95 \| 50 ms \| 20\.9 ms \(Δ \+29\.1 ms\) \| warn 45 ms \/ fail 60 ms \| WARN/
  );
});

test('event-loop p95 above the hard budget fails with the measured value', () => {
  const result = goodResult();
  result.after.load.eventLoopP95Ms = 82.4;
  const evaluation = evaluateLoadResult(result, budgets);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /event-loop p95 82\.4 ms > hard budget 60 ms/);
});

test('RSS above the hard budget fails with the measured value', () => {
  const result = goodResult();
  result.after.load.rssMb = 181;
  const evaluation = evaluateLoadResult(result, budgets);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /RSS 181 MB > hard budget 180 MB/);
});

test('missing performance metrics still fail the gate', () => {
  const result = goodResult();
  delete result.after.load.eventLoopP95Ms;
  delete result.after.load.rssMb;
  const evaluation = evaluateLoadResult(result, budgets);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /event-loop p95 metric is missing/);
  assert.match(evaluation.failures.join('\n'), /RSS metric is missing/);
});

test('existing functional error counters remain hard failures', () => {
  const result = goodResult();
  result.deltas.handlerErrors = 1;
  const evaluation = evaluateLoadResult(result, budgets);
  assert.equal(evaluation.ok, false);
  assert.match(evaluation.failures.join('\n'), /handlerErrors delta must be 0, got 1/);
});
