import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_STAGE_SPEC, parseStages, stageRecord, stagedMarkdownSummary } from './stagedLoadGate.mjs';

function loadResult(overrides = {}) {
  return {
    after: {
      sessions: 48,
      load: { eventLoopP95Ms: 21, rssMb: 97 }
    },
    readiness: { ok: true, status: 200 },
    deltas: {
      invalidMessages: 0,
      socketSendFailures: 0,
      handlerErrors: 0,
      capacityRejected: 0,
      snapshotsSkippedForLoad: 0,
      verificationFailed: 0,
      latePacketsDropped: 0
    },
    gate: {
      ok: true,
      failures: [],
      warnings: [],
      budgets: { maxEventLoopP95Ms: 60, maxRssMb: 180 }
    },
    ...overrides
  };
}

test('default staged load plan uses the three moderate Nightly 2.0 levels', () => {
  assert.deepEqual(parseStages(DEFAULT_STAGE_SPEC), [
    { rooms: 24, clients: 48, seconds: 12 },
    { rooms: 48, clients: 96, seconds: 12 },
    { rooms: 96, clients: 192, seconds: 12 }
  ]);
});

test('stage plan is configurable with rooms:seconds entries', () => {
  assert.deepEqual(parseStages('8:5,16:7'), [
    { rooms: 8, clients: 16, seconds: 5 },
    { rooms: 16, clients: 32, seconds: 7 }
  ]);
});

test('invalid stage plan is rejected before any load starts', () => {
  assert.throws(() => parseStages('24'), /rooms:seconds/);
  assert.throws(() => parseStages('0:12'), /positive integer/);
  assert.throws(() => parseStages('24:0'), /positive integer/);
  assert.throws(() => parseStages(''), /at least one stage/);
});

test('stage record preserves scaling and diagnostic metrics', () => {
  const stage = { rooms: 24, clients: 48, seconds: 12 };
  const record = stageRecord(1, stage, loadResult(), 0);
  assert.equal(record.status, 'PASS');
  assert.equal(record.eventLoopP95Ms, 21);
  assert.equal(record.rssMb, 97);
  assert.equal(record.sessions, 48);
  assert.equal(record.verificationFailed, 0);
  assert.equal(record.latePacketsDropped, 0);
});

test('non-zero load gate exit makes the stage fail with its concrete gate failures', () => {
  const stage = { rooms: 48, clients: 96, seconds: 12 };
  const result = loadResult();
  result.gate.ok = false;
  result.gate.failures = ['event-loop p95 82 ms > hard budget 60 ms'];
  const record = stageRecord(2, stage, result, 1);
  assert.equal(record.status, 'FAIL');
  assert.deepEqual(record.failures, ['event-loop p95 82 ms > hard budget 60 ms']);
});

test('missing result is an explicit stage failure', () => {
  const stage = { rooms: 96, clients: 192, seconds: 12 };
  const record = stageRecord(3, stage, null, 1);
  assert.equal(record.status, 'FAIL');
  assert.match(record.failures.join('\n'), /did not produce a machine-readable load result/);
});

test('aggregate summary shows scaling and explains the first stopped stage', () => {
  const stages = parseStages(DEFAULT_STAGE_SPEC);
  const first = stageRecord(1, stages[0], loadResult(), 0);
  const failingResult = loadResult();
  failingResult.after.load.eventLoopP95Ms = 82;
  failingResult.gate.ok = false;
  failingResult.gate.failures = ['event-loop p95 82 ms > hard budget 60 ms'];
  const second = stageRecord(2, stages[1], failingResult, 1);
  const summary = stagedMarkdownSummary([first, second], stages);

  assert.match(summary, /24 rooms \/ 48 clients \/ 12s → 48 rooms \/ 96 clients \/ 12s/);
  assert.match(summary, /\| 1 \| 24 \| 48 \| 21 ms \| 97 MB \| 0 \| PASS \|/);
  assert.match(summary, /\| 2 \| 48 \| 96 \| 82 ms \| 97 MB \| 0 \| FAIL \|/);
  assert.match(summary, /Stopped after Stage 2/);
  assert.match(summary, /event-loop p95 82 ms > hard budget 60 ms/);
});
