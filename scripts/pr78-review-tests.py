from pathlib import Path


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}: {old[:140]!r}")
    path.write_text(text.replace(old, new, 1))


routes_test = Path("server/controlPlaneRoutes.test.mjs")
replace_once(routes_test, "      health: async () => null,\n", "      status: async () => null,\n")
replace_once(routes_test, "      health: async () => ({ ok: true }),\n", "      status: async () => ({ reachable: true, ready: true, ok: true }),\n")

client_test = Path("server/controlPlaneGameClient.test.mjs")
client_test.write_text(
    client_test.read_text()
    + '''

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
'''
)

reader_test = Path("server/serviceReliabilityReader.test.mjs")
replace_once(
    reader_test,
    "const { ServiceReliabilityReader } = require('./serviceReliabilityReader');",
    "const { ServiceReliabilityReader, createServiceReliabilityReader } = require('./serviceReliabilityReader');",
)
reader_test.write_text(
    reader_test.read_text()
    + '''

test('safe reliability reader factory degrades when reliability schema is unavailable', () => {
  const db = database();
  try {
    db.exec('DROP TABLE service_reliability_events; DROP TABLE service_reliability_samples;');
    assert.equal(createServiceReliabilityReader({ db }), null);
    assert.doesNotThrow(() => db.prepare('SELECT COUNT(*) AS count FROM admin_users').get());
  } finally {
    db.close();
  }
});
'''
)
