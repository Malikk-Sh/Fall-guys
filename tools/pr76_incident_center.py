from pathlib import Path
from textwrap import dedent


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


def write(path, content):
    file = Path(path)
    if file.exists():
        raise SystemExit(f'{path}: file already exists')
    file.write_text(dedent(content).lstrip(), encoding='utf-8')


write(
    'server/migrations/014_player_incident_diagnostics.js',
    r'''
    module.exports = {
      version: 14,
      sql: `
        CREATE TABLE player_incident_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          occurred_at INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 32),
          code TEXT NOT NULL CHECK(length(code) BETWEEN 1 AND 48),
          room_ref TEXT CHECK(room_ref IS NULL OR length(room_ref) = 12),
          match_ref TEXT CHECK(match_ref IS NULL OR length(match_ref) = 12),
          mode TEXT CHECK(mode IS NULL OR mode IN ('race', 'coop')),
          phase TEXT CHECK(phase IS NULL OR phase IN ('roomless', 'matchmaking', 'LOBBY', 'COUNTDOWN', 'PLAYING', 'RESULTS', 'CLOSING')),
          device TEXT CHECK(device IS NULL OR device IN ('mobile', 'desktop')),
          value_ms INTEGER CHECK(value_ms IS NULL OR (value_ms >= 0 AND value_ms <= 604800000))
        );

        CREATE INDEX idx_player_incident_account_time
          ON player_incident_events(account_id, occurred_at DESC, id DESC);
        CREATE INDEX idx_player_incident_time
          ON player_incident_events(occurred_at);
      `
    };
    ''',
)

write(
    'server/incidentDiagnostics.js',
    r'''
    'use strict';

    const crypto = require('crypto');
    const { ERROR_CODES } = require('../shared/protocol.js');

    const DAY_MS = 24 * 60 * 60 * 1000;
    const DEFAULT_RETENTION_DAYS = 14;
    const DEFAULT_MAX_PER_ACCOUNT = 400;
    const DEFAULT_QUERY_LIMIT = 100;
    const MAX_QUERY_LIMIT = 200;
    const MAX_VALUE_MS = 7 * DAY_MS;
    const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
    const CORRELATION_KEY = crypto.randomBytes(32);

    const FIXED_CODES = Object.freeze({
      auth: new Set(['authenticated', 'account-sanctioned']),
      connection: new Set(['disconnected', 'resumed', 'socket-error']),
      room: new Set(['created', 'joined']),
      matchmaking: new Set(['queued', 'matched', 'cancelled', 'away', 'disconnected', 'restart']),
      match: new Set(['started', 'completed', 'abandoned']),
      support: new Set(['forced-logout', 'renamed'])
    });
    const NETWORK_ERROR_CODES = new Set(Object.values(ERROR_CODES));
    const MODES = new Set(['race', 'coop']);
    const PHASES = new Set(['roomless', 'matchmaking', 'LOBBY', 'COUNTDOWN', 'PLAYING', 'RESULTS', 'CLOSING']);
    const DEVICES = new Set(['mobile', 'desktop']);

    function cleanAccountId(value) {
      const id = String(value || '').trim();
      return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(id) ? id : '';
    }

    function validCode(kind, code) {
      const normalizedKind = String(kind || '').trim();
      const normalizedCode = String(code || '').trim();
      if (normalizedKind === 'network-error') {
        return NETWORK_ERROR_CODES.has(normalizedCode) ? normalizedCode : '';
      }
      return FIXED_CODES[normalizedKind]?.has(normalizedCode) ? normalizedCode : '';
    }

    function correlationRef(scope, value) {
      const raw = String(value || '').trim();
      if (!raw) return null;
      return crypto
        .createHmac('sha256', CORRELATION_KEY)
        .update(`${scope}:${raw}`)
        .digest('hex')
        .slice(0, 12);
    }

    function safeEnum(value, allowed) {
      const text = String(value || '').trim();
      return allowed.has(text) ? text : null;
    }

    function safeValueMs(value) {
      if (value == null) return null;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < 0 || number > MAX_VALUE_MS) return null;
      return number;
    }

    function clampLimit(value) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) return DEFAULT_QUERY_LIMIT;
      return Math.min(parsed, MAX_QUERY_LIMIT);
    }

    class IncidentDiagnostics {
      constructor({
        db,
        now = () => Date.now(),
        retentionDays = DEFAULT_RETENTION_DAYS,
        maxPerAccount = DEFAULT_MAX_PER_ACCOUNT
      } = {}) {
        if (!db) throw new Error('IncidentDiagnostics requires an open database');
        this.db = db;
        this.now = now;
        this.retentionDays = Math.max(1, Math.min(90, Number(retentionDays) || DEFAULT_RETENTION_DAYS));
        this.maxPerAccount = Math.max(10, Math.min(2000, Number(maxPerAccount) || DEFAULT_MAX_PER_ACCOUNT));
        this.lastPrunedAt = 0;
        this.statements = prepare(db);
      }

      record({
        accountId,
        kind,
        code,
        occurredAt = this.now(),
        roomId = null,
        matchId = null,
        mode = null,
        phase = null,
        device = null,
        valueMs = null
      } = {}) {
        const id = cleanAccountId(accountId);
        const normalizedKind = String(kind || '').trim();
        const normalizedCode = validCode(normalizedKind, code);
        const at = Number(occurredAt);
        if (!id || !normalizedCode || !Number.isSafeInteger(at) || at < 0) return false;
        if (!this.statements.accountExists.get(id)) return false;

        this.#prune(at);
        this.statements.insert.run(
          id,
          at,
          normalizedKind,
          normalizedCode,
          correlationRef('room', roomId),
          correlationRef('match', matchId),
          safeEnum(mode, MODES),
          safeEnum(phase, PHASES),
          safeEnum(device, DEVICES),
          safeValueMs(valueMs)
        );
        this.statements.capAccount.run(id, id, this.maxPerAccount);
        return true;
      }

      timeline(accountId, { limit = DEFAULT_QUERY_LIMIT, now = this.now() } = {}) {
        const id = cleanAccountId(accountId);
        const at = Number(now);
        if (!id || !Number.isSafeInteger(at) || at < 0) return null;
        const account = this.statements.account.get(id);
        if (!account) return null;
        this.#prune(at, true);
        const from = at - this.retentionDays * DAY_MS;
        const rows = this.statements.timeline.all(id, from, clampLimit(limit));
        const summary = this.statements.summary.get(id, from) || {};
        return {
          generatedAt: at,
          retentionDays: this.retentionDays,
          account: { id: account.id, name: account.display_name },
          summary: {
            events: Number(summary.events || 0),
            disconnects: Number(summary.disconnects || 0),
            resumes: Number(summary.resumes || 0),
            networkErrors: Number(summary.network_errors || 0),
            matchesCompleted: Number(summary.matches_completed || 0),
            matchesAbandoned: Number(summary.matches_abandoned || 0),
            lastEventAt: summary.last_event_at == null ? null : Number(summary.last_event_at)
          },
          events: rows.map(row => ({
            id: Number(row.id),
            occurredAt: Number(row.occurred_at),
            kind: row.kind,
            code: row.code,
            roomRef: row.room_ref || null,
            matchRef: row.match_ref || null,
            mode: row.mode || null,
            phase: row.phase || null,
            device: row.device || null,
            valueMs: row.value_ms == null ? null : Number(row.value_ms)
          }))
        };
      }

      #prune(now, force = false) {
        if (!force && now - this.lastPrunedAt < HOUSEKEEPING_INTERVAL_MS) return;
        this.lastPrunedAt = now;
        this.statements.prune.run(now - this.retentionDays * DAY_MS);
      }
    }

    function prepare(db) {
      return {
        accountExists: db.prepare('SELECT 1 AS ok FROM accounts WHERE id = ?'),
        account: db.prepare('SELECT id, display_name FROM accounts WHERE id = ?'),
        insert: db.prepare(`
          INSERT INTO player_incident_events
            (account_id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        capAccount: db.prepare(`
          DELETE FROM player_incident_events
          WHERE account_id = ?
            AND id IN (
              SELECT id
              FROM player_incident_events
              WHERE account_id = ?
              ORDER BY occurred_at DESC, id DESC
              LIMIT -1 OFFSET ?
            )
        `),
        prune: db.prepare('DELETE FROM player_incident_events WHERE occurred_at < ?'),
        timeline: db.prepare(`
          SELECT id, occurred_at, kind, code, room_ref, match_ref, mode, phase, device, value_ms
          FROM player_incident_events
          WHERE account_id = ? AND occurred_at >= ?
          ORDER BY occurred_at DESC, id DESC
          LIMIT ?
        `),
        summary: db.prepare(`
          SELECT
            COUNT(*) AS events,
            SUM(CASE WHEN kind = 'connection' AND code = 'disconnected' THEN 1 ELSE 0 END) AS disconnects,
            SUM(CASE WHEN kind = 'connection' AND code = 'resumed' THEN 1 ELSE 0 END) AS resumes,
            SUM(CASE WHEN kind = 'network-error' THEN 1 ELSE 0 END) AS network_errors,
            SUM(CASE WHEN kind = 'match' AND code = 'completed' THEN 1 ELSE 0 END) AS matches_completed,
            SUM(CASE WHEN kind = 'match' AND code = 'abandoned' THEN 1 ELSE 0 END) AS matches_abandoned,
            MAX(occurred_at) AS last_event_at
          FROM player_incident_events
          WHERE account_id = ? AND occurred_at >= ?
        `)
      };
    }

    module.exports = {
      IncidentDiagnostics,
      DEFAULT_RETENTION_DAYS,
      DEFAULT_MAX_PER_ACCOUNT,
      MAX_QUERY_LIMIT,
      validCode,
      correlationRef
    };
    ''',
)

