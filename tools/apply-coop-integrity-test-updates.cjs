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

replaceOnce(
  'server/integration.test.js',
  `// Проверяется на кооперативе, потому что там до реванша можно дойти быстро. Сам сброс от режима не
// зависит: это один и тот же beginCountdown.`,
  `// Проверяется на кооперативе, потому что там до реванша можно дойти быстро. После появления
// CoopMovementAudit у режимов независимые буферы аномалий, но жизненный цикл у них общий:
// beginCountdown обязан очищать co-op историю так же строго, как race.`
);

replaceOnce(
  'server/integration.test.js',
  `  assert.ok(
    Object.values(player.movementAnomalies || {}).some(count => count > 0),
    'подготовка: забег обязан оставить отклонения'
  );`,
  `  assert.ok(
    Object.values(player.coopMovementAnomalies || {}).some(count => count > 0),
    'подготовка: быстрый co-op прогон обязан оставить audit-отклонения'
  );`
);

replaceOnce(
  'server/integration.test.js',
  `  assert.deepEqual(player.movementAnomalies, {}, 'новый забег обязан начинаться с полным запасом');
  assert.deepEqual(player.movementHistory, [], 'история движения прошлого забега к новому не относится');`,
  `  assert.deepEqual(
    player.coopMovementAnomalies,
    {},
    'новый co-op забег обязан начинаться с полным запасом audit-бюджета'
  );
  assert.deepEqual(
    player.coopMovementHistory,
    [],
    'co-op история движения прошлого забега к новому не относится'
  );`
);

replaceOnce(
  'server/integration.test.js',
  `// Кооперативная глава попадает в общую таблицу — и это единственный режим, кроме гонки, где она
// вообще имеет смысл.
//
// Движение в коопе сервер не проверяет: разметка главы рукотворная, коридоров и потолков скорости
// у неё нет. Зато время он меряет сам, по своим часам, от старта комнаты до финиша, — подделать
// его клиент не может. Проверяется именно это: строка появляется, время в ней серверное, а не
// присланное, и оба напарника получают своё место.`,
  `// Кооперативная глава попадает в competitive-таблицу только после server-side movement audit.
// Этот тест намеренно использует runHonestly, а не быстрый функциональный runToFinish: последний
// движется примерно в семь раз быстрее персонажа и теперь правильно снимает зачёт. Проверяется
// полный production boundary: серверное время + допустимое движение + строки обоих напарников.`
);

replaceOnce(
  'server/integration.test.js',
  `  await Promise.all([
    runToFinish(host, started.spec, started.matchId),
    runToFinish(guest, started.spec, started.matchId)
  ]);`,
  `  await Promise.all([
    runHonestly(host, started.spec, started.matchId),
    runHonestly(guest, started.spec, started.matchId)
  ]);`
);

replaceOnce(
  'server/integration.test.js',
  `  assert.equal(
    board.movementVerified,
    false,
    'интерфейсу честно сообщается, что движение здесь не проверялось'
  );`,
  `  assert.equal(
    board.movementVerified,
    true,
    'competitive co-op board обязан сообщать о server-side movement verification'
  );`
);
