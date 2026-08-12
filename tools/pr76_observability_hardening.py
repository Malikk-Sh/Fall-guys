from pathlib import Path


def replace_once(path, old, new, label):
    file = Path(path)
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, got {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'server/index.js',
    """  if (!id) return false;
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
""",
    """  if (!id) return false;
  try {
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
  } catch {
    // Diagnostics are observability only. A SQLite/storage failure must never change gameplay,
    // authentication, moderation enforcement or the protocol response the player receives.
    return false;
  }
}
""",
    'diagnostics fail-safe boundary',
)

path = Path('server/socketAuthIntegration.test.mjs')
text = path.read_text(encoding='utf-8').rstrip()
marker = "incident storage failure does not change the gameplay protocol response"
if marker in text:
    raise SystemExit('observability failure regression already present')
text += """


test('incident storage failure does not change the gameplay protocol response', async t => {
  core.resetRateLimits();
  const auth = new AuthService({ db: core.accounts.db });
  networkIdentity.configure(ticket => auth.consumeSocketTicket(ticket));
  const account = core.accounts.create('Diagnostics Failure');
  const ticket = auth.createSocketTicket(account.id).token;

  await new Promise(resolve => core.server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${core.server.address().port}/ws`;
  const client = await openClient(url);
  const originalRecord = core.incidentDiagnostics.record;
  t.after(async () => {
    core.incidentDiagnostics.record = originalRecord;
    await closeClient(client);
    await new Promise(resolve => core.server.close(resolve));
    networkIdentity.reset();
  });

  const authReply = waitFor(client, 'authenticated');
  client.send(JSON.stringify({ type: 'auth', ticket }));
  await authReply;

  core.incidentDiagnostics.record = () => {
    throw new Error('injected diagnostics write failure');
  };

  const errorReply = waitFor(client, 'error');
  client.send(JSON.stringify({ type: 'join', code: 'ZZZZZZ', name: account.name, protocolVersion: 10 }));
  const response = await errorReply;
  assert.equal(response.code, 'ROOM_NOT_FOUND');
});
"""
path.write_text(text.rstrip() + '\n', encoding='utf-8')
