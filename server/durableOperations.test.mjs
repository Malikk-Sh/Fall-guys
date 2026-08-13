import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  beginDurableOperation,
  readOperationJournal,
  recoverDurableOperations,
  transitionDurableOperation,
  writeRestartMarker
} from '../deploy/wobble-ops-helper.mjs';

const require = createRequire(import.meta.url);
const { AdminOperationsClient } = require('./adminOperationsClient');

function tempState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wobble-durable-ops-'));
  return {
    dir,
    journalPath: path.join(dir, 'operations.json'),
    markerPath: path.join(dir, 'restart.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

const request = (id, action) => ({ requestId: id, action });

test('durable journal persists the full bounded operation lifecycle atomically', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('11111111-1111-4111-8111-111111111111', 'backup.create'), {
      journalPath: ctx.journalPath,
      now: 1000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 1100 }), true);
    assert.equal(
      transitionDurableOperation(started.context, 'succeeded', { now: 1600, durationMs: 600 }),
      true
    );
    const records = readOperationJournal(ctx.journalPath);
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'succeeded');
    assert.equal(records[0].durationMs, 600);
    assert.deepEqual(
      records[0].transitions.map(step => step.state),
      ['queued', 'running', 'succeeded']
    );
    assert.equal(fs.statSync(ctx.journalPath).mode & 0o777, 0o644);
  } finally {
    ctx.cleanup();
  }
});

test('an active durable operation blocks overlap and interrupted non-restart work fails on helper recovery', () => {
  const ctx = tempState();
  try {
    const first = beginDurableOperation(request('22222222-2222-4222-8222-222222222222', 'backup.verify'), {
      journalPath: ctx.journalPath,
      now: 2000
    });
    assert.equal(first.ok, true);
    assert.equal(transitionDurableOperation(first.context, 'running', { now: 2100 }), true);
    const blocked = beginDurableOperation(request('33333333-3333-4333-8333-333333333333', 'smoke.run'), {
      journalPath: ctx.journalPath,
      now: 2200
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, 'operation-busy');
    assert.equal(blocked.activeId, first.context.id);

    const recovered = recoverDurableOperations({
      journalPath: ctx.journalPath,
      markerPath: ctx.markerPath,
      now: 3000
    });
    assert.equal(recovered[0].state, 'failed');
    assert.equal(recovered[0].reason, 'helper-restarted');

    const second = beginDurableOperation(request('33333333-3333-4333-8333-333333333333', 'smoke.run'), {
      journalPath: ctx.journalPath,
      now: 3100
    });
    assert.equal(second.ok, true);
  } finally {
    ctx.cleanup();
  }
});

test('restart marker keeps the matching durable restart alive across helper restart', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('44444444-4444-4444-8444-444444444444', 'wobble.restart'), {
      journalPath: ctx.journalPath,
      now: 4000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 4100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 4200 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 1234,
          startedAt: 4000,
          clearMaintenance: true,
          phase: 'signal-delivered',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );
    const recovered = recoverDurableOperations({
      journalPath: ctx.journalPath,
      markerPath: ctx.markerPath,
      now: 4300
    });
    assert.equal(recovered[0].state, 'drain');
    assert.equal(recovered[0].reason, null);
  } finally {
    ctx.cleanup();
  }
});

test('control-plane operations client exposes sanitized active state and newest-first history', () => {
  const ctx = tempState();
  try {
    fs.writeFileSync(
      ctx.journalPath,
      JSON.stringify({
        version: 1,
        operations: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            action: 'backup.create',
            state: 'succeeded',
            createdAt: 1000,
            updatedAt: 1500,
            completedAt: 1500,
            durationMs: 500,
            reason: null,
            secret: 'must-not-leak',
            transitions: [{ state: 'succeeded', at: 1500, raw: 'hidden' }]
          },
          {
            id: '66666666-6666-4666-8666-666666666666',
            action: 'wobble.restart',
            state: 'verifying',
            createdAt: 2000,
            updatedAt: 2500,
            completedAt: null,
            durationMs: null,
            reason: null,
            transitions: [{ state: 'verifying', at: 2500 }]
          }
        ]
      })
    );
    const client = new AdminOperationsClient({
      socketPath: path.join(ctx.dir, 'missing.sock'),
      maintenanceFlag: path.join(ctx.dir, 'maintenance'),
      journalPath: ctx.journalPath
    });
    const status = client.status();
    assert.equal(status.busy, true);
    assert.equal(status.activeOperation.id, '66666666-6666-4666-8666-666666666666');
    assert.equal(status.history[0].state, 'verifying');
    assert.equal(status.history[1].state, 'succeeded');
    assert.equal(Object.hasOwn(status.history[1], 'secret'), false);
    assert.deepEqual(status.history[1].transitions[0], { state: 'succeeded', at: 1500 });
  } finally {
    ctx.cleanup();
  }
});
