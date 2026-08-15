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

patchFile('shared/protocol.js', [
  ['protocol version', 'export const PROTOCOL_VERSION = 10;', 'export const PROTOCOL_VERSION = 11;']
]);

patchFile('client/net/networkBindings.js', [
  [
    'grid comment',
    `    // каждый Player создавался ровно в \`spec.start\`, поэтому все участники начинали внутри друг\n    // друга. На время отсчёта даём локальному Course персональную стартовую точку; сразу после\n    // отсчёта возвращаем канонический start как точку респауна, чтобы клиент и сервер не расходились.\n`,
    `    // каждый Player создавался ровно в \`spec.start\`, поэтому все участники начинали внутри друг\n    // друга. Теперь checkpoint 0 авторитетно закреплён за тем же slot и на сервере, поэтому эта\n    // персональная точка остаётся стартом и точкой раннего респауна до первого checkpoint.\n`
  ],
  [
    'remove canonical respawn restore',
    `    await game.startRace(message.mode === GAME_MODE.COOP ? 'coop' : 'multi', spec, message.at, message.slots);\n    if (gridStart && game.player) {\n      game.player.spawn.set(message.spec.start.x, message.spec.start.y, message.spec.start.z);\n      if (game.course?.spec) game.course.spec.start = { ...message.spec.start };\n    }\n    if (message.resumed) game.restoreRun(message.resumed);\n`,
    `    await game.startRace(message.mode === GAME_MODE.COOP ? 'coop' : 'multi', spec, message.at, message.slots);\n    if (message.resumed) game.restoreRun(message.resumed);\n`
  ]
]);
