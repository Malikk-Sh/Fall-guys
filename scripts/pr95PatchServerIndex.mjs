import fs from 'node:fs';

const file = 'server/index.js';
let source = fs.readFileSync(file, 'utf8');

function replaceOnce(name, before, after) {
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`${name}: source pattern not found`);
  if (source.indexOf(before, first + before.length) !== -1) throw new Error(`${name}: source pattern is not unique`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}

replaceOnce(
  'race grid import',
  "const { preloadBots, spawnBots, resetBots, stepBots, clearBots } = require('./roomBots');\n",
  "const { preloadBots, spawnBots, resetBots, stepBots, clearBots } = require('./roomBots');\nconst { raceSpawnFor } = require('../shared/raceGrid.js');\n"
);

replaceOnce(
  'assign slots before bot reset',
  `  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;\n  // Боты бегут заново вместе со всеми. Комната после реванша та же, и модель бота — та же, поэтому\n  // без сброса он остался бы стоять на ленте с прошлого забега и «финишировал» бы на первом тике.\n  resetBots(room);\n`,
  `  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;\n  // Слоты должны быть окончательными ДО сброса ботов: внутренняя модель бота и публичный snapshot\n  // обязаны получить одну и ту же клетку стартовой решётки уже во время отсчёта.\n  assignSlots(room);\n  // Боты бегут заново вместе со всеми. Комната после реванша та же, и модель бота — та же, поэтому\n  // без сброса он остался бы стоять на ленте с прошлого забега и «финишировал» бы на первом тике.\n  resetBots(room);\n`
);

replaceOnce(
  'remove late slot assignment',
  `  if (room.mode === GAME_MODE.COOP) {\n    for (const item of room.players.values()) gameplay.count('chapter_started', dims(room, item));\n  }\n  assignSlots(room);\n\n  for (const item of room.players.values())\n    Object.assign(item, {\n`,
  `  if (room.mode === GAME_MODE.COOP) {\n    for (const item of room.players.values()) gameplay.count('chapter_started', dims(room, item));\n  }\n\n  for (const item of room.players.values()) {\n    const start =\n      room.mode === GAME_MODE.COOP\n        ? coopSpawnFor(room.spec, 0, item.slot)\n        : raceSpawnFor(room.spec, item.slot, room.players.size);\n    Object.assign(item, {\n`
);

replaceOnce(
  'authoritative grid start',
  `      checkpoint: 0,\n      last: {\n        ...(room.mode === GAME_MODE.COOP ? coopSpawnFor(room.spec, 0, item.slot) : room.spec.start),\n        ry: 0,\n`,
  `      checkpoint: 0,\n      // Для гонки сохраняем клетку отдельно: checkpoint 0 обязан возвращать игрока именно сюда,\n      // а не в старую общую центральную точку. В коопе старт и так вычисляется по slot каждый раз.\n      raceSpawn: room.mode === GAME_MODE.RACE ? { ...start } : null,\n      last: {\n        ...start,\n        ry: 0,\n`
);

replaceOnce(
  'close countdown player loop',
  `      ready: false,\n      resultChoice: null\n    });\n\n  log('info', 'match_started', { roomId: room.code, matchId: room.matchId, mode: room.mode });\n`,
  `      ready: false,\n      resultChoice: null\n    });\n  }\n\n  log('info', 'match_started', { roomId: room.code, matchId: room.matchId, mode: room.mode });\n`
);

replaceOnce(
  'slot-aware race respawn',
  `      const position = spawnFor(room.spec, player.checkpoint);\n      // Главный вопрос про падения — не «сколько», а «где». Место берётся по последнему\n`,
  `      const position =\n        player.checkpoint === 0 && player.raceSpawn\n          ? player.raceSpawn\n          : spawnFor(room.spec, player.checkpoint);\n      // Главный вопрос про падения — не «сколько», а «где». Место берётся по последнему\n`
);

replaceOnce(
  'full room bot removal',
  `      const free = MAX_PLAYERS[GAME_MODE.RACE] - room.players.size;\n      if (free <= 0) return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');\n      const added = addRoomBots(room, {\n        count: Math.min(message.count, free),\n        skill: message.skill || RACE_BOT_SKILLS\n      });\n      if (!added) return sendError(ws, ERROR_CODES.WRONG_STATE, 'Соперники сейчас недоступны.');\n      log('info', 'room_bots_added', { roomId: room.code, bots: added });\n`,
  `      const free = MAX_PLAYERS[GAME_MODE.RACE] - room.players.size;\n      // Удаление не требует свободного места — наоборот, именно в полной комнате кнопка «−»\n      // особенно нужна, чтобы освободить слот живому игроку.\n      if (message.count > 0 && free <= 0)\n        return sendError(ws, ERROR_CODES.ROOM_FULL, 'В комнате нет свободных мест.');\n      const changed = addRoomBots(room, {\n        count: message.count === 0 ? 0 : Math.min(message.count, free),\n        skill: message.skill || RACE_BOT_SKILLS\n      });\n      if (!changed)\n        return sendError(\n          ws,\n          ERROR_CODES.WRONG_STATE,\n          message.count === 0 ? 'В комнате нет ботов.' : 'Соперники сейчас недоступны.'\n        );\n      log('info', 'room_bots_changed', { roomId: room.code, delta: changed });\n`
);

fs.writeFileSync(file, source);
