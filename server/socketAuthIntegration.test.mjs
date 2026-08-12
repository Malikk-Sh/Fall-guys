import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const core = require('./index');
const { AuthService } = require('./auth');
const { networkIdentity } = require('./networkIdentity');

const waitFor = (ws, type, timeout = 5_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', listener);
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeout);
    const listener = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.off('message', listener);
      resolve(message);
    };
    ws.on('message', listener);
  });

const openClient = url =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const closeClient = ws =>
  new Promise(resolve => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(() => {
      ws.terminate();
      resolve();
    }, 500);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.close();
  });

test('real WebSocket AUTH consumes WST and room messages no longer carry credentials', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Socket Integration');
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const first = await openClient(url);
  const second = await openClient(url);
  t.after(async () => {
    await Promise.all([closeClient(first), closeClient(second)]);
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const authReply = waitFor(first, 'authenticated');
  first.send(JSON.stringify({ type: 'auth', ticket }));
  const authenticated = await authReply;
  assert.equal(authenticated.accountId, account.id);

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

  const replayReply = waitFor(second, 'error');
  second.send(JSON.stringify({ type: 'auth', ticket }));
  const replay = await replayReply;
  assert.equal(replay.code, 'AUTH_FAILED');
});

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
  const updatedLobbyReply = waitFor(client, 'lobby');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  const [authenticated, updatedLobby] = await Promise.all([authReply, updatedLobbyReply]);
  assert.equal(authenticated.accountId, account.id);
  assert.equal(player.accountId, account.id);
  assert.equal(player.name, account.name);
  assert.equal(reconnectSession.accountId, account.id);
  assert.equal(updatedLobby.players[0].name, account.name);

  // Defense in depth: even if the copied room/session identity regresses, the live authenticated
  // socket is sufficient to identify and revoke its reconnect token.
  player.accountId = null;
  reconnectSession.accountId = null;
  assert.equal(player.ws.accountId, account.id);
  assert.equal(core.revokeAccountReconnectSessions(account.id), 1);
  assert.equal(core.sessions.has(reconnectToken), false);
});

test('late WebSocket AUTH does not emit room-state while a match is already playing', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Playing Bound');
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
  client.send(JSON.stringify({ type: 'create', name: 'Before Auth', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  room.state = 'playing';

  let unexpectedRoomState = 0;
  const listener = raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'lobby') unexpectedRoomState += 1;
  };
  client.on('message', listener);

  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  const authenticated = await authReply;
  assert.equal(authenticated.accountId, account.id);
  await new Promise(resolve => setTimeout(resolve, 75));
  client.off('message', listener);
  assert.equal(unexpectedRoomState, 0);
});