write(
    'server/incidentDiagnostics.test.mjs',
    r'''
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';

    const require = createRequire(import.meta.url);
    const { openDatabase } = require('./db');
    const { migrateDatabase } = require('./migrations');
    const { IncidentDiagnostics } = require('./incidentDiagnostics');

    function account(db, id = '11111111-2222-3333-4444-555555555555') {
      db.prepare(
        'INSERT INTO accounts (id, display_name, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
      ).run(id, 'Diag Player', `hash-${id}`, 1, 1);
      return id;
    }

    test('incident diagnostics stores only allowlisted privacy-safe event fields', () => {
      const db = openDatabase(':memory:');
      migrateDatabase(db);
      const id = account(db);
      const incidents = new IncidentDiagnostics({ db, now: () => 10_000 });

      assert.equal(
        incidents.record({
          accountId: id,
          kind: 'network-error',
          code: 'RECONNECT_EXPIRED',
          roomId: 'AB12CD',
          matchId: 'secret-match-id',
          mode: 'coop',
          phase: 'PLAYING',
          device: 'mobile',
          valueMs: 1234,
          ip: '203.0.113.9',
          token: 'never-store-this',
          detail: { arbitrary: 'payload' }
        }),
        true
      );
      assert.equal(incidents.record({ accountId: id, kind: 'arbitrary', code: 'anything' }), false);
      assert.equal(incidents.record({ accountId: id, kind: 'network-error', code: 'NOT_A_REAL_CODE' }), false);

      const timeline = incidents.timeline(id, { now: 10_001 });
      assert.equal(timeline.summary.networkErrors, 1);
      assert.equal(timeline.events.length, 1);
      assert.match(timeline.events[0].roomRef, /^[a-f0-9]{12}$/);
      assert.match(timeline.events[0].matchRef, /^[a-f0-9]{12}$/);
      const serialized = JSON.stringify(timeline);
      for (const secret of ['AB12CD', 'secret-match-id', '203.0.113.9', 'never-store-this', 'payload']) {
        assert.equal(serialized.includes(secret), false, `${secret} must not cross diagnostics boundary`);
      }
      db.close();
    });

    test('incident diagnostics prunes retention and bounds rows per account', () => {
      const db = openDatabase(':memory:');
      migrateDatabase(db);
      const id = account(db, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const incidents = new IncidentDiagnostics({ db, retentionDays: 1, maxPerAccount: 10 });
      const day = 24 * 60 * 60 * 1000;
      incidents.record({ accountId: id, kind: 'connection', code: 'disconnected', occurredAt: 1 });
      for (let index = 0; index < 14; index += 1) {
        incidents.record({
          accountId: id,
          kind: 'connection',
          code: index % 2 ? 'resumed' : 'disconnected',
          occurredAt: day + 1000 + index
        });
      }
      const timeline = incidents.timeline(id, { limit: 200, now: day + 2000 });
      assert.equal(timeline.events.length, 10);
      assert.equal(timeline.events.some(event => event.occurredAt === 1), false);
      assert.equal(
        db.prepare('SELECT COUNT(*) AS count FROM player_incident_events WHERE account_id = ?').get(id).count,
        10
      );
      db.close();
    });

    test('incident timeline returns null for an unknown account', () => {
      const db = openDatabase(':memory:');
      migrateDatabase(db);
      const incidents = new IncidentDiagnostics({ db });
      assert.equal(incidents.timeline('missing'), null);
      assert.equal(incidents.record({ accountId: 'missing', kind: 'connection', code: 'disconnected' }), false);
      db.close();
    });
    ''',
)

