'use strict';

const fs = require('node:fs');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function write(file, content) {
  fs.writeFileSync(file, content);
}

function replaceOnce(file, from, to) {
  const source = read(file);
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`anchor not found in ${file}: ${from.slice(0, 100)}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`anchor is not unique in ${file}`);
  write(file, source.slice(0, first) + to + source.slice(first + from.length));
}

replaceOnce(
  'server/index.js',
  "const { backupHealthStatus } = require('./backupStatus');",
  "const { backupHealthStatus } = require('./backupStatus');\nconst { buildIdentity } = require('./buildInfo');\nconst { trackSignatureMetrics } = require('./signatureMetrics');"
);

replaceOnce(
  'server/index.js',
  "  'roomCreated',\n  'roomJoined',\n  'matchStarted',",
  "  'roomCreated',\n  'roomJoined',\n  'matchmakingStarted',\n  'matchmakingMatched',\n  'matchStarted',"
);

replaceOnce(
  'server/index.js',
  'const productEvents = createEventCounters();',
  'const productEvents = createEventCounters();\nconst build = buildIdentity();'
);

replaceOnce(
  'server/index.js',
  'const coopMatchmaking = [];\nconst ROOM_TTL = 45 * 60 * 1000;',
  `const coopMatchmaking = [];

function matchmakingStatus({ queue = coopMatchmaking, counters = productEvents, now = Date.now() } = {}) {
  let oldestQueuedAt = Infinity;
  for (const item of queue) {
    if (Number.isFinite(item?.queuedAt)) oldestQueuedAt = Math.min(oldestQueuedAt, item.queuedAt);
  }
  return {
    waiting: queue.length,
    oldestWaitMs: Number.isFinite(oldestQueuedAt) ? Math.max(0, now - oldestQueuedAt) : 0,
    matchedSinceStart: Number(counters.matchmakingMatched || 0)
  };
}

const ROOM_TTL = 45 * 60 * 1000;`
);

replaceOnce(
  'server/index.js',
  "  version: '2.2.0',\n  protocolVersion: PROTOCOL_VERSION,",
  '  version: build.version,\n  commit: build.commit,\n  protocolVersion: PROTOCOL_VERSION,\n  startedAt: build.startedAt,'
);

replaceOnce(
  'server/index.js',
  '  events: productEvents,\n  uptime: Math.round(process.uptime()),',
  '  events: productEvents,\n  matchmaking: matchmakingStatus(),\n  uptime: Math.round(process.uptime()),'
);

replaceOnce(
  'server/index.js',
  `      if (!result.ok) return;
      if (result.relay) {`,
  `      if (!result.ok) return;
      trackSignatureMetrics({ room, player, message, result, gameplay, dimensions: dims });
      if (result.relay) {`
);

replaceOnce(
  'server/index.js',
  "  server.listen(port, host, () => log('info', 'server_started', { port, host }));",
  "  server.listen(port, host, () =>\n    log('info', 'server_started', { port, host, version: build.version, commit: build.commit })\n  );"
);

replaceOnce(
  'server/index.js',
  '  loadStatus,\n  rotateEventLoopWindow,',
  '  loadStatus,\n  health,\n  matchmakingStatus,\n  rotateEventLoopWindow,'
);

replaceOnce(
  'server/test.js',
  '  createEventCounters,\n  trackEvent\n} = require(\'./index\');',
  '  createEventCounters,\n  trackEvent,\n  matchmakingStatus\n} = require(\'./index\');'
);

write(
  'server/test.js',
  read('server/test.js') +
    `\n\ntest('оперативный matchmaking status показывает очередь и число найденных пар', () => {\n` +
    `  const events = createEventCounters();\n` +
    `  assert.equal(Object.hasOwn(events, 'matchmakingStarted'), true);\n` +
    `  assert.equal(Object.hasOwn(events, 'matchmakingMatched'), true);\n` +
    `  events.matchmakingMatched = 7;\n` +
    `  assert.deepEqual(\n` +
    `    matchmakingStatus({ queue: [{ queuedAt: 1000 }, { queuedAt: 1500 }], counters: events, now: 2500 }),\n` +
    `    { waiting: 2, oldestWaitMs: 1500, matchedSinceStart: 7 }\n` +
    `  );\n` +
    `  assert.deepEqual(matchmakingStatus({ queue: [], counters: events, now: 2500 }), {\n` +
    `    waiting: 0, oldestWaitMs: 0, matchedSinceStart: 7\n` +
    `  });\n` +
    `});\n`
);

const pkg = JSON.parse(read('package.json'));
pkg.version = '2.3.0';
if (!pkg.scripts.test.includes('server/observability.test.mjs')) {
  pkg.scripts.test = pkg.scripts.test.replace(
    'server/pwa.test.mjs',
    'server/pwa.test.mjs server/observability.test.mjs'
  );
}
pkg.scripts['load:observe'] = 'node server/loadObserver.mjs';
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lock = JSON.parse(read('package-lock.json'));
lock.version = '2.3.0';
lock.packages[''].version = '2.3.0';
write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

replaceOnce(
  'deploy/install.sh',
  'say "Служба и резервные копии"',
  `# Build identity is generated from the exact checked-out commit. It is not a secret and is
# intentionally refreshed on every deploy, unlike hand-edited production settings.
build_sha="$(git -C "$APP_DIR" rev-parse HEAD)"
if grep -q '^WOBBLE_BUILD_SHA=' /etc/wobble.env; then
  sed -i "s/^WOBBLE_BUILD_SHA=.*/WOBBLE_BUILD_SHA=\${build_sha}/" /etc/wobble.env
else
  printf '\\n# Generated by deploy/install.sh for exact build identity.\\nWOBBLE_BUILD_SHA=%s\\n' "$build_sha" >>/etc/wobble.env
fi

say "Служба и резервные копии"`
);
