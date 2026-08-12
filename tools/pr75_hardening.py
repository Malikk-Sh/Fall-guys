from pathlib import Path


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


# Make support logout fail closed across durable and process-local auth paths.
p = 'server/adminControl.js'
s = read(p)
old = """    let revokedSessions = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      revokedSessions = Number(this.auth.revokeAccountSessions(id) || 0);
      this.adminAuth.audit({
        actor,
        action: 'player.support.logout',
        targetType: 'player-account',
        targetId: id,
        detail: { note: internalNote, revokedSessions },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    let revokedSocketTickets = 0;
    let revokedReconnectSessions = 0;
    let disconnectedSockets = 0;
    try {
      revokedSocketTickets = Number(this.auth.revokeAccountSocketTickets?.(id) || 0);
    } catch {
      revokedSocketTickets = 0;
    }
    try {
      revokedReconnectSessions = Number(this.revokeReconnectSessions?.(id) || 0);
    } catch {
      revokedReconnectSessions = 0;
    }
    try {
      disconnectedSockets = Number(
        this.disconnectAccount?.(id, { code: 4004, reason: 'support-logout' }) || 0
      );
    } catch {
      disconnectedSockets = 0;
    }
    return {
      ok: true,
      accountId: id,
      revokedSessions,
      revokedSocketTickets,
      revokedReconnectSessions,
      disconnectedSockets
    };
"""
new = """    let revokedSessions = 0;
    let revokedSocketTickets = 0;
    let revokedReconnectSessions = 0;
    let disconnectedSockets = 0;
    const failedSteps = [];

    this.db.exec('BEGIN IMMEDIATE');
    try {
      revokedSessions = Number(this.auth.revokeAccountSessions(id) || 0);
      try {
        if (typeof this.auth.revokeAccountSocketTickets !== 'function') {
          throw new Error('socket-ticket revocation unavailable');
        }
        revokedSocketTickets = Number(this.auth.revokeAccountSocketTickets(id) || 0);
      } catch {
        failedSteps.push('socket-tickets');
      }
      try {
        if (!this.revokeReconnectSessions) throw new Error('reconnect-session revocation unavailable');
        revokedReconnectSessions = Number(this.revokeReconnectSessions(id) || 0);
      } catch {
        failedSteps.push('reconnect-sessions');
      }
      try {
        if (!this.disconnectAccount) throw new Error('socket disconnection unavailable');
        disconnectedSockets = Number(
          this.disconnectAccount(id, { code: 4004, reason: 'support-logout' }) || 0
        );
      } catch {
        failedSteps.push('active-sockets');
      }

      this.adminAuth.audit({
        actor,
        action: 'player.support.logout',
        targetType: 'player-account',
        targetId: id,
        detail: {
          note: internalNote,
          revokedSessions,
          revokedSocketTickets,
          revokedReconnectSessions,
          disconnectedSockets,
          complete: failedSteps.length === 0,
          failedSteps
        },
        now
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const result = {
      accountId: id,
      revokedSessions,
      revokedSocketTickets,
      revokedReconnectSessions,
      disconnectedSockets
    };
    return failedSteps.length
      ? { ok: false, reason: 'support-logout-incomplete', ...result, failedSteps }
      : { ok: true, ...result };
"""
s = replace_once(s, old, new, 'fail-closed player logout')
write(p, s)

# Preserve partial-cleanup diagnostics and use 503 for an incomplete force logout.
p = 'server/adminRoutes.js'
s = read(p)
old = """      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable'
              ? 503
              : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {})
      });
"""
new = """      const status =
        result.reason === 'unknown-account'
          ? 404
          : result.reason === 'support-action-forbidden'
            ? 403
            : result.reason === 'player-support-actions-unavailable' ||
                result.reason === 'support-logout-incomplete'
              ? 503
              : 400;
      return res.status(status).json({
        ok: false,
        error: result.reason,
        ...(result.maxLength ? { maxLength: result.maxLength } : {}),
        ...(result.reason === 'support-logout-incomplete'
          ? {
              accountId: result.accountId,
              revokedSessions: result.revokedSessions,
              revokedSocketTickets: result.revokedSocketTickets,
              revokedReconnectSessions: result.revokedReconnectSessions,
              disconnectedSockets: result.disconnectedSockets,
              failedSteps: result.failedSteps
            }
          : {})
      });
"""
s = replace_once(s, old, new, 'support logout incomplete route')
write(p, s)

# Add an injected failure mode and verify both success audit completeness and partial failure behavior.
p = 'server/adminPlayerSupportRoutes.test.mjs'
s = read(p)
s = replace_once(s, 'function prepare() {\n', 'function prepare({ reconnectFailure = false } = {}) {\n', 'support route fixture options')
s = replace_once(
    s,
    """    revokeReconnectSessions: accountId => {
      reconnectRevocations.push(accountId);
      return accountId === 'support-player' ? 1 : 0;
    },
""",
    """    revokeReconnectSessions: accountId => {
      reconnectRevocations.push(accountId);
      if (reconnectFailure) throw new Error('injected reconnect cleanup failure');
      return accountId === 'support-player' ? 1 : 0;
    },
""",
    'support route injected reconnect failure'
)
s = replace_once(
    s,
    """  assert.equal(logoutAudit.detail.note, 'Игрок попросил завершить все входы');
  assert.equal(logoutAudit.detail.revokedSessions, 2);

  const moderator = await login(base, adminAuth, 'moderator');
""",
    """  assert.deepEqual(logoutAudit.detail, {
    note: 'Игрок попросил завершить все входы',
    revokedSessions: 2,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    complete: true,
    failedSteps: []
  });

  const moderator = await login(base, adminAuth, 'moderator');
""",
    'support logout success audit assertions'
)
append = """

test('support logout reports partial cleanup failures instead of claiming success', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare({
    reconnectFailure: true
  });
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const session = auth.createSession('support-player', 20_000);
  const ticket = auth.createSocketTicket('support-player', 20_100);
  assert.ok(session && ticket);
  const operator = await login(base, adminAuth, 'operator');

  const response = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Проверка частичного сбоя очистки'
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'support-logout-incomplete',
    accountId: 'support-player',
    revokedSessions: 1,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 0,
    disconnectedSockets: 2,
    failedSteps: ['reconnect-sessions']
  });

  assert.equal(auth.resolveSession(session.token, 20_200), null);
  assert.equal(auth.consumeSocketTicket(ticket.token, 20_200), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'later cleanup steps still run after an earlier local failure');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.deepEqual(audit.detail, {
    note: 'Проверка частичного сбоя очистки',
    revokedSessions: 1,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 0,
    disconnectedSockets: 2,
    complete: false,
    failedSteps: ['reconnect-sessions']
  });
});
"""
if "support logout reports partial cleanup failures instead of claiming success" in s:
    raise SystemExit('partial cleanup test already present')
s = s.rstrip() + append
write(p, s)