write(
    'server/adminIncidentRoutes.test.mjs',
    r'''
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';

    const require = createRequire(import.meta.url);
    const express = require('express');
    const { openDatabase } = require('./db');
    const { AdminAuthService } = require('./adminAuth');
    const { installAdminRoutes } = require('./adminRoutes');

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
    ''',
)

# Migration registration.
replace_once(
    'server/migrations/index.js',
    "const playerSanctions = require('./013_player_sanctions');\n",
    "const playerSanctions = require('./013_player_sanctions');\nconst playerIncidentDiagnostics = require('./014_player_incident_diagnostics');\n",
    'migration import',
)
replace_once(
    'server/migrations/index.js',
    '  accountSupportSearch,\n  playerSanctions\n]);',
    '  accountSupportSearch,\n  playerSanctions,\n  playerIncidentDiagnostics\n]);',
    'migration list',
)

# Capabilities: account-linked diagnostics stay within owner/operator support roles.
replace_once(
    'server/adminAuth.js',
    "    'player-support.name.write',\n    'moderation.read',",
    "    'player-support.name.write',\n    'incidents.read',\n    'moderation.read',",
    'owner incidents capability',
)
replace_once(
    'server/adminAuth.js',
    "    'player-support.sessions.write',\n    'moderation.read',",
    "    'player-support.sessions.write',\n    'incidents.read',\n    'moderation.read',",
    'operator incidents capability',
)

# Player Support history excludes read-only incident-view audit noise.
replace_once(
    'server/adminPlayerSupport.js',
    "        AND action <> 'player.support.view'\n",
    "        AND action NOT IN ('player.support.view', 'player.incident.view')\n",
    'support history view filters',
)

# AdminControl integrates diagnostics and records support actions best-effort.
replace_once(
    'server/adminControl.js',
    "    gameplay,\n    adminAuth,",
    "    gameplay,\n    incidents = null,\n    adminAuth,",
    'control constructor incidents arg',
)
replace_once(
    'server/adminControl.js',
    "    this.gameplay = gameplay;\n    this.adminAuth = adminAuth;",
    "    this.gameplay = gameplay;\n    this.incidents = incidents;\n    this.adminAuth = adminAuth;",
    'control incidents field',
)
replace_once(
    'server/adminControl.js',
    "  playerLogout({ targetAccountId, note, actor, now = Date.now() } = {}) {",
    dedent(r'''
      incidentTimeline(accountId, { actor, limit = 100, now = Date.now() } = {}) {
        if (!actor?.id || !actor?.name || !actor?.role) return { ok: false, reason: 'invalid-admin-actor' };
        if (!['owner', 'operator'].includes(actor.role)) return { ok: false, reason: 'incident-read-forbidden' };
        if (!this.incidents || typeof this.incidents.timeline !== 'function') {
          return { ok: false, reason: 'incident-diagnostics-unavailable' };
        }
        const profile = this.playerSupport.get(accountId, { now });
        if (!profile) return { ok: false, reason: 'unknown-account' };
        const timeline = this.incidents.timeline(profile.account.id, { limit, now });
        if (!timeline) return { ok: false, reason: 'unknown-account' };
        const result = {
          ok: true,
          incident: {
            ...timeline,
            account: {
              id: profile.account.id,
              supportId: profile.account.supportId,
              name: profile.account.name
            },
            live: { sockets: Number(this.connectionCount?.(profile.account.id) || 0) }
          }
        };
        this.adminAuth.audit({
          actor,
          action: 'player.incident.view',
          targetType: 'player-account',
          targetId: profile.account.id,
          now
        });
        return result;
      }

      playerLogout({ targetAccountId, note, actor, now = Date.now() } = {}) {
    ''').rstrip(),
    'incident timeline method',
)
replace_once(
    'server/adminControl.js',
    "    const result = {\n      accountId: id,\n      revokedSessions,",
    "    try {\n      this.incidents?.record({ accountId: id, kind: 'support', code: 'forced-logout', occurredAt: now });\n    } catch {\n      // Diagnostics are observability only; failure must never weaken or roll back a completed logout.\n    }\n\n    const result = {\n      accountId: id,\n      revokedSessions,",
    'logout incident event',
)
replace_once(
    'server/adminControl.js',
    "    return { ok: true, accountId: id, previousName: account.display_name, name: updatedName };",
    "    try {\n      this.incidents?.record({ accountId: id, kind: 'support', code: 'renamed', occurredAt: now });\n    } catch {\n      // Rename is already committed; diagnostics must not turn observability into a mutation dependency.\n    }\n    return { ok: true, accountId: id, previousName: account.display_name, name: updatedName };",
    'rename incident event',
)

