import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSoak, renderSoakSummary } from './soakSummary.mjs';

const budgets = {
  maxEventLoopP95Ms: 60,
  maxRssMb: 180,
  warnRecoveryRssGrowthMb: 32,
  maxRecoveryRssGrowthMb: 64,
  warnRecoveryHeapGrowthMb: 24,
  maxRecoveryHeapGrowthMb: 48,
  minDurationSeconds: 1800,
  allowShortRun: false
};

function sample(phaseName, rssMb, heapUsedMb, eventLoopP95Ms = 22) {
  return {
    phaseName,
    eventLoopP95Ms,
    rssMb,
    heapUsedMb,
    overloaded: false
  };
}

function goodProbe() {
  const samples = [
    ...[108, 109, 110, 109].map((rss, index) => sample('base-24', rss, 18 + index)),
    ...[116, 118, 117].map((rss, index) => sample('base-48', rss, 21 + index)),
    ...[114, 116, 115].map((rss, index) => sample('load-24-churn', rss, 22 + index)),
    ...[121, 123, 122].map((rss, index) => sample('load-48-churn', rss, 24 + index)),
    ...[132, 136, 134].map((rss, index) => sample('burst-96', rss, 27 + index, 24)),
    ...[121, 119, 118, 117, 118, 117].map((rss, index) => sample('recovery-24', rss, 23 - index * 0.2))
  ];
  return {
    config: { plannedDurationSeconds: 1800 },
    baseline: { rooms: 0, players: 0, sessions: 0 },
    final: { rooms: 0, players: 0, sessions: 0 },
    readiness: { ok: true, status: 200 },
    durationSeconds: 1812,
    phases: [
      { index: 1, name: 'base-24', rooms: 24, churn: false, status: 'PASS' },
      { index: 2, name: 'base-48', rooms: 48, churn: false, status: 'PASS' },
      { index: 3, name: 'load-24-churn', rooms: 24, churn: true, status: 'PASS' },
      { index: 4, name: 'load-48-churn', rooms: 48, churn: true, status: 'PASS' },
      { index: 5, name: 'burst-96', rooms: 96, churn: false, status: 'PASS' },
      { index: 6, name: 'recovery-24', rooms: 24, churn: false, status: 'PASS' }
    ],
    samples,
    churnPulses: [
      { phaseName: 'load-24-churn', status: 'PASS' },
      { phaseName: 'load-48-churn', status: 'PASS' }
    ],
    deltas: {
      handlerErrors: 0,
      socketSendFailures: 0,
      invalidMessages: 0,
      capacityRejected: 0,
      resumeSucceeded: 40,
      resumeFailed: 0,
      verificationFailed: 0,
      latePacketsDropped: 0,
      snapshotsSkippedForLoad: 0
    },
    failures: []
  };
}

test('good weekly soak result passes', () => {
  const gate = evaluateSoak(goodProbe(), budgets);
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.failures, []);
  assert.equal(gate.metrics.churnPulseCount, 2);
});

test('critical server error delta fails concretely', () => {
  const probe = goodProbe();
  probe.deltas.handlerErrors = 2;
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /handlerErrors delta 2/);
});

test('established event-loop and RSS hard budgets still apply', () => {
  const probe = goodProbe();
  probe.samples.push(sample('burst-96', 181, 30, 61));
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /event-loop p95 peak 61 ms > budget 60 ms/);
  assert.match(gate.failures.join('\n'), /RSS peak 181 MB > budget 180 MB/);
});

test('cleanup must return rooms players and sessions to baseline', () => {
  const probe = goodProbe();
  probe.final.sessions = 3;
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /cleanup counts/);
});

test('missing important telemetry fails instead of silently passing', () => {
  const probe = goodProbe();
  delete probe.deltas.socketSendFailures;
  delete probe.samples[0].heapUsedMb;
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /missing metric delta socketSendFailures/);
  assert.match(gate.failures.join('\n'), /missing heap used/);
});

test('strong monotonic recovery growth is a hard leak signal', () => {
  const probe = goodProbe();
  probe.samples = probe.samples.filter(item => item.phaseName !== 'recovery-24');
  for (let index = 0; index < 9; index++) {
    probe.samples.push(sample('recovery-24', 80 + index * 11, 10 + index * 9));
  }
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /recovery RSS grew/);
  assert.match(gate.failures.join('\n'), /recovery heap grew/);
});

test('moderate recovery growth is warning-only', () => {
  const probe = goodProbe();
  probe.samples = probe.samples.filter(item => item.phaseName !== 'recovery-24');
  for (let index = 0; index < 8; index++) {
    probe.samples.push(sample('recovery-24', 100 + index * 6, 20 + index * 4));
  }
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, true);
  assert.ok(gate.warnings.some(item => item.includes('recovery RSS trend')));
});

test('weekly plan must remain at least 30 minutes unless explicit short smoke mode is enabled', () => {
  const probe = goodProbe();
  probe.config.plannedDurationSeconds = 120;
  const gate = evaluateSoak(probe, budgets);
  assert.equal(gate.ok, false);
  assert.match(gate.failures.join('\n'), /planned soak duration 120s < minimum 1800s/);

  const smoke = evaluateSoak(probe, { ...budgets, allowShortRun: true });
  assert.equal(smoke.ok, true);
});

test('summary keeps phase, memory and failure diagnostics visible', () => {
  const probe = goodProbe();
  const gate = evaluateSoak(probe, budgets);
  const summary = renderSoakSummary(probe, gate);
  assert.match(summary, /Weekly Multiplayer Soak/);
  assert.match(summary, /recovery-24/);
  assert.match(summary, /Memory \/ recovery/);
  assert.match(summary, /RSS is not required to return exactly/);
});
