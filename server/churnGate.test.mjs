import assert from 'node:assert/strict';
import test from 'node:test';
import { churnBudgets, churnMarkdownSummary, evaluateChurnResult } from './churnGate.mjs';

function goodResult(overrides = {}) {
  return {
    config: {
      baseRooms: 12,
      baseClients: 24,
      rapidCycles: 3,
      stormClients: 24,
      roomIterations: 100,
      churnBatch: 10
    },
    baseline: { rooms: 0, players: 0, sessions: 0 },
    scenarios: {
      rapid: { cycles: 3, attempts: 36, succeeded: 36 },
      staleSocket: { cases: 4, passed: 4 },
      storm: { clients: 24, attempts: 24, succeeded: 24, readiness: { ok: true, status: 200 } },
      roomChurn: { iterations: 100, reclaimed: 100 }
    },
    identityMismatches: 0,
    duplicatePlayerObservations: 0,
    roomCountMismatches: 0,
    resumeAttempts: 64,
    resumeSucceededObserved: 64,
    resumeSuccessRate: 1,
    deltas: {
      invalidMessages: 0,
      socketSendFailures: 0,
      handlerErrors: 0,
      capacityRejected: 0,
      resumeSucceeded: 64,
      resumeFailed: 0,
      snapshotsSkippedForLoad: 0,
      verificationFailed: 0,
      latePacketsDropped: 0
    },
    peaks: {
      peakRooms: 12,
      peakPlayers: 24,
      peakSessions: 24,
      peakEventLoopP95Ms: 24,
      peakRssMb: 130
    },
    final: { rooms: 0, players: 0, sessions: 0 },
    readiness: { ok: true, status: 200 },
    failures: [],
    ...overrides
  };
}

const budgets = churnBudgets({
  WOBBLE_CHURN_BASELINE_EVENT_LOOP_P95_MS: '20.9',
  WOBBLE_CHURN_MAX_EVENT_LOOP_P95_MS: '60',
  WOBBLE_CHURN_BASELINE_RSS_MB: '108',
  WOBBLE_CHURN_MAX_RSS_MB: '180',
  WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE: '1'
});

test('good deterministic churn result passes', () => {
  const gate = evaluateChurnResult(goodResult(), budgets);
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.failures, []);
});

test('churn thresholds are configurable and validated', () => {
  assert.deepEqual(
    churnBudgets({
      WOBBLE_CHURN_MAX_EVENT_LOOP_P95_MS: '75',
      WOBBLE_CHURN_MAX_RSS_MB: '220',
      WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE: '0.98'
    }),
    {
      baselineEventLoopP95Ms: null,
      maxEventLoopP95Ms: 75,
      baselineRssMb: null,
      maxRssMb: 220,
      minResumeSuccessRate: 0.98
    }
  );
  assert.throws(() => churnBudgets({ WOBBLE_CHURN_MIN_RESUME_SUCCESS_RATE: '1.1' }), /between 0 and 1/);
  assert.throws(() => churnBudgets({ WOBBLE_CHURN_MAX_RSS_MB: '0' }), /positive finite number/);
});

test('unexpected resume failure and incomplete success ratio fail concretely', () => {
  const result = goodResult();
  result.resumeSucceededObserved = 63;
  result.resumeSuccessRate = 63 / 64;
  result.deltas.resumeSucceeded = 63;
  result.deltas.resumeFailed = 1;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /observed resume successes 63 != attempts 64/);
  assert.match(gate.failures.join('\n'), /resumeFailed delta 1 != 0/);
  assert.match(gate.failures.join('\n'), /resume success rate/);
});

test('stale old socket regression fails even when aggregate resume counters look healthy', () => {
  const result = goodResult();
  result.scenarios.staleSocket.passed = 3;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /stale old-socket cases passed 3\/4/);
});

test('session growth and cleanup leakage fail', () => {
  const result = goodResult();
  result.peaks.peakSessions = 25;
  result.final.sessions = 2;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /peak sessions 25 > expected bound 24/);
  assert.match(gate.failures.join('\n'), /final sessions 2 != baseline 0/);
});

test('handler and socket send failures remain hard correctness gates', () => {
  const result = goodResult();
  result.deltas.handlerErrors = 1;
  result.deltas.socketSendFailures = 2;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /handlerErrors delta 1 != 0/);
  assert.match(gate.failures.join('\n'), /socketSendFailures delta 2 != 0/);
});

test('established server p95 and RSS hard budgets apply to churn', () => {
  const result = goodResult();
  result.peaks.peakEventLoopP95Ms = 61;
  result.peaks.peakRssMb = 181;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /event-loop p95 61 ms > hard budget 60 ms/);
  assert.match(gate.failures.join('\n'), /RSS 181 MB > hard budget 180 MB/);
});

test('missing important metrics fail instead of silently passing', () => {
  const result = goodResult();
  delete result.deltas.resumeFailed;
  delete result.peaks.peakEventLoopP95Ms;
  const gate = evaluateChurnResult(result, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /resumeFailed delta is missing/);
  assert.match(gate.failures.join('\n'), /peak event-loop p95 is missing/);
});

test('summary keeps scenario, cleanup and error diagnostics visible', () => {
  const result = goodResult();
  const gate = evaluateChurnResult(result, budgets);
  const summary = churnMarkdownSummary(result, gate);
  assert.match(summary, /Rapid disconnect\/resume \| 36 \/ 36 resumes/);
  assert.match(summary, /Reconnect storm \| 24 \/ 24 clients/);
  assert.match(summary, /Room churn \| 100 \/ 100 rooms reclaimed/);
  assert.match(summary, /Peak event-loop p95 \| 24 ms \(ref 20.9 ms, Δ \+3.1 ms\)/);
  assert.match(summary, /Cleanup sessions \| 0 \(baseline 0\)/);
  assert.match(summary, /handlerErrors \| 0/);
});