# Admin route.
replace_once(
    'server/adminRoutes.js',
    "  app.post('/api/admin/players/logout', json, (req, res) => {",
    dedent(r'''
      app.post('/api/admin/incidents/player', json, (req, res) => {
        const resolved = requireAdmin(req, res, 'incidents.read');
        if (!resolved) return undefined;
        if (!keysOnly(req.body, new Set(['accountId', 'limit'])) || !req.body?.accountId) {
          return res.status(400).json({ ok: false, error: 'invalid-payload' });
        }
        if (!control || typeof control.incidentTimeline !== 'function') {
          return res.status(503).json({ ok: false, error: 'incident-diagnostics-unavailable' });
        }
        const result = control.incidentTimeline(req.body.accountId, {
          actor: resolved.session.user,
          limit: req.body.limit
        });
        if (!result.ok) {
          const status =
            result.reason === 'unknown-account'
              ? 404
              : result.reason === 'incident-read-forbidden'
                ? 403
                : result.reason === 'incident-diagnostics-unavailable'
                  ? 503
                  : 400;
          return res.status(status).json({ ok: false, error: result.reason });
        }
        return res.json(result);
      });

      app.post('/api/admin/players/logout', json, (req, res) => {
    ''').rstrip(),
    'incident admin route',
)

# Bootstrap passes the diagnostics service into the control layer.
replace_once(
    'server/bootstrap.js',
    "  gameplay: core.gameplay,\n  adminAuth,",
    "  gameplay: core.gameplay,\n  incidents: core.incidentDiagnostics,\n  adminAuth,",
    'bootstrap incidents wiring',
)

# NetworkIdentity returns the known blocked account internally so the server can record a safe event.
replace_once(
    'server/networkIdentity.js',
    "    if (!this.allowed(accountId)) return { ok: false, reason: 'blocked-account' };",
    "    if (!this.allowed(accountId)) return { ok: false, reason: 'blocked-account', accountId };",
    'blocked identity account return',
)

