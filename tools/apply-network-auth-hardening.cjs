'use strict';

const fs = require('fs');

const path = 'server/index.js';
let source = fs.readFileSync(path, 'utf8');
let changed = false;

function replaceOnce(before, after, label) {
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Patch anchor missing: ${label}`);
  source = source.replace(before, after);
  changed = true;
}

function replaceAll(before, after, expected, label) {
  if (!source.includes(before)) {
    const countAfter = source.split(after).length - 1;
    if (countAfter >= expected) return;
    throw new Error(`Patch anchor missing: ${label}`);
  }
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} anchors for ${label}, found ${count}`);
  source = source.split(before).join(after);
  changed = true;
}

replaceOnce(
  "const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');",
  "const { GameplayMetrics, deviceFromUserAgent } = require('./metrics');\nconst { BoundedIpRateLimiter } = require('./ipRateLimiter');\nconst { networkIdentity } = require('./networkIdentity');",
  'imports'
);

replaceOnce(
  `const HTTP_WINDOW_MS = 10 * 60 * 1000;\nconst httpLimits = { create: [20, new Map()], login: [40, new Map()], record: [200, new Map()] };\n\nfunction httpRateLimited(kind, ip) {\n  if (!ip) return false;\n  const [max, hits] = httpLimits[kind];\n  const now = Date.now();\n  const entry = hits.get(ip);\n  if (!entry || now - entry.start > HTTP_WINDOW_MS) {\n    hits.set(ip, { start: now, count: 1 });\n    return false;\n  }\n  entry.count++;\n  return entry.count > max;\n}`,
  `const HTTP_WINDOW_MS = 10 * 60 * 1000;\nconst httpLimits = {\n  create: [20, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })],\n  login: [40, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })],\n  record: [200, new BoundedIpRateLimiter({ windowMs: HTTP_WINDOW_MS })]\n};\n\nfunction httpRateLimited(kind, ip) {\n  if (!ip) return false;\n  const [max, limiter] = httpLimits[kind];\n  return limiter.limited(ip, max);\n}`,
  'legacy HTTP rate limiter'
);

replaceOnce(
  `const IP_WINDOW_MS = 60 * 1000;\nconst IP_MAX_ROOM_OPS = 40;\nconst MAX_CONNECTIONS_PER_IP = 24;\nconst ipRoomOps = new Map();\nconst ipConnections = new Map();\n\nfunction ipRateLimited(ip) {\n  if (!ip) return false;\n  const now = Date.now();\n  const entry = ipRoomOps.get(ip);\n  if (!entry || now - entry.start > IP_WINDOW_MS) {\n    ipRoomOps.set(ip, { start: now, count: 1 });\n    return false;\n  }\n  entry.count++;\n  return entry.count > IP_MAX_ROOM_OPS;\n}`,
  `const IP_WINDOW_MS = 60 * 1000;\nconst IP_MAX_ROOM_OPS = 40;\nconst MAX_CONNECTIONS_PER_IP = 24;\nconst ipRoomOps = new BoundedIpRateLimiter({ windowMs: IP_WINDOW_MS });\nconst ipConnections = new Map();\n\nfunction ipRateLimited(ip) {\n  return ipRoomOps.limited(ip, IP_MAX_ROOM_OPS);\n}`,
  'room operation rate limiter'
);

replaceOnce(
  `function addPlayer(room, ws, name, playerId = null, accountToken = null) {\n  ws.room = room.code;\n  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];\n  const authenticated = accountToken ? accounts.login(accountToken) : null;`,
  `function addPlayer(room, ws, name, playerId = null) {\n  ws.room = room.code;\n  const color = PLAYER_COLORS[room.players.size % PLAYER_COLORS.length];\n  const authenticated = networkIdentity.accountForSocket(ws, accounts);`,
  'addPlayer identity source'
);

replaceOnce(
  `    // Серверный прогресс никогда не доверяет присланному playerId: только проверенному коду.\n    accountId: authenticated?.id || null,`,
  `    // Серверный прогресс никогда не доверяет присланному playerId: только identity,\n    // которая была подтверждена один раз и привязана к этому WebSocket.\n    accountId: authenticated?.id || null,`,
  'player account comment'
);

replaceOnce(
  `      name: message.name,\n      playerId: message.playerId,\n      accountToken: message.accountToken,\n      chapterId: requested,`,
  `      name: message.name,\n      playerId: message.playerId,\n      chapterId: requested,`,
  'matchmaking queue credential'
);

