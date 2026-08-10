'use strict';

const fs = require('fs');
const path = 'server/network.test.mjs';
let source = fs.readFileSync(path, 'utf8');

const before = `test('неудачный resume чистит токен и не отправляет накопленное', () => {
  const net = makeNet();
  net.roomCode = 'ABCDE';
  net.matchId = 'm1';
  net.resumeInFlight = true;
  net.resumeToken = 'dead-token';
  net.handleMessage({ type: S2C.WELCOME, id: 'temp-id', token: 'fresh-token', serverTime: Date.now() });
  net.queue.push(JSON.stringify({ type: C2S.PLAYER_STATE }));

  let expired = 0;
  net.on('sessionExpired', () => expired++);
  net.handleMessage({ type: S2C.RESUME_FAILED, code: 'RECONNECT_EXPIRED' });

  assert.equal(expired, 1, 'игра должна узнать, что возвращаться некуда');
  assert.equal(net.id, 'temp-id', 'после отказа личность нового сокета становится настоящей');
  assert.equal(net.sessionToken, 'fresh-token', 'мёртвый токен заменён свежим');
  assert.equal(net.matchId, null, 'матча больше нет');
  assert.deepEqual(net.queue, [], 'очередь прошлой жизни отправлять некуда');
});`;

const after = `test('неудачный resume чистит токен и заново подтверждает account перед новой жизнью', async () => {
  const net = makeNet();
  net.roomCode = 'ABCDE';
  net.matchId = 'm1';
  net.resumeInFlight = true;
  net.resumeToken = 'dead-token';
  net.handleMessage({ type: S2C.WELCOME, id: 'temp-id', token: 'fresh-token', serverTime: Date.now() });
  net.queue.push(JSON.stringify({ type: C2S.PLAYER_STATE }));

  let freshRequests = 0;
  net.ui.accountToken = async ({ fresh } = {}) => {
    assert.equal(fresh, true, 'после провала resume нужен новый WST из HttpOnly session');
    freshRequests++;
    return 'WST.fresh-after-resume-failure-1234567890';
  };

  let expired = 0;
  net.on('sessionExpired', () => expired++);
  net.handleMessage({ type: S2C.RESUME_FAILED, code: 'RECONNECT_EXPIRED' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(expired, 1, 'игра должна узнать, что возвращаться некуда');
  assert.equal(net.id, null, 'временный hello нельзя принимать до нового socket-auth');
  assert.equal(net.sessionToken, null, 'мёртвый room-session должен быть удалён');
  assert.equal(net.matchId, null, 'матча больше нет');
  assert.deepEqual(net.queue, [], 'очередь прошлой жизни отправлять некуда');
  assert.equal(freshRequests, 1, 'новый WST запрашивается ровно один раз');
  assert.deepEqual(net.sent.at(-1), {
    type: C2S.AUTH,
    ticket: 'WST.fresh-after-resume-failure-1234567890'
  });

  net.handleMessage({ type: S2C.AUTHENTICATED, accountId: 'acc-1' });
  assert.equal(net.id, 'temp-id', 'личность нового сокета принимается только после AUTH');
  assert.equal(net.sessionToken, 'fresh-token', 'новая room-session сохраняется после AUTH');
  assert.equal(net.handshakeReady, true);
});`;

if (source.includes(after)) {
  console.log('already patched');
  process.exit(0);
}
if (!source.includes(before)) throw new Error('resume-auth regression anchor missing');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('patched server/network.test.mjs');
