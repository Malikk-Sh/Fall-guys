import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ControlPlaneGameClient, GAME_ADMIN_PATHS, MAX_REQUEST_BYTES } = require('./controlPlaneGameClient');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, port: server.address().port };
}

async function close(server) {
  await new Promise(resolve => server.close(resolve));
}

test('game admin client rejects unknown paths before contacting upstream', async () => {
  let calls = 0;
  const client = new ControlPlaneGameClient({
    request() {
      calls += 1;
      throw new Error('must not contact upstream');
    }
  });
  const result = await client.adminRequest('/api/admin/not-real', { body: {} });
  assert.equal(result.statusCode, 404);
  assert.equal(result.payload.error, 'admin-route-not-found');
  assert.equal(result.contactedUpstream, false);
  assert.equal(calls, 0);
});

test('game admin client forwards only bounded auth headers and preserves application response', async () => {
  let received = null;
  const { server, port } = await listen((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        url: req.url,
        cookie: req.headers.cookie,
        csrf: req.headers['x-wobble-admin-csrf'],
        authorization: req.headers.authorization,
        forwarded: req.headers['x-forwarded-for'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
      };
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'case-changed', case: { revision: 4 } }));
    });
  });
  try {
    const client = new ControlPlaneGameClient({ port });
    const result = await client.adminRequest('/api/admin/moderation/transition', {
      body: { targetAccountId: 'a', status: 'resolved' },
      cookie: 'wobble_admin_session=WAS.test',
      csrf: 'csrf-value'
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.payload.error, 'case-changed');
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/admin/moderation/transition');
    assert.equal(received.cookie, 'wobble_admin_session=WAS.test');
    assert.equal(received.csrf, 'csrf-value');
    assert.equal(received.authorization, undefined);
    assert.equal(received.forwarded, undefined);
    assert.deepEqual(received.body, { targetAccountId: 'a', status: 'resolved' });
  } finally {
    await close(server);
  }
});

test('game admin client converts connection failure into safe availability error', async () => {
  const { server, port } = await listen((_req, res) => res.end('{}'));
  await close(server);
  const client = new ControlPlaneGameClient({ port, timeoutMs: 300 });
  const result = await client.adminRequest('/api/admin/dashboard', { body: {} });
  assert.equal(result.statusCode, 503);
  assert.deepEqual(result.payload, { ok: false, error: 'game-control-unavailable' });
});

test('game admin client bounds request bodies', async () => {
  const client = new ControlPlaneGameClient();
  const result = await client.adminRequest('/api/admin/analytics', {
    body: { value: 'x'.repeat(MAX_REQUEST_BYTES + 1) }
  });
  assert.equal(result.statusCode, 413);
  assert.equal(result.contactedUpstream, false);
  assert.equal(result.payload.error, 'admin-request-too-large');
});

test('game admin path allowlist stays explicit', () => {
  assert.ok(GAME_ADMIN_PATHS.includes('/api/admin/dashboard'));
  assert.ok(GAME_ADMIN_PATHS.includes('/api/admin/sanctions/revoke'));
  assert.equal(GAME_ADMIN_PATHS.includes('/api/admin/login'), false);
  assert.equal(GAME_ADMIN_PATHS.includes('/api/admin/operations/run'), false);
});

test('game status treats a responding but unready process as reachable and not ready', async () => {
  const { server, port } = await listen((req, res) => {
    assert.equal(req.url, '/health/ready');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: false,
        service: 'wobble-rush-3d',
        version: '2.6.0',
        commit: 'draining123',
        uptime: 42,
        load: { overloaded: true },
        capacity: { socketsFull: false }
      })
    );
  });
  try {
    const client = new ControlPlaneGameClient({ port });
    const status = await client.status();
    assert.equal(status.reachable, true);
    assert.equal(status.ready, false);
    assert.equal(status.commit, 'draining123');
  } finally {
    await close(server);
  }
});

test('game status reports ready only from successful /health/ready', async () => {
  const { server, port } = await listen((req, res) => {
    assert.equal(req.url, '/health/ready');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        service: 'wobble-rush-3d',
        version: '2.6.0',
        commit: 'ready456',
        uptime: 3
      })
    );
  });
  try {
    const client = new ControlPlaneGameClient({ port });
    const status = await client.status();
    assert.equal(status.reachable, true);
    assert.equal(status.ready, true);
    assert.equal(status.commit, 'ready456');
  } finally {
    await close(server);
  }
});