# Core diagnostics service and event instrumentation.
replace_once(
    'server/index.js',
    "const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');\n",
    "const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');\nconst { IncidentDiagnostics } = require('./incidentDiagnostics');\n",
    'incident import',
)
replace_once(
    'server/index.js',
    "const gameplay = new GameplayMetrics({ db: gameDb });\nconst socialSafety = new SocialSafety({ db: gameDb });",
    "const gameplay = new GameplayMetrics({ db: gameDb });\nconst incidentDiagnostics = new IncidentDiagnostics({ db: gameDb });\nconst socialSafety = new SocialSafety({ db: gameDb });",
    'incident instance',
)
replace_once(
    'server/index.js',
    "const send = (ws, data) => socketSend(ws, JSON.stringify(data));\n\nconst sendError = (ws, code, message, recoverable = true) =>\n  send(ws, { type: S2C.ERROR, code, message, recoverable });",
    dedent(r'''
      const send = (ws, data) => socketSend(ws, JSON.stringify(data));

      function incidentForSocket(ws, { accountId = null, kind, code, roomId, matchId, mode, phase, valueMs } = {}) {
        const room = ws?.room ? rooms.get(ws.room) : null;
        const player = room?.players.get(ws?.id);
        const id = String(accountId || ws?.accountId || player?.accountId || '');
        if (!id) return false;
        return incidentDiagnostics.record({
          accountId: id,
          kind,
          code,
          roomId: roomId === undefined ? room?.code : roomId,
          matchId: matchId === undefined ? room?.matchId : matchId,
          mode: mode === undefined ? room?.mode : mode,
          phase: phase === undefined ? room?.state || (ws?.room ? null : 'roomless') : phase,
          device: ws?.device,
          valueMs
        });
      }

      const sendError = (ws, code, message, recoverable = true) => {
        incidentForSocket(ws, { kind: 'network-error', code });
        return send(ws, { type: S2C.ERROR, code, message, recoverable });
      };
    ''').rstrip(),
    'central incident error recording',
)
replace_once(
    'server/index.js',
    "  if (player.accountId && !networkIdentity.allowed(player.accountId)) {\n    ws.accountAccessDenied = true;\n    return false;\n  }",
    "  if (player.accountId && !networkIdentity.allowed(player.accountId)) {\n    ws.accountAccessDenied = true;\n    ws.accountAccessDeniedAccountId = player.accountId;\n    return false;\n  }",
    'resume denied account identity',
)
replace_once(
    'server/index.js',
    "  trackEvent(productEvents, 'connectionRecovered');\n\n  // Токен возвращается вместе с ответом.",
    "  trackEvent(productEvents, 'connectionRecovered');\n  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'resumed' });\n\n  // Токен возвращается вместе с ответом.",
    'resume incident success',
)
replace_once(
    'server/index.js',
    "  if (!ws.room) {\n    const queued = coopMatchmaking.findIndex(entry => entry.ws === ws);",
    "  if (!ws.room) {\n    const queued = coopMatchmaking.findIndex(entry => entry.ws === ws);\n    incidentForSocket(ws, {\n      kind: 'connection',\n      code: 'disconnected',\n      phase: queued === -1 ? 'roomless' : 'matchmaking'\n    });",
    'roomless disconnect incident',
)
replace_once(
    'server/index.js',
    "  player.ws = null;\n  player.disconnectedAt = Date.now();",
    "  player.ws = null;\n  player.disconnectedAt = Date.now();\n  incidentForSocket(ws, { accountId: player.accountId, kind: 'connection', code: 'disconnected' });",
    'room disconnect incident',
)
replace_once(
    'server/index.js',
    "        gameplay.count('match_abandoned', dims(room, player, `cp${player.checkpoint ?? 0}`));\n      }\n      dropPlayer(room, player.id);",
    "        gameplay.count('match_abandoned', dims(room, player, `cp${player.checkpoint ?? 0}`));\n        incidentForSocket(player.ws, {\n          accountId: player.accountId,\n          kind: 'match',\n          code: 'abandoned',\n          roomId: room.code,\n          matchId: room.matchId,\n          mode: room.mode,\n          phase: room.state\n        });\n      }\n      dropPlayer(room, player.id);",
    'abandoned incident',
)
replace_once(
    'server/index.js',
    "    trackEvent(productEvents, 'matchmakingStarted');\n    return send(ws, { type: S2C.MATCHMAKING_WAITING, waitedMs: 0 });",
    "    trackEvent(productEvents, 'matchmakingStarted');\n    incidentForSocket(ws, { kind: 'matchmaking', code: 'queued', phase: 'matchmaking' });\n    return send(ws, { type: S2C.MATCHMAKING_WAITING, waitedMs: 0 });",
    'queued incident',
)
replace_once(
    'server/index.js',
    "  trackEvent(productEvents, 'matchmakingMatched');\n  log('info', 'matchmaking_matched', { roomId: room.code, chapterId, waitedMs: now - partner.queuedAt });",
    "  trackEvent(productEvents, 'matchmakingMatched');\n  incidentForSocket(partner.ws, {\n    kind: 'matchmaking',\n    code: 'matched',\n    phase: room.state,\n    valueMs: now - partner.queuedAt\n  });\n  incidentForSocket(ws, { kind: 'matchmaking', code: 'matched', phase: room.state });\n  log('info', 'matchmaking_matched', { roomId: room.code, chapterId, waitedMs: now - partner.queuedAt });",
    'matched incidents',
)
replace_once(
    'server/index.js',
    "  for (const item of room.players.values()) gameplay.count('match_started', dims(room, item));",
    "  for (const item of room.players.values()) {\n    gameplay.count('match_started', dims(room, item));\n    incidentForSocket(item.ws, {\n      accountId: item.accountId,\n      kind: 'match',\n      code: 'started',\n      roomId: room.code,\n      matchId: room.matchId,\n      mode: room.mode,\n      phase: room.state\n    });\n  }",
    'match started incidents',
)
replace_once(
    'server/index.js',
    "    gameplay.observe(\n      'finish_time',\n      entry.time,\n      dims(room, player, entry.verified ? 'verified' : 'unverified')\n    );",
    "    gameplay.observe(\n      'finish_time',\n      entry.time,\n      dims(room, player, entry.verified ? 'verified' : 'unverified')\n    );\n    incidentForSocket(player?.ws, {\n      accountId: player?.accountId,\n      kind: 'match',\n      code: 'completed',\n      roomId: room.code,\n      matchId: room.matchId,\n      mode: room.mode,\n      phase: room.state,\n      valueMs: entry.time\n    });",
    'match completed incidents',
)
replace_once(
    'server/index.js',
    "        if (authenticated.reason === 'blocked-account') {\n          try {",
    "        if (authenticated.reason === 'blocked-account') {\n          incidentForSocket(ws, {\n            accountId: authenticated.accountId,\n            kind: 'auth',\n            code: 'account-sanctioned'\n          });\n          try {",
    'blocked auth incident',
)
replace_once(
    'server/index.js',
    "      bindAuthenticatedSocketToRoom(ws, authenticated.accountId);\n      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });",
    "      bindAuthenticatedSocketToRoom(ws, authenticated.accountId);\n      incidentForSocket(ws, { accountId: authenticated.accountId, kind: 'auth', code: 'authenticated' });\n      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });",
    'auth success incident',
)
replace_once(
    'server/index.js',
    "      if (ws.accountAccessDenied) {\n        log('info', 'resume_sanctioned', { playerId: ws.id });",
    "      if (ws.accountAccessDenied) {\n        incidentForSocket(ws, {\n          accountId: ws.accountAccessDeniedAccountId,\n          kind: 'auth',\n          code: 'account-sanctioned'\n        });\n        log('info', 'resume_sanctioned', { playerId: ws.id });",
    'sanctioned resume incident',
)
replace_once(
    'server/index.js',
    "        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'button', device: ws.device });\n      }\n      return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });",
    "        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'button', device: ws.device });\n        incidentForSocket(ws, { kind: 'matchmaking', code: 'cancelled', phase: 'matchmaking' });\n      }\n      return send(ws, { type: S2C.MATCHMAKING_WAITING, cancelled: true, waitedMs: 0 });",
    'matchmaking cancel incident',
)
replace_once(
    'server/index.js',
    "        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'away', device: ws.device });\n        return send(ws, {",
    "        gameplay.count('queue_cancel', { mode: GAME_MODE.COOP, detail: 'away', device: ws.device });\n        incidentForSocket(ws, { kind: 'matchmaking', code: 'away', phase: 'matchmaking' });\n        return send(ws, {",
    'matchmaking away incident',
)
replace_once(
    'server/index.js',
    "      log('info', 'room_created', { roomId: code, mode });\n      return addPlayer(room, ws, message.name, message.playerId);",
    "      log('info', 'room_created', { roomId: code, mode });\n      addPlayer(room, ws, message.name, message.playerId);\n      incidentForSocket(ws, { kind: 'room', code: 'created' });\n      return;",
    'room created incident',
)
replace_once(
    'server/index.js',
    "      trackEvent(productEvents, 'roomJoined');\n      return addPlayer(room, ws, message.name, message.playerId);",
    "      trackEvent(productEvents, 'roomJoined');\n      addPlayer(room, ws, message.name, message.playerId);\n      incidentForSocket(ws, { kind: 'room', code: 'joined' });\n      return;",
    'room joined incident',
)
replace_once(
    'server/index.js',
    "  ws.on('error', error => {\n    log('warn', 'socket_error', { playerId: ws.id, message: error?.message });",
    "  ws.on('error', error => {\n    incidentForSocket(ws, { kind: 'connection', code: 'socket-error' });\n    log('warn', 'socket_error', { playerId: ws.id, message: error?.message });",
    'socket error incident',
)
replace_once(
    'server/index.js',
    "  gameplay,\n  socialSafety,",
    "  gameplay,\n  incidentDiagnostics,\n  socialSafety,",
    'incident export',
)

