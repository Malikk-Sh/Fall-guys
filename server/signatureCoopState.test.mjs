import test from 'node:test';
import assert from 'node:assert/strict';
import coopRules from './coopRules.js';
import { signatureLayout } from '../shared/signatureCoop.js';

const { ensureSignatureState, signatureSnapshot, validateCoopEvent } = coopRules;

const player = (id, position) => ({
  id,
  last: { ...position, ry: 0, vx: 0, vz: 0, checkpoint: 0 },
  downed: false
});

function roomFor(chapterId, matchId = 'match-1') {
  const layout = signatureLayout(chapterId);
  const first = player(
    'a-player',
    layout.core?.spawn || layout.signal?.guide || { x: 0, y: 1, z: 0 }
  );
  const second = player(
    'b-player',
    layout.core?.socket || layout.signal?.operator || { x: 1, y: 1, z: 0 }
  );
  return {
    chapterId,
    spec: { chapterId },
    matchId,
    players: new Map([
      [first.id, first],
      [second.id, second]
    ])
  };
}

const signatureEvent = (objectId, extra = {}) => ({
  action: 'plate',
  objectId,
  ...extra
});

test('ch7: сервер владеет ядром от pickup до socket и сохраняет его при reconnect', () => {
  const room = roomFor('ch7');
  const layout = signatureLayout('ch7');
  const first = room.players.get('a-player');
  const second = room.players.get('b-player');
  const started = 10_000;

  let result = validateCoopEvent(room, first, signatureEvent('core:pickup'), started);
  assert.equal(result.ok, true);
  assert.equal(result.relay.signature.core.carrier, first.id);

  first.last = {
    ...first.last,
    x: layout.core.spawn.x,
    y: layout.core.spawn.y,
    z: layout.core.spawn.z
  };
  result = validateCoopEvent(
    room,
    first,
    signatureEvent('core:throw', { vector: { x: 1, y: 0.35, z: 0 } }),
    started + 100
  );
  assert.equal(result.ok, true);
  assert.equal(result.relay.signature.core.carrier, null);
  assert.ok(result.relay.signature.core.velocity.x > 9, 'сервер нормализует бросок до скорости главы');

  const airborne = signatureSnapshot(room, started + 430).core;
  second.last = { ...second.last, ...airborne.position };
  result = validateCoopEvent(room, second, signatureEvent('core:pickup'), started + 430);
  assert.equal(result.ok, true, 'напарник ловит то же серверное ядро');
  assert.equal(result.relay.signature.core.carrier, second.id);

  second.last = { ...second.last, ...layout.core.socket };
  result = validateCoopEvent(room, second, signatureEvent('core:insert'), started + 500);
  assert.equal(result.ok, true);
  assert.equal(result.relay.signature.core.insertedInto, layout.core.socket.id);

  const reconnectSync = validateCoopEvent(room, first, signatureEvent('sig:sync'), started + 900);
  assert.equal(reconnectSync.relay.signature.core.insertedInto, layout.core.socket.id);

  room.matchId = 'match-2';
  const nextRun = ensureSignatureState(room, started + 1000).state;
  assert.equal(nextRun.core.insertedInto, null, 'новый matchId получает новое ядро');
  assert.deepEqual(nextRun.core.position, layout.core.spawn);
});

test('ядро нельзя подобрать или вставить с другого конца главы', () => {
  const room = roomFor('ch10');
  const layout = signatureLayout('ch10');
  const first = room.players.get('a-player');

  first.last = { ...first.last, x: 90, y: 1, z: 90 };
  assert.equal(validateCoopEvent(room, first, signatureEvent('core:pickup'), 20_000).ok, false);

  first.last = { ...first.last, ...layout.core.spawn };
  assert.equal(validateCoopEvent(room, first, signatureEvent('core:pickup'), 20_100).ok, true);
  assert.equal(validateCoopEvent(room, first, signatureEvent('core:insert'), 20_200).ok, false);
});

test('ch9: только operator у терминала может вводить последовательность, прогресс живёт на сервере', () => {
  const room = roomFor('ch9');
  const layout = signatureLayout('ch9');
  const guide = room.players.get('a-player');
  const operator = room.players.get('b-player');
  operator.last = { ...operator.last, ...layout.signal.operator };
  guide.last = { ...guide.last, ...layout.signal.guide };

  assert.equal(
    validateCoopEvent(room, guide, signatureEvent('signal:press:0'), 30_000).ok,
    false,
    'guide видит код, но не нажимает кнопки'
  );

  for (let progress = 0; progress < layout.signal.sequence.length; progress++) {
    const symbol = layout.signal.sequence[progress];
    const index = layout.signal.symbols.indexOf(symbol);
    const result = validateCoopEvent(
      room,
      operator,
      signatureEvent(`signal:press:${index}`),
      30_100 + progress
    );
    assert.equal(result.ok, true);
    assert.equal(result.relay.signature.signal.progress, progress + 1);
  }

  const sync = validateCoopEvent(room, guide, signatureEvent('sig:sync'), 31_000);
  assert.equal(sync.relay.signature.signal.solved, true);
  assert.equal(sync.relay.signature.signal.roles.guide, guide.id);
  assert.equal(sync.relay.signature.signal.roles.operator, operator.id);
});

test('signature layout физически разводит стороны задачи', () => {
  const ch7 = signatureLayout('ch7');
  assert.ok(ch7.core.spawn.x < 0 && ch7.core.socket.x > 0);
  assert.equal(ch7.core.gateId, 'relay2');

  const ch9 = signatureLayout('ch9');
  assert.ok(ch9.signal.guide.x < 0 && ch9.signal.operator.x > 0);
  assert.equal(ch9.signal.gateId, 'verticalGate');

  const ch10 = signatureLayout('ch10');
  assert.equal(ch10.core.gateId, 'finalRelay');
});
