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

  const lobbyReply = waitFor(first, 'lobby');
  first.send(JSON.stringify({ type: 'create', name: 'Bound', protocolVersion: 10 }));
  const lobby = await lobbyReply;
  const room = core.rooms.get(lobby.code);
  assert.ok(room);
  assert.equal([...room.players.values()][0].accountId, account.id);

  const replayReply = waitFor(second, 'error');
  second.send(JSON.stringify({ type: 'auth', ticket }));
  const replay = await replayReply;
  assert.equal(replay.code, 'AUTH_FAILED');
});