# Migration tests move to schema 14.
path = Path('server/migrations.test.mjs')
text = path.read_text(encoding='utf-8')
text = text.replace('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]', '[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]')
text = text.replace('{ version: 13, applied_at: 123 }\n  ]', '{ version: 13, applied_at: 123 },\n    { version: 14, applied_at: 123 }\n  ]')
text = text.replace("    'player_sanctions'\n  ])", "    'player_sanctions',\n    'player_incident_events'\n  ])")
# Every tail migration expectation that previously ended at 13 now includes 14.
for old, new in [
    ('[8, 9, 10, 11, 12, 13]', '[8, 9, 10, 11, 12, 13, 14]'),
    ('[9, 10, 11, 12, 13]', '[9, 10, 11, 12, 13, 14]'),
    ('[10, 11, 12, 13]', '[10, 11, 12, 13, 14]'),
    ('[11, 12, 13]', '[11, 12, 13, 14]'),
    ('[12, 13]', '[12, 13, 14]'),
    ('[13]', '[13, 14]'),
]:
    text = text.replace(old, new)
path.write_text(text, encoding='utf-8')

# Package test suite includes new diagnostics coverage.
replace_once(
    'package.json',
    'server/adminPlayerSupport.test.mjs server/adminPlayerSupportRoutes.test.mjs server/adminOperations.test.mjs',
    'server/adminPlayerSupport.test.mjs server/adminPlayerSupportRoutes.test.mjs server/incidentDiagnostics.test.mjs server/adminIncidentRoutes.test.mjs server/adminOperations.test.mjs',
    'package incident tests',
)

# Admin UI: tab + Incident Center + player shortcut.
replace_once(
    'client/admin/index.html',
    '          <button data-panel="players" data-capability="player-support.read">Игроки</button>\n          <button data-panel="moderation"',
    '          <button data-panel="players" data-capability="player-support.read">Игроки</button>\n          <button data-panel="incidents" data-capability="incidents.read">Инциденты</button>\n          <button data-panel="moderation"',
    'incident tab',
)
replace_once(
    'client/admin/index.html',
    "                <button id=\"player-open-moderation\" class=\"ghost\" type=\"button\" hidden>\n                  Открыть дело модерации\n                </button>",
    "                <button id=\"player-open-incidents\" class=\"ghost\" type=\"button\" hidden>\n                  Открыть диагностику\n                </button>\n                <button id=\"player-open-moderation\" class=\"ghost\" type=\"button\" hidden>\n                  Открыть дело модерации\n                </button>",
    'player incident shortcut',
)
incident_panel = r'''
        <section id="panel-incidents" class="panel" hidden>
          <details class="help-card" open>
            <summary>Что такое «Инциденты»?</summary>
            <p>
              Это короткая техническая история конкретного аккаунта: авторизация, вход в комнату, matchmaking,
              начало/завершение матча, disconnect/resume и безопасные коды сетевых ошибок. Она нужна, когда игрок
              сообщает «не подключается», «вылетело» или «сломался кооп».
            </p>
            <p>
              История хранится ограниченное время и не содержит IP, User-Agent, токенов, recovery-данных,
              invite-кодов комнат или сырых match ID. Корреляционные ссылки ниже необратимо маскируются
              серверным process-key и нужны только чтобы понять, какие события относились к одной комнате/матчу.
            </p>
          </details>

          <article class="card">
            <p class="eyebrow">LIVE DIAGNOSTICS</p>
            <h2>Найти игрока</h2>
            <p class="section-help">Поиск работает по имени, ID аккаунта или Support ID и ничего не меняет.</p>
            <form id="incident-search-form" class="support-search">
              <input id="incident-search-query" type="search" minlength="2" maxlength="80" placeholder="Malik, WBL-… или UUID" required />
              <button class="primary support-search-button" type="submit">Найти диагностику</button>
            </form>
            <p id="incident-search-meta" class="muted"></p>
            <div class="table-wrap">
              <table>
                <thead><tr><th>Игрок</th><th>Последняя активность</th><th>Активных входов</th><th></th></tr></thead>
                <tbody id="incident-results-body"></tbody>
              </table>
            </div>
          </article>

          <article id="incident-detail" class="card player-detail" hidden>
            <div class="card-head">
              <div>
                <p class="eyebrow">INCIDENT CENTER</p>
                <h2 id="incident-detail-name">Игрок</h2>
                <p id="incident-detail-id" class="mono muted"></p>
              </div>
              <div class="support-action-buttons">
                <button id="incident-open-player" class="ghost" type="button">Открыть карточку</button>
                <button id="incident-copy-package" class="ghost" type="button">Скопировать диагностический пакет</button>
                <button id="incident-detail-close" class="ghost" type="button">Закрыть</button>
              </div>
            </div>
            <p id="incident-meta" class="muted"></p>
            <div id="incident-summary-cards" class="cards"></div>
            <div class="table-wrap">
              <table>
                <thead>
                  <tr><th>Время</th><th>Событие</th><th>Контекст</th></tr>
                </thead>
                <tbody id="incident-events-body"></tbody>
              </table>
            </div>
          </article>
        </section>

'''
replace_once(
    'client/admin/index.html',
    '        <section id="panel-moderation" class="panel" hidden>',
    incident_panel + '        <section id="panel-moderation" class="panel" hidden>',
    'incident panel',
)

