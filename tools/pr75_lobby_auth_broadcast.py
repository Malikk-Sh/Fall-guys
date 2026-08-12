from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    return text.replace(old, new, 1)


path = Path('server/index.js')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """  room.updatedAt = Date.now();
  return true;
}

function createCoopRoom(chapterId, hostId) {
""",
    """  room.updatedAt = Date.now();
  if (room.state === ROOM_STATE.LOBBY) emitLobby(room);
  return true;
}

function createCoopRoom(chapterId, hostId) {
""",
    'late auth lobby broadcast',
)
path.write_text(text, encoding='utf-8')

path = Path('server/socketAuthIntegration.test.mjs')
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  const authenticated = await authReply;
  assert.equal(authenticated.accountId, account.id);
  assert.equal(player.accountId, account.id);
  assert.equal(player.name, account.name);
  assert.equal(reconnectSession.accountId, account.id);
""",
    """  const authReply = waitFor(client, 'authenticated');
  const updatedLobbyReply = waitFor(client, 'lobby');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  const [authenticated, updatedLobby] = await Promise.all([authReply, updatedLobbyReply]);
  assert.equal(authenticated.accountId, account.id);
  assert.equal(player.accountId, account.id);
  assert.equal(player.name, account.name);
  assert.equal(reconnectSession.accountId, account.id);
  assert.equal(updatedLobby.players[0].name, account.name);
""",
    'late auth updated lobby regression',
)

append = """

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
"""
if 'late WebSocket AUTH does not emit room-state while a match is already playing' in text:
    raise SystemExit('playing late-auth broadcast regression already present')
text = text.rstrip() + append
path.write_text(text, encoding='utf-8')
