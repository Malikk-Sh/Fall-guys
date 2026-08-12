import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const { openDatabase } = require('./db');
const { AdminAuthService } = require('./adminAuth');
const { installAdminRoutes } = require('./adminRoutes');
const adminClient = readFileSync(new URL('../client/admin/admin.js', import.meta.url), 'utf8');

async function start(role) {
  const db = openDatabase(':memory:');
  const adminAuth = new AdminAuthService({ db });
  const created = adminAuth.createUser({ name: role, role });
  const login = adminAuth.login(created.accessCode);
  const app = express();
  const calls = [];
  installAdminRoutes({
    app,
    adminAuth,
    control: {
      overview: () => ({}),
      analytics: () => ({}),
      moderationQueue: () => ({ ok: true, cases: [] }),
      incidentTimeline: (accountId, options) => {
        calls.push({ accountId, options });
        return {
          ok: true,
          incident: {
            generatedAt: 100,
            retentionDays: 14,
            account: { id: accountId, supportId: 'WBL-111122223333', name: 'Player' },
            live: { sockets: 0 },
            summary: { events: 0 },
            events: []
          }
        };
      }
    },
    enabled: true,
    secureCookies: false
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    db,
    server,
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: `wobble_admin_session=${encodeURIComponent(login.token)}`,
    csrf: login.csrf
  };
}

async function post(ctx, body) {
  return fetch(`${ctx.base}/api/admin/incidents/player`, {
    method: 'POST',
    headers: {
      Cookie: ctx.cookie,
      'Content-Type': 'application/json',
      'X-Wobble-Admin-CSRF': ctx.csrf
    },
    body: JSON.stringify(body)
  });
}

for (const role of ['owner', 'operator']) {
  test(`${role} can read player incident diagnostics`, async t => {
    const ctx = await start(role);
    t.after(() => {
      ctx.server.close();
      ctx.db.close();
    });
    const response = await post(ctx, { accountId: '11111111-2222-3333-4444-555555555555', limit: 75 });
    assert.equal(response.status, 200);
    assert.equal(ctx.calls.length, 1);
    assert.equal(ctx.calls[0].options.actor.role, role);
    assert.equal(ctx.calls[0].options.limit, 75);
  });
}

test('moderator cannot read account-linked incident diagnostics', async t => {
  const ctx = await start('moderator');
  t.after(() => {
    ctx.server.close();
    ctx.db.close();
  });
  assert.equal((await post(ctx, { accountId: 'target' })).status, 403);
  assert.equal(ctx.calls.length, 0);
});

test('incident route rejects extra fields before calling control service', async t => {
  const ctx = await start('owner');
  t.after(() => {
    ctx.server.close();
    ctx.db.close();
  });
  assert.equal((await post(ctx, { accountId: 'target', rawIp: '203.0.113.9' })).status, 400);
  assert.equal(ctx.calls.length, 0);
});

test('admin logout clears account-linked incident state and privacy copy describes coarse device class', () => {
  const adminJs = readFileSync(new URL('../client/admin/admin.js', import.meta.url), 'utf8');
  const adminHtml = readFileSync(new URL('../client/admin/index.html', import.meta.url), 'utf8');
  const clearStart = adminJs.indexOf('function clearIncidentView()');
  const loginStart = adminJs.indexOf("function showLogin(message = '')");
  assert.ok(clearStart >= 0 && loginStart > clearStart);
  const clearBody = adminJs.slice(clearStart, loginStart);
  for (const fragment of [
    'state.incidentRevision += 1',
    "state.incidentSearchQuery = ''",
    'state.incidentData = null',
    "$('#incident-results-body')",
    "$('#incident-events-body')"
  ])
    assert.ok(clearBody.includes(fragment), `missing incident cleanup: ${fragment}`);
  assert.match(adminJs.slice(loginStart, loginStart + 220), /clearIncidentView\(\)/);
  assert.match(adminHtml, /mobile\/desktop/);
  assert.match(adminHtml, /raw\s+User-Agent/i);
  assert.match(adminHtml, /device fingerprint/i);
});

test('incident search responses cannot repopulate account data after admin session invalidation', () => {
  const start = adminClient.indexOf('async function searchIncidents()');
  const end = adminClient.indexOf('async function loadIncidents()', start);
  assert.ok(start >= 0 && end > start);
  const source = adminClient.slice(start, end);
  assert.match(source, /const revision = \+\+state\.incidentRevision;/);
  assert.match(source, /const sessionGeneration = state\.sessionGeneration;/);
  assert.match(
    source,
    /revision !== state\.incidentRevision \|\| sessionGeneration !== state\.sessionGeneration/
  );
});
