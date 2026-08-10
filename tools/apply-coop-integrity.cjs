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
  if (first < 0) throw new Error(`anchor not found in ${file}: ${from.slice(0, 120)}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`anchor is not unique in ${file}`);
  write(file, source.slice(0, first) + to + source.slice(first + from.length));
}

// Co-op audit: final segment/finish region belongs to the same integrity boundary as checkpoints.
replaceOnce(
  'server/coopMovementAudit.js',
  '\nmodule.exports = {',
  `
function minimumFinishMs(spec) {
  if (!spec?.chapterId) return 0;
  const fromZ = spec.checkpoints.at(-1) ?? spec.start.z;
  const distanceToFinish = Math.abs(fromZ - spec.finishZ);
  const maxForwardSpeed = spec.mechanics?.tether ? 22 : 15.5;
  return Math.max(350, Math.round((distanceToFinish / maxForwardSpeed) * 1000));
}

function verifyCoopFinish(player, spec, state, now = Date.now()) {
  if (!spec?.chapterId || !state) return null;
  if (Math.abs(state.x) > LANE_WIDTH / 2 + 1.5 || state.y < -2 || state.y > 10) {
    return {
      reason: 'coop-finish-region',
      x: Math.round(state.x * 100) / 100,
      y: Math.round(state.y * 100) / 100
    };
  }
  const previousAt = player.coopLastCheckpointAt || player.matchStartedAt || now;
  const elapsed = now - previousAt;
  const minimum = minimumFinishMs(spec);
  if (elapsed < minimum) return { reason: 'coop-finish-too-fast', elapsed, minimum };
  return null;
}

module.exports = {`
);
replaceOnce(
  'server/coopMovementAudit.js',
  '  verifyCoopCheckpoint,\n  minimumCheckpointMs,',
  '  verifyCoopCheckpoint,\n  verifyCoopFinish,\n  minimumCheckpointMs,\n  minimumFinishMs,'
);

replaceOnce(
  'server/coopMovementAudit.test.mjs',
  '  verifyCoopCheckpoint,\n  minimumCheckpointMs,',
  '  verifyCoopCheckpoint,\n  verifyCoopFinish,\n  minimumCheckpointMs,\n  minimumFinishMs,'
);
write(
  'server/coopMovementAudit.test.mjs',
  read('server/coopMovementAudit.test.mjs') +
    `\n\ntest('финальный участок тоже имеет физический минимум и игровую область', () => {\n` +
    `  const spec = coopSpec('ch10');\n` +
    `  const player = playerAt(stateAt({ z: spec.checkpoints.at(-1) }));\n` +
    `  player.coopLastCheckpointAt = START_MS;\n` +
    `  assert.ok(minimumFinishMs(spec) >= 350);\n` +
    `  assert.equal(\n` +
    `    verifyCoopFinish(player, spec, stateAt({ x: 10, z: spec.finishZ }), START_MS + 10_000)?.reason,\n` +
    `    'coop-finish-region'\n` +
    `  );\n` +
    `  assert.equal(\n` +
    `    verifyCoopFinish(player, spec, stateAt({ z: spec.finishZ }), START_MS + 100)?.reason,\n` +
    `    'coop-finish-too-fast'\n` +
    `  );\n` +
    `  assert.equal(\n` +
    `    verifyCoopFinish(player, spec, stateAt({ z: spec.finishZ }), START_MS + 10_000),\n` +
    `    null\n` +
    `  );\n` +
    `});\n`
);

// Server integration.
replaceOnce(
  'server/index.js',
  "const { trackSignatureMetrics } = require('./signatureMetrics');",
  `const { trackSignatureMetrics } = require('./signatureMetrics');
const {
  auditCoopMovement,
  verifyCoopCheckpoint,
  verifyCoopFinish,
  noteAuthoritativeLaunch,
  resetCoopMotionHistory
} = require('./coopMovementAudit');`
);

replaceOnce(
  'server/index.js',
  `// Времена здесь мерил сервер — от старта комнаты до финиша, по своим часам. Движение он не
// проверял: разметка главы рукотворная, и коридоров, по которым проверяется гонка, у неё нет.
// Клиенту это сообщается полем movementVerified, чтобы интерфейс не обещал больше, чем есть.`,
  `// Время и движение здесь проверяет сервер. Для рукотворных глав используется отдельный
// CoopMovementAudit: он читает ту же data-driven разметку, что строит клиент, и проверяет
// систематическую скорость, опоры, высоту, checkpoint regions и физические минимумы, сохраняя
// узкие исключения только для серверно подтверждённых механик.`
);
replaceOnce('server/index.js', '    movementVerified: false,', '    movementVerified: true,');

replaceOnce(
  'server/index.js',
  `function addVerificationFindings(room, player, findings, details = {}) {
  if (room.mode !== GAME_MODE.RACE || !findings?.length) return false;`,
  `function addVerificationFindings(room, player, findings, details = {}) {
  if (!findings?.length) return false;`
);

replaceOnce(
  'server/index.js',
  `// Геометрия трассы известна серверу только в гонке: кооперативная глава — рукотворная разметка с
// другими опорами, и мерить её теми же коридорами нельзя.
function raceSpec(room) {
  return room.mode === GAME_MODE.RACE ? room.spec : null;
}

function verifyPlayerProgress(room, player, checkpoint, now) {
  if (room.mode !== GAME_MODE.RACE) return null;
  const verification = verifyCheckpointTime(player, checkpoint, now, room.spec);
  if (!verification) return null;
  addVerificationFindings(room, player, [verification.reason], verification);
  return verification;
}`,
  `function verificationFindingsForState(room, player, state, now) {
  return room.mode === GAME_MODE.COOP
    ? auditCoopMovement(room, player, state, now)
    : verifyMovement(player, state, now, room.spec);
}

function verifyPlayerProgress(room, player, checkpoint, state, now) {
  const verification =
    room.mode === GAME_MODE.COOP
      ? verifyCoopCheckpoint(player, room.spec, checkpoint, state, now)
      : verifyCheckpointTime(player, checkpoint, now, room.spec);
  if (!verification) return null;
  addVerificationFindings(room, player, [verification.reason], verification);
  return verification;
}`
);

replaceOnce(
  'server/index.js',
  `      addVerificationFindings(room, player, verifyMovement(player, result.state, now, raceSpec(room)));
      player.last = { ...result.state, id: player.id };
      player.lastAt = now;
      player.lastSequence = message.sequence;
      verifyPlayerProgress(room, player, result.checkpoint, now);`,
  `      addVerificationFindings(room, player, verificationFindingsForState(room, player, result.state, now));
      verifyPlayerProgress(room, player, result.checkpoint, result.state, now);
      player.last = { ...result.state, id: player.id };
      player.lastAt = now;
      player.lastSequence = message.sequence;`
);

replaceOnce(
  'server/index.js',
  `        addVerificationFindings(room, player, verifyMovement(player, result.state, now, raceSpec(room)));
        player.last = { ...result.state, id: player.id };
        player.lastAt = now;
        player.receivedAt = now;
        verifyPlayerProgress(room, player, result.checkpoint, now);`,
  `        addVerificationFindings(room, player, verificationFindingsForState(room, player, result.state, now));
        verifyPlayerProgress(room, player, result.checkpoint, result.state, now);
        player.last = { ...result.state, id: player.id };
        player.lastAt = now;
        player.receivedAt = now;`
);

replaceOnce(
  'server/index.js',
  `      // Последний отрезок — от арки до ленты — до сих пор не проверял никто.
      if (room.mode === GAME_MODE.RACE) {
        const tail = verifyFinishTime(player, now);
        if (tail) addVerificationFindings(room, player, [tail.reason], tail);
      }`,
  `      // Последний отрезок тоже входит в verification boundary. У гонки и коопа разные
      // геометрия и физические исключения, но итог один: мгновенный выход к ленте не становится
      // подтверждённым результатом.
      const tail =
        room.mode === GAME_MODE.COOP
          ? verifyCoopFinish(player, room.spec, player.last, now)
          : verifyFinishTime(player, now);
      if (tail) addVerificationFindings(room, player, [tail.reason], tail);`
);

replaceOnce(
  'server/index.js',
  `      if (result.relay) {
        if (result.relay.action === 'revive') {`,
  `      if (result.relay) {
        if (result.relay.action === 'launch') {
          // Исключение выдаёт сервер и только тому, кого действительно подбросила прошедшая все
          // проверки катапульта. Клиент сам объявить себе «режим быстрого полёта» не может.
          const target = room.players.get(result.relay.target);
          if (target) noteAuthoritativeLaunch(target);
        }
        if (result.relay.action === 'revive') {`
);

replaceOnce(
  'server/index.js',
  `        const point = coopSpawnFor(room.spec, player.checkpoint, player.slot);
        resetHistory(player);`,
  `        const point = coopSpawnFor(room.spec, player.checkpoint, player.slot);
        resetHistory(player);
        resetCoopMotionHistory(player);`
);

replaceOnce(
  'server/index.js',
  `      movementAnomalies: {},
      movementHistory: [],
      freeFallSince: null,`,
  `      movementAnomalies: {},
      movementHistory: [],
      freeFallSince: null,
      // Независимая история co-op audit. Она сбрасывается на каждый matchId так же, как race
      // verification, чтобы реванш не наследовал аномалии предыдущего забега.
      coopMovementAnomalies: {},
      coopMovementHistory: [],
      coopFreeFallSince: null,
      coopLastCheckpointAt: room.startedAt,
      coopMotionException: null,`
);

replaceOnce(
  'server/index.js',
  `    // Отметка проверки идёт отдельным измерением, а не фильтром. Выбросить непроверенные времена
    // значило бы потерять и те, где виноват не игрок: в кооперативе движение вообще не проверяется,
    // а в гонке зачёт снимает и чужой обрыв связи. Смешать их с проверенными — испортить среднее
    // одним забегом на три секунды. Разными строками читаются и те и другие.`,
  `    // Отметка проверки идёт отдельным измерением, а не фильтром. Непроверенный забег всё равно
    // полезен для продуктовой аналитики: он показывает длительность попытки, но не участвует в
    // competitive leaderboard и не смешивается со средним подтверждённых прохождений.`
);

replaceOnce(
  'server/index.js',
  `  // В таблицу идут оба режима — но только те, где время мерил сервер.
  //
  // В гонке проверено и время, и каждое положение игрока. В коопе геометрия главы серверу
  // неизвестна, и движение он не проверяет, — зато время меряет сам, по своим часам, от старта
  // комнаты до финиша. Подделать его клиент не может, и этого достаточно, чтобы таблица глав
  // означала то, что обещает. Соло в таблицу не идёт и идти не может: там сервера нет вовсе.`,
  `  // В публичную таблицу идут только trusted online-забеги. В race движение проверяется по
  // процедурной геометрии, в coop — отдельным data-driven CoopMovementAudit с известными
  // исключениями механик. Соло в таблицу не идёт: сервера там нет, и подтвердить движение некому.`
);

replaceOnce(
  'server/index.js',
  `  matchmakingStatus,
  rotateEventLoopWindow,`,
  `  matchmakingStatus,
  addVerificationFindings,
  verificationFindingsForState,
  verifyPlayerProgress,
  rotateEventLoopWindow,`
);

// A co-op verification reason must affect the same board/trust model as a race reason.
replaceOnce(
  'server/test.js',
  `  trackEvent,
  matchmakingStatus
} = require('./index');`,
  `  trackEvent,
  matchmakingStatus,
  addVerificationFindings
} = require('./index');`
);
write(
  'server/test.js',
  read('server/test.js') +
    `\n\ntest('co-op verification findings снимают competitive trust так же, как race', () => {\n` +
    `  const room = { mode: 'coop', code: 'AUDIT', matchId: 'm-coop' };\n` +
    `  const player = { id: 'p1', verificationReasons: [] };\n` +
    `  assert.equal(addVerificationFindings(room, player, ['coop-sustained-speed']), true);\n` +
    `  assert.deepEqual(player.verificationReasons, ['coop-sustained-speed']);\n` +
    `  assert.equal(addVerificationFindings(room, player, ['coop-sustained-speed']), false, 'reason дедуплицируется');\n` +
    `});\n`
);

// Verification v3 is the first version where co-op movement itself is audited. Old co-op rows must
// not be silently promoted to competitive records, while race v2 records remain valid race history.
replaceOnce(
  'server/verifiedLeaderboard.js',
  `// 2 — проверка узнала геометрию трассы и обзавелась историей пакетов: свои потолки скорости на
// каждое состояние персонажа, коридор опоры и полоса высоты стояния, средняя скорость за окно в две
// секунды, правило «вне досягаемости препятствий работает только гравитация», минимальное время
// сегмента по его типу вместо общих 300 мс. Записи версии 1 приняты правилами, которые ничего из
// этого не знали.
const VERIFICATION_VERSION = 2;`,
  `// 2 — race-проверка узнала геометрию трассы и историю пакетов.
// 3 — competitive co-op получил собственный CoopMovementAudit по общей разметке глав: sustained
// speed, support/height, checkpoint regions, минимумы участков и серверные исключения механик.
// Старые co-op строки версии 2 были только server-timed и не могут считаться проверенными v3.
const VERIFICATION_VERSION = 3;`
);
replaceOnce(
  'server/verifiedLeaderboard.js',
  `    this.migrated = migrate(this.db);
    this.db.exec(SCHEMA);
    this.statements = prepare(this.db);`,
  `    this.migrated = migrate(this.db);
    this.db.exec(SCHEMA);
    this.staleCoopPruned = Number(
      this.db
        .prepare("DELETE FROM leaderboard_entries WHERE mode = 'coop' AND verification_version < ?")
        .run(this.verificationVersion).changes || 0
    );
    this.statements = prepare(this.db);`
);

write(
  'server/verifiedLeaderboard.test.mjs',
  read('server/verifiedLeaderboard.test.mjs') +
    `\n\ntest('новая co-op verification version не повышает старые server-timed строки задним числом', () => {\n` +
    `  const db = openDatabase(':memory:');\n` +
    `  const legacy = new VerifiedLeaderboard({ db, verificationVersion: 2 });\n` +
    `  legacy.record({\n` +
    `    matchId: 'legacy-coop', mode: 'coop', courseKey: 'ch1',\n` +
    `    entries: [{ playerId: 'coop-old', name: 'Старый кооп', time: 9000, verified: true }]\n` +
    `  });\n` +
    `  legacy.record({\n` +
    `    matchId: 'legacy-race', mode: 'race', courseKey: '1:easy',\n` +
    `    entries: [{ playerId: 'race-old', name: 'Старая гонка', time: 12000, verified: true }]\n` +
    `  });\n` +
    `  assert.equal(legacy.get('coop', 'ch1').length, 1, 'подготовка: legacy co-op строка существует');\n` +
    `  const current = new VerifiedLeaderboard({ db });\n` +
    `  assert.equal(current.staleCoopPruned, 1);\n` +
    `  assert.deepEqual(current.get('coop', 'ch1'), [], 'movement-unverified co-op v2 удалён из competitive board');\n` +
    `  assert.equal(current.get('race', '1:easy').length, 1, 'race v2 не затронут co-op migration');\n` +
    `  db.close();\n` +
    `});\n`
);

// Release/build identity.
const pkg = JSON.parse(read('package.json'));
pkg.version = '2.4.0';
if (!pkg.scripts.test.includes('server/coopMovementAudit.test.mjs')) {
  pkg.scripts.test = pkg.scripts.test.replace(
    'server/signatureCoopState.test.mjs',
    'server/signatureCoopState.test.mjs server/coopMovementAudit.test.mjs'
  );
}
write('package.json', JSON.stringify(pkg, null, 2) + '\n');

const lock = JSON.parse(read('package-lock.json'));
lock.version = '2.4.0';
lock.packages[''].version = '2.4.0';
write('package-lock.json', JSON.stringify(lock, null, 2) + '\n');

replaceOnce('server/observability.test.mjs', "      version: '2.3.0',", "      version: '2.4.0',");

replaceOnce(
  'README.md',
  `- Общая таблица рекордов у гонки и у кооперативных глав — там, где время меряет сервер. В гонке
  проверено ещё и каждое положение игрока; в коопе разметка рукотворная, движение не проверяется, и
  таблица честно подписана «время по серверу». Соло идёт только в личный рекорд: сервера в нём нет,
  и публичная таблица была бы списком чисел, которые каждый вписывает себе сам.`,
  `- Общая competitive-таблица рекордов у гонки и кооперативных глав принимает только server-timed
  подтверждённые забеги. В гонке движение проверяется по процедурной геометрии; в коопе отдельный
  CoopMovementAudit читает общую data-driven разметку главы, проверяет sustained speed, опоры,
  высоту, checkpoint regions и минимальное время участков, делая узкие исключения для подтверждённых
  сервером катапульт, троса и moving platform. Старые co-op строки, записанные до этой проверки,
  не повышаются до competitive задним числом. Соло остаётся только личным рекордом: сервера там нет.`
);
