'use strict';

const fs = require('node:fs');

function replaceOnce(file, from, to) {
  const source = fs.readFileSync(file, 'utf8');
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`anchor not found in ${file}: ${from.slice(0, 120)}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`anchor is not unique in ${file}`);
  fs.writeFileSync(file, source.slice(0, first) + to + source.slice(first + from.length));
}

replaceOnce('server/coopMovementAudit.js', 'const WINDOW_MIN_SAMPLES = 18;', 'const WINDOW_MIN_SAMPLES = 2;');

replaceOnce(
  'server/coopMovementAudit.js',
  `  const maxLength = Number(tether.maxLength) || 11;
  return distance(state, partner.last) >= maxLength - 1.5;`,
  `  const maxLength = Number(tether.maxLength) || 11;
  const length = distance(state, partner.last);
  // Трос даёт исключение только рядом с собственной предельной длиной. Условие «всё, что дальше
  // maxLength» превращало бы оторвавшегося на полкарты читера в вечный tether-exception.
  return length >= maxLength - 1.5 && length <= maxLength + 4;`
);

replaceOnce(
  'server/coopMovementAudit.js',
  `    history.push({ at: now, x: state.x, z: state.z, speed: observed });
    while (history.length > HISTORY_LIMIT) history.shift();
    while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();
    if (history.length >= WINDOW_MIN_SAMPLES && now - history[0].at >= WINDOW_MS * 0.72) {
      const average = history.reduce((sum, item) => sum + item.speed, 0) / history.length;
      if (average > MAX_SUSTAINED_SPEED) note(player, 'coop-sustained-speed', findings);
    }`,
  `    history.push({ at: now, x: state.x, z: state.z });
    while (history.length > HISTORY_LIMIT) history.shift();
    while (history.length > 1 && now - history[0].at > WINDOW_MS) history.shift();
    if (history.length >= WINDOW_MIN_SAMPLES && now - history[0].at >= WINDOW_MS * 0.72) {
      const first = history[0];
      const last = history.at(-1);
      const elapsed = Math.max(0.001, (last.at - first.at) / 1000);
      // Net displacement, а не среднее по пакетам: так проверка не зависит от того, шлёт
      // модифицированный клиент 15 state/s или намеренно опускается до 2–4 state/s. Боковое
      // движение moving platform/fan учитывается, но их реальные скорости далеко ниже порога.
      const sustained = Math.hypot(last.x - first.x, last.z - first.z) / elapsed;
      if (sustained > MAX_SUSTAINED_SPEED) note(player, 'coop-sustained-speed', findings);
    }`
);

replaceOnce(
  'server/coopMovementAudit.test.mjs',
  `  const { findings } = feed(room, player, bounceStates(piece, 18, 75));
  assert.equal(findings.has('coop-reported-speed'), false, '18 оставлено ниже шумного мгновенного потолка');
  assert.equal(findings.has('coop-observed-speed'), false, '18 оставлено ниже шумного observed потолка');
  assert.equal(findings.has('coop-sustained-speed'), true, 'средняя скорость обязана поймать систематику');`,
  `  const fastStates = Array.from({ length: 75 }, (_, index) =>
    stateAt({
      z: piece.z + 3 - ((index + 1) * 18 * SEND_MS) / 1000,
      vz: -18
    })
  );
  const { findings } = feed(room, player, fastStates);
  assert.equal(findings.has('coop-reported-speed'), false, '18 оставлено ниже шумного мгновенного потолка');
  assert.equal(findings.has('coop-observed-speed'), false, '18 оставлено ниже шумного observed потолка');
  assert.equal(findings.has('coop-sustained-speed'), true, 'быстрое продвижение обязано пойматься окном');`
);

fs.appendFileSync(
  'server/coopMovementAudit.test.mjs',
  `\n\ntest('редкие state-пакеты не позволяют обойти sustained-speed audit', () => {\n` +
    `  const room = roomFor('ch1');\n` +
    `  const piece = firstLongFloor('ch1');\n` +
    `  const player = playerAt(stateAt({ z: piece.z + 5, vz: -8 }));\n` +
    `  room.players.set(player.id, player);\n` +
    `  const findings = new Set();\n` +
    `  let z = piece.z + 5;\n` +
    `  let now = START_MS;\n` +
    `  for (let index = 0; index < 10; index++) {\n` +
    `    now += 500; // всего 2 пакета/с — намеренно ниже обычных ~15/s\n` +
    `    z -= 10; // 20 ед/с при заявленных безопасных vx/vz\n` +
    `    const state = stateAt({ z, vz: -8 });\n` +
    `    for (const reason of auditCoopMovement(room, player, state, now)) findings.add(reason);\n` +
    `    player.last = { ...state };\n` +
    `    player.lastAt = now;\n` +
    `  }\n` +
    `  assert.equal(findings.has('coop-sustained-speed'), true);\n` +
    `});\n\n` +
    `test('tether exception не действует далеко за физической длиной троса', () => {\n` +
    `  const room = roomFor('ch10');\n` +
    `  const piece = firstLongFloor('ch10');\n` +
    `  const player = playerAt(stateAt({ x: -5, z: piece.z }));\n` +
    `  const partner = { id: 'p2', last: stateAt({ x: 5, z: piece.z }), disconnectedAt: null };\n` +
    `  room.players.set(player.id, player);\n` +
    `  room.players.set(partner.id, partner);\n` +
    `  assert.equal(tetherActive(room, player, stateAt({ x: -5, z: piece.z })), true);\n` +
    `  assert.equal(\n` +
    `    tetherActive(room, player, stateAt({ x: -30, z: piece.z })),\n` +
    `    false,\n` +
    `    'игрок далеко за maxLength не получает бесконечное исключение'\n` +
    `  );\n` +
    `});\n`
);