# Admin client state and labels.
replace_once(
    'client/admin/admin.js',
    "  playerActionTimer: null,\n  moderationCase: null,",
    "  playerActionTimer: null,\n  incidentRevision: 0,\n  incidentSearchQuery: '',\n  incidentData: null,\n  moderationCase: null,",
    'incident client state',
)
replace_once(
    'client/admin/admin.js',
    "  'player.support.rename': 'Изменено имя игрока',\n  'ops.operation.requested':",
    "  'player.support.rename': 'Изменено имя игрока',\n  'player.incident.view': 'Открыта диагностика игрока',\n  'ops.operation.requested':",
    'incident audit label',
)
replace_once(
    'client/admin/admin.js',
    "  if (name !== 'players') state.playerDetailRevision += 1;\n  if (name !== 'operations')",
    "  if (name !== 'players') state.playerDetailRevision += 1;\n  if (name !== 'incidents') state.incidentRevision += 1;\n  if (name !== 'operations')",
    'incident panel revision',
)
replace_once(
    'client/admin/admin.js',
    "  const moderationButton = $('#player-open-moderation');\n  moderationButton.hidden = !(state.capabilities.has('moderation.read') && moderation);",
    "  const incidentButton = $('#player-open-incidents');\n  incidentButton.hidden = !state.capabilities.has('incidents.read');\n  const moderationButton = $('#player-open-moderation');\n  moderationButton.hidden = !(state.capabilities.has('moderation.read') && moderation);",
    'player incident button visibility',
)
replace_once(
    'client/admin/admin.js',
    "function openPlayerModeration() {\n  const player = state.playerDetail;",
    dedent(r'''
      async function openPlayerIncidents() {
        const player = state.playerDetail;
        if (!player?.account?.id || !state.capabilities.has('incidents.read')) return;
        switchPanel('incidents');
        await openIncidentTimeline(player.account.id);
      }

      function openPlayerModeration() {
        const player = state.playerDetail;
    ''').rstrip(),
    'player incident navigation',
)

