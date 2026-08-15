import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  beginDurableOperation,
  readOperationJournal,
  finalizeRestartOperation,
  recoverDurableOperations,
  recoverRestartMonitor,
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
    assert.equal(status.history[0].completedAt, null);
    assert.equal(status.history[0].durationMs, null);
    assert.equal(status.history[1].state, 'succeeded');
    assert.equal(Object.hasOwn(status.history[1], 'secret'), false);
    assert.deepEqual(status.history[1].transitions[0], { state: 'succeeded', at: 1500 });
  } finally {
    ctx.cleanup();
  }
});

test('helper execution exception is persisted as failed rather than leaving an active operation', async t => {
  const { createServer } = await import('../deploy/wobble-ops-helper.mjs');
  const ctx = tempState();
  const socketPath = path.join(ctx.dir, 'ops.sock');
  const server = createServer({
    journalPath: ctx.journalPath,
    execute: async () => {
      throw new Error('synthetic helper failure');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    ctx.cleanup();
  });

  // Тест проверяет, что исключение хелпера сохраняется как failed, а не что клиент умеет
  // отваливаться по таймауту. Прежняя секунда была не границей смысла, а страховкой от зависания —
  // и на загруженном CI-раннере круг через unix-сокет успевал её превысить: вместо
  // 'operation-failed' приходил 'helper-timeout'. Запас берём с большим отрывом; настоящее
  // зависание всё равно поймает таймаут самого test runner.
  const client = new AdminOperationsClient({
    socketPath,
    maintenanceFlag: path.join(ctx.dir, 'maintenance'),
    journalPath: ctx.journalPath,
    timeoutMs: 30_000
  });
  const result = await client.run('backup.verify');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'operation-failed');
  const records = readOperationJournal(ctx.journalPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'failed');
  assert.equal(records[0].reason, 'operation-failed');
});

test('malformed durable journal fails closed and is never overwritten by a new root action', () => {
  const ctx = tempState();
  try {
    const malformed = '{"version":1,"operations":[';
    fs.writeFileSync(ctx.journalPath, malformed);
    const started = beginDurableOperation(request('77777777-7777-4777-8777-777777777777', 'nginx.reload'), {
      journalPath: ctx.journalPath,
      now: 7000
    });
    assert.equal(started.ok, false);
    assert.equal(started.reason, 'operation-state-failed');
    assert.equal(fs.readFileSync(ctx.journalPath, 'utf8'), malformed);
  } finally {
    ctx.cleanup();
  }
});

test('restart recovery rollback closes the matching durable operation instead of blocking forever', async () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('88888888-8888-4888-8888-888888888888', 'wobble.restart'), {
      journalPath: ctx.journalPath,
      now: 8000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 8100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 8200 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 4321,
          startedAt: 8000,
          clearMaintenance: true,
          phase: 'signal-pending',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );

    const recovered = await recoverRestartMonitor({
      markerPath: ctx.markerPath,
      journalPath: ctx.journalPath,
      now: 8300,
      advanceSignal: async () => ({ marker: null, rolledBack: true })
    });
    assert.equal(recovered, false);
    const records = readOperationJournal(ctx.journalPath);
    assert.equal(records[0].state, 'failed');
    assert.equal(records[0].reason, 'restart-signal-failed');
  } finally {
    ctx.cleanup();
  }
});

test('operation timestamps stay monotonic across wall-clock rollback', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('99999999-9999-4999-8999-999999999999', 'backup.verify'), {
      journalPath: ctx.journalPath,
      now: 10_000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 9_000 }), true);
    assert.equal(transitionDurableOperation(started.context, 'succeeded', { now: 8_000 }), true);
    const [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.updatedAt, 10_000);
    assert.equal(record.completedAt, 10_000);
    assert.equal(record.durationMs, 0);
    assert.deepEqual(
      record.transitions.map(step => step.at),
      [10_000, 10_000, 10_000]
    );
  } finally {
    ctx.cleanup();
  }
});

