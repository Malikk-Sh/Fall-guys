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


# 1) Late WebSocket AUTH must become part of the durable room/reconnect identity,
# and authenticated room joins must resolve the canonical server-side account name.
p = 'server/index.js'
s = read(p)
s = replace_once(
    s,
    """    if (session?.accountId !== id && player?.accountId !== id) continue;
""",
    """    if (
      session?.accountId !== id &&
      player?.accountId !== id &&
      player?.ws?.accountId !== id
    )
      continue;
""",
    'reconnect revocation live socket identity'
)
s = replace_once(
    s,
    """  const authenticated = networkIdentity.accountForSocket(ws, accounts);
  room.players.set(ws.id, {
    id: ws.id,
    name: safeName(name),
""",
    """  const authenticated = networkIdentity.accountForSocket(ws, accounts);
  const playerName = authenticated?.name ? safeName(authenticated.name) : safeName(name);
  room.players.set(ws.id, {
    id: ws.id,
    name: playerName,
""",
    'canonical authenticated room name'
)
anchor = """  room.updatedAt = Date.now();
  assignSlots(room);
  emitLobby(room);
}

function createCoopRoom(chapterId, hostId) {
"""
replacement = """  room.updatedAt = Date.now();
  assignSlots(room);
  emitLobby(room);
}

function bindAuthenticatedSocketToRoom(ws, accountId) {
  const id = String(accountId || '');
  if (!id || !ws?.room) return false;
  const room = rooms.get(ws.room);
  const player = room?.players.get(ws.id);
  if (!player || player.ws !== ws) return false;
  const account = networkIdentity.accountForSocket(ws, accounts);
  if (!account || account.id !== id) return false;

  player.accountId = id;
  player.anonymousId = id;
  player.name = safeName(account.name);
  player.loadout = socialCosmetics.forAccount(id);

  const session = sessions.get(ws.token);
  if (session && session.playerId === ws.id && session.roomCode === room.code) {
    session.accountId = id;
  }
  room.updatedAt = Date.now();
  emitLobby(room);
  return true;
}

function createCoopRoom(chapterId, hostId) {
"""
s = replace_once(s, anchor, replacement, 'late auth room binding helper')
s = replace_once(
    s,
    """      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });
""",
    """      bindAuthenticatedSocketToRoom(ws, authenticated.accountId);
      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });
""",
    'late auth handler sync'
)
write(p, s)

# 2) Force logout must continue every independent cleanup step even if durable HTTP-session
# revocation fails. The response remains fail-closed and audit records partial completion.
p = 'server/adminControl.js'
s = read(p)
old = """    this.db.exec('BEGIN IMMEDIATE');
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
"""
new = """    try {
      revokedSessions = Number(this.auth.revokeAccountSessions(id) || 0);
    } catch {
      failedSteps.push('http-sessions');
    }
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

    const auditedFailedSteps = [...failedSteps];
    try {
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
          complete: auditedFailedSteps.length === 0,
          failedSteps: auditedFailedSteps
        },
        now
      });
    } catch {
      failedSteps.push('audit');
    }

    const result = {
"""
s = replace_once(s, old, new, 'continue logout cleanup after durable failure')
write(p, s)

# 3) Regression tests for canonical names, late AUTH identity and durable cleanup failure.
p = 'server/socketAuthIntegration.test.mjs'
s = read(p)
s = replace_once(
    s,
    """  assert.equal(authenticated.accountId, account.id);

  const lobbyReply = waitFor(first, 'lobby');
  first.send(JSON.stringify({ type: 'create', name: 'Bound', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  assert.equal([...room.players.values()][0].accountId, account.id);
""",
    """  assert.equal(authenticated.accountId, account.id);

  // Simulate a support rename while this browser still has its old cached profile name.
  core.accounts.rename(account.id, 'Support Renamed');
  const lobbyReply = waitFor(first, 'lobby');
  first.send(JSON.stringify({ type: 'create', name: 'Socket Integration', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  const boundPlayer = [...room.players.values()][0];
  assert.equal(boundPlayer.accountId, account.id);
  assert.equal(boundPlayer.name, 'Support Renamed');
""",
    'canonical name integration assertion'
)
append = """

test('late WebSocket AUTH synchronizes room identity and reconnect revocation', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Late Bound');
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const client = await openClient(url);
  t.after(async () => {
    await closeClient(client);
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const lobbyReply = waitFor(client, 'lobby');
  client.send(JSON.stringify({ type: 'create', name: 'Anonymous Old', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  const player = [...room.players.values()][0];
  const reconnectToken = player.ws.token;
  const reconnectSession = core.sessions.get(reconnectToken);
  assert.ok(reconnectSession);
  assert.equal(player.accountId, null);
  assert.equal(reconnectSession.accountId, null);

  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  const authenticated = await authReply;
  assert.equal(authenticated.accountId, account.id);
  assert.equal(player.accountId, account.id);
  assert.equal(player.name, account.name);
  assert.equal(reconnectSession.accountId, account.id);

  // Defense in depth: even if the copied room/session identity regresses, the live authenticated
  // socket is sufficient to identify and revoke its reconnect token.
  player.accountId = null;
  reconnectSession.accountId = null;
  assert.equal(player.ws.accountId, account.id);
  assert.equal(core.revokeAccountReconnectSessions(account.id), 1);
  assert.equal(core.sessions.has(reconnectToken), false);
});
"""
if 'late WebSocket AUTH synchronizes room identity and reconnect revocation' in s:
    raise SystemExit('late auth regression test already present')
s = s.rstrip() + append
write(p, s)

p = 'server/adminPlayerSupportRoutes.test.mjs'
s = read(p)
append = """

test('support logout continues local cleanup when HTTP session revocation fails', async t => {
  const { db, adminAuth, app, auth, disconnected, reconnectRevocations } = prepare();
  const { server, base } = await start(app);
  t.after(() => {
    server.close();
    db.close();
  });

  const session = auth.createSession('support-player', 30_000);
  const ticket = auth.createSocketTicket('support-player', 30_100);
  assert.ok(session && ticket);
  auth.revokeAccountSessions = () => {
    throw new Error('injected durable session failure');
  };
  const operator = await login(base, adminAuth, 'operator');

  const response = await post(base, '/api/admin/players/logout', operator, {
    accountId: 'support-player',
    note: 'Проверка отказа хранилища сессий'
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: 'support-logout-incomplete',
    accountId: 'support-player',
    revokedSessions: 0,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    failedSteps: ['http-sessions']
  });

  assert.ok(auth.resolveSession(session.token, 30_200), 'failed durable path is reported, not hidden');
  assert.equal(auth.consumeSocketTicket(ticket.token, 30_200), null);
  assert.deepEqual(reconnectRevocations, ['support-player']);
  assert.equal(disconnected.length, 1, 'all process-local cleanup still runs');

  const audit = adminAuth.recentAudit(20).find(event => event.action === 'player.support.logout');
  assert.deepEqual(audit.detail, {
    note: 'Проверка отказа хранилища сессий',
    revokedSessions: 0,
    revokedSocketTickets: 1,
    revokedReconnectSessions: 1,
    disconnectedSockets: 2,
    complete: false,
    failedSteps: ['http-sessions']
  });
});
"""
if 'support logout continues local cleanup when HTTP session revocation fails' in s:
    raise SystemExit('durable logout failure regression test already present')
s = s.rstrip() + append
write(p, s)