incident_js = r'''
const INCIDENT_KIND_LABELS = Object.freeze({
  auth: 'Авторизация',
  connection: 'Соединение',
  room: 'Комната',
  matchmaking: 'Подбор напарника',
  match: 'Матч',
  support: 'Поддержка',
  'network-error': 'Сетевая ошибка'
});
const INCIDENT_CODE_LABELS = Object.freeze({
  authenticated: 'Аккаунт подтверждён',
  'account-sanctioned': 'Доступ ограничен санкцией',
  disconnected: 'Соединение потеряно',
  resumed: 'Соединение восстановлено',
  'socket-error': 'Ошибка WebSocket транспорта',
  created: 'Комната создана',
  joined: 'Вход в комнату',
  queued: 'Встал в очередь',
  matched: 'Напарник найден',
  cancelled: 'Очередь отменена',
  away: 'Очередь отменена из-за свёрнутой игры',
  restart: 'Очередь закрыта обслуживанием',
  started: 'Матч начат',
  completed: 'Матч завершён',
  abandoned: 'Матч покинут после grace period',
  'forced-logout': 'Поддержка завершила сессии',
  renamed: 'Поддержка изменила имя'
});

function incidentEventLabel(event) {
  const code = INCIDENT_CODE_LABELS[event.code] || event.code;
  const kind = INCIDENT_KIND_LABELS[event.kind] || event.kind;
  return `${kind}: ${code}`;
}

function incidentContext(event) {
  const values = [];
  if (event.mode) values.push(modeLabel(event.mode));
  if (event.phase) values.push(`состояние ${event.phase}`);
  if (event.device) values.push(deviceLabel(event.device));
  if (event.roomRef) values.push(`room ref ${event.roomRef}`);
  if (event.matchRef) values.push(`match ref ${event.matchRef}`);
  if (event.valueMs != null) values.push(`время ${formatMilliseconds(event.valueMs)}`);
  return values.join(' · ') || 'без дополнительного контекста';
}

function renderIncidentTimeline(incident) {
  state.incidentData = incident;
  const account = incident.account || {};
  const summary = incident.summary || {};
  $('#incident-detail-name').textContent = account.name || 'Wobbler';
  $('#incident-detail-id').textContent = `${account.supportId || 'Support ID недоступен'} · ID аккаунта: ${account.id}`;
  $('#incident-meta').textContent =
    `История хранится ${formatNumber(incident.retentionDays)} дней · сформировано ${formatTime(incident.generatedAt)} · сейчас ${formatNumber(incident.live?.sockets)} игровых WebSocket.`;
  $('#incident-summary-cards').replaceChildren(
    statCard('Событий', formatNumber(summary.events), `последнее ${formatTime(summary.lastEventAt)}`),
    statCard('Обрывов', formatNumber(summary.disconnects), `${formatNumber(summary.resumes)} успешных resume`, summary.disconnects ? 'warn' : ''),
    statCard('Сетевых ошибок', formatNumber(summary.networkErrors), 'только серверные коды, без текста payload', summary.networkErrors ? 'warn' : ''),
    statCard('Матчи', formatNumber(summary.matchesCompleted), `${formatNumber(summary.matchesAbandoned)} abandon`, summary.matchesAbandoned ? 'warn' : 'good')
  );
  const body = $('#incident-events-body');
  body.replaceChildren();
  for (const event of incident.events || []) {
    body.append(rowWithCells([formatTime(event.occurredAt), incidentEventLabel(event), incidentContext(event)]));
  }
  if (!incident.events?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'За период хранения диагностических событий пока нет.', 'empty');
    cell.colSpan = 3;
    body.append(row);
  }
  $('#incident-detail').hidden = false;
}

async function openIncidentTimeline(accountId, { preserveStatus = false } = {}) {
  const revision = ++state.incidentRevision;
  if (!preserveStatus) setStatus('Загружаю диагностику игрока…');
  try {
    const payload = await api('/api/admin/incidents/player', { accountId, limit: 150 });
    if (revision !== state.incidentRevision) return;
    renderIncidentTimeline(payload.incident);
    if (!preserveStatus) setStatus('Диагностика игрока загружена', 'good');
  } catch (error) {
    if (revision !== state.incidentRevision) return;
    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');
    setStatus(`Не удалось загрузить диагностику: ${error.message}`, 'bad');
  }
}

async function searchIncidents() {
  const query = $('#incident-search-query').value.trim();
  if (query.length < 2) {
    $('#incident-search-meta').textContent = 'Введите хотя бы 2 символа.';
    return false;
  }
  state.incidentSearchQuery = query;
  const payload = await api('/api/admin/players/search', { query, limit: 30 });
  const body = $('#incident-results-body');
  body.replaceChildren();
  for (const player of payload.results || []) {
    const row = rowWithCells([
      `${player.name} · ${player.supportId ? `${player.supportId} · ` : ''}${player.id}`,
      formatTime(player.lastSeenAt),
      formatNumber(player.activeSessions)
    ]);
    const action = document.createElement('td');
    const button = appendText(action, 'button', 'Открыть события', 'case-open');
    button.type = 'button';
    button.addEventListener('click', () => openIncidentTimeline(player.id));
    row.append(action);
    body.append(row);
  }
  if (!payload.results?.length) {
    const row = document.createElement('tr');
    const cell = appendText(row, 'td', 'Игроки по этому запросу не найдены.', 'empty');
    cell.colSpan = 4;
    body.append(row);
  }
  $('#incident-search-meta').textContent = `Найдено: ${formatNumber(payload.results?.length)}.`;
  return true;
}

async function loadIncidents() {
  if (state.incidentData?.account?.id) {
    return openIncidentTimeline(state.incidentData.account.id, { preserveStatus: true });
  }
  if (!state.incidentSearchQuery) return true;
  $('#incident-search-query').value = state.incidentSearchQuery;
  return searchIncidents();
}

async function copyIncidentPackage() {
  const incident = state.incidentData;
  if (!incident) return setStatus('Сначала откройте диагностику игрока.', 'warn');
  const safePackage = {
    version: 1,
    generatedAt: incident.generatedAt,
    retentionDays: incident.retentionDays,
    player: {
      supportId: incident.account?.supportId || null,
      name: incident.account?.name || 'Wobbler'
    },
    summary: incident.summary,
    events: incident.events
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(safePackage, null, 2));
    setStatus('Безопасный диагностический пакет скопирован.', 'good');
  } catch {
    setStatus('Не удалось скопировать диагностический пакет автоматически.', 'warn');
  }
}

async function incidentOpenPlayer() {
  const accountId = state.incidentData?.account?.id;
  if (!accountId) return;
  switchPanel('players');
  await openPlayerDetail(accountId);
}

function closeIncidentDetail() {
  state.incidentRevision += 1;
  state.incidentData = null;
  $('#incident-detail').hidden = true;
}

'''
replace_once(
    'client/admin/admin.js',
    "function reasonsText(reasons = {}) {",
    incident_js + "function reasonsText(reasons = {}) {",
    'incident client functions',
)
replace_once(
    'client/admin/admin.js',
    "    players: loadPlayers,\n    moderation: loadModeration,",
    "    players: loadPlayers,\n    incidents: loadIncidents,\n    moderation: loadModeration,",
    'incident loader',
)
replace_once(
    'client/admin/admin.js',
    "$('#player-open-moderation').addEventListener('click', openPlayerModeration);",
    "$('#player-open-incidents').addEventListener('click', openPlayerIncidents);\n$('#player-open-moderation').addEventListener('click', openPlayerModeration);\n$('#incident-search-form').addEventListener('submit', async event => {\n  event.preventDefault();\n  setStatus('Ищу игрока для диагностики…');\n  try {\n    await searchIncidents();\n    setStatus('Поиск завершён', 'good');\n  } catch (error) {\n    if (error.status === 401) return showLogin('Сессия администратора завершена. Войдите снова.');\n    setStatus(`Ошибка поиска: ${error.message}`, 'bad');\n  }\n});\n$('#incident-copy-package').addEventListener('click', copyIncidentPackage);\n$('#incident-open-player').addEventListener('click', incidentOpenPlayer);\n$('#incident-detail-close').addEventListener('click', closeIncidentDetail);",
    'incident event listeners',
)

# Socket integration regression: event timeline gets real server-side auth/room/disconnect events without raw credentials.
path = Path('server/socketAuthIntegration.test.mjs')
text = path.read_text(encoding='utf-8').rstrip()
if 'incident diagnostics follows authenticated socket lifecycle' in text:
    raise SystemExit('incident socket regression already present')
text += dedent(r'''


test('incident diagnostics follows authenticated socket lifecycle without storing credentials', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Incident Socket');
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const client = await openClient(url);
  t.after(async () => {
    await closeClient(client);
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  await authReply;
  const lobbyReply = waitFor(client, 'lobby');
  client.send(JSON.stringify({ type: 'create', name: 'Ignored Cached Name', protocolVersion: 10 }));
  await lobbyReply;
  await closeClient(client);
  await new Promise(resolve => setTimeout(resolve, 30));

  const timeline = core.incidentDiagnostics.timeline(account.id);
  assert.ok(timeline.events.some(event => event.kind === 'auth' && event.code === 'authenticated'));
  assert.ok(timeline.events.some(event => event.kind === 'room' && event.code === 'created'));
  assert.ok(timeline.events.some(event => event.kind === 'connection' && event.code === 'disconnected'));
  const serialized = JSON.stringify(timeline);
  assert.equal(serialized.includes(ticket), false);
  assert.equal(serialized.includes('Ignored Cached Name'), false);
});
''').rstrip() + '\n'
path.write_text(text, encoding='utf-8')
