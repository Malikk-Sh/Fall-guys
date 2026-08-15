import fs from 'node:fs';

function patchFile(file, replacements) {
  let source = fs.readFileSync(file, 'utf8');
  for (const [name, before, after] of replacements) {
    const first = source.indexOf(before);
    if (first === -1) throw new Error(`${file} ${name}: source pattern not found`);
    if (source.indexOf(before, first + before.length) !== -1)
      throw new Error(`${file} ${name}: source pattern is not unique`);
    source = source.slice(0, first) + after + source.slice(first + before.length);
  }
  fs.writeFileSync(file, source);
}

patchFile('server/roomBots.js', [
  [
    'bot spawn follows grid',
    `    const start = raceSpawnFor(room.spec, player.slot, total);\n    entry.bot.player.teleport(new runtime.THREE.Vector3(start.x, start.y, start.z));\n`,
    `    const start = raceSpawnFor(room.spec, player.slot, total);\n    const position = new runtime.THREE.Vector3(start.x, start.y, start.z);\n    // Player.respawn() без авторитетной позиции возвращается в player.spawn. Один teleport менял\n    // только текущую физику, поэтому первый промах бота снова схлопывал его в общий центр.\n    entry.bot.player.spawn.copy(position);\n    entry.bot.player.teleport(position);\n`
  ]
]);

patchFile('server/index.js', [
  [
    'bot helper export import',
    `const { preloadBots, spawnBots, resetBots, stepBots, clearBots } = require('./roomBots');\nconst { raceSpawnFor } = require('../shared/raceGrid.js');\n`,
    `const {\n  preloadBots,\n  spawnBots,\n  resetBots,\n  stepBots,\n  clearBots,\n  placeBotsOnGrid\n} = require('./roomBots');\nconst { raceSpawnFor } = require('../shared/raceGrid.js');\nconst { assignRaceSlots } = require('./raceSlots');\n`
  ],
  [
    'match slot order',
    `  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;\n  // Слоты должны быть окончательными ДО сброса ботов: внутренняя модель бота и публичный snapshot\n  // обязаны получить одну и ту же клетку стартовой решётки уже во время отсчёта.\n  assignSlots(room);\n  // Боты бегут заново вместе со всеми. Комната после реванша та же, и модель бота — та же, поэтому\n  // без сброса он остался бы стоять на ленте с прошлого забега и «финишировал» бы на первом тике.\n  resetBots(room);\n  // matchId отсекает запоздавшие сообщения прошлого забега: снапшот с чужим matchId\n  // игнорируется вместо того, чтобы дёрнуть игрока в позицию из предыдущей гонки.\n  room.matchId = crypto.randomBytes(8).toString('hex');\n`,
    `  if (!setRoomState(room, ROOM_STATE.COUNTDOWN)) return false;\n  // matchId одновременно отсекает хвост прошлого забега и служит солью для перестановки race-slot'ов:\n  // ряды отличаются по Z, поэтому привязывать переднюю клетку к joinOrder было бы постоянной форой.\n  room.matchId = crypto.randomBytes(8).toString('hex');\n  // Сначала сбрасываем/при необходимости пересоздаём ботов. Смена сложности может пересобрать их\n  // записи целиком, поэтому окончательные slot'ы назначаются уже после resetBots.\n  resetBots(room);\n  if (room.mode === GAME_MODE.RACE) assignRaceSlots(room, room.matchId);\n  else assignSlots(room);\n  // Внутренняя физика ботов должна получить те же уже перемешанные клетки, что player.last и клиенты.\n  placeBotsOnGrid(room);\n`
  ]
]);

patchFile('server/roomBots.js', [
  [
    'export grid placer',
    `  resetBots,\n  stepBots,\n  clearBots,\n  isBot\n};\n`,
    `  resetBots,\n  stepBots,\n  clearBots,\n  placeBotsOnGrid,\n  isBot\n};\n`
  ]
]);

patchFile('package.json', [
  [
    'include second review regressions',
    `server/roomBots.test.mjs server/roomBotsSession.test.mjs server/raceGrid.test.mjs server/raceLobbyGridSession.test.mjs server/raceAchievements.test.mjs`,
    `server/roomBots.test.mjs server/roomBotsSession.test.mjs server/raceGrid.test.mjs server/raceSlots.test.mjs server/raceBotGridRespawn.test.mjs server/raceLobbyGridSession.test.mjs server/raceAchievements.test.mjs`
  ]
]);
