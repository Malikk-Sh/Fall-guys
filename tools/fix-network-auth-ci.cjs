'use strict';

const fs = require('fs');

function patch(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return false;
  if (!source.includes(before)) throw new Error(`Missing patch anchor: ${label}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
  return true;
}

const changed = [];

if (
  patch(
    'server/index.js',
    "  for (const [ip, entry] of ipRoomOps) if (now - entry.start > IP_WINDOW_MS) ipRoomOps.delete(ip);",
    "  ipRoomOps.cleanup(now, { force: true });\n  for (const [, limiter] of Object.values(httpLimits)) limiter.cleanup(now, { force: true });",
    'heartbeat bounded limiter cleanup'
  )
)
  changed.push('server/index.js');

if (
  patch(
    'server/integration.test.js',
    `  await Promise.all([host.wait('hello'), guest.wait('hello')]);\n  const hostAccount = accounts.create('Аня');\n  const guestAccount = accounts.create('Боря');\n  host.send('create', {\n    name: 'Аня',\n    playerId: 'подменённый-id',\n    accountToken: hostAccount.secret,\n    mode: 'coop'\n  });\n  const created = await host.wait('lobby', m => m.players.length === 1);\n  guest.send('join', {\n    name: 'Боря',\n    playerId: 'ещё-один-подменённый-id',\n    accountToken: guestAccount.secret,\n    code: created.code\n  });`,
    `  await Promise.all([host.wait('hello'), guest.wait('hello')]);\n  const hostAccount = accounts.create('Аня');\n  const guestAccount = accounts.create('Боря');\n\n  // Auth V2 больше не принимает recovery credential внутри room-команд. Этот integration test\n  // повторяет настоящий production boundary: HttpOnly session выдаёт короткий WST, сокет один раз\n  // поглощает его, а CREATE/JOIN после этого вообще ничего не знают об account credential.\n  const { AuthService } = require('./auth');\n  const { networkIdentity } = require('./networkIdentity');\n  const socketAuth = new AuthService({ db: accounts.db });\n  networkIdentity.configure(ticket => socketAuth.consumeSocketTicket(ticket));\n  t.after(() => networkIdentity.reset());\n\n  host.send('auth', { ticket: socketAuth.createSocketTicket(hostAccount.id).token });\n  guest.send('auth', { ticket: socketAuth.createSocketTicket(guestAccount.id).token });\n  await Promise.all([host.wait('authenticated'), guest.wait('authenticated')]);\n\n  host.send('create', {\n    name: 'Аня',\n    playerId: 'подменённый-id',\n    mode: 'coop'\n  });\n  const created = await host.wait('lobby', m => m.players.length === 1);\n  guest.send('join', {\n    name: 'Боря',\n    playerId: 'ещё-один-подменённый-id',\n    code: created.code\n  });`,
    'coop account integration uses socket auth'
  )
)
  changed.push('server/integration.test.js');

console.log(changed.length ? `patched: ${changed.join(', ')}` : 'already patched');