test('legacy restart marker is imported into durable busy ownership before recovery work', async () => {
  const ctx = tempState();
  try {
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 2468,
          startedAt: 11_000,
          clearMaintenance: false
        },
        ctx.markerPath
      ),
      true
    );
    let importedId = null;
    const recovered = await recoverRestartMonitor({
      markerPath: ctx.markerPath,
      journalPath: ctx.journalPath,
      now: 11_100,
      advanceSignal: async marker => {
        const persisted = JSON.parse(fs.readFileSync(ctx.markerPath, 'utf8'));
        importedId = persisted.operationId;
        assert.match(importedId, /^[0-9a-f-]{36}$/i);
        const client = new AdminOperationsClient({
          socketPath: path.join(ctx.dir, 'missing.sock'),
          maintenanceFlag: path.join(ctx.dir, 'maintenance'),
          journalPath: ctx.journalPath
        });
        const status = client.status();
        assert.equal(status.busy, true);
        assert.equal(status.activeOperation.id, importedId);
        assert.equal(status.activeOperation.action, 'wobble.restart');
        return { marker, rolledBack: true };
      }
    });
    assert.equal(recovered, false);
    const [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.id, importedId);
    assert.equal(record.state, 'failed');
    assert.equal(record.reason, 'restart-signal-failed');
  } finally {
    ctx.cleanup();
  }
});

test('restart terminal state is durable before its recovery marker is released', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'wobble.restart'), {
      journalPath: ctx.journalPath,
      now: 12_000
    });
    assert.equal(started.ok, true);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 12_100 }), true);
    assert.equal(transitionDurableOperation(started.context, 'drain', { now: 12_200 }), true);
    assert.equal(transitionDurableOperation(started.context, 'verifying', { now: 12_300 }), true);
    assert.equal(
      writeRestartMarker(
        {
          version: 1,
          oldPid: 1357,
          startedAt: 12_000,
          clearMaintenance: false,
          phase: 'signal-delivered',
          operationId: started.context.id
        },
        ctx.markerPath
      ),
      true
    );

    const journal = fs.readFileSync(ctx.journalPath, 'utf8');
    fs.rmSync(ctx.journalPath);
    assert.equal(
      finalizeRestartOperation({
        operationId: started.context.id,
        state: 'succeeded',
        startedAt: 12_000,
        journalPath: ctx.journalPath,
        markerPath: ctx.markerPath,
        clearMaintenance: false,
        now: 12_400
      }),
      false
    );
    assert.equal(fs.existsSync(ctx.markerPath), true);

    fs.writeFileSync(ctx.journalPath, journal);
    assert.equal(
      finalizeRestartOperation({
        operationId: started.context.id,
        state: 'succeeded',
        startedAt: 12_000,
        journalPath: ctx.journalPath,
        markerPath: ctx.markerPath,
        clearMaintenance: false,
        now: 12_400
      }),
      true
    );
    assert.equal(readOperationJournal(ctx.journalPath)[0].state, 'succeeded');
    assert.equal(fs.existsSync(ctx.markerPath), false);
  } finally {
    ctx.cleanup();
  }
});

test('operations helper is enabled at boot so persisted recovery cannot remain permanently idle', () => {
  const service = fs.readFileSync(path.join(process.cwd(), 'deploy/wobble-ops.service'), 'utf8');
  const installer = fs.readFileSync(path.join(process.cwd(), 'deploy/install.sh'), 'utf8');
  assert.match(service, /\[Install\][\s\S]*WantedBy=multi-user\.target/);
  assert.match(installer, /systemctl enable[^\n]*wobble-ops\.service/);
});

test('root helper preserves null duration until an operation becomes terminal', () => {
  const ctx = tempState();
  try {
    const started = beginDurableOperation(request('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'backup.create'), {
      journalPath: ctx.journalPath,
      now: 13_000
    });
    assert.equal(started.ok, true);
    let [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.state, 'queued');
    assert.equal(record.durationMs, null);
    assert.equal(transitionDurableOperation(started.context, 'running', { now: 13_100 }), true);
    [record] = readOperationJournal(ctx.journalPath);
    assert.equal(record.state, 'running');
    assert.equal(record.durationMs, null);
  } finally {
    ctx.cleanup();
  }
});