replaceOnce(
  `  addPlayer(room, partner.ws, partner.name, partner.playerId, partner.accountToken);\n  addPlayer(room, ws, message.name, message.playerId, message.accountToken);`,
  `  addPlayer(room, partner.ws, partner.name, partner.playerId);\n  addPlayer(room, ws, message.name, message.playerId);`,
  'matchmaking addPlayer credentials'
);

replaceOnce(
  `  const player = room.players.get(session.playerId);\n  if (!player) {\n    sessions.delete(token);\n    return false;\n  }\n\n  // Занимаем прежнее место: идентификатор игрока сохраняется, поэтому напарник не увидит,`,
  `  const player = room.players.get(session.playerId);\n  if (!player) {\n    sessions.delete(token);\n    return false;\n  }\n\n  // Resume token уже принадлежит конкретному серверному player. Обычный reconnect наследует\n  // accountId этого player; заранее привязанный другой account занять его место не может.\n  if (!networkIdentity.bindResumedPlayer(ws, player)) return false;\n\n  // Занимаем прежнее место: идентификатор игрока сохраняется, поэтому напарник не увидит,`,
  'resume account binding'
);

replaceOnce(
  `  ws.token = crypto.randomBytes(16).toString('hex');\n  ws.ip = ip;\n  ws.isAlive = true;`,
  `  ws.token = crypto.randomBytes(16).toString('hex');\n  ws.ip = ip;\n  ws.accountId = null;\n  ws.isAlive = true;`,
  'socket account state'
);

replaceOnce(
  `    // Отметка времени сервера в каждом pong — по ней клиент оценивает расхождение часов.\n    if (message.type === C2S.PING) {\n      return send(ws, { type: S2C.PONG, at: message.at, serverTime: Date.now() });\n    }\n    if (message.type === C2S.LEAVE_ROOM) return leave(ws);`,
  `    // Отметка времени сервера в каждом pong — по ней клиент оценивает расхождение часов.\n    if (message.type === C2S.PING) {\n      return send(ws, { type: S2C.PONG, at: message.at, serverTime: Date.now() });\n    }\n\n    if (message.type === C2S.AUTH) {\n      const authenticated = networkIdentity.authenticate(ws, message.ticket);\n      if (!authenticated.ok) {\n        const code =\n          authenticated.reason === 'already-bound'\n            ? ERROR_CODES.AUTH_ALREADY_BOUND\n            : authenticated.reason === 'unavailable'\n              ? ERROR_CODES.AUTH_UNAVAILABLE\n              : ERROR_CODES.AUTH_FAILED;\n        const detail =\n          authenticated.reason === 'already-bound'\n            ? 'Аккаунт уже привязан к этому соединению.'\n            : authenticated.reason === 'unavailable'\n              ? 'Сетевая авторизация временно недоступна.'\n              : 'WebSocket ticket недействителен, истёк или уже использован.';\n        return sendError(ws, code, detail, false);\n      }\n      return send(ws, { type: S2C.AUTHENTICATED, accountId: authenticated.accountId });\n    }\n\n    if (message.type === C2S.LEAVE_ROOM) return leave(ws);`,
  'AUTH handler'
);

replaceOnce(
  `      if (message.protocolVersion !== undefined && message.protocolVersion !== PROTOCOL_VERSION) {\n        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);\n      }`,
  `      if (\n        message.protocolVersion !== undefined &&\n        message.protocolVersion !== PROTOCOL_VERSION &&\n        message.protocolVersion !== PROTOCOL_VERSION - 1\n      ) {\n        return sendError(ws, ERROR_CODES.VERSION_MISMATCH, 'Версия игры устарела. Обновите страницу.', false);\n      }`,
  'one-version request compatibility'
);

replaceAll(
  `return addPlayer(room, ws, message.name, message.playerId, message.accountToken);`,
  `return addPlayer(room, ws, message.name, message.playerId);`,
  2,
  'create/join credentials'
);

replaceOnce(
  `function resetRateLimits() {\n  ipRoomOps.clear();\n  ipConnections.clear();\n}`,
  `function resetRateLimits() {\n  ipRoomOps.clear();\n  ipConnections.clear();\n  for (const [, limiter] of Object.values(httpLimits)) limiter.clear();\n}`,
  'test rate-limit reset'
);

if (changed) fs.writeFileSync(path, source);
console.log(changed ? 'server/index.js patched' : 'server/index.js already patched');
